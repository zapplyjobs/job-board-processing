#!/usr/bin/env node
// R2-fetch for the Supabase metrics bridge (INF-BRIDGE-1 fix). DEP-FREE (Node built-ins only —
// crypto + fetch; no npm install needed). The bridge read the 16 metric blobs from jobs-data-2026's
// git checkout, but INF-R2-GITCUTOVER-1 untracked them (they now live in R2). This downloads them
// from R2 into the data dir so publish-metrics-to-edge.js reads fresh data. Missing-in-R2 files
// are SKIPPED (the git-present fallback covers those).
// Usage: node scripts/r2-fetch-metrics.js <out-dir>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outDir = process.argv[2] || 'jobs-data-2026/.github/data';
const FILES = [
  'metrics/latest.json', 'jobs-metadata.json', 'enrichment-stats.json', 'zjp-metrics.json',
  'general-review.json', 'pipeline-alert.json', 'daily-stats.json', 'posted_jobs.json',
  'history.jsonl', 'history-archive.jsonl', 'enrichment-history.jsonl', 'traffic-history.jsonl',
  'canada-tech-summary.json', 'tag-history.jsonl', 'bridge-metrics.json', 'bridge-metrics-history.jsonl',
];
const AK = process.env.R2_ACCESS_KEY_ID, SK = process.env.R2_SECRET_ACCESS_KEY;
const EP = process.env.R2_ENDPOINT, BK = process.env.R2_BUCKET_NAME;
if (!AK || !SK || !EP || !BK) { console.error('missing R2 env vars'); process.exit(1); }

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sigKey = (sec, date) => hmac(hmac(hmac(hmac('AWS4' + sec, date), 'auto'), 's3'), 'aws4_request');

async function getR2(key) {
  const host = new URL(EP).host;
  const resource = `/${BK}/${key}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const hdrs = { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate };
  const canonHeaders = Object.keys(hdrs).sort().map(k => `${k}:${hdrs[k]}\n`).join('');
  const signedHeaders = Object.keys(hdrs).sort().join(';');
  const canonReq = `GET\n${resource}\n\n${canonHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const strToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha(canonReq)}`;
  const signature = crypto.createHmac('sha256', sigKey(SK, dateStamp)).update(strToSign).digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(`${EP}${resource}`, { headers: { ...hdrs, authorization: auth } });
  if (!res.ok) throw new Error(`GET ${key} → ${res.status}`);
  return await res.text();
}

(async () => {
  fs.mkdirSync(path.join(outDir, 'metrics'), { recursive: true });
  let ok = 0, skip = 0;
  for (const f of FILES) {
    try {
      const body = await getR2('data/' + f);
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
