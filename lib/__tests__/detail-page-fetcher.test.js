#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseJsonOrNdjsonRecords, loadJobs } = require('../detail-page-fetcher');

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
fs.writeFileSync(path.join(tmp, 'all_jobs.json'), JSON.stringify(arrayRows));
assert.deepStrictEqual(loadJobs(tmp), arrayRows);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('PASS detail-page-fetcher parses JSON array and NDJSON jobs');
