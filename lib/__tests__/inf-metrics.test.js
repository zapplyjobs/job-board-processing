/**
 * Tests for INF metrics logic functions.
 *
 * Covers: carryForwardMetric, mergeWithPrevious, detectEvents, computeGrowthTrend
 * Extracted from collect-metrics.js for testability.
 *
 * Run: node lib/__tests__/inf-metrics.test.js
 * From: job-board-shared/ root
 */

const assert = require('assert');
const { carryForwardMetric, mergeWithPrevious, detectEvents, computeGrowthTrend } = require('../metrics-logic');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ─── carryForwardMetric ──────────────────────────────────────────────────────

console.log('\ncarryForwardMetric:');

test('carries forward when current is null and previous exists', () => {
  const result = carryForwardMetric(null, 42, 'test_field');
  assert.strictEqual(result.carried, true);
  assert.strictEqual(result.value, 42);
});

test('returns current when current is not null', () => {
  const result = carryForwardMetric(10, 42, 'test_field');
  assert.strictEqual(result.carried, false);
  assert.strictEqual(result.value, 10);
});

test('returns current when both are null', () => {
  const result = carryForwardMetric(null, null, 'test_field');
  assert.strictEqual(result.carried, false);
  assert.strictEqual(result.value, null);
});

test('returns current when current is 0 (falsy but valid)', () => {
  const result = carryForwardMetric(0, 42, 'test_field');
  assert.strictEqual(result.carried, false);
  assert.strictEqual(result.value, 0);
});

test('returns current when current is empty string (falsy but valid)', () => {
  const result = carryForwardMetric('', 'previous', 'test_field');
  assert.strictEqual(result.carried, false);
  assert.strictEqual(result.value, '');
});

test('carries forward when current is false (falsy but valid)', () => {
  const result = carryForwardMetric(false, true, 'test_field');
  assert.strictEqual(result.carried, false);
  assert.strictEqual(result.value, false);
});

// ─── mergeWithPrevious ───────────────────────────────────────────────────────

console.log('\nmergeWithPrevious:');

test('returns current unchanged when no previous snapshot', () => {
  const current = { name: 'test-repo', workflowStatus: 'success', jobCount: 100 };
  const result = mergeWithPrevious(current, null);
  assert.strictEqual(result.workflowStatus, 'success');
  assert.strictEqual(result.jobCount, 100);
  assert.strictEqual(result._stale_since, undefined);
});

test('returns current unchanged when previous has no matching repo', () => {
  const current = { name: 'test-repo', workflowStatus: 'success', jobCount: 100 };
  const previous = { repos: { 'other-repo': { workflowStatus: 'failure' } }, timestamp: 't1' };
  const result = mergeWithPrevious(current, previous);
  assert.strictEqual(result.workflowStatus, 'success');
  assert.strictEqual(result._stale_since, undefined);
});

test('carries forward workflowStatus when current is null', () => {
  const current = { name: 'test-repo', workflowStatus: null, jobCount: 100 };
  const previous = {
    repos: { 'test-repo': { workflowStatus: 'success', workflowLastRun: 't1' } },
    timestamp: 't1'
  };
  const result = mergeWithPrevious(current, previous);
  assert.strictEqual(result.workflowStatus, 'success');
  assert.strictEqual(result.workflowLastRun, 't1');
  assert.strictEqual(result._stale_since, 't1');
});

test('carries forward jobCount when current is null', () => {
  const current = { name: 'test-repo', workflowStatus: 'success', jobCount: null };
  const previous = {
    repos: { 'test-repo': { jobCount: 50 } },
    timestamp: 't1'
  };
  const result = mergeWithPrevious(current, previous);
  assert.strictEqual(result.jobCount, 50);
  assert.strictEqual(result._stale_since, 't1');
});

test('carries forward lastJobsUpdate when current is null', () => {
  const current = { name: 'test-repo', workflowStatus: 'success', lastJobsUpdate: null };
  const previous = {
    repos: { 'test-repo': { lastJobsUpdate: '2026-05-01' } },
    timestamp: 't1'
  };
  const result = mergeWithPrevious(current, previous);
  assert.strictEqual(result.lastJobsUpdate, '2026-05-01');
});

