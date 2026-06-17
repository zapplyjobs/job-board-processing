#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  chooseBoardJobs,
  loadDescriptionsMap,
  buildDescriptionsMap,
  isUsTech,
} = require('../publish-descriptions-map');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-desc-map-'));

fs.writeFileSync(path.join(tmp, 'us_jobs.json'), JSON.stringify([
  { id: 'wd-1', description: 'inline desc', tags: { locations: ['us'], domains: ['software'] } },
  { id: 'wd-2', description: 'x'.repeat(80), tags: { locations: ['us'], domains: ['marketing'] } },
  { id: 'wd-3', description: '', tags: { locations: ['us'], domains: ['data_science'] } },
]));
fs.writeFileSync(path.join(tmp, 'descriptions-workday.jsonl'), [
  JSON.stringify({ id: 'wd-1', description_text: 'y'.repeat(90) }),
  JSON.stringify({ id: 'wd-3', description_text: 'z'.repeat(120) }),
].join('\n') + '\n');

const jobs = chooseBoardJobs(tmp);
assert.deepStrictEqual(jobs.map(j => j.id).sort(), ['wd-1', 'wd-3']);
assert.strictEqual(isUsTech(jobs[0]), true);

const descs = loadDescriptionsMap(tmp);
const built = buildDescriptionsMap(jobs, descs);
assert.deepStrictEqual(Object.keys(built.map).sort(), ['wd-1', 'wd-3']);
assert.strictEqual(built.fromSidecar, 2);
assert.strictEqual(built.fromInline, 0);
assert.strictEqual(built.map['wd-1'].length, 90);
assert.strictEqual(built.map['wd-3'].length, 120);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('PASS publish descriptions map');
