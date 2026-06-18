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
  buildMetadata,
  isUsTech,
} = require('../publish-descriptions-map');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-desc-map-'));

fs.writeFileSync(path.join(tmp, 'us_jobs.json'), JSON.stringify([
  { id: 'wd-1', description: 'inline desc', tags: { locations: ['us'], domains: ['software'] } },
  { id: 'wd-2', description: 'x'.repeat(80), tags: { locations: ['us'], domains: ['marketing'] } },
  { id: 'wd-3', description: '', tags: { locations: ['us'], domains: ['data_science'] } },
]));
fs.writeFileSync(path.join(tmp, 'jobs-metadata.json'), JSON.stringify({ generated: '2026-06-18T00:00:00.000Z' }));
fs.writeFileSync(path.join(tmp, 'enrichment-stats.json'), JSON.stringify({ generated_at: '2026-06-18T00:01:00.000Z', enricher_version: 86 }));
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

const meta = buildMetadata(tmp, jobs, built.map, built.fromSidecar, built.fromInline);
assert.strictEqual(meta.source_basis, 'us_jobs.json');
assert.strictEqual(meta.board_row_count, 2);
assert.strictEqual(meta.description_entries, 2);
assert.strictEqual(meta.coverage_pct, 100);
assert.strictEqual(meta.source_breakdown.sidecar, 2);
assert.strictEqual(meta.jobs_metadata_generated, '2026-06-18T00:00:00.000Z');
assert.strictEqual(meta.enrichment_stats_generated, '2026-06-18T00:01:00.000Z');
assert.strictEqual(meta.enrichment_version, 86);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('PASS publish descriptions map');
