#!/usr/bin/env node
/**
 * publish-metrics-to-supabase.js
 *
 * Publishes the 8 pipeline metric blobs to the Supabase `pipeline_metrics` table,
 * which analytics-dashboard reads server-side. This REPLACES the non-compliant
 * public raw-GitHub read path (binding R2/private rule; see projects/zjp/DASH_DIRECTION.md).
 *
 * Run after the metric files exist in --data-dir (default .github/data), e.g. as a
 * final step in the metrics/publish workflow. Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 *   node lib/publish-metrics-to-supabase.js [--data-dir PATH] [--dry-run] [--max-bytes N]
 *
 * Design notes:
 *  - posted_jobs.json (~15MB) is too large + unnecessary in full for a dashboard. We publish
 *    a derived SUMMARY (total / last-24h / by-channel / top-referrers) under key 'posted-jobs-summary'
 *    instead of the raw blob. The other 7 blobs are published in full (all < 1MB).
 *  - Upsert via PostgREST: POST .../rest/v1/pipeline_metrics with Prefer: resolution=merge-duplicates.
 */
const fs = require('fs');
const path = require('path');

// --- args ---
const argv = process.argv.slice(2);
const val = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const dataDir = path.resolve(val('data-dir', path.join(process.cwd(), '.github', 'data')));
const dryRun = argv.includes('--dry-run');
const maxBytes = parseInt(val('max-bytes', '1_000_000'), 10); // skip full publish above this; summarize instead

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dryRun && (!URL || !KEY)) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or use --dry-run).');
  process.exit(1);
}

// (key, relative-path, summarizer?) — summarizer(data)=>smaller payload when the file is large
const SOURCES = [
  ['metrics-latest',    'metrics/latest.json'],
  ['jobs-metadata',     'jobs-metadata.json'],
  ['enrichment-stats',  'enrichment-stats.json'],
  ['zjp-metrics',       'zjp-metrics.json'],
  ['general-review',    'general-review.json'],
  ['pipeline-alert',    'pipeline-alert.json'],
  ['daily-stats',       'daily-stats.json'],
  ['posted-jobs',       'posted_jobs.json', summarizePostedJobs],
  // History time-series — JSONL files (one object per line), published in full (<1MB each).
  ['history',           'history.jsonl'],
  ['history-archive',   'history-archive.jsonl'],
  ['enrichment-history','enrichment-history.jsonl'],
  ['traffic-history',   'traffic-history.jsonl'],
  // Canada lane — single aggregate summary blob (plain JSON, ~2KB).
  ['canada-tech-summary', 'canada-tech-summary.json'],
  ['tag-history',      'tag-history.jsonl'],
];

function summarizePostedJobs(data) {
  // posted_jobs.json shape: { jobs: [{ postedToDiscord, channel/..., ... }] } (v2) or array (v1)
  const jobs = Array.isArray(data) ? data : (data.jobs || []);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let last24h = 0;
  const byChannel = {};
  const refCount = {};
  for (const j of jobs) {
    const ts = j.postedToDiscord;
    if (ts && (now - new Date(ts).getTime()) < dayMs) last24h++;
    // channel: try common fields
    const ch = j.channel || j.channelName || (j.discordPosts && Object.keys(j.discordPosts)[0]);
    if (ch) byChannel[ch] = (byChannel[ch] || 0) + 1;
    const ref = j.referrer || j.source || j.referringDomain;
    if (ref) refCount[ref] = (refCount[ref] || 0) + 1;
  }
  const topReferrers = Object.entries(refCount).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, count]) => ({ name, count }));
  return { total: jobs.length, last24h, byChannel, topReferrers, summarizedAt: new Date().toISOString() };
}

function readJson(rel) {
  const fp = path.join(dataDir, rel);
  if (!fs.existsSync(fp)) return { missing: true };
  const raw = fs.readFileSync(fp, 'utf8');
  const bytes = Buffer.byteLength(raw);
  // JSONL: one JSON object per line → parse into an array. Plain .json stays a single blob.
  if (rel.endsWith('.jsonl')) {
    const data = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => JSON.parse(line));
    return { data, bytes };
  }
  return { data: JSON.parse(raw), bytes };
}

async function upsert(key, data) {
  const res = await fetch(`${URL}/rest/v1/pipeline_metrics`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ key, data }),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

(async () => {
  console.log(`publish-metrics-to-supabase — data-dir: ${dataDir}${dryRun ? '  [DRY-RUN]' : ''}`);
  let ok = 0, skip = 0, fail = 0;
  for (const [key, rel, summarizer] of SOURCES) {
    const f = readJson(rel);
    if (f.missing) { console.log(`SKIP  ${key.padEnd(18)} (missing ${rel})`); skip++; continue; }
    let payload = f.data;
    let note = '';
    if (summarizer && f.bytes > maxBytes) {
      payload = summarizer(f.data);
      note = ` (summarized from ${(f.bytes / 1024).toFixed(0)}KB)`;
    } else {
      note = ` (${(f.bytes / 1024).toFixed(0)}KB)`;
    }
    const payloadStr = JSON.stringify(payload);
    if (dryRun) { console.log(`DRY   ${key.padEnd(18)} ${note} → ${payloadStr.length} bytes json`); continue; }
    const r = await upsert(key, payload);
    if (r.ok) { ok++; console.log(`OK    ${key.padEnd(18)} [${r.status}]${note}`); }
    else { fail++; console.log(`FAIL  ${key.padEnd(18)} [${r.status}]${note}  ${r.text.slice(0, 200)}`); }
  }
  console.log(`\n${dryRun ? 'DRY-RUN complete' : 'PUBLISHED'}: ${ok} ok, ${skip} skipped, ${fail} failed`);
  if (fail) process.exit(1);
})();
