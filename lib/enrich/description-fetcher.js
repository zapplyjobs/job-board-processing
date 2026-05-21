// ---------------------------------------------------------------------------
// ENR-ARCH-1: Description fetcher module
// Sidecar loading + WD/SR on-demand description fetching.
// Extracted from enrich-jobs.js for independent testing and maintainability.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const he = require('he');

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const DESCRIPTIONS_PATH = path.join(DATA_DIR, 'descriptions.jsonl');
const DESC_FETCH_PER_RUN = 500;
const DESC_FETCH_DELAY_MS = 300;

// Build WD API URL from job URL
function buildWdDescUrl(jobUrl) {
  const m = jobUrl.match(/^(https:\/\/([^.]+)\.wd\d+\.myworkdayjobs\.com)\/([^/]+)(\/.*)/);
  if (!m) return null;
  return `${m[1]}/wday/cxs/${m[2]}/${m[3]}${m[4]}`;
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

// Load per-source description sidecars → Map<id, description_text>
function loadDescriptionsMap() {
  const map = new Map();

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
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const { id, description_text } = JSON.parse(line);
        if (id) map.set(id, description_text || null);
      } catch (_) { /* skip malformed */ }
    }
  }

  return map;
}

// Failure cache: skip URLs that returned 403/404 for 24h
const DESC_FAIL_CACHE_PATH = path.join(DATA_DIR, 'desc-fetch-failures.json');

function loadFailCache() {
  if (!fs.existsSync(DESC_FAIL_CACHE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(DESC_FAIL_CACHE_PATH, 'utf8')); } catch { return {}; }
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
    saveFailCache(failCache);
    return 0;
  }

  const batch = pending.slice(0, DESC_FETCH_PER_RUN);
  console.log(`[enrich-jobs] DESC-MIGRATE-1: ${pending.length} pending (${failCacheSize} skipped via fail cache), fetching ${batch.length}...`);

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
        rawHtml = [srSections.jobDescription?.text, srSections.qualifications?.text].filter(Boolean).join('\n\n') || null;
      } catch (_) { failCache[job.id] = Date.now(); continue; }
    }

    if (rawHtml) {
      const text = he.decode(he.decode(rawHtml)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 20) {
        descriptionsMap.set(job.id, text);
        newEntries.push({ id: job.id, description_text: text });
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

  saveFailCache(failCache);
  console.log(`[enrich-jobs] DESC-MIGRATE-1: fetched ${fetched} descriptions (${Object.keys(failCache).length} in fail cache, skip for 24h)`);
  return fetched;
}

module.exports = {
  buildWdDescUrl,
  buildSrDescUrl,
  loadDescriptionsMap,
  resolveActiveChunk,
  fetchMissingDescriptions,
  quickGet,
  loadFailCache,
  saveFailCache,
};
