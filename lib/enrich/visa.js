// ---------------------------------------------------------------------------
// ENR-ARCH-1: Visa module
// Visa detection, LCA lookup, defense classification, ATS form scraping.
// Extracted from enrich-jobs.js for independent testing and maintainability.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const he = require('he');

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const LCA_ALIASES_PATH = path.join(__dirname, 'lca-aliases.json');

// Defense contractor classification
const DEFENSE_CONTRACTORS = new Set([
  'Northrop Grumman',
  'Moog',
  'MITRE',
  'Noblis',
  'ManTech',
  'Dark Wolf Solutions',
  'Draper',
  'Boeing Aerospace Ops',
  'CPI OpenFox',
  'FLIR',
  'SNC',
]);

function classifyVisaGap(companyName, sponsorsVisa, visaQuestionPresent, possibleSponsor) {
  if (sponsorsVisa !== null || visaQuestionPresent !== null || possibleSponsor !== null) return null;
  if (DEFENSE_CONTRACTORS.has(companyName)) return 'defense_contractor';
  return null;
}

// LCA lookup
const LCA_COMPANY_ALIASES = fs.existsSync(LCA_ALIASES_PATH)
  ? JSON.parse(fs.readFileSync(LCA_ALIASES_PATH, 'utf8'))
  : {};

function normalizeLcaName(name) {
  return name.toLowerCase().trim().replace(/[.,]/g, '').replace(/&/g, 'and').replace(/-/g, ' ');
}

function loadLcaSponsors() {
  const lcaPath = path.join(DATA_DIR, 'lca-sponsors.json');
  if (!fs.existsSync(lcaPath)) {
    console.log('[enrich-jobs] LCA file not found, skipping LCA matching');
    return new Set();
  }
  const raw = JSON.parse(fs.readFileSync(lcaPath, 'utf8'));
  const employers = new Set(raw.employers.map(e => normalizeLcaName(e)));
  console.log(`[enrich-jobs] LCA sponsors loaded: ${employers.size} employers`);
  return employers;
}

function isPossibleSponsor(companyName, lcaSet) {
  if (!companyName || lcaSet.size === 0) return null;
  const norm = normalizeLcaName(companyName);
  if (lcaSet.has(norm)) return true;
  const alias = LCA_COMPANY_ALIASES[companyName];
  if (alias && lcaSet.has(normalizeLcaName(alias))) return true;
  return null;
}

// Visa text detection
const EEO_BOILERPLATE = [
  /equal opportunity employer/i,
  /without regard to race/i,
  /eeo statement/i,
  /disability.{0,40}veteran/i,
  /reasonable accommodation/i,
];

const VISA_NEGATIVE = [
  /\bno\b.{0,30}\bvisa sponsorship\b/i,
  /will not sponsor/i,
  /cannot sponsor/i,
  /unable to sponsor/i,
  /unable to (?:provide|offer).{0,20}(?:u\.?s\.?\s*)?(?:visa\s*)?sponsorship/i,
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
  /u\.?s\.? citizenship (status )?is required/i,
  /u\.?s\.? citizenship is a pre-?requisite/i,
  /non-u\.?s\.? citizens may not be eligible to obtain a security clearance/i,
  /current u\.?s\.? citizenship due to contract requirements/i,
  /u\.?s\.? citizen(?:ship)? is required for all positions with a government clearance/i,
  /applicant must be a u\.?s\.? person.{0,120}(citizen|green card|permanent resident|refugee|asylee)/i,
  /u\.?s\.? person.{0,120}(citizens?|nationals?|green card holders?|permanent residents?|refugees?|asylees?).{0,40}\(required\)/i,
  /\b(?:itar|ear)\b.{0,180}applicant must be a u\.?s\.? person/i,
];

const VISA_POSITIVE = [
  /will (provide|offer|consider) (visa )?sponsorship/i,
  /visa sponsorship (is )?available/i,
  /sponsorship available\.?$/im,
  /^[-•]\s*visa sponsorship\s*$/im,
  /h[\s-]?1[\s-]?b sponsorship/i,
  /open to (visa )?sponsorship/i,
  /able to sponsor/i,
  /sponsorship (for|of) (work )?visa/i,
  /we (do )?sponsor/i,
];

