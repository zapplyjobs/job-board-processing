#!/usr/bin/env node
'use strict';

const assert = require('assert');
const config = require('../jobs-data-scripts/checks/config');

// --- Helpers ---

function makeCtx(overrides = {}) {
  return {
    token: 'test-token',
    config,
    dataDir: '/tmp/test-data',
    metadata: null,
    prev: null,
    enrichStats: null,
    metricsLatest: null,
    allJobs: null,
    allJobsPath: null,
    zjpMetrics: null,
    ...overrides,
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.catch(e => {
        failed++;
        console.error(`  FAIL: ${name}`);
        console.error(`    ${e.message}`);
      });
    }
    passed++;
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
  }
}

// --- Check 4: Job count drop ---
const check04 = require('../jobs-data-scripts/checks/check-04-job-drop');

test('check-04: passes when no prev snapshot', () => {
  assert.strictEqual(check04.check(makeCtx()), null);
});

test('check-04: passes when job count stable', () => {
  const ctx = makeCtx({
    prev: { pipeline: { prevTotalJobs: 10000 } },
    metadata: { total_jobs: 9800 },
  });
  assert.strictEqual(check04.check(ctx), null);
});

test('check-04: fails on catastrophic drop', () => {
  const ctx = makeCtx({
    prev: { pipeline: { prevTotalJobs: 10000 } },
    metadata: { total_jobs: 5000 },
  });
  const result = check04.check(ctx);
  assert.ok(result, 'Should return failure');
  assert.ok(result.includes('Job count drop'), `Got: ${result}`);
  assert.ok(result.includes('50%'), `Should show drop percentage, got: ${result}`);
});

test('check-04: passes at threshold boundary (61%)', () => {
  const ctx = makeCtx({
    prev: { pipeline: { prevTotalJobs: 10000 } },
    metadata: { total_jobs: 6100 },
  });
  assert.strictEqual(check04.check(ctx), null);
});

test('check-04: fails just below threshold (59%)', () => {
  const ctx = makeCtx({
    prev: { pipeline: { prevTotalJobs: 10000 } },
    metadata: { total_jobs: 5900 },
  });
  assert.ok(check04.check(ctx));
});

// --- Check 5: Source drop ---
const check05 = require('../jobs-data-scripts/checks/check-05-source-drop');

test('check-05: passes when no prev snapshot', () => {
  assert.strictEqual(check05.check(makeCtx()), null);
});

test('check-05: passes when sources stable', () => {
  const ctx = makeCtx({
    prev: { pipeline: { bySource: { greenhouse: 5000 } } },
    metadata: { by_source: { greenhouse: 4800 } },
  });
  assert.strictEqual(check05.check(ctx), null);
});

test('check-05: passes when source small (<100 prev, not checked)', () => {
  const ctx = makeCtx({
    prev: { pipeline: { bySource: { greenhouse: 50 } } },
    metadata: { by_source: { greenhouse: 10 } },
  });
  assert.strictEqual(check05.check(ctx), null);
});

test('check-05: fails on catastrophic source drop', () => {
  const ctx = makeCtx({
    prev: { pipeline: { bySource: { greenhouse: 5000 } } },
    metadata: { by_source: { greenhouse: 1000 } },
  });
  const result = check05.check(ctx);
  assert.ok(result, 'Should detect source drop');
  assert.ok(result.includes('greenhouse'), `Should name the source: ${result}`);
});

// --- Check 9: Domain empty ---
const check09 = require('../jobs-data-scripts/checks/check-09-domain-empty');

test('check-09: passes when no metadata', () => {
  assert.strictEqual(check09.check(makeCtx()), null);
});

test('check-09: passes with all domains populated', () => {
  const ctx = makeCtx({
    metadata: {
      tag_stats: {
        domains: {
          software: 5000,
          data_science: 2000,
          hardware: 500,
          healthcare: 300,
          ai: 1000,
        },
      },
    },
  });
  assert.strictEqual(check09.check(ctx), null);
});

test('check-09: fails when a key domain has zero jobs', () => {
  const ctx = makeCtx({
    metadata: {
      tag_stats: {
        domains: {
          software: 5000,
          data_science: 0,
          hardware: 500,
          ai: 1000,
        },
      },
    },
  });
  const result = check09.check(ctx);
  assert.ok(result, 'Should detect empty domain');
  assert.ok(result.includes('data_science'), `Should name the domain: ${result}`);
});

// --- Check 10: Senior filter (reads allJobs) ---
const check10 = require('../jobs-data-scripts/checks/check-10-senior-filter');

test('check-10: passes when no allJobs file', () => {
  assert.strictEqual(check10.check(makeCtx()), null);
});

test('check-10: passes with low senior rate', () => {
  const fs = require('fs');
  const tmpFile = '/tmp/test-alljobs.jsonl';
  // Create a temp all_jobs file with mostly entry-level jobs
  const lines = [];
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({
      company_name: `Company${i}`,
      tags: {
        domains: ['software'],
        locations: ['us'],
        employment: i < 3 ? 'senior' : 'entry_level',
      },
    }));
  }
  fs.writeFileSync(tmpFile, lines.join('\n'));

  const ctx = makeCtx({
    allJobsPath: tmpFile,
    allJobs: lines.map(l => JSON.parse(l)),
  });
  assert.strictEqual(check10.check(ctx), null);
  fs.unlinkSync(tmpFile);
});