test('preserves existing _stale_since when carrying forward', () => {
  const current = { name: 'test-repo', workflowStatus: null };
  const previous = {
    repos: { 'test-repo': { workflowStatus: 'success', _stale_since: 't0', workflowLastRun: 't1' } },
    timestamp: 't1'
  };
  const result = mergeWithPrevious(current, previous);
  assert.strictEqual(result._stale_since, 't0');
});

test('does not carry forward when current has values', () => {
  const current = { name: 'test-repo', workflowStatus: 'failure', jobCount: 200, lastJobsUpdate: '2026-05-10' };
  const previous = {
    repos: { 'test-repo': { workflowStatus: 'success', jobCount: 100, lastJobsUpdate: '2026-05-01' } },
    timestamp: 't1'
  };
  const result = mergeWithPrevious(current, previous);
  assert.strictEqual(result.workflowStatus, 'failure');
  assert.strictEqual(result.jobCount, 200);
  assert.strictEqual(result.lastJobsUpdate, '2026-05-10');
  assert.strictEqual(result._stale_since, undefined);
});

test('carries forward multiple null fields at once', () => {
  const current = { name: 'test-repo', workflowStatus: null, jobCount: null, lastJobsUpdate: null };
  const previous = {
    repos: { 'test-repo': { workflowStatus: 'success', workflowLastRun: 't1', jobCount: 50, lastJobsUpdate: '2026-05-01' } },
    timestamp: 't1'
  };
  const result = mergeWithPrevious(current, previous);
  assert.strictEqual(result.workflowStatus, 'success');
  assert.strictEqual(result.jobCount, 50);
  assert.strictEqual(result.lastJobsUpdate, '2026-05-01');
  assert.strictEqual(result._stale_since, 't1');
});

// ─── detectEvents ────────────────────────────────────────────────────────────

console.log('\ndetectEvents:');

test('returns empty array when no previous snapshot', () => {
  const events = detectEvents({ timestamp: 't1' }, null);
  assert.deepStrictEqual(events, []);
});

test('detects pool drop > 500 jobs', () => {
  const current = { timestamp: 't2', pipeline: { pipelineTotal: 60000 } };
  const previous = { pipeline: { pipelineTotal: 61000 } };
  const events = detectEvents(current, previous);
  const drop = events.find(e => e.type === 'pool_drop');
  assert.ok(drop, 'expected pool_drop event');
  assert.strictEqual(drop.severity, 'high');
  assert.strictEqual(drop.details.delta, -1000);
});

test('detects pool drop > 5% even if < 500', () => {
  const current = { timestamp: 't2', pipeline: { pipelineTotal: 940 } };
  const previous = { pipeline: { pipelineTotal: 1000 } };
  const events = detectEvents(current, previous);
  const drop = events.find(e => e.type === 'pool_drop');
  assert.ok(drop, 'expected pool_drop event for >5% drop');
  assert.strictEqual(drop.details.delta, -60);
});

test('does not alert on small pool drop < 5% and < 500', () => {
  const current = { timestamp: 't2', pipeline: { pipelineTotal: 9800 } };
  const previous = { pipeline: { pipelineTotal: 10000 } };
  const events = detectEvents(current, previous);
  const drop = events.find(e => e.type === 'pool_drop');
  assert.strictEqual(drop, undefined, 'should not alert on 2% drop');
});

test('detects pool rise > 500 jobs', () => {
  const current = { timestamp: 't2', pipeline: { pipelineTotal: 62000 } };
  const previous = { pipeline: { pipelineTotal: 61000 } };
  const events = detectEvents(current, previous);
  const rise = events.find(e => e.type === 'pool_rise');
  assert.ok(rise, 'expected pool_rise event');
  assert.strictEqual(rise.severity, 'info');
  assert.strictEqual(rise.details.delta, 1000);
});

test('detects source zero (prev > 20, curr = 0)', () => {
  const current = { timestamp: 't2', pipeline: { pipelineTotal: 50000, bySource: { workday: 0, greenhouse: 1000 } } };
  const previous = { pipeline: { pipelineTotal: 50000, bySource: { workday: 500, greenhouse: 1000 } } };
  const events = detectEvents(current, previous);
  const zero = events.find(e => e.type === 'source_zero' && e.source === 'workday');
  assert.ok(zero, 'expected source_zero for workday');
  assert.strictEqual(zero.severity, 'high');
});

