/**
* enrich-jobs.js
*
* Reads all_jobs.json, enriches new jobs (split batch: fast CPU-only + slow HTTP sources),
* appends results to enriched_jobs.json (JSONL).
*
* Enrichment extracts:
*   - required_skills[]        (from requirements/qualifications sections)
*   - nice_to_have_skills[]    (from preferred/bonus sections)
*   - sponsors_visa            (true | false | null — text-based, kept as fallback)
*   - visa_question_present    (true | false | null — from ATS application form)
*   - visa_no_signal_reason    ('defense_contractor' | null — explained gap for zero visa signal)
*   - is_remote                (bool, from tags.locations includes 'remote')
*   - experience_level         (from tags.employment)
*   - is_simple_apply          (bool | null — DATA-8: GH only, question_count <= 13)
*   - question_count           (int | null — DATA-8: GH/Ashby/Lever)
*   - min_degree               ('bachelors'|'masters'|'phd'|'associates'|'none'|null — DATA-3)
*   - experience_level_from_desc ('entry_level'|'mid_level'|'senior'|null — DATA-4)
*   - has_description          (bool — whether a description was available during enrichment)
*   + denormalized display fields: title, company_name, job_city, job_state, url, posted_at
*
* visa_question_present detection (per ATS):
*   Greenhouse: GET /v1/boards/{slug}/jobs/{id}?questions=true → questions[].label
*   Ashby:      fetch apply_url page → window.__appData JSON → field.title
*   Lever:      fetch apply_url page → HTML-entity-encoded JSON → fields[].text
*/

'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const he = require('he');

// Module imports (ENR-ARCH-1)
const { loadTaxonomy, matchSkills, hasTechContext, COMPANY_NAME_TERMS } = require('./enrich/taxonomy');
const { toPlainText, splitSections } = require('./enrich/text-processing');
const { detectVisa, normalizeLcaName, isPossibleSponsor, classifyVisaGap, loadLcaSponsors, fetchApplicationVisaStatus, SIMPLE_APPLY_THRESHOLD } = require('./enrich/visa');
const { extractMinDegree, inferDegreeFromTitle, extractExperienceLevel, BOILERPLATE_OPENERS } = require('./enrich/field-extraction');
const { loadDescriptionsMap, resolveActiveChunk, fetchMissingDescriptions, refreshStaleSrDescriptions, buildWdDescUrl, buildSrDescUrl, quickGet, loadFailCache, saveFailCache } = require('./enrich/description-fetcher');
const { generateStats, classifyTier, TECH_DOMAINS } = require('./enrich/stats');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ENRICHER_VERSION = 68;   // VISA-EXPORT: capture U.S.-person / ITAR-EAR restriction language as job-level negative visa signal
const SLOW_BATCH_SIZE = 200;   // GH, Ashby/Lever — HTTP calls per job (ENR-49: 120→200)
const FAST_BATCH_SIZE = 500;  // All non-GH/Ashby/Lever sources — CPU only during enrichment
const MAX_RETRIES = 3;        // ENR-QUEUE-1: cap retry attempts for no-result records
const FAST_SOURCES = new Set(['workday', 'smartrecruiters', 'jsearch', 'amazon', 'netflix', 'eightfold', 'oracle', 'microsoft', 'amd', 'uber', 'apple', 'google', 'simplify']);
// ENR-STRUCTURAL-SKIP: Sources with no description API. They enter the pool as T0 (title+URL only)
// and waste batch slots cycling through MAX_RETRIES before re-exhausting. Skip them permanently.
const STRUCTURAL_SOURCES = new Set(['simplify', 'jsearch', 'eightfold']);
const DESC_FETCH_PER_RUN = 500; // DESC-MIGRATE-1: WD/SR descriptions fetched by enrichment (3s timeout per)
const DESC_FETCH_DELAY_MS = 300;
const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const ALL_JOBS_PATH = path.join(DATA_DIR, 'all_jobs.json');
const ENRICHED_PATH = path.join(DATA_DIR, 'enriched_jobs.json');
const PROCESSED_PATH = path.join(DATA_DIR, 'processed_ids.json');
const DESCRIPTIONS_PATH = path.join(DATA_DIR, 'descriptions.jsonl');
const TAXONOMY_PATH = path.join(__dirname, 'enrich', 'skills-taxonomy.json');
const LCA_ALIASES_PATH = path.join(__dirname, 'enrich', 'lca-aliases.json');


// ---------------------------------------------------------------------------
// Load taxonomy — flatten all categories into a single Set for O(1) lookup,
// preserving canonical casing from the JSON for output.
// Aliases are canonicalized so consumers see consistent skill names.
// ---------------------------------------------------------------------------
// loadTaxonomy → imported from ./enrich/taxonomy

// ---------------------------------------------------------------------------
// classifyVisaGap → imported from ./enrich/visa

