// ---------------------------------------------------------------------------
// ENR-ARCH-1: Description fetcher module
// Sidecar loading + WD/SR on-demand description fetching.
// Sidecars now preserve display-safe text separately from extraction text.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const he = require('he');
const { toPlainText, toDisplayText } = require('./text-processing');

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const DESCRIPTIONS_PATH = path.join(DATA_DIR, 'descriptions.jsonl');
const DESC_FETCH_PER_RUN = 500;
const TECH_DESC_FETCH_PER_RUN = 350; // Reserve most of the WD/SR fetch budget for current tech-US jobs; keep the rest for broader US classification support.
const DESC_FETCH_DELAY_MS = 300;
const TECH_DOMAINS = new Set(['software', 'data_science', 'hardware', 'ai']);
const STALE_STRUCTURED_REFRESH_PER_RUN = 300; // Gradually rewrite legacy flat WD/SR sidecars into dual-text structured entries while staying under the normal ENR runtime cap.

// Build WD API URL from job URL
function buildWdDescUrl(jobUrl) {
  if (!jobUrl) return null;
  const classic = jobUrl.match(/^(https:\/\/([^.]+)\.wd\d+\.myworkdayjobs\.com)(?:\/([a-z]{2}-[A-Z]{2}))?\/([^/]+)(\/.*)/);
  if (classic) {
    const careerSlug = classic[4];
    const pathSuffix = classic[5];
    const dupMatch = pathSuffix.match(/^\/([^/]+)(\/.*)/);
    if (dupMatch && dupMatch[1] === careerSlug) {
      return `${classic[1]}/wday/cxs/${classic[2]}/${careerSlug}${dupMatch[2]}`;
    }
    return `${classic[1]}/wday/cxs/${classic[2]}/${careerSlug}${pathSuffix}`;
  }
  const site = jobUrl.match(/^(https:\/\/wd\d+\.myworkdaysite\.com)\/([^/]+)(\/.*)/);
  if (site) return `${site[1]}/wday/cxs/${site[2]}${site[3]}`;
  return null;
}

// Build SR API URL from job ID and company slug
function buildSrDescUrl(jobId, companySlug) {
  const numericId = jobId.split('-').slice(2).join('-');
  return `https://api.smartrecruiters.com/v1/companies/${companySlug}/postings/${numericId}`;
}

// Fast GET for description fetches — shorter timeout, no redirect following
function quickGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-board-bot/1.0)' }
    }, (res) => {
      if (res.statusCode !== 200) { resolve({ status: res.statusCode, body: '' }); return; }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Load per-source description sidecars → Map<id, extraction_text|description_text>
// Also returns:
// - enrichedIds: Set of IDs loaded from enriched sidecars (for stale detection)
// - flatIds: IDs whose sidecar entry predates the dual-text format (no extraction_text)
function loadDescriptionsMap() {
  const map = new Map();
  const enrichedIds = new Set();
  const flatIds = new Set();

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^descriptions-.*\.jsonl$/.test(f))
    .sort((a, b) => {
      const ae = a.includes('-enriched-') ? 1 : 0;
      const be = b.includes('-enriched-') ? 1 : 0;
      return ae - be;
    })
    .map(f => path.join(DATA_DIR, f));

  if (files.length === 0 && fs.existsSync(DESCRIPTIONS_PATH)) {
    files.push(DESCRIPTIONS_PATH);
  }

  for (const filePath of files) {
    const isEnriched = filePath.includes('-enriched-');
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const { id, description_text, extraction_text } = JSON.parse(line);
        if (id) {
          map.set(id, extraction_text || description_text || null);
          if (!extraction_text) flatIds.add(id);
          if (isEnriched) enrichedIds.add(id);
        }
      } catch (_) { /* skip malformed */ }
    }
  }

  return { map, enrichedIds, flatIds };
}

// Failure cache: skip URLs that returned 403/404 for 24h
const DESC_FAIL_CACHE_PATH = path.join(DATA_DIR, 'desc-fetch-failures.json');

function loadFailCache() {
  if (!fs.existsSync(DESC_FAIL_CACHE_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(DESC_FAIL_CACHE_PATH, 'utf8'));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const pruned = {};
    for (const [id, ts] of Object.entries(raw || {})) {
      if (typeof ts === 'number' && ts > cutoff) pruned[id] = ts;
    }
    return pruned;
  } catch {
    return {};
  }
}

