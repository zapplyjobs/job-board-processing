#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateStats } = require('../enrich/stats');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'enr-stats-'));
}

const DATA_DIR = tempDir();

const allJobs = [
  { id: 'job-text', source: 'workday', company_name: 'A', tags: { domains: ['software'], locations: ['us'] } },
  { id: 'job-form-lca', source: 'workday', company_name: 'B', tags: { domains: ['software'], locations: ['us'] } },
  { id: 'job-lca-only', source: 'workday', company_name: 'C', tags: { domains: ['software'], locations: ['us'] } },
  { id: 'job-none', source: 'workday', company_name: 'D', tags: { domains: ['software'], locations: ['us'] } },
];

const finalLines = [
  JSON.stringify({ id: 'job-text', source: 'workday', has_description: true, required_skills: ['python'], min_degree: 'bachelors', sponsors_visa: false, visa_question_present: null, possible_sponsor: null, question_count: null, experience_level_from_desc: null, visa_no_signal_reason: null, enricher_version: 67, company_name: 'A' }),
  JSON.stringify({ id: 'job-form-lca', source: 'workday', has_description: true, required_skills: ['python'], min_degree: 'bachelors', sponsors_visa: null, visa_question_present: true, possible_sponsor: true, question_count: 5, experience_level_from_desc: null, visa_no_signal_reason: null, enricher_version: 67, company_name: 'B' }),
  JSON.stringify({ id: 'job-lca-only', source: 'workday', has_description: true, required_skills: ['python'], min_degree: 'bachelors', sponsors_visa: null, visa_question_present: null, possible_sponsor: true, question_count: null, experience_level_from_desc: null, visa_no_signal_reason: null, enricher_version: 67, company_name: 'C' }),
  JSON.stringify({ id: 'job-none', source: 'workday', has_description: true, required_skills: ['python'], min_degree: 'bachelors', sponsors_visa: null, visa_question_present: null, possible_sponsor: null, question_count: null, experience_level_from_desc: null, visa_no_signal_reason: 'defense_contractor', enricher_version: 67, company_name: 'D' }),
];

const descriptionsMap = new Map(allJobs.map(j => [j.id, 'desc']));
const processedMap = Object.fromEntries(allJobs.map(j => [j.id, { status: 'enriched' }]));

const stats = generateStats({
  allJobs,
  finalLines,
  processedMap,
  descriptionsMap,
  DATA_DIR,
  ENRICHER_VERSION: 67,
  descWaiting: 0,
  reenrichmentPending: 0,
});

const workday = stats.by_source.workday;
assert.strictEqual(workday.actual_job_signal, 2);
assert.strictEqual(workday.lca_only_signal, 1);
assert.strictEqual(workday.no_visa_signal, 1);
assert.strictEqual(workday.sponsors_visa_false, 1);
assert.strictEqual(workday.visa_question_present_true, 1);
assert.strictEqual(workday.possible_sponsor_true, 2);
assert.strictEqual(workday.actual_job_signal_pct, 50);
assert.strictEqual(workday.lca_only_signal_pct, 25);
assert.strictEqual(workday.no_visa_signal_pct, 25);

const truthPath = path.join(DATA_DIR, 'tech-us-truth.json');
assert.ok(fs.existsSync(truthPath), 'tech-us-truth.json should be written');
const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8'));
assert.strictEqual(truth.schema, 'tech-us-truth-v1');
assert.strictEqual(truth.denominator.pool_total_jobs, 4);
assert.strictEqual(truth.denominator.tech_us_total_jobs, 4);
assert.strictEqual(truth.numerator.enriched_total_jobs, 4);
assert.strictEqual(truth.numerator.t3_t4_total_jobs, 4);
assert.strictEqual(truth.denominator.by_source.workday.tech_us_jobs, 4);


console.log('PASS stats visa path breakdown');