// ---------------------------------------------------------------------------
// ENR-VISA-2: LCA visa signal — exact-match + curated alias map
//
// DOL LCA filings use legal entity names; pipeline uses brand names.
// Prefix matching is fundamentally unsafe (C25 found 3.2% FP from common words).
// Every non-exact match goes through a verified alias map.
// Covers 99.0% of at-risk records (4,091/4,134). 43 records from 9 genuinely-FP
// companies lose their signal — all are unrelated entities sharing a name.
// ---------------------------------------------------------------------------
const LCA_COMPANY_ALIASES = fs.existsSync(LCA_ALIASES_PATH)
  ? JSON.parse(fs.readFileSync(LCA_ALIASES_PATH, 'utf8'))
  : {};

// normalizeLcaName → imported from ./enrich/visa

// loadLcaSponsors → imported from ./enrich/visa

// isPossibleSponsor → imported from ./enrich/visa

// Load per-source description sidecars → Map<id, description_text>
//
// Reads all files matching descriptions-*.jsonl in DATA_DIR.
// Handles both single-source files (descriptions-greenhouse.jsonl) and
// chunked files (descriptions-greenhouse-1.jsonl, descriptions-greenhouse-2.jsonl).
// Falls back to legacy descriptions.jsonl if per-source files are absent
// (handles transition period between old and new aggregator).
// ---------------------------------------------------------------------------
// loadDescriptionsMap → imported from ./enrich/description-fetcher

// ---------------------------------------------------------------------------
// DESC-MIGRATE-1: Fetch WD/SR descriptions on-demand for enrichable jobs
// Reconstructs API URLs from job.url — no _raw fields needed.
// Only fetches for tech+US jobs missing from sidecar (targeted, no waste).
// ---------------------------------------------------------------------------
// buildWdDescUrl → imported from ./enrich/description-fetcher

// buildSrDescUrl → imported from ./enrich/description-fetcher

// Fast GET for description fetches — shorter timeout, no redirect following
// quickGet → imported from ./enrich/description-fetcher

// Failure cache: skip URLs that returned 403/404 for 24h
const DESC_FAIL_CACHE_PATH = path.join(DATA_DIR, 'desc-fetch-failures.json');
// loadFailCache → imported from ./enrich/description-fetcher
// saveFailCache → imported from ./enrich/description-fetcher

// Determine which enriched chunk to write to for this entire run.
// Checked once at startup — never switches mid-run to avoid splitting a batch across files.
// A new chunk file is started when the current tail chunk exceeds CHUNK_LIMIT_BYTES.
// Chunks: descriptions-enriched-1.jsonl, -2.jsonl, -3.jsonl, ...
// resolveActiveChunk → imported from ./enrich/description-fetcher

// fetchMissingDescriptions → imported from ./enrich/description-fetcher

// ---------------------------------------------------------------------------
// HTML → plain text with structural section markers
// Strategy:
//   - <h1>–<h4>: always structural → emit ###SECTION:text###
//   - <strong>/<b> inside a block that contains ONLY the strong tag → structural
//   - All other <strong>/<b> → inline emphasis, stripped normally
// Sampling (5 GH + 5 Ashby, 2026-02-28): GH uses <strong> for section headers
// (Anduril, SpaceX, Lucid, Okta); <h2> seen only in Elastic. Ashby uses <h1>–<h3>
// depending on company. No single tag is universal, so both paths needed.
// ---------------------------------------------------------------------------
// toPlainText → imported from ./enrich/text-processing

