#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseJsonOrNdjsonRecords, loadJobs, needsDetailFetch } = require('../detail-page-fetcher');

const arrayRows = [
  { id: 'apple-1', source: 'apple' },
  { id: 'google-1', source: 'google' },
];
const ndjsonRows = [
  { id: 'apple-2', source: 'apple' },
  { id: 'oracle-1', source: 'oracle' },
];

assert.deepStrictEqual(parseJsonOrNdjsonRecords(JSON.stringify(arrayRows)), arrayRows);
assert.deepStrictEqual(
  parseJsonOrNdjsonRecords(ndjsonRows.map(row => JSON.stringify(row)).join('\n') + '\n'),
  ndjsonRows
);
assert.deepStrictEqual(parseJsonOrNdjsonRecords(''), []);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-page-fetcher-'));
const descs = new Map([
  ['apple-rich', 'Minimum Qualifications:\\n5 years of C++ experience'],
  ['apple-thin', 'Short listing copy'],
]);
assert.strictEqual(needsDetailFetch({ id: 'apple-missing', source_id: '2001' }, descs), true);
assert.strictEqual(needsDetailFetch({ id: 'apple-thin', source_id: '2002' }, descs), true);
assert.strictEqual(needsDetailFetch({ id: 'apple-rich', source_id: '2003' }, descs), false);
assert.strictEqual(needsDetailFetch({ title: 'missing identifiers' }, descs), false);

fs.writeFileSync(path.join(tmp, 'all_jobs.json'), JSON.stringify(arrayRows));
assert.deepStrictEqual(loadJobs(tmp), arrayRows);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('PASS detail-page-fetcher parses JSON array and NDJSON jobs');
