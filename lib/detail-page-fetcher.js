#!/usr/bin/env node

/**
 * Detail Page Fetcher (AGG-FETCH-10)
 *
 * Fetches Google and Apple job detail pages to extract full qualifications
 * that are missing from listing page descriptions.
 *
 * Batched: 100 Google + 100 Apple per run (~150s total).
 * State: Checks if existing description already contains qualification text.
 *
 * Usage:
 *   node detail-page-fetcher.js --data-dir .github/data
 *   node detail-page-fetcher.js --data-dir .github/data --dry-run
 *   node detail-page-fetcher.js --data-dir .github/data --google-only
 *   node detail-page-fetcher.js --data-dir .github/data --apple-only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const GOOGLE_BATCH = 100;
const APPLE_BATCH = 100;
const GOOGLE_DELAY_MS = 500;
const APPLE_DELAY_MS = 1000;
const HTTP_TIMEOUT = 15000;
const MAX_RUNTIME_MS = 5 * 60 * 1000;

const GOOGLE_BASE_URL = 'https://www.google.com/about/careers/applications/jobs/results/';
const APPLE_BASE_URL = 'https://jobs.apple.com';
const GOOGLE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};
const APPLE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const QUALIFICATION_MARKERS = [
  'minimum qualifications', 'minimum qualification',
  'preferred qualifications', 'preferred qualification',
  'basic qualifications', 'basic qualification',
];

function httpGet(url, options = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: options.headers || {},
      timeout: options.timeout || HTTP_TIMEOUT,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let r = res.headers.location;
        if (r.startsWith('/')) r = `${parsed.protocol}//${parsed.host}${r}`;
        if ((options._redirects || 0) > 5) { resolve(null); return; }
        httpGet(r, { ...options, _redirects: (options._redirects || 0) + 1 }).then(resolve);
        return;
      }
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function extractGoogleQualifications(html) {
  if (!html) return null;
  const t = html.match(/<title>(.*?)<\/title>/);
  if (t && t[1].trim() === 'Jobs search') return null;
  const min = html.match(/Minimum qualifications:<\/h3>\s*<ul>([\s\S]*?)<\/ul>/);
  const pref = html.match(/Preferred qualifications:<\/h3>\s*<ul>([\s\S]*?)<\/ul>/);
  const strip = h => h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n\s*\n/g, '\n').trim();
  const mq = min ? strip(min[1]) : '';
  const pq = pref ? strip(pref[1]) : '';
  return (mq || pq) ? { minimumQualifications: mq, preferredQualifications: pq } : null;
}

function extractAppleQualifications(html) {
  if (!html) return null;
  const m = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\);/s);
  if (!m) return null;
  try {
    const d = JSON.parse(JSON.parse(m[1]));
    const j = d.loaderData?.jobDetails?.jobsData;
    if (!j) return null;
    const mq = (j.minimumQualifications || '').trim();
    const pq = (j.preferredQualifications || '').trim();
    return (mq || pq) ? { minimumQualifications: mq, preferredQualifications: pq } : null;
  } catch (_) { return null; }
}

function buildDesc(existing, q) {
  const p = [];
  if (existing) p.push(existing);
  if (q?.minimumQualifications) p.push('Minimum Qualifications:\n' + q.minimumQualifications);
  if (q?.preferredQualifications) p.push('Preferred Qualifications:\n' + q.preferredQualifications);
  return p.join('\n\n') || null;
}

function hasQuals(d) {
  if (!d) return false;
  const l = d.toLowerCase();
  return QUALIFICATION_MARKERS.some(m => l.includes(m));
}

function loadDescs(dir) {
  const map = new Map();
  for (const f of fs.readdirSync(dir).filter(f => /^descriptions-.*\.jsonl$/.test(f))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)) {
      try { const { id, description_text } = JSON.parse(line); if (id) map.set(id, description_text || null); } catch (_) {}
    }
  }
  return map;
}

function activeChunk(dir) {
  let n = 1;
  while (true) {
    const p = path.join(dir, `descriptions-enriched-${n}.jsonl`);
    if (!fs.existsSync(p) || fs.statSync(p).size < 50*1024*1024) return p;
    n++;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let dataDir = '.github/data', go = false, ao = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i+1]) dataDir = args[++i];
    else if (args[i] === '--google-only') go = true;
    else if (args[i] === '--apple-only') ao = true;
  }
  console.log('[detail-page-fetcher] Starting');
  if (!fs.existsSync(dataDir)) { console.error('No data dir'); process.exit(1); }

  const jobs = fs.readFileSync(path.join(dataDir, 'all_jobs.json'), 'utf8').trim().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  console.log(`[detail-page-fetcher] Jobs: ${jobs.length}`);

  const descs = loadDescs(dataDir);
  console.log(`[detail-page-fetcher] Descriptions: ${descs.size}`);

  const gj = jobs.filter(j => j.source === 'google');
  const aj = jobs.filter(j => j.source === 'apple');
  console.log(`[detail-page-fetcher] Google: ${gj.length}, Apple: ${aj.length}`);

  const need = arr => arr.filter(j => { const d = descs.get(j.id); return d && !hasQuals(d) && (j.source_id || j.id); });
  const gNeed = need(gj), aNeed = need(aj);
  console.log(`[detail-page-fetcher] Need fetch: G=${gNeed.length} A=${aNeed.length}`);

  const t0 = Date.now(), entries = [];
  let gOk = 0, gFail = 0, aOk = 0, aFail = 0;

  if (!ao && gNeed.length) {
    const batch = gNeed.slice(0, GOOGLE_BATCH);
    console.log(`[detail-page-fetcher] Google: ${batch.length} pages`);
    for (const j of batch) {
      if (Date.now()-t0 > MAX_RUNTIME_MS) { console.log('[detail-page-fetcher] Time limit'); break; }
      const id = j.source_id || (j.id||'').replace('google-','');
      try {
        const r = await httpGet(`${GOOGLE_BASE_URL}${id}`, { headers: GOOGLE_HEADERS });
        const q = r ? extractGoogleQualifications(r.body) : null;
        if (q) { const f = buildDesc(descs.get(j.id)||'', q); if (f && f !== descs.get(j.id)) { entries.push({id:j.id,description_text:f}); gOk++; } else gFail++; }
        else gFail++;
      } catch { gFail++; }
      await new Promise(r => setTimeout(r, GOOGLE_DELAY_MS));
    }
    console.log(`[detail-page-fetcher] Google: ${gOk}/${batch.length}`);
  }

  if (!go && aNeed.length) {
    const batch = aNeed.slice(0, APPLE_BATCH);
    console.log(`[detail-page-fetcher] Apple: ${batch.length} pages`);
    for (const j of batch) {
      if (Date.now()-t0 > MAX_RUNTIME_MS) { console.log('[detail-page-fetcher] Time limit'); break; }
      const pid = j.source_id || (j.id||'').replace('apple-','');
      const url = (j.url && j.url.includes('/details/')) ? j.url : `${APPLE_BASE_URL}/en-us/details/${pid}`;
      try {
        const r = await httpGet(url, { headers: APPLE_HEADERS });
        const q = r ? extractAppleQualifications(r.body) : null;
        if (q) { const f = buildDesc(descs.get(j.id)||'', q); if (f && f !== descs.get(j.id)) { entries.push({id:j.id,description_text:f}); aOk++; } else aFail++; }
        else aFail++;
      } catch { aFail++; }
      await new Promise(r => setTimeout(r, APPLE_DELAY_MS));
    }
    console.log(`[detail-page-fetcher] Apple: ${aOk}/${batch.length}`);
  }

  if (entries.length) {
    const chunk = activeChunk(dataDir);
    console.log(`[detail-page-fetcher] Writing ${entries.length} to ${path.basename(chunk)}`);
    fs.appendFileSync(chunk, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  console.log(`[detail-page-fetcher] Done ${((Date.now()-t0)/1000).toFixed(1)}s: ${gOk}G+${aOk}A=${entries.length} total, remaining ${Math.max(0,gNeed.length-GOOGLE_BATCH)}G ${Math.max(0,aNeed.length-APPLE_BATCH)}A`);
}

main().catch(e => { console.error('[detail-page-fetcher]', e.message); process.exit(1); });
