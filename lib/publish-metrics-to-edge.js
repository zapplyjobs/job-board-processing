#!/usr/bin/env node
/**
 * publish-metrics-to-edge.js
 *
 * Reads the 8 metric blobs from --data-dir, summarizes posted_jobs, and POSTs them to the
 * Supabase Edge Function (which holds the service key + writes to pipeline_metrics).
 *
 * This is the CI path that keeps the sensitive SUPABASE_SERVICE_ROLE_KEY out of GitHub —
 * GitHub Actions holds ONLY PUBLISH_SECRET. (For local/manual use, publish-metrics-to-supabase.js
 * writes directly with the service key.)
 *
 *   node lib/publish-metrics-to-edge.js --data-dir jobs-data-2026/.github/data
 *   Env: EDGE_FUNCTION_URL, PUBLISH_SECRET
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const di = argv.indexOf('--data-dir');
const dataDir = path.resolve(di >= 0 ? argv[di + 1] : path.join(process.cwd(), '.github', 'data'));
const dryRun = argv.includes('--dry-run');

const URL = process.env.EDGE_FUNCTION_URL;
const SECRET = process.env.PUBLISH_SECRET;
if (!dryRun && (!URL || !SECRET)) {
  console.error('ERROR: EDGE_FUNCTION_URL and PUBLISH_SECRET must be set (or use --dry-run).');
  process.exit(1);
}

const MAX_BYTES = 1_000_000; // summarize blobs above this

const SOURCES = [
  ['metrics-latest', 'metrics/latest.json'],
  ['jobs-metadata', 'jobs-metadata.json'],
  ['enrichment-stats', 'enrichment-stats.json'],
  ['zjp-metrics', 'zjp-metrics.json'],
  ['general-review', 'general-review.json'],
  ['pipeline-alert', 'pipeline-alert.json'],
  ['daily-stats', 'daily-stats.json'],
  ['posted-jobs', 'posted_jobs.json', summarizePostedJobs],
];

function summarizePostedJobs(data) {
  const jobs = Array.isArray(data) ? data : (data.jobs || []);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let last24h = 0;
  const byChannel = {};
  const refCount = {};
  for (const j of jobs) {
    if (j.postedToDiscord && now - new Date(j.postedToDiscord).getTime() < dayMs) last24h++;
    const ch = j.channel || j.channelName || (j.discordPosts && Object.keys(j.discordPosts)[0]);
    if (ch) byChannel[ch] = (byChannel[ch] || 0) + 1;
    const ref = j.referrer || j.source || j.referringDomain;
    if (ref) refCount[ref] = (refCount[ref] || 0) + 1;
  }
  const topReferrers = Object.entries(refCount).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, count]) => ({ name, count }));
  return { total: jobs.length, last24h, byChannel, topReferrers, summarizedAt: new Date().toISOString() };
}

(async () => {
  console.log(`publish-metrics-to-edge — data-dir: ${dataDir}${dryRun ? '  [DRY-RUN]' : ''}`);
  const blobs = {};
  let ok = 0, skip = 0;
  for (const [key, rel, summarizer] of SOURCES) {
    const fp = path.join(dataDir, rel);
    if (!fs.existsSync(fp)) { console.log(`SKIP  ${key.padEnd(18)} (missing ${rel})`); skip++; continue; }
    let data, bytes;
    try { const raw = fs.readFileSync(fp, 'utf8'); data = JSON.parse(raw); bytes = Buffer.byteLength(raw); }
    catch (e) { console.log(`FAIL  ${key.padEnd(18)} (parse: ${e.message})`); continue; }
    let payload = data, note = '';
    if (summarizer && bytes > MAX_BYTES) { payload = summarizer(data); note = ` (summarized from ${(bytes / 1024).toFixed(0)}KB)`; }
    blobs[key] = payload;
    ok++;
    console.log(`${dryRun ? 'DRY' : 'OK'}    ${key.padEnd(18)}${note}`);
  }

  if (dryRun) { console.log(`\nDRY-RUN: ${ok} blobs ready, ${skip} skipped`); return; }

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, blobs }),
  });
  const text = await res.text();
  if (res.ok) { console.log(`\nPUBLISHED via edge: ${ok} blobs → ${text}`); }
  else { console.error(`\nFAILED [${res.status}]: ${text}`); process.exit(1); }
})();