test('does not alert source zero if prev <= 20', () => {
  const current = { timestamp: 't2', pipeline: { bySource: { small: 0 } } };
  const previous = { pipeline: { bySource: { small: 15 } } };
  const events = detectEvents(current, previous);
  const zero = events.find(e => e.type === 'source_zero');
  assert.strictEqual(zero, undefined, 'should not alert for sources with <=20 jobs');
});

test('detects source recovery', () => {
  const current = { timestamp: 't2', pipeline: { bySource: { greenhouse: 500 } } };
  const previous = { pipeline: { bySource: { greenhouse: 0 } } };
  const events = detectEvents(current, previous);
  const recovery = events.find(e => e.type === 'source_recovered');
  assert.ok(recovery, 'expected source_recovered');
  assert.strictEqual(recovery.source, 'greenhouse');
});

test('detects enrichment rate shift > 5%', () => {
  const current = { timestamp: 't2', enrichment: { totalEnriched: 9000, totalTechUs: 10000 } };
  const previous = { enrichment: { totalEnriched: 8000, totalTechUs: 10000 } };
  const events = detectEvents(current, previous);
  const shift = events.find(e => e.type === 'enrichment_shift');
  assert.ok(shift, 'expected enrichment_shift event');
  assert.strictEqual(shift.severity, 'medium');
});

test('does not alert on small enrichment shift < 5%', () => {
  const current = { timestamp: 't2', enrichment: { totalEnriched: 8500, totalTechUs: 10000 } };
  const previous = { enrichment: { totalEnriched: 8400, totalTechUs: 10000 } };
  const events = detectEvents(current, previous);
  const shift = events.find(e => e.type === 'enrichment_shift');
  assert.strictEqual(shift, undefined);
});

test('detects repo workflow failure transition', () => {
  const current = {
    timestamp: 't2',
    repos: { 'NGJ': { workflowStatus: 'failure' } }
  };
  const previous = {
    repos: { 'NGJ': { workflowStatus: 'success' } }
  };
  const events = detectEvents(current, previous);
  const fail = events.find(e => e.type === 'repo_failure');
  assert.ok(fail, 'expected repo_failure event');
  assert.strictEqual(fail.repo, 'NGJ');
});

test('detects repo workflow recovery', () => {
  const current = {
    timestamp: 't2',
    repos: { 'NGJ': { workflowStatus: 'success' } }
  };
  const previous = {
    repos: { 'NGJ': { workflowStatus: 'failure' } }
  };
  const events = detectEvents(current, previous);
  const recovery = events.find(e => e.type === 'repo_recovered');
  assert.ok(recovery, 'expected repo_recovered event');
});

test('detects repo going stale', () => {
  const current = {
    timestamp: 't2',
    repos: { 'NGJ': { _stale_since: 't1' } }
  };
  const previous = {
    repos: { 'NGJ': {} }
  };
  const events = detectEvents(current, previous);
  const stale = events.find(e => e.type === 'repo_stale');
  assert.ok(stale, 'expected repo_stale event');
  assert.strictEqual(stale.severity, 'medium');
});

test('detects star milestone crossing', () => {
  const current = {
    timestamp: 't2',
    repos: { 'NGJ': { stars: 105 } }
  };
  const previous = {
    repos: { 'NGJ': { stars: 98 } }
  };
  const events = detectEvents(current, previous);
  const milestone = events.find(e => e.type === 'star_milestone');
  assert.ok(milestone, 'expected star_milestone event');
  assert.strictEqual(milestone.details.milestone, 100);
});

test('detects multiple milestone crossings at once', () => {
  const current = {
    timestamp: 't2',
    repos: { 'NGJ': { stars: 260 } }
  };
  const previous = {
    repos: { 'NGJ': { stars: 45 } }
  };
  const events = detectEvents(current, previous);
  const milestones = events.filter(e => e.type === 'star_milestone');
  const milestoneValues = milestones.map(e => e.details.milestone);
  assert.ok(milestoneValues.includes(50), 'should detect 50 milestone');
  assert.ok(milestoneValues.includes(100), 'should detect 100 milestone');
  assert.ok(milestoneValues.includes(250), 'should detect 250 milestone');
});