// ---------------------------------------------------------------------------
// Section splitter
// Returns { required: string, preferred: string }
// Matches both ###SECTION:### markers (from HTML tags) and plain-text headers
// (fallback for Lever plain-text descriptions).
// [:\s]? makes trailing colon/space optional — handles all-caps headers with no suffix.
// ---------------------------------------------------------------------------
const REQUIRED_HEADERS = [
/requirements?[:\s]?$/i,
/(?<!preferred\s)(?<!desired\s)qualifications?[:\s]?$/i,
/what you (need|bring|must have)[:\s]?$/i,
/what you need to succeed[:\s]?$/i,
/what we('?re| are) looking for[:\s]?$/i,
/education (and|&).{0,10}experience[:\s]?$/i,
/minimum qualifications?[:\s]?$/i,
/basic qualifications?[:\s]?$/i,
/required (skills?|qualifications?)[:\s]?$/i,
/must[ -]have[:\s]?$/i,
/you (will need|should have)[:\s]?$/i,
/skills? you.ll need[:\s]?/i,
/in practice this looks like[:\s]?$/i,
/you might thrive here if[:\s]?$/i,
/who you are[:\s]?$/i,
/what you.ll bring[:\s]?$/i,
/about you[:\s]?$/i,
/the ideal candidate[:\s]?$/i,
/^experience[:\s]?$/i,
/successful candidates?.{0,50}(will|should|must)/i,
];

const PREFERRED_HEADERS = [
/preferred (qualifications?|skills?|experience)/i,
/nice[ -]to[ -]haves?[:\s]?$/i,
/bonus (points?|if|qualifications?)?[:\s]?$/i,
/desired qualifications?/i,
/plus (if|points?)?[:\s]?$/i,
/it'?s? (a )?(bonus|plus|nice)[:\s]?$/i,
/while not required/i,
/added (plus|bonus)/i,
];

// splitSections → imported from ./enrich/text-processing

// ---------------------------------------------------------------------------
// Taxonomy matcher
// Returns deduplicated array of canonical skill names found in text.
// Uses word-boundary aware matching to avoid "r" matching "requirements".
//
// Ambiguous short terms (go, r, c, rest, etc.) require explicit tech context
// nearby to avoid false positives like "go-to-market" or "the rest of".
// ---------------------------------------------------------------------------

// Terms that are too ambiguous on their own — require a tech context signal
// within the same sentence/bullet to count as a match.
const AMBIGUOUS_TERMS = new Set(['go', 'r', 'c', 'rest', 'restful', 'assembly', 'lean', 'chef', 'classification', 'move']);

// COMPANY_NAME_TERMS → imported from ./enrich/taxonomy

const TECH_CONTEXT_SIGNALS = [
/\b(programming|language|developer|engineer|code|software|written in|experience with|proficien|framework|backend|api)\b/i,
];

// matchSkills, hasTechContext → imported from ./enrich/taxonomy

// ---------------------------------------------------------------------------
// Visa sponsorship detector
// Returns true | false | null
// ---------------------------------------------------------------------------

// Patterns that appear in EEO boilerplate — strip these paragraphs first
const EEO_BOILERPLATE = [
/equal opportunity employer/i,
/without regard to race/i,
/eeo statement/i,
/disability.{0,40}veteran/i,
/reasonable accommodation/i,
];

// Negative signals → false (company explicitly will NOT sponsor)
const VISA_NEGATIVE = [
/\bno\b.{0,30}\bvisa sponsorship\b/i,
/will not sponsor/i,
/cannot sponsor/i,
/unable to sponsor/i,
/does not (offer|provide) (visa )?sponsorship/i,
/sponsorship (is )?not available/i,
/must be (authorized|eligible) to work.{0,60}without (sponsorship|authorization)/i,
/authorized to work in the u\.?s\.?(a\.?)? without/i,
/u\.?s\.? citizen(ship)? (or|and) (permanent resident|green card)/i,
/legally authorized to work.{0,40}united states/i,
/work authorization.{0,40}required/i,
/must be authorized to work in the (u\.?s\.?|united states)/i,
/applicant must be.{0,30}(u\.?s\.? citizen|permanent resident)/i,
/must be.{0,20}(citizen|permanent resident).{0,30}united states/i,
];

// Positive signals → true
const VISA_POSITIVE = [
/will (provide|offer|consider) (visa )?sponsorship/i,
/visa sponsorship (is )?available/i,
/sponsorship available\.?$/im,          // "Sponsorship available." (Ashby bullet-list benefit format)
/^[-•]\s*visa sponsorship\s*$/im,       // "- Visa Sponsorship" (Ashby benefit line, standalone)
/h[\s-]?1[\s-]?b sponsorship/i,
/open to (visa )?sponsorship/i,
/able to sponsor/i,
/sponsorship (for|of) (work )?visa/i,
/we (do )?sponsor/i,
];

// detectVisa → imported from ./enrich/visa

// ---------------------------------------------------------------------------
// ATS application form visa detection
// Returns: true (question present) | false (not present) | null (fetch failed / source unsupported)
// ---------------------------------------------------------------------------

const GH_VISA_RE = /sponsor|visa/i;
const ASHBY_VISA_RE = /sponsor/i;
const LEVER_VISA_RE = /sponsor/i;
const FETCH_TIMEOUT_MS = 8000;

// httpsGet → imported from ./enrich/visa

// SIMPLE_APPLY_THRESHOLD → imported from ./enrich/visa

// fetchApplicationVisaStatus returns { visaPresent, questionCount }
// visaPresent: true | false | null
// questionCount: integer (GH/Ashby/Lever) | null (Workday/Amazon — no form access)
// fetchApplicationVisaStatus → imported from ./enrich/visa

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function loadAllJobs() {
if (!fs.existsSync(ALL_JOBS_PATH)) {
console.log('all_jobs.json not found — nothing to enrich');
process.exit(0);
}
const lines = fs.readFileSync(ALL_JOBS_PATH, 'utf8').trim().split('\n');
return lines.filter(l => l.trim()).map(l => {
try { return JSON.parse(l); }
catch (_) { console.warn(`[enrich-jobs] skipped malformed line: ${l.slice(0, 60)}`); return null; }
}).filter(Boolean);
}

function loadProcessedIds() {
if (!fs.existsSync(PROCESSED_PATH)) return new Set();
try {
const raw = JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8'));
// Support both legacy flat array and current map format
if (Array.isArray(raw)) return new Set(raw);
if (raw && typeof raw === 'object') return new Set(Object.keys(raw));
return new Set();
} catch (_) {
return new Set();
}
}

function loadProcessedMap() {
if (!fs.existsSync(PROCESSED_PATH)) return {};
try {
const raw = JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8'));
// Migrate legacy flat array to map format on first read
if (Array.isArray(raw)) {
const map = {};
for (const id of raw) map[id] = { status: 'enriched', processed_at: null };
return map;
}
if (raw && typeof raw === 'object') return raw;
return {};
} catch (_) {
return {};
}
}

function loadEnrichedIds() {
// RE-ENRICH-1 fix: only load "skipped" (non-enrichable) IDs from processed_ids.json.
// "enriched" IDs must go through the version filter below — otherwise stale v2/v3
// records are pre-loaded as "done" and never re-enter the queue.
const ids = new Set();
const latestById = new Map();
if (fs.existsSync(PROCESSED_PATH)) {
try {
const raw = JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8'));
if (Array.isArray(raw)) {
// Legacy format — treat all as done (no status info to distinguish)
for (const id of raw) ids.add(id);
} else if (raw && typeof raw === 'object') {
for (const [id, val] of Object.entries(raw)) {
if (val && val.status === 'skipped') ids.add(id);
              // ENR-QUEUE-2: Exhausted records at old versions get a second chance on version bump.
              // The retry counter reset (line ~1266) only fires for records IN the batch — but
              // exhausted records were filtered out before reaching it, creating a permanent deadlock.
              if (val && val.status === 'exhausted' && (val.enricher_version || 0) >= ENRICHER_VERSION) ids.add(id);
// "enriched"/"retry" status entries intentionally NOT added — version filter below decides
}
}
} catch (_) {}
}
if (!fs.existsSync(ENRICHED_PATH)) return { ids, latestById };
const lines = fs.readFileSync(ENRICHED_PATH, 'utf8').trim().split('\n').filter(Boolean);
for (const line of lines) {
try {
const obj = JSON.parse(line);
if (obj.id) latestById.set(obj.id, obj);
// RE-ENRICH-1: skip stale versions so they re-enter the pending queue
if (obj.id && (obj.enricher_version || 0) >= ENRICHER_VERSION) {
        // ENR-P0: Only consider "done" if enrichment extracted skills.
        // has_description alone is insufficient — WD jobs get has_description=true from
        // transient in-memory desc fetches that may not persist to sidecar. When the sidecar
        // is missing on next run, isEnrichable() returns false but the done-check still says
        // "done" → deadlocked at T1 with zero skills. Requiring skills ensures records
        // that produced nothing re-enter the queue (up to MAX_RETRIES, then exhausted).
        const hasResults = (obj.required_skills?.length > 0);
        if (hasResults) ids.add(obj.id);
      }
} catch (_) {}
}
return { ids, latestById };
}

// ---------------------------------------------------------------------------
// DATA-7: Summary line extraction
// Returns the first non-boilerplate sentence from plain text description.
// Boilerplate openers (company mission, "at X we..." intros) are skipped.
// Falls back to first sentence of full text if no non-boilerplate sentence found.
// ---------------------------------------------------------------------------
// Boilerplate openers: company-about sentences, NOT role description sentences.
// Deliberately excludes "we are looking for" / "we're hiring" — those describe the role.
// Targets: "At [Company]...", "About us", "Our mission", "Founded in", company overview intros.
// extractMinDegree → imported from ./enrich/field-extraction

// ---------------------------------------------------------------------------
// DATA-3B: Title-based degree inference (ENR-45, Path A)
// When extractMinDegree returns null (no degree language in description),
// infer degree from job title patterns. Validated at 97.5% accuracy against
// records with known degrees. 33 measured FPs out of ~1,100 inferred (3%).
// ---------------------------------------------------------------------------

// Patterns ordered by specificity — first match wins.
// Each pattern maps to the inferred minimum degree.
// inferDegreeFromTitle → imported from ./enrich/field-extraction

// ---------------------------------------------------------------------------
// DATA-4: Experience level extraction from description text
// Returns: 'entry_level' | 'mid_level' | 'senior' | null
//   null = no year-range language found
//
// Year ranges map to levels:
//   0–2 years  → entry_level
//   3–5 years  → mid_level
//   6+ years   → senior
// When a range spans levels (e.g. "2-4 years"), use the lower bound.
//
// Sampling: GH=31%, Ashby=26%, Lever=2% have explicit year patterns.
// Patterns seen: "N+ years of experience", "N-M years of experience",
//   "N years experience", "N to M years of experience"
// ---------------------------------------------------------------------------
// extractExperienceLevel → imported from ./enrich/field-extraction

// TECH_DOMAINS → imported from ./enrich/stats

function isEnrichable(job, descriptionsMap) {
const domains = job.tags?.domains || [];
const locations = job.tags?.locations || [];
if (!domains.some(d => TECH_DOMAINS.has(d))) return false;
if (!locations.includes('us')) return false;
// ENRICH-OBS-2: Workday and SmartRecruiters jobs are only enrichable if a description is available.
// Without a description, enrichJob() produces null for skills/summary/visa — permanently
// blocking the slot and masking these fields as "enriched" when they're actually empty.
// These sources fetch descriptions asynchronously in the aggregator (Step 1b/1c).
if (job.source === 'workday' || job.source === 'smartrecruiters') {
return !!descriptionsMap.get(job.id);
}
return true;
}

function hasDescriptionNow(job, descriptionsMap) {
return !!(descriptionsMap.get(job.id) || job.description);
}

function shouldRescueExhaustedRecord(job, descriptionsMap, processedEntry, latestRecord) {
const currentlyExhausted = processedEntry?.status === 'exhausted' && (processedEntry.enricher_version || 0) >= ENRICHER_VERSION;
const wasMissingDescription = !latestRecord || latestRecord.has_description === false;
return currentlyExhausted && wasMissingDescription && hasDescriptionNow(job, descriptionsMap);
}

async function enrichJob(job, termMap, descriptionsMap, lcaSponsors) {

// ENR-32: Fall back to job.description for sources that embed descriptions in the
// job data itself (Greenhouse, Ashby, Lever) rather than requiring sidecar.
// WD/SR descriptions are fetched asynchronously and stored in descriptions-*.jsonl.
const rawDescription = descriptionsMap.get(job.id) || job.description || null;
const plainText = toPlainText(rawDescription || '');
const { required, preferred } = splitSections(plainText);

if (!required) {
console.log(`[enrich] no section found for ${job.id} — using full text`);
}
const text = required || plainText;
let requiredSkills = matchSkills(text, termMap);
let skillsSource = requiredSkills.length > 0 ? 'required' : null;
let niceToHaveSkills = matchSkills(preferred, termMap).filter(
s => !requiredSkills.includes(s)
);

// ENRICH-QUALITY-1: If required section yielded zero skills but preferred has them,
// promote preferred skills to required. Common pattern: SpaceX, Palantir, Hermeus put
// degree under "Basic Qualifications" and all tech skills under "Preferred Skills."
if (requiredSkills.length === 0 && niceToHaveSkills.length > 0) {
requiredSkills = niceToHaveSkills;
niceToHaveSkills = [];
skillsSource = 'preferred_promoted';
}

// TAXONOMY-AUDIT-1: Full-text fallback — when both required section and preferred
// section yielded zero skills but a section WAS found (non-empty required), the
// section may contain only degree/experience text while tech skills are elsewhere
// in the description. Fall back to full text as last resort.
if (requiredSkills.length === 0 && required && plainText.length > required.length) {
requiredSkills = matchSkills(plainText, termMap);
if (requiredSkills.length > 0) skillsSource = 'fulltext_fallback';
}

// ENR-53: Remove skills that match company-name boilerplate. e.g., "openai"
// appears in OpenAI job descriptions as company boilerplate, not as a skill.
// Only filter when company_name contains the term (keeps legitimate matches
// at non-OpenAI companies like "looking for OpenAI API experience").
const companyLower = (job.company_name || '').toLowerCase();
if (companyLower) {
for (const term of COMPANY_NAME_TERMS) {
if (companyLower.includes(term) && requiredSkills.includes(term)) {
requiredSkills = requiredSkills.filter(s => s.toLowerCase() !== term);
}
if (companyLower.includes(term) && niceToHaveSkills.includes(term)) {
niceToHaveSkills = niceToHaveSkills.filter(s => s.toLowerCase() !== term);
}
}
}

const sponsorsVisa = detectVisa(plainText);
const { visaPresent: visaQuestionPresent, questionCount } = await fetchApplicationVisaStatus(job);
// ENR-VISA-2: LCA exact-match + curated alias map (no prefix matching)
const possibleSponsor = isPossibleSponsor(job.company_name, lcaSponsors);
// ENR-VISA-1: classify zero-signal visa gaps (defense contractors)
const visaNoSignalReason = classifyVisaGap(job.company_name, sponsorsVisa, visaQuestionPresent, possibleSponsor);
const isRemote = (job.tags?.locations || []).includes('remote');
const experienceLevel = job.tags?.employment || null;

// DATA-8: simple apply detection — GH only (question count exact); Ashby/Lever schema unverified
const isSimpleApply = questionCount !== null ? questionCount <= SIMPLE_APPLY_THRESHOLD : null;

// DATA-3: education requirement — extracted from required section (fallback: full text)
// DATA-3B: title-based inference when extraction returns null (ENR-45, Path A)
// ENR-DEGREE-2: Also try preferred section and full plainText when required section returns null.
let minDegree = extractMinDegree(text);
let minDegreeSource = minDegree !== null ? 'extracted' : null;
if (minDegree === null && preferred) {
minDegree = extractMinDegree(preferred);
}
if (minDegree === null && text !== plainText) {
minDegree = extractMinDegree(plainText);
}
if (minDegree !== null && minDegreeSource === null) {
minDegreeSource = 'extracted';
}
if (minDegree === null) {
const inferred = inferDegreeFromTitle(job.title);
if (inferred !== null) {
  minDegree = inferred;
  minDegreeSource = 'inferred';
}
}
// DATA-4: experience level from description — extracted with same fallback chain as degree
// ENR-QUALITY-7: Try required section, then preferred section, then full plainText.
let experienceLevelFromDesc = extractExperienceLevel(text);
if (experienceLevelFromDesc === null && preferred) {
  experienceLevelFromDesc = extractExperienceLevel(preferred);
}
if (experienceLevelFromDesc === null && text !== plainText) {
  experienceLevelFromDesc = extractExperienceLevel(plainText);
}

return {
id: job.id,
source: job.source || null,
enricher_version: ENRICHER_VERSION,
required_skills: requiredSkills,
nice_to_have_skills: niceToHaveSkills,
skills_source: skillsSource,
sponsors_visa: sponsorsVisa,
visa_question_present: visaQuestionPresent,
possible_sponsor: possibleSponsor,
visa_no_signal_reason: visaNoSignalReason,
is_remote: isRemote,
experience_level: experienceLevel,
has_description: !!rawDescription,
// DATA-3: education requirement extracted from description text
min_degree: minDegree,
// DATA-3B: source of min_degree — 'extracted' (from description) or 'inferred' (from title)
min_degree_source: minDegreeSource,
// DATA-4: experience level extracted from description text (distinct from tags.employment)
experience_level_from_desc: experienceLevelFromDesc,
// DATA-8: simple apply signal (GH: exact; Ashby/Lever: null pending schema verification)
is_simple_apply: isSimpleApply,
question_count: questionCount,
enriched_at: new Date().toISOString(),
// Denormalized display fields
title: job.title || null,
company_name: job.company_name || null,
job_city: job.job_city || null,
job_state: job.job_state || null,
url: job.url || null,
posted_at: job.posted_at || null,
};
}

async function main() {
console.log('[enrich-jobs] Starting enrichment run');

const termMap = loadTaxonomy();
console.log(`[enrich-jobs] Taxonomy loaded: ${termMap.size} terms`);


const { map: descriptionsMap, enrichedIds: descEnrichedIds } = loadDescriptionsMap();
console.log(`[enrich-jobs] Descriptions loaded: ${descriptionsMap.size} entries (${descEnrichedIds.size} from enriched sidecars)`);

const lcaSponsors = loadLcaSponsors();

const allJobs = loadAllJobs();
console.log(`[enrich-jobs] Total jobs in pool: ${allJobs.length}`);

// DESC-MIGRATE-1: Fetch WD/SR descriptions for tech+US jobs missing from sidecar.
// Active chunk is determined once at run start (not per-append) so a single workflow
// never splits a batch across two files mid-run.
const activeChunkPath = resolveActiveChunk();
console.log(`[enrich-jobs] Active enriched chunk: ${path.basename(activeChunkPath)}`);
await fetchMissingDescriptions(allJobs, descriptionsMap, activeChunkPath);

// SR-STALE: Re-fetch SR descriptions that only exist in source sidecar (pre-C103 fix)
await refreshStaleSrDescriptions(allJobs, descriptionsMap, descEnrichedIds, activeChunkPath);

const processedMap = loadProcessedMap();
const { ids: enrichedIds, latestById } = loadEnrichedIds();
// ENR-SOURCE-2: Current-version exhausted records can become enrichable later when
// a sidecar description arrives after they were exhausted. Microsoft is the known case:
// records exhausted at T0 with has_description=false, then descriptions-microsoft.jsonl
// later gains full text. Rescue them back into the queue instead of waiting for an
// unrelated version bump.
let rescuedExhausted = 0;
for (const job of allJobs) {
const processed = processedMap[job.id];
const latest = latestById.get(job.id);
if (shouldRescueExhaustedRecord(job, descriptionsMap, processed, latest)) {
delete processedMap[job.id];
enrichedIds.delete(job.id);
rescuedExhausted++;
}
}
if (rescuedExhausted > 0) {
console.log(`[enrich-jobs] Rescued ${rescuedExhausted} exhausted records that now have descriptions`);
}
console.log(`[enrich-jobs] Already enriched: ${enrichedIds.size}`);

const pending = allJobs.filter(j => !enrichedIds.has(j.id));
console.log(`[enrich-jobs] Pending enrichment: ${pending.length}`);

// PIPELINE-2: Bulk-mark non-enrichable jobs as processed so they exit the queue permanently.
// Previously these were marked one-at-a-time inside each batch, wasting ~83% of batch capacity
// on jobs that would be skipped. Now we mark them all upfront and only batch enrichable jobs.
const now = new Date().toISOString();
let bulkMarked = 0;
let descWaiting = 0;
for (const job of pending) {
if (!isEnrichable(job, descriptionsMap) && !processedMap[job.id]) {
const domains = job.tags?.domains || [];
const locations = job.tags?.locations || [];
// ENRICH-OBS-2: WD/SR US jobs with no description yet are NOT permanently skipped.
// They stay unprocessed so each run retries them as description sidecars grow.
// TAG-7: expanded from tech+US to ALL US (descriptions needed for classification).
if ((job.source === 'workday' || job.source === 'smartrecruiters') && locations.includes('us')) {
descWaiting++;
continue;
}
const reason = !domains.some(d => TECH_DOMAINS.has(d)) ? 'non-tech' : 'non-us';
processedMap[job.id] = { status: 'skipped', reason, processed_at: now };
bulkMarked++;
}
// ENR-STRUCTURAL-SKIP: Skip structural sources permanently — no description API exists.
// Without this, 461+ Simplify/EF/JSearch records cycle through MAX_RETRIES every version bump,
// clogging the FAST batch and delaying real work (Oracle, SR, WD T1 records).
if (STRUCTURAL_SOURCES.has(job.source) && !processedMap[job.id]) {
processedMap[job.id] = { status: 'skipped', reason: 'structural_no_desc', processed_at: now };
bulkMarked++;
}
}
if (bulkMarked > 0) {
console.log(`[enrich-jobs] Bulk-marked ${bulkMarked} non-enrichable jobs as processed (non-tech or non-US)`);
}
if (descWaiting > 0) {
console.log(`[enrich-jobs] WD/SR jobs waiting for description: ${descWaiting} (will retry each run)`);
}

const enrichablePending = pending.filter(j => isEnrichable(j, descriptionsMap));
// ENR-49: Process newest jobs first — posted_at descending.
// Prevents new jobs from waiting behind stale re-enrichment records.
enrichablePending.sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));
// ENR-41: Count stale-version jobs awaiting re-enrichment
const pendingIds = new Set(pending.map(j => j.id));
let reenrichmentPending = 0;
if (fs.existsSync(ENRICHED_PATH)) {
  const enrichedLines = fs.readFileSync(ENRICHED_PATH, 'utf8').trim().split('\n');
  const seen = new Set();
  for (let i = enrichedLines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(enrichedLines[i]);
      if (seen.has(obj.id)) continue; // dedup: last wins
      seen.add(obj.id);
      if (pendingIds.has(obj.id) && (obj.enricher_version || 0) < ENRICHER_VERSION) {
        reenrichmentPending++;
      }
    } catch (_) {}
  }
}
console.log(`[enrich-jobs] Enrichable pending: ${enrichablePending.length} (re-enrichment: ${reenrichmentPending})`);