test('check-10: fails with high senior rate', () => {
  const fs = require('fs');
  const tmpFile = '/tmp/test-alljobs-senior.jsonl';
  const lines = [];
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({
      company_name: `Company${i}`,
      tags: {
        domains: ['software'],
        locations: ['us'],
        employment: i < 10 ? 'senior' : 'entry_level', // 10% senior
      },
    }));
  }
  fs.writeFileSync(tmpFile, lines.join('\n'));

  const ctx = makeCtx({
    allJobsPath: tmpFile,
    allJobs: lines.map(l => JSON.parse(l)),
  });
  const result = check10.check(ctx);
  assert.ok(result, 'Should detect high senior rate');
  assert.ok(result.includes('Senior filter'), `Got: ${result}`);
  fs.unlinkSync(tmpFile);
});

// --- Check 11: G1 rate ---
const check11 = require('../jobs-data-scripts/checks/check-11-g1-rate');

test('check-11: passes when no metadata', () => {
  assert.strictEqual(check11.check(makeCtx()), null);
});

test('check-11: passes with low G1 rate', () => {
  const ctx = makeCtx({
    metadata: {
      tag_stats: {
        g1: { us_general_rate_pct: 20 },
      },
    },
  });
  assert.strictEqual(check11.check(ctx), null);
});

test('check-11: fails when G1 rate exceeds threshold', () => {
  const ctx = makeCtx({
    metadata: {
      tag_stats: {
        g1: { us_general_rate_pct: 35 },
      },
    },
  });
  const result = check11.check(ctx);
  assert.ok(result, 'Should detect high G1 rate');
  assert.ok(result.includes('G1'), `Got: ${result}`);
});

// --- Check 12: Enrichment coverage ---
const check12 = require('../jobs-data-scripts/checks/check-12-enrich-coverage');

test('check-12: passes when no enrich stats', () => {
  assert.strictEqual(check12.check(makeCtx()), null);
});

test('check-12: passes with healthy enrichment coverage', () => {
  const ctx = makeCtx({
    enrichStats: { total_enriched: 9500, total_tech_us: 10000 },
  });
  assert.strictEqual(check12.check(ctx), null);
});

test('check-12: fails when enrichment coverage drops', () => {
  const ctx = makeCtx({
    enrichStats: { total_enriched: 5000, total_tech_us: 10000 },
  });
  const result = check12.check(ctx);
  assert.ok(result, 'Should detect low enrichment coverage');
  assert.ok(result.includes('Enrichment coverage'), `Got: ${result}`);
});

// --- Check 21: Dedupe store size ---
const check21 = require('../jobs-data-scripts/checks/check-21-dedupe-size');

test('check-21: passes when no zjp metrics', () => {
  assert.strictEqual(check21.check(makeCtx()), null);
});

test('check-21: passes with small dedupe store', () => {
  const ctx = makeCtx({
    zjpMetrics: { dedupe: { status: 'tracked', size_mb: 5 } },
  });
  assert.strictEqual(check21.check(ctx), null);
});

test('check-21: fails when dedupe store exceeds catastrophic threshold', () => {
  const ctx = makeCtx({
    zjpMetrics: { dedupe: { status: 'tracked', size_mb: 25 } },
  });
  const result = check21.check(ctx);
  assert.ok(result, 'Should detect large dedupe store');
  assert.ok(result.includes('25'), `Should mention size: ${result}`);
});

test('check-21: warn fires at warning threshold', () => {
  const ctx = makeCtx({
    zjpMetrics: { dedupe: { status: 'tracked', size_mb: 12 } },
  });
  const result = check21.warn(ctx);
  assert.ok(result, 'Should warn at warning threshold');
  assert.ok(result.includes('12'), `Should mention size: ${result}`);
});

// --- Check 22: Metadata completeness ---
const check22 = require('../jobs-data-scripts/checks/check-22-metadata-completeness');

test('check-22: fails when metadata is null', () => {
  const result = check22.check(makeCtx());
  assert.ok(result, 'Should fail when metadata missing');
  assert.ok(result.includes('Metadata missing'), `Got: ${result}`);
});

test('check-22: passes when all required fields present', () => {
  const ctx = makeCtx({
    metadata: {
      keyword_overlap: {},
      keyword_health: {},
      tag_drift: {},
      tag_precision: {},
      senior_filter_stats: {},
      tag_stats: {},
      stage_timings: {},
      validation_stats: {},
    },
  });
  assert.strictEqual(check22.check(ctx), null);
});

test('check-22: fails when 4+ fields missing (severe)', () => {
  const ctx = makeCtx({
    metadata: {
      keyword_overlap: {},
      keyword_health: {},
      senior_filter_stats: {},
      tag_stats: {},
    },
  });
  const result = check22.check(ctx);
  assert.ok(result, 'Should detect incomplete metadata');
  assert.ok(result.includes('severely incomplete'), `Got: ${result}`);
});

