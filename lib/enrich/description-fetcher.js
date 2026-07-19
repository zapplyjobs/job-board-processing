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
const { CHUNK_LIMIT_BYTES } = require('../sidecar-standard'); // ENR-SIDECAR-STANDARD-1: singular 40MB standard

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const DESCRIPTIONS_PATH = path.join(DATA_DIR, 'descriptions.jsonl');
const DESC_FETCH_PER_RUN = 500;
const TECH_DESC_FETCH_PER_RUN = 350; // Reserve most of the WD/SR fetch budget for current tech-US jobs; keep the rest for broader US classification support.
const DESC_FETCH_DELAY_MS = 300;
const TECH_DOMAINS = new Set(['software', 'data_science', 'hardware', 'ai']);
const STALE_STRUCTURED_REFRESH_PER_RUN = 200; // Gradually rewrite legacy flat WD/SR sidecars into dual-text structured entries while preserving the normal ENR runtime target.
const STALE_CONTENT_AGE_MS = 30 * 24 * 60 * 60 * 1000; // D1 (C181): re-fetch on-demand WD/SR descriptions whose stored copy may be stale (posting changed)
const STALE_CONTENT_REFRESH_PER_RUN = 100; // D1: bounded catch-up so the first wave over timestamp-less legacy records stays gradual

// ENR-WORKDAY-SLA-1 (2026-07-18): myworkdaysite.com path-based tenant map.
// The path component after the domain (e.g. "snap") is the public CAREER SLUG, not the
// internal Workday tenant name. The WD cloud API at /wday/cxs/{tenant}/{career_slug}/...
// requires the internal tenant name (e.g. "snapchat" for Snap). Without this map, the
// API returns HTTP 422 and jobs enter failCache permanently — looking like queue starvation.
// Restored from S245 (lost during refactor). Add new entries here as new myworkdaysite.com
// tenants appear in the pool.
const MYWORKDAYSITE_TENANTS = { snap: 'snapchat' };

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
  if (site) {
    // ENR-WORKDAY-SLA-1: career slug != WD tenant name for myworkdaysite.com. Map career slug
    // to internal tenant; unknown tenants fall back to using the slug itself (will 422, failCache).
    const tenant = MYWORKDAYSITE_TENANTS[site[2]] || site[2];
    return `${site[1]}/wday/cxs/${tenant}/${site[2]}${site[3]}`;
  }
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
  const staleByAgeIds = new Set();
  const staleCutoff = Date.now() - STALE_CONTENT_AGE_MS; // D1 (C181): content-staleness cutoff

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^descriptions-.*\.jsonl$/.test(f))
    .sort((a, b) => {
      // ENR-SIDECAR-STANDARD-1: deterministic merge order (was FS-dependent readdirSync).
      // Non-enriched files load before enriched; within each group the order is pinned
      // (enriched = chunk-index ascending, non-enriched = alphabetical) so map.set last-wins
      // is reproducible. On an id collision the HIGHEST enriched chunk index wins.
      const ae = a.includes('-enriched-') ? 1 : 0;
      const be = b.includes('-enriched-') ? 1 : 0;
      if (ae !== be) return ae - be;
      if (ae === 1) {
        const na = parseInt((a.match(/-enriched-(\d+)\.jsonl$/) || [])[1] || '0', 10);
        const nb = parseInt((b.match(/-enriched-(\d+)\.jsonl$/) || [])[1] || '0', 10);
        return na - nb;
      }
      return a.localeCompare(b);
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
        const { id, description_text, extraction_text, fetched_at } = JSON.parse(line);
        if (id) {
          map.set(id, extraction_text || description_text || null);
          if (!extraction_text) flatIds.add(id);
          if (isEnriched) enrichedIds.add(id);
          // D1 (C181): entries with no freshness signal (legacy) or older than the cutoff are
          // content-stale candidates, so changed postings (e.g. added export-control language)
          // get re-fetched instead of silently driving visa/degree misses.
          if (!fetched_at || Number(fetched_at) < staleCutoff) staleByAgeIds.add(id);
        }
      } catch (_) { /* skip malformed */ }
    }
  }

  return { map, enrichedIds, flatIds, staleByAgeIds };
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

// ENR-DESCCACHE-OBSERVABILITY-1 (2026-07-19): failCache was runner-local ephemeral — each fresh
// runner started with empty cache, populating it during the run, then discarding on teardown.
// Snap-class bugs (silent 422 failCaching) went invisible for months. Sync to R2 so the cache
// persists across runs AND is observable.
let _r2Client = null;
function getR2Client() {
  if (!_r2Client) {
    try { _r2Client = require('../storage/r2-client').createR2Client({ prefix: 'data/' }); }
    catch { _r2Client = false; }  // false = unavailable (e.g. local dev without R2 creds)
  }
  return _r2Client || null;
}

const DESC_FAIL_CACHE_R2_KEY = 'desc-fetch-failures.json';

// Pull R2 copy + merge with local (newest timestamp wins per id). Prunes >24h on merge.
async function syncFailCacheFromR2() {
  const r2 = getR2Client();
  if (!r2) return;
  try {
    const remote = await r2.downloadJson(DESC_FAIL_CACHE_R2_KEY);
    if (!remote) return;
    const local = loadFailCache();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const merged = {};
    for (const [id, ts] of Object.entries({ ...remote, ...local })) {
      if (typeof ts === 'number' && ts > cutoff) merged[id] = ts;
    }
    fs.writeFileSync(DESC_FAIL_CACHE_PATH, JSON.stringify(merged), 'utf8');
    console.log(`[enrich-jobs] FAILCACHE-SYNC: downloaded ${Object.keys(remote).length} entries from R2, merged to ${Object.keys(merged).length} local`);
  } catch (err) {
    console.error(`[enrich-jobs] FAILCACHE-SYNC: R2 download failed (non-blocking): ${err.message}`);
  }
}