// ENRICH-THROUGHPUT-1: Split batch by source type. Fast sources (CPU-only, no HTTP)
// can process 500/run. Slow sources (GH/Ashby/Lever need HTTP per job) stay at 40.
const fastPending = enrichablePending.filter(j => FAST_SOURCES.has(j.source));
const slowPending = enrichablePending.filter(j => !FAST_SOURCES.has(j.source));
const fastBatch = fastPending.slice(0, FAST_BATCH_SIZE);
const slowBatch = slowPending.slice(0, SLOW_BATCH_SIZE);
const batch = [...fastBatch, ...slowBatch];
console.log(`[enrich-jobs] Processing batch: ${fastBatch.length} fast + ${slowBatch.length} slow = ${batch.length} total`);

if (batch.length === 0) {
// Still need to persist the bulk-marked non-enrichable IDs and prune expired ones
const liveIds = new Set(allJobs.map(j => j.id));
for (const id of Object.keys(processedMap)) {
if (!liveIds.has(id)) delete processedMap[id];
}
fs.writeFileSync(PROCESSED_PATH, JSON.stringify(processedMap), 'utf8');
// Prune enriched_jobs.json even with empty batch — removes expired zombie records
// that would otherwise persist indefinitely (records from jobs that left the live pool).
if (fs.existsSync(ENRICHED_PATH)) {
const allEnrichedLines = fs.readFileSync(ENRICHED_PATH, 'utf8').trim().split('\n').filter(Boolean);
const prunedLines = [];
for (const line of allEnrichedLines) {
try {
const obj = JSON.parse(line);
if (liveIds.has(obj.id)) prunedLines.push(line);
} catch (_) {}
}
if (prunedLines.length < allEnrichedLines.length) {
fs.writeFileSync(ENRICHED_PATH, prunedLines.join('\n') + '\n', 'utf8');
console.log(`[enrich-jobs] Pruned ${allEnrichedLines.length - prunedLines.length} expired records (empty batch)`);
}
}
console.log('[enrich-jobs] Nothing to enrich. Exiting.');
return;
}

