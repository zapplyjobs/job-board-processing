#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-sidecars-'));
const repoRoot = path.resolve(__dirname, '..', '..');
const dataDir = path.join(tmp, '.github', 'data');
fs.mkdirSync(dataDir, { recursive: true });

fs.writeFileSync(path.join(dataDir, 'all_jobs.json'), [
  JSON.stringify({ id: 'job-1' }),
  JSON.stringify({ id: 'job-2' }),
].join('\n') + '\n');
fs.writeFileSync(path.join(dataDir, 'processed_ids.json'), JSON.stringify({}));
fs.writeFileSync(path.join(dataDir, 'enriched_jobs.json'), [
  JSON.stringify({ id: 'job-1' }),
  JSON.stringify({ id: 'job-2' }),
].join('\n') + '\n');
fs.writeFileSync(path.join(dataDir, 'descriptions-enriched-1.jsonl'), [
  JSON.stringify({ id: 'job-1', description_text: 'old flat text' }),
  JSON.stringify({ id: 'job-1', description_text: 'new display', extraction_text: 'new extract' }),
  JSON.stringify({ id: 'job-2', description_text: 'only one' }),
].join('\n') + '\n');

execFileSync('node', ['lib/prune-sidecars.js', '--data-dir', dataDir], {
  cwd: repoRoot,
  stdio: 'pipe',
  encoding: 'utf8',
});

const lines = fs.readFileSync(path.join(dataDir, 'descriptions-enriched-1.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
assert.strictEqual(lines.length, 2);
const job1 = lines.find(r => r.id === 'job-1');
assert.strictEqual(job1.description_text, 'new display');
assert.strictEqual(job1.extraction_text, 'new extract');
console.log('PASS prune-sidecars latest structured entry wins');
