#!/usr/bin/env node
// R2-fetch for the Supabase metrics bridge (INF-BRIDGE-1 fix).
// The bridge used to read the 16 metric blobs from jobs-data-2026's git checkout, but
// INF-R2-GITCUTOVER-1 untracked them (they now live in R2). This downloads them from R2 into the
// data dir so publish-metrics-to-edge.js reads fresh data. Missing-in-R2 files are SKIPPED
// (the git-present fallback remains for those).
// Usage: node scripts/r2-fetch-metrics.js <out-dir>
const fs = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const outDir = process.argv[2] || 'jobs-data-2026/.github/data';
// Mirrors the SOURCES list in lib/publish-metrics-to-edge.js.
const FILES = [
  'metrics/latest.json', 'jobs-metadata.json', 'enrichment-stats.json', 'zjp-metrics.json',
  'general-review.json', 'pipeline-alert.json', 'daily-stats.json', 'posted_jobs.json',
  'history.jsonl', 'history-archive.jsonl', 'enrichment-history.jsonl', 'traffic-history.jsonl',
  'canada-tech-summary.json', 'tag-history.jsonl', 'bridge-metrics.json', 'bridge-metrics-history.jsonl',
];

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

(async () => {
  fs.mkdirSync(path.join(outDir, 'metrics'), { recursive: true });
  let ok = 0, skip = 0;
  for (const f of FILES) {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: 'data/' + f }));
      const body = await res.Body.transformToString('utf-8');
      fs.writeFileSync(path.join(outDir, f), body);
      console.log(`R2_FETCHED:${f}`);
      ok++;
    } catch (e) {
      console.log(`SKIP(${f}):${(e.message || '').slice(0, 80)}`);
      skip++;
    }
  }
  console.log(`r2-fetch complete: ${ok} fetched, ${skip} skipped (git fallback covers skipped)`);
  if (ok === 0) { console.error('FAIL: fetched 0 files from R2'); process.exit(1); }
})().catch(e => { console.error('r2-fetch ERROR:', e.message); process.exit(1); });
