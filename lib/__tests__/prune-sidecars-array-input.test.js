#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-sidecars-array-'));
const dataDir = path.join(tmp, '.github', 'data');
fs.mkdirSync(dataDir, { recursive: true });

fs.writeFileSync(path.join(dataDir, 'all_jobs.json'), JSON.stringify([
  { id: 'microsoft-active', source: 'microsoft' },
]));
fs.writeFileSync(path.join(dataDir, 'processed_ids.json'), JSON.stringify({}));
fs.writeFileSync(path.join(dataDir, 'enriched_jobs.json'), JSON.stringify([
  { id: 'microsoft-enriched-only', source: 'microsoft' },
]));
fs.writeFileSync(path.join(dataDir, 'descriptions-microsoft.jsonl'), [
  JSON.stringify({ id: 'microsoft-active', description_text: 'active all_jobs description' }),
  JSON.stringify({ id: 'microsoft-enriched-only', description_text: 'active enriched description' }),
  JSON.stringify({ id: 'microsoft-stale', description_text: 'stale description' }),
].join('\n') + '\n');

execFileSync('node', ['lib/prune-sidecars.js', '--data-dir', dataDir], {
  cwd: repoRoot,
  stdio: 'pipe',
  encoding: 'utf8',
});

const rows = fs.readFileSync(path.join(dataDir, 'descriptions-microsoft.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(JSON.parse);

assert.deepStrictEqual(rows.map(row => row.id).sort(), [
  'microsoft-active',
  'microsoft-enriched-only',
]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('PASS prune-sidecars keeps array-format active IDs');