// Upload current local failCache to R2 (so next run + monitoring can see it).
async function syncFailCacheToR2() {
  const r2 = getR2Client();
  if (!r2) return;
  try {
    const local = loadFailCache();
    const size = Object.keys(local).length;
    await r2.uploadRaw(DESC_FAIL_CACHE_R2_KEY, JSON.stringify(local), 'application/json');
    console.log(`[enrich-jobs] FAILCACHE-SYNC: uploaded ${size} entries to R2`);
  } catch (err) {
    console.error(`[enrich-jobs] FAILCACHE-SYNC: R2 upload failed (non-blocking): ${err.message}`);
  }
}

// Determine which enriched chunk to write to
function resolveActiveChunk() {
  let n = 1;
  while (true) {
    const p = path.join(DATA_DIR, `descriptions-enriched-${n}.jsonl`);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    if (size < CHUNK_LIMIT_BYTES) return p;
    n++;
  }
}

function prioritizeMissingDescriptionBatch(pending, enrichedIds = new Set()) {
  const tech = [];
  const nonTech = [];
  for (const job of pending) {
    const domains = job.tags?.domains || [];
    if (domains.some(d => TECH_DOMAINS.has(d))) tech.push(job);
    else nonTech.push(job);
  }
  // ENR-DESCRETRIEVE-1: recovery first. A job already enriched (in enriched_jobs.json) whose
  // retrievable description text was lost is a user-visible degraded listing, so it outranks a
  // never-fetched new arrival for the limited per-run fetch budget. Within each group, newest first.
  const recoveryFirst = (a, b) => {
    const aRec = enrichedIds.has(a.id) ? 1 : 0;
    const bRec = enrichedIds.has(b.id) ? 1 : 0;
    if (aRec !== bRec) return bRec - aRec;
    return String(b.posted_at || '').localeCompare(String(a.posted_at || ''));
  };
  tech.sort(recoveryFirst);
  nonTech.sort(recoveryFirst);
  const techBatch = tech.slice(0, TECH_DESC_FETCH_PER_RUN);
  const remaining = Math.max(0, DESC_FETCH_PER_RUN - techBatch.length);
  const nonTechBatch = nonTech.slice(0, remaining);
  return { batch: [...techBatch, ...nonTechBatch], techCount: techBatch.length, nonTechCount: nonTechBatch.length };
}


async function fetchMissingDescriptions(allJobs, descriptionsMap, activeChunkPath, enrichedIds = new Set()) {
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
    const { batch, techCount, nonTechCount } = prioritizeMissingDescriptionBatch(pending, enrichedIds);
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
        newEntries.push({ id: job.id, description_text: displayText, extraction_text: extractionText, fetched_at: Date.now() });
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
    if (Date.now() - startTime > 60 * 1000) break; // 60s cap for stale refresh — keeps migration moving while restoring the normal <4 min ENR runtime target

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
          newEntries.push({ id: job.id, description_text: displayText, extraction_text: extractionText, fetched_at: Date.now() });
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

// D1 (C181): Re-fetch WD/SR on-demand descriptions whose stored copy may be content-stale
// (no fetched_at, or fetched_at older than STALE_CONTENT_AGE_MS). Unlike refreshStaleSrDescriptions
// (which upgrades legacy flat-FORMAT entries), this catches postings whose CONTENT changed after
// the original fetch (e.g. an eligibility/export-control sentence added later — the FLIR class).
// Bounded per run to keep HTTP volume gradual during the one-time catch-up of timestamp-less records.
async function refreshStaleContentDescriptions(allJobs, descriptionsMap, staleByAgeIds, activeChunkPath, currentEnrichedById = new Map()) {
  const failCache = loadFailCache();
  const candidates = allJobs.filter(j => {
    if (j.source !== 'workday' && j.source !== 'smartrecruiters') return false;
    if (!staleByAgeIds.has(j.id)) return false;
    if (failCache[j.id]) return false;
    const locs = j.tags?.locations || [];
    return locs.includes('us');
  });

  if (candidates.length === 0) {
    console.log(`[enrich-jobs] DESC-STALE: 0 WD/SR descriptions are stale-by-age`);
    saveFailCache(failCache);
    return 0;
  }

  const batch = prioritizeStructuredRefreshCandidates(candidates, currentEnrichedById, STALE_CONTENT_REFRESH_PER_RUN);
  console.log(`[enrich-jobs] DESC-STALE: ${candidates.length} WD/SR descriptions stale-by-age, refreshing ${batch.length}...`);

  let refreshed = 0;
  const newEntries = [];
  const startTime = Date.now();

  for (const job of batch) {
    if (Date.now() - startTime > 60 * 1000) break; // 60s cap — keeps the refresh gradual within the ENR runtime target

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
          newEntries.push({ id: job.id, description_text: displayText, extraction_text: extractionText, fetched_at: Date.now() });
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
  console.log(`[enrich-jobs] DESC-STALE: refreshed ${refreshed} stale descriptions (${candidates.length - refreshed} remaining)`);
  return refreshed;
}

module.exports = {
  buildWdDescUrl,
  buildSrDescUrl,
  loadDescriptionsMap,
  resolveActiveChunk,
  fetchMissingDescriptions,
  refreshStaleSrDescriptions,
  refreshStaleContentDescriptions,
  prioritizeStructuredRefreshCandidates,
  prioritizeMissingDescriptionBatch,
  quickGet,
  loadFailCache,
  saveFailCache,
  syncFailCacheFromR2,
  syncFailCacheToR2,
};