function saveFailCache(cache) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const pruned = {};
  for (const [id, ts] of Object.entries(cache)) {
    if (ts > cutoff) pruned[id] = ts;
  }
  fs.writeFileSync(DESC_FAIL_CACHE_PATH, JSON.stringify(pruned), 'utf8');
}

// Determine which enriched chunk to write to
function resolveActiveChunk() {
  const CHUNK_LIMIT_BYTES = 50 * 1024 * 1024;
  let n = 1;
  while (true) {
    const p = path.join(DATA_DIR, `descriptions-enriched-${n}.jsonl`);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    if (size < CHUNK_LIMIT_BYTES) return p;
    n++;
  }
}

function prioritizeMissingDescriptionBatch(pending) {
  const tech = [];
  const nonTech = [];
  for (const job of pending) {
    const domains = job.tags?.domains || [];
    if (domains.some(d => TECH_DOMAINS.has(d))) tech.push(job);
    else nonTech.push(job);
  }
  tech.sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));
  nonTech.sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));
  const techBatch = tech.slice(0, TECH_DESC_FETCH_PER_RUN);
  const remaining = Math.max(0, DESC_FETCH_PER_RUN - techBatch.length);
  const nonTechBatch = nonTech.slice(0, remaining);
  return { batch: [...techBatch, ...nonTechBatch], techCount: techBatch.length, nonTechCount: nonTechBatch.length };
}


async function fetchMissingDescriptions(allJobs, descriptionsMap, activeChunkPath) {
  const failCache = loadFailCache();
  const failCacheSize = Object.keys(failCache).length;

  const pending = allJobs.filter(j => {
    if (j.source !== 'workday' && j.source !== 'smartrecruiters') return false;
    if (descriptionsMap.has(j.id)) return false;
    if (failCache[j.id]) return false;
    const locs = j.tags?.locations || [];
    return locs.includes('us');
  });

  if (pending.length === 0) {
    console.log(`[enrich-jobs] DESC-MIGRATE-1: 0 WD/SR jobs need descriptions (${failCacheSize} in fail cache)`);
  } else {
    const { batch, techCount, nonTechCount } = prioritizeMissingDescriptionBatch(pending);
    console.log(`[enrich-jobs] DESC-MIGRATE-1: ${pending.length} pending (${failCacheSize} skipped via fail cache), fetching ${batch.length} (${techCount} tech-US + ${nonTechCount} other US)...`);
    await fetchBatch(batch, descriptionsMap, activeChunkPath, failCache);
  }

  saveFailCache(failCache);
  return 0;
}