test('check-22: warns when 1-2 fields missing', () => {
  const ctx = makeCtx({
    metadata: {
      keyword_overlap: {},
      keyword_health: {},
      tag_drift: {},
      tag_precision: {},
      senior_filter_stats: {},
      tag_stats: {},
    },
  });
  const result = check22.check(ctx);
  assert.ok(result, 'Should detect missing fields');
  assert.ok(!result.includes('severely'), `Should not be severe for 2 missing: ${result}`);
});

// --- Check 25: R2 freshness ---
const check25 = require('../jobs-data-scripts/checks/check-25-r2-freshness');

test('check-25: passes when no zjp metrics', () => {
  assert.strictEqual(check25.check(makeCtx()), null);
});

test('check-25: passes with healthy R2', () => {
  const ctx = makeCtx({
    zjpMetrics: { r2: { status: 'healthy', manifest_age_minutes: 5 } },
  });
  assert.strictEqual(check25.check(ctx), null);
});

test('check-25: fails when R2 status is error', () => {
  const ctx = makeCtx({
    zjpMetrics: { r2: { status: 'error', error: 'connection failed' } },
  });
  const result = check25.check(ctx);
  assert.ok(result, 'Should detect R2 error');
  assert.ok(result.includes('R2'), `Got: ${result}`);
});

test('check-25: fails when R2 manifest is stale', () => {
  const ctx = makeCtx({
    zjpMetrics: { r2: { status: 'stale', manifest_age_minutes: 90 } },
  });
  const result = check25.check(ctx);
  assert.ok(result, 'Should detect stale R2');
  assert.ok(result.includes('stale'), `Got: ${result}`);
});

test('check-25: warns when R2 is aging', () => {
  const ctx = makeCtx({
    zjpMetrics: { r2: { status: 'healthy', manifest_age_minutes: 35 } },
  });
  const result = check25.warn(ctx);
  assert.ok(result, 'Should warn on aging R2');
});

// --- All checks: interface contract ---

test('all checks export { id, name, check }', () => {
  const checkFiles = [
    'check-01-fetch-stale', 'check-02-discord-failed', 'check-03-consumer-failed',
    'check-04-job-drop', 'check-05-source-drop', 'check-06-healthcare-drift',
    'check-07-us-tagger', 'check-09-domain-empty', 'check-10-senior-filter',
    'check-11-g1-rate', 'check-12-enrich-coverage', 'check-13-runtime',
    'check-14-fetcher-silent', 'check-15-enrich-sanity', 'check-16-p2-drift',
    'check-17-bump-failed', 'check-18-consumer-stale', 'check-19-zero-yield',
    'check-20-carryforward-stale', 'check-21-dedupe-size',
    'check-22-metadata-completeness', 'check-23-description-coverage',
    'check-24-fp-rate-trend', 'check-25-r2-freshness', 'check-26-sidecar-growth',
  ];

  for (const name of checkFiles) {
    const mod = require(`../jobs-data-scripts/checks/${name}`);
    assert.ok(typeof mod.id === 'number', `${name}: id must be number`);
    assert.ok(typeof mod.name === 'string', `${name}: name must be string`);
    assert.ok(typeof mod.check === 'function', `${name}: check must be function`);
  }
});

// --- Null-safety for sync checks ---
test('all sync checks return null/string with empty ctx', () => {
  const syncChecks = [
    'check-04-job-drop', 'check-05-source-drop', 'check-06-healthcare-drift',
    'check-07-us-tagger', 'check-09-domain-empty', 'check-10-senior-filter',
    'check-11-g1-rate', 'check-12-enrich-coverage', 'check-14-fetcher-silent',
    'check-15-enrich-sanity', 'check-20-carryforward-stale',
    'check-21-dedupe-size', 'check-22-metadata-completeness',
    'check-23-description-coverage', 'check-24-fp-rate-trend',
    'check-25-r2-freshness', 'check-26-sidecar-growth',
  ];

  for (const name of syncChecks) {
    const mod = require(`../jobs-data-scripts/checks/${name}`);
    try {
      const result = mod.check(makeCtx());
      assert.ok(result === null || typeof result === 'string',
        `${name}: should return null or string, got ${typeof result}`);
    } catch (e) {
      assert.fail(`${name}: should not throw on empty ctx — ${e.message}`);
    }
  }
});

// --- Async checks return null/string with empty ctx ---
test('all async checks return null/string with empty ctx', async () => {
  const asyncChecks = [
    'check-19-zero-yield',
  ];

  for (const name of asyncChecks) {
    const mod = require(`../jobs-data-scripts/checks/${name}`);
    try {
      const result = await mod.check(makeCtx());
      assert.ok(result === null || typeof result === 'string',
        `${name}: should return null or string, got ${typeof result}`);
    } catch (e) {
      assert.fail(`${name}: should not throw on empty ctx — ${e.message}`);
    }
  }
});

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error('Tests FAILED.');
  process.exit(1);
} else {
  console.log('All tests passed.');
}
