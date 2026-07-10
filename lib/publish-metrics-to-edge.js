#!/usr/bin/env node
/**
 * publish-metrics-to-edge.js
 *
 * Reads the 8 metric blobs from --data-dir, summarizes posted_jobs, and POSTs them to the
 * Supabase Edge Function (named "publish-metrics-function"), which holds the service key and
 * writes to pipeline_metrics.
 *
 * SECURITY: GitHub Actions holds ONLY PUBLISH_SECRET (lightweight). The sensitive
 * SUPABASE_SERVICE_ROLE_KEY stays in the Supabase function's secret store. We send the PUBLIC
 * anon key in the Authorization header only to satisfy Supabase's default Edge Function JWT
 * gate — the function still rejects callers without the correct PUBLISH_SECRET in the body.
 * (For local/manual use, publish-metrics-to-supabase.js writes directly with the service key.)
 *
 *   node lib/publish-metrics-to-edge.js --data-dir jobs-data-2026/.github/data
 *   Env: EDGE_FUNCTION_URL, PUBLISH_SECRET
 */
const fs = require('fs');
const path = require('path');

// Public anon key (role:anon, RLS-restricted) — safe to commit; only passes Supabase's JWT gate.
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4bWhnYWdwYnhqZmxham9hYWh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTEyMzAzODEsImV4cCI6MjA2NjgwNjM4MX0.duvIX0qo207ZCn54UhtFwFLAWPdvHwwNgl9BN8GfZKE';

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
  ['history', 'history.jsonl'],
  ['history-archive', 'history-archive.jsonl'],
  ['enrichment-history', 'enrichment-history.jsonl'],
  ['traffic-history', 'traffic-history.jsonl'],
  // Canada lane — single aggregate summary blob (plain JSON, ~2KB).
  ['canada-tech-summary', 'canada-tech-summary.json'],
  ['tag-history',      'tag-history.jsonl'],
  ['bridge-metrics', 'bridge-metrics.json'],
  ['bridge-metrics-history', 'bridge-metrics-history.jsonl'],
];

function summarizePostedJobs(data) {
  const jobs = Array.isArray(data) ? data : (data.jobs || []);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let last24h = 0;
  const byChannel = {};
  const refCount = {};
  const dayBuckets = {}; // postsPerDay (last 30d)
  for (const j of jobs) {
    if (j.postedToDiscord && now - new Date(j.postedToDiscord).getTime() < dayMs) last24h++;
    const ch = j.channel || j.channelName || (j.discordPosts && Object.keys(j.discordPosts)[0]);
    if (ch) byChannel[ch] = (byChannel[ch] || 0) + 1;
    const ref = j.referrer || j.source || j.referringDomain;
    if (ref) refCount[ref] = (refCount[ref] || 0) + 1;
    // Bucket by day for the posts-per-day series (last 30d)
    if (j.postedToDiscord) {
      const day = j.postedToDiscord.slice(0, 10); // YYYY-MM-DD
      const ageDays = (now - new Date(j.postedToDiscord).getTime()) / dayMs;
      if (ageDays < 30) dayBuckets[day] = (dayBuckets[day] || 0) + 1;
    }
  }
  const topReferrers = Object.entries(refCount).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, count]) => ({ name, count }));
  // Recent jobs: last 50 by postedToDiscord, trimmed fields for the OUT searchable table
  const recentJobs = jobs
    .filter((j) => j.postedToDiscord)
    .sort((a, b) => new Date(b.postedToDiscord) - new Date(a.postedToDiscord))
    .slice(0, 50)
    .map((j) => ({
      company: j.company || '—',
      title: (j.title || '—').slice(0, 80),
      source: j.source || j.referrer || j.referringDomain || '—',
      channel: j.channel || j.channelName || (j.discordPosts && Object.keys(j.discordPosts)[0]) || '—',
      postedAt: j.postedToDiscord,
    }));
  // Posts per day: sorted ascending by date (last 30d)
  const postsPerDay = Object.entries(dayBuckets)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { total: jobs.length, last24h, byChannel, topReferrers, recentJobs, postsPerDay, summarizedAt: new Date().toISOString() };
}
// Default summarizer for blobs > MAX_BYTES that have no specific summarizer (INF-BRIDGE-1):
// large append-only history blobs (tag-history 13MB, history, history-archive) shouldn't be
// written full to a metrics JSONB row — it blows past Supabase's statement_timeout. Keep a
// compact summary (count + latest + recent 10) so the dashboard still has recent history context.
function defaultSummarize(data, rel, bytes) {
  const arr = Array.isArray(data) ? data : [data];
  return { _summarized: true, source: rel, count: arr.length, sizeBytes: bytes, latest: arr[arr.length - 1] || null, recent: arr.slice(-10), summarizedAt: new Date().toISOString() };
}

(async () => {
  console.log(`publish-metrics-to-edge — data-dir: ${dataDir}${dryRun ? '  [DRY-RUN]' : ''}`);
  const blobs = {};
  let ok = 0, skip = 0;
  for (const [key, rel, summarizer] of SOURCES) {
    const fp = path.join(dataDir, rel);
    if (!fs.existsSync(fp)) { console.log(`SKIP  ${key.padEnd(18)} (missing ${rel})`); skip++; continue; }
    let data, bytes;
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      bytes = Buffer.byteLength(raw);
      // JSONL: one JSON object per line → array. Plain .json stays a single blob.
      data = rel.endsWith('.jsonl')
        ? raw.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => JSON.parse(line))
        : JSON.parse(raw);
    }
    catch (e) { console.log(`FAIL  ${key.padEnd(18)} (parse: ${e.message})`); continue; }
    let payload = data, note = '';
    if (bytes > MAX_BYTES) {
      if (summarizer) { payload = summarizer(data); note = ` (summarized from ${(bytes / 1024).toFixed(0)}KB)`; }
      else { payload = defaultSummarize(data, rel, bytes); note = ` (auto-summarized from ${(bytes / 1024).toFixed(0)}KB)`; }
    }
    blobs[key] = payload;
    ok++;
    console.log(`${dryRun ? 'DRY' : 'OK'}    ${key.padEnd(18)}${note}`);
  }

  if (dryRun) { console.log(`\nDRY-RUN: ${ok} blobs ready, ${skip} skipped`); return; }

  // INF-BRIDGE-1: POST in small batches (4 blobs each) instead of one big POST. The Edge Function
  // does ONE upsert per call; a single 16-row upsert (incl. tag-history 13MB + the growing history
  // blobs) exceeds Supabase's statement_timeout. Batching keeps each upsert small + fast. Idempotent
  // (onConflict:key) so partial-then-retry is safe.
  const entries = Object.entries(blobs);
  const BATCH = 4;
  const nBatches = Math.ceil(entries.length / BATCH);
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = Object.fromEntries(entries.slice(i, i + BATCH));
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ secret: SECRET, blobs: chunk }),
    });
    const text = await res.text();
    if (!res.ok) { console.error(`\nFAILED [${res.status}] (batch ${Math.floor(i / BATCH) + 1}/${nBatches}): ${text}`); process.exit(1); }
    console.log(`PUBLISHED batch ${Math.floor(i / BATCH) + 1}/${nBatches}: ${Object.keys(chunk).length} blobs → ${text}`);
  }
  console.log(`\nDONE: ${ok} blobs in ${nBatches} batches`);
})();