function detectVisa(text) {
  if (!text) return null;
  const filtered = text
    .split(/\n{2,}/)
    .map(p => p
      .split(/(?<=[.!?])\s+/)
      .filter(s => !EEO_BOILERPLATE.some(re => re.test(s)))
      .join(' '))
    .filter(Boolean)
    .join('\n\n');
  const scanStart = Math.floor(filtered.length * 0.6);
  const bottomText = filtered.slice(scanStart);
  const fullText = filtered;

  for (const re of VISA_NEGATIVE) {
    if (re.test(bottomText) || re.test(fullText)) return false;
  }
  for (const re of VISA_POSITIVE) {
    if (re.test(bottomText) || re.test(fullText)) return true;
  }
  return null;
}

// ATS application form visa detection
const GH_VISA_RE = /sponsor|visa/i;
const ASHBY_VISA_RE = /sponsor/i;
const LEVER_VISA_RE = /sponsor/i;
const MICROSOFT_VISA_RE = /sponsorship for an immigration-related employment benefit|work authorization - united states|require the company'?s sponsorship/i;
const FETCH_TIMEOUT_MS = 8000;
const SIMPLE_APPLY_THRESHOLD = 13;

function httpsGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        resolve(httpsGet(res.headers.location));
        return;
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function extractMicrosoftVisaQuestionPresence(html) {
  if (!html) return null;
  return MICROSOFT_VISA_RE.test(he.decode(html)) ? true : false;
}


async function fetchApplicationVisaStatus(job) {
  try {
    if (job.source === 'greenhouse') {
      const m = job.id.match(/^greenhouse-(.+)-(\d+)$/);
      if (!m) return { visaPresent: null, questionCount: null };
      const [, slug, jobId] = m;
      const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?questions=true`;
      const result = await httpsGet(url);
      if (!result || result.status !== 200) return { visaPresent: null, questionCount: null };
      const data = JSON.parse(result.body);
      const questions = data.questions || [];
      return {
        visaPresent: questions.some(q => GH_VISA_RE.test(q.label || '')) ? true : false,
        questionCount: questions.length,
      };
    }

    if (job.source === 'ashby') {
      const applyUrl = job.apply_url;
      if (!applyUrl) return { visaPresent: null, questionCount: null };
      const result = await httpsGet(applyUrl);
      if (!result || result.status !== 200) return { visaPresent: null, questionCount: null };
      const m = result.body.match(/window\.__appData\s*=\s*(\{[\s\S]*?\});\s*\n/);
      if (!m) {
        console.log(`[enrich] Ashby window.__appData not found for ${job.id} — visa check skipped`);
        return { visaPresent: null, questionCount: null };
      }
      const appData = JSON.parse(m[1]);
      const str = JSON.stringify(appData);
      const fieldEntries = appData.posting?.applicationForm?.fieldEntries;
      const questionCount = Array.isArray(fieldEntries) ? fieldEntries.length : null;
      return { visaPresent: ASHBY_VISA_RE.test(str) ? true : false, questionCount };
    }

    if (job.source === 'lever') {
      const applyUrl = job.apply_url;
      if (!applyUrl) return { visaPresent: null, questionCount: null };
      const result = await httpsGet(applyUrl);
      if (!result || result.status !== 200) return { visaPresent: null, questionCount: null };
      const decoded = he.decode(result.body);
      let questionCount = null;
      const fieldsIdx = decoded.indexOf('"fields":[');
      if (fieldsIdx >= 0) {
        let depth = 0, end = null;
        const snippet = decoded.slice(fieldsIdx + '"fields":'.length);
        for (let i = 0; i < snippet.length; i++) {
          if (snippet[i] === '[') depth++;
          else if (snippet[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end) {
          try {
            const fields = JSON.parse(snippet.slice(0, end));
            questionCount = fields.length;
          } catch (_) {}
        }
      }
      return { visaPresent: LEVER_VISA_RE.test(decoded) ? true : false, questionCount };
    }

    if (job.source === 'microsoft') {
      const pageUrl = job.apply_url || job.url;
      if (!pageUrl) return { visaPresent: null, questionCount: null };
      const result = await httpsGet(pageUrl);
      if (!result || result.status !== 200) return { visaPresent: null, questionCount: null };
      return { visaPresent: extractMicrosoftVisaQuestionPresence(result.body), questionCount: null };
    }


    return { visaPresent: null, questionCount: null };
  } catch (_) {
    return { visaPresent: null, questionCount: null };
  }
}

module.exports = {
  normalizeLcaName,
  isPossibleSponsor,
  classifyVisaGap,
  detectVisa,
  loadLcaSponsors,
  fetchApplicationVisaStatus,
  extractMicrosoftVisaQuestionPresence,
  SIMPLE_APPLY_THRESHOLD,
  httpsGet,
};