const enriched = await Promise.all(batch.map(job => enrichJob(job, termMap, descriptionsMap, lcaSponsors)));
// All batch jobs are enrichable (pre-filtered) — no skips expected here
const results = enriched.filter(r => r && !r.skipped);
console.log(`[enrich-jobs] Enriched and appended ${results.length} jobs`);

// Append new enriched results
if (results.length > 0) {
const newLines = results.map(r => JSON.stringify(r)).join('\n') + '\n';
fs.appendFileSync(ENRICHED_PATH, newLines, 'utf8');
}

// Mark enriched batch IDs as processed
// ENR-QUEUE-1: Track retry count for no-result records. After MAX_RETRIES attempts,
// mark as 'exhausted' so they exit the queue instead of consuming batch slots forever.
const liveIds = new Set(allJobs.map(j => j.id));
const resultMap = new Map();
for (const r of results) { if (r && r.id) resultMap.set(r.id, r); }
let retryMarked = 0;
let exhaustedMarked = 0;

for (const job of batch) {
const result = resultMap.get(job.id);
const hasResults = result && (result.required_skills?.length > 0);
if (hasResults) {
processedMap[job.id] = { status: 'enriched', processed_at: now };
} else {
const prev = processedMap[job.id];
// Reset retry counter on version bump — new code may succeed where old didn't
const prevVersion = prev?.enricher_version || 0;
const isVersionBump = prevVersion < ENRICHER_VERSION;
const retryCount = isVersionBump ? 1 : (prev?.retry_count || 0) + 1;
if (retryCount >= MAX_RETRIES) {
processedMap[job.id] = { status: 'exhausted', retry_count: retryCount, enricher_version: ENRICHER_VERSION, processed_at: now };
exhaustedMarked++;
} else {
processedMap[job.id] = { status: 'retry', retry_count: retryCount, enricher_version: ENRICHER_VERSION, processed_at: now };
retryMarked++;
}
}
}
if (retryMarked > 0 || exhaustedMarked > 0) {
console.log(`[enrich-jobs] Retry tracking: ${retryMarked} retry, ${exhaustedMarked} exhausted (max ${MAX_RETRIES})`);
}