test('does not fire event when stars stay below milestones', () => {
  const current = {
    timestamp: 't2',
    repos: { 'NGJ': { stars: 8 } }
  };
  const previous = {
    repos: { 'NGJ': { stars: 5 } }
  };
  const events = detectEvents(current, previous);
  const milestone = events.find(e => e.type === 'star_milestone');
  assert.strictEqual(milestone, undefined);
});

test('handles missing pipeline data gracefully', () => {
  const current = { timestamp: 't2' };
  const previous = {};
  const events = detectEvents(current, previous);
  assert.ok(Array.isArray(events));
  assert.strictEqual(events.length, 0);
});

// ─── computeGrowthTrend ──────────────────────────────────────────────────────

console.log('\ncomputeGrowthTrend:');

test('returns null when no history lines', () => {
  const result = computeGrowthTrend({ pipelineTotal: 100 }, null);
  assert.strictEqual(result, null);
});

test('returns null when fewer than 2 history entries', () => {
  const result = computeGrowthTrend({ pipelineTotal: 100 }, [{ timestamp: new Date().toISOString(), pipeline: { pipelineTotal: 90 } }]);
  assert.strictEqual(result, null);
});

test('returns null when no current pipeline', () => {
  const result = computeGrowthTrend(null, [
    { timestamp: new Date().toISOString(), pipeline: { pipelineTotal: 90 } },
    { timestamp: new Date(Date.now() - 86400000).toISOString(), pipeline: { pipelineTotal: 80 } }
  ]);
  assert.strictEqual(result, null);
});

test('computes total delta and percentage', () => {
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = computeGrowthTrend(
    { pipelineTotal: 110, bySource: { workday: 60 } },
    [
      { timestamp: new Date(now - 100000).toISOString(), pipeline: { pipelineTotal: 109, bySource: { workday: 59 } } },
      { timestamp: sevenDaysAgo, pipeline: { pipelineTotal: 100, bySource: { workday: 50 } } }
    ]
  );
  assert.ok(result, 'expected result');
  assert.strictEqual(result.total_delta, 10);
  assert.strictEqual(result.total_delta_pct, 10);
  assert.strictEqual(result.by_source_delta.workday, 10);
});

test('returns null when no snapshot within 7-day window', () => {
  const now = Date.now();
  const fifteenDaysAgo = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = computeGrowthTrend(
    { pipelineTotal: 110 },
    [
      { timestamp: fifteenDaysAgo, pipeline: { pipelineTotal: 100 } },
      { timestamp: thirtyDaysAgo, pipeline: { pipelineTotal: 90 } }
    ]
  );
  assert.strictEqual(result, null, 'should return null when all snapshots are > 7 days from target');
});

test('picks snapshot closest to 7 days ago', () => {
  const now = Date.now();
  const sixDays = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();
  const eightDays = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
  const result = computeGrowthTrend(
    { pipelineTotal: 120, bySource: {} },
    [
      { timestamp: sixDays, pipeline: { pipelineTotal: 110, bySource: {} } },
      { timestamp: eightDays, pipeline: { pipelineTotal: 100, bySource: {} } }
    ]
  );
  assert.ok(result, 'expected result');
  assert.strictEqual(result.compared_to, sixDays);
  assert.strictEqual(result.total_delta, 10);
});

test('handles source appearing in current but not previous', () => {
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sixDaysAgo = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();
  const result = computeGrowthTrend(
    { pipelineTotal: 110, bySource: { newsource: 50 } },
    [
      { timestamp: sixDaysAgo, pipeline: { pipelineTotal: 109, bySource: {} } },
      { timestamp: sevenDaysAgo, pipeline: { pipelineTotal: 100, bySource: {} } }
    ]
  );
  assert.ok(result);
  assert.strictEqual(result.by_source_delta.newsource, 50);
});

test('handles source disappearing from current', () => {
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sixDaysAgo = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();
  const result = computeGrowthTrend(
    { pipelineTotal: 90, bySource: {} },
    [
      { timestamp: sixDaysAgo, pipeline: { pipelineTotal: 95, bySource: {} } },
      { timestamp: sevenDaysAgo, pipeline: { pipelineTotal: 100, bySource: { oldsource: 50 } } }
    ]
  );
  assert.ok(result);
  assert.strictEqual(result.by_source_delta.oldsource, -50);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('\nFAILURES DETECTED — fix before committing.');
  process.exit(1);
} else {
  console.log('All tests passed.');
}