// Fetch a batch of description URLs
async function fetchBatch(batch, descriptionsMap, activeChunkPath, failCache) {
  let fetched = 0;
  const newEntries = [];
  const startTime = Date.now();
  const MAX_FETCH_TIME_MS = 3 * 60 * 1000;

  for (const job of batch) {
    if (Date.now() - startTime > MAX_FETCH_TIME_MS) {
      console.log(`[enrich-jobs] DESC-MIGRATE-1: time limit reached after ${fetched} fetches`);
      break;
    }
    let url, rawHtml;
    if (job.source === 'workday') {
      url = buildWdDescUrl(job.url);
      if (!url) continue;
      const result = await quickGet(url);
      if (!result || result.status !== 200) { failCache[job.id] = Date.now(); continue; }
      try {
        const data = JSON.parse(result.body);
        rawHtml = data?.jobPostingInfo?.jobDescription || null;
      } catch (_) { failCache[job.id] = Date.now(); continue; }
    } else {
      url = buildSrDescUrl(job.id, job.company_slug);
      const result = await quickGet(url);
      if (!result || result.status !== 200) { failCache[job.id] = Date.now(); continue; }
      try {
        const data = JSON.parse(result.body);
        const srSections = data?.jobAd?.sections || {};
        rawHtml = [
          srSections.jobDescription?.text,
          srSections.qualifications?.text,
          srSections.companyDescription?.text,
        ].filter(Boolean).join('\n\n') || null;
      } catch (_) { failCache[job.id] = Date.now(); continue; }
    }

    if (rawHtml) {
      const displayText = toDisplayText(rawHtml);
      const extractionText = toPlainText(rawHtml);
      if (displayText.length > 20) {
        descriptionsMap.set(job.id, extractionText || displayText);
        newEntries.push({ id: job.id, description_text: displayText, extraction_text: extractionText });
        fetched++;
      } else {
        failCache[job.id] = Date.now();
      }
    } else {
      failCache[job.id] = Date.now();
    }

    await new Promise(r => setTimeout(r, DESC_FETCH_DELAY_MS));
  }

  if (newEntries.length > 0) {
    fs.appendFileSync(activeChunkPath,
      newEntries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  console.log(`[enrich-jobs] DESC-MIGRATE-1: fetched ${fetched} descriptions (${Object.keys(failCache).length} in fail cache)`);
  return fetched;
}

// Gradually re-fetch legacy flat WD/SR descriptions that predate the dual-text sidecar format.
// This upgrades already-fetched records to display-safe description_text + extraction_text
// without waiting for them to disappear from the pool and refetch naturally.
function prioritizeStructuredRefreshCandidates(stale, currentEnrichedById = new Map(), limit = STALE_STRUCTURED_REFRESH_PER_RUN) {
  return [...stale]
    .sort((a, b) => {
      const aEnriched = currentEnrichedById.has(a.id) ? 1 : 0;
      const bEnriched = currentEnrichedById.has(b.id) ? 1 : 0;
      if (bEnriched !== aEnriched) return bEnriched - aEnriched;
      return String(b.posted_at || '').localeCompare(String(a.posted_at || ''));
    })
    .slice(0, limit);
}

async function refreshStaleSrDescriptions(allJobs, descriptionsMap, enrichedIds, flatIds, activeChunkPath, currentEnrichedById = new Map()) {
  const failCache = loadFailCache();

  const stale = allJobs.filter(j => {
    if (j.source !== 'smartrecruiters' && j.source !== 'workday') return false;
    if (!flatIds.has(j.id)) return false;
    if (j.source === 'smartrecruiters' && enrichedIds.has(j.id)) return false; // Already has enriched version
    if (failCache[j.id]) return false;
    const locs = j.tags?.locations || [];
    return locs.includes('us');
  });


  if (stale.length === 0) {
    console.log(`[enrich-jobs] DESC-STRUCT: 0 legacy flat WD/SR descriptions remaining`);
    saveFailCache(failCache);
    return 0;
  }

  const batch = prioritizeStructuredRefreshCandidates(stale, currentEnrichedById);
  console.log(`[enrich-jobs] DESC-STRUCT: ${stale.length} legacy flat WD/SR descriptions, refreshing ${batch.length}...`);

  let refreshed = 0;
  const newEntries = [];
  const startTime = Date.now();

  for (const job of batch) {
    if (Date.now() - startTime > 90 * 1000) break; // 90s cap for stale refresh — faster migration, still bounded inside the <4 min ENR runtime rule

    const url = job.source === 'workday'
      ? buildWdDescUrl(job.url)
      : buildSrDescUrl(job.id, job.company_slug);
    if (!url) continue;
    const result = await quickGet(url);
    if (!result || result.status !== 200) { failCache[job.id] = Date.now(); continue; }

    try {
      let rawHtml = null;
      if (job.source === 'workday') {
        const data = JSON.parse(result.body);
        rawHtml = data?.jobPostingInfo?.jobDescription || null;
      } else {
        const data = JSON.parse(result.body);
        const srSections = data?.jobAd?.sections || {};
        rawHtml = [srSections.jobDescription?.text, srSections.qualifications?.text].filter(Boolean).join('\n\n') || null;
      }

      if (rawHtml) {
        const displayText = toDisplayText(rawHtml);
        const extractionText = toPlainText(rawHtml);
        if (displayText.length > 20) {
          descriptionsMap.set(job.id, extractionText || displayText);
          newEntries.push({ id: job.id, description_text: displayText, extraction_text: extractionText });
          enrichedIds.add(job.id);
          flatIds.delete(job.id);
          refreshed++;
        }
      }
    } catch (_) { /* skip */ }

    await new Promise(r => setTimeout(r, DESC_FETCH_DELAY_MS));
  }

  if (newEntries.length > 0) {
    fs.appendFileSync(activeChunkPath,
      newEntries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  saveFailCache(failCache);
  console.log(`[enrich-jobs] DESC-STRUCT: refreshed ${refreshed} descriptions (${stale.length - refreshed} remaining)`);
  return refreshed;
}

module.exports = {
  buildWdDescUrl,
  buildSrDescUrl,
  loadDescriptionsMap,
  resolveActiveChunk,
  fetchMissingDescriptions,
  refreshStaleSrDescriptions,
  prioritizeStructuredRefreshCandidates,
  prioritizeMissingDescriptionBatch,
  quickGet,
  loadFailCache,
  saveFailCache,
};