// Prune: remove IDs no longer in the live pool (aged out of 14-day window)
for (const id of Object.keys(processedMap)) {
if (!liveIds.has(id)) delete processedMap[id];
}
fs.writeFileSync(PROCESSED_PATH, JSON.stringify(processedMap), 'utf8');
console.log(`[enrich-jobs] processed_ids.json: ${Object.keys(processedMap).length} total (pruned to live pool)`);

// Prune enriched_jobs.json: remove expired IDs + dedup (keep latest per ID).
// RE-ENRICH-1: re-enriched jobs produce a second record — dedup keeps the newer one.
if (fs.existsSync(ENRICHED_PATH)) {
const allEnrichedLines = fs.readFileSync(ENRICHED_PATH, 'utf8').trim().split('\n').filter(Boolean);
// Dedup: last occurrence wins (new records appended at end → latest is last)
const seenIds = new Map(); // id → line index
const prunedLines = [];
for (let i = 0; i < allEnrichedLines.length; i++) {
try {
const obj = JSON.parse(allEnrichedLines[i]);
if (!liveIds.has(obj.id)) continue; // expired
if (seenIds.has(obj.id)) {
// Replace earlier occurrence with this newer one
prunedLines[seenIds.get(obj.id)] = null;
}
seenIds.set(obj.id, prunedLines.length);
prunedLines.push(allEnrichedLines[i]);
} catch (_) {
// drop malformed lines
}
}
const finalLines = prunedLines.filter(Boolean);

if (finalLines.length < allEnrichedLines.length) {
const removed = allEnrichedLines.length - finalLines.length;
fs.writeFileSync(ENRICHED_PATH, finalLines.join('\n') + '\n', 'utf8');
console.log(`[enrich-jobs] Pruned ${removed} records (expired + deduped)`);
}

// Quick stats
const withRequired = results.filter(r => r.required_skills.length > 0).length;
const withVisa = results.filter(r => r.sponsors_visa !== null).length;
const withVisaForm = results.filter(r => r.visa_question_present !== null).length;
console.log(`[enrich-jobs] Stats: ${withRequired}/${results.length} had required skills, ${withVisa}/${results.length} had visa text signal, ${withVisaForm}/${results.length} had visa form signal`);
console.log(`[enrich-jobs] Total enriched (post-prune): ${finalLines.length}`);

// Contract validation: verify enriched output matches schema contract
const CONTRACT_PATH = path.join(__dirname, '..', 'schemas', 'enrichment_contract.json');
if (fs.existsSync(CONTRACT_PATH)) {
  try {
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
    const consumerFields = Object.entries(contract.fields).filter(([, f]) => f.consumer_reads);
    const latestRecords = finalLines.slice(-Math.min(5, finalLines.length)).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    let contractViolations = 0;
    for (const record of latestRecords) {
      for (const [field, def] of consumerFields) {
        if (def.required_since_version && (record.enricher_version || 0) < def.required_since_version) continue;
        if (!(field in record)) {
          console.warn(`[contract] VIOLATION: ${record.id} (v${record.enricher_version}) missing consumer field: ${field}`);
          contractViolations++;
        }
      }
    }
    if (contractViolations > 0) {
      console.warn(`[contract] ${contractViolations} violations found — enrichment output does not match contract`);
    } else {
      console.log(`[contract] Validated ${latestRecords.length} recent records against contract v${contract.version} — OK`);
    }
  } catch (err) {
    console.warn(`[contract] Validation failed: ${err.message}`);
  }
} else {
  console.log('[contract] No contract file found — skipping validation');
}

// Stats → imported from ./enrich/stats
const enrichmentStats = generateStats({ allJobs, finalLines, processedMap, descriptionsMap, DATA_DIR, ENRICHER_VERSION, descWaiting, reenrichmentPending });
}
}
// Export pure functions for testing
module.exports = {
normalizeLcaName,
isPossibleSponsor,
classifyVisaGap,
toPlainText,
splitSections,
matchSkills,
detectVisa,
extractMinDegree,
inferDegreeFromTitle,
extractExperienceLevel,
buildWdDescUrl,
buildSrDescUrl,
shouldRescueExhaustedRecord,
};

if (require.main === module) {
main().catch(err => { console.error('[enrich-jobs] Fatal:', err); process.exit(1); });
}