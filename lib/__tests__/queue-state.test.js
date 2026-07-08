'use strict';

/**
 * Unit test: QueueState — the consolidated done-check FSM (ENR-DONECHECK-CONSOLIDATION-1)
 *
 * Tests every state, every transition, every query condition, and every edge case.
 * This is the transition-table test from the design spec §4 (behavioral parity).
 *
 * Run: node lib/__tests__/queue-state.test.js
 * From: job-board-processing/ root
 */

const assert = require('assert');
const { QueueState } = require('../enrich/queue-state');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
  }
}

// Helper: create a QueueState with standard config
function makeQueue(overrides = {}) {
  return new QueueState({
    processedMap: overrides.processedMap || {},
    enrichedJobsById: overrides.enrichedJobsById || new Map(),
    descriptionsMap: overrides.descriptionsMap || new Map(),
    currentVersion: overrides.currentVersion || 89,
    techDomains: overrides.techDomains || new Set(['software', 'data_science', 'hardware', 'ai']),
    structuralSources: overrides.structuralSources || new Set(['simplify', 'apple', 'google', 'jsearch', 'eightfold', 'amd']),
    maxRetries: overrides.maxRetries || 3,
  });
}

// Helper: a sample tech-US job
function techUSJob(overrides = {}) {
  return {
    id: 'test-1',
    source: 'greenhouse',
    tags: { domains: ['software'], locations: ['us'] },
    ...overrides,
  };
}

// =====================
// isDone tests
// =====================

test('isDone: NEW job (no entry) → not done', () => {
  const q = makeQueue();
  assert.strictEqual(q.isDone('new-job'), false);
});

test('isDone: SKIPPED → done', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'skipped', reason: 'non-tech' } } });
  assert.strictEqual(q.isDone('j1'), true);
});

test('isDone: EXHAUSTED at current version → done', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'exhausted', enricher_version: 89 } } });
  assert.strictEqual(q.isDone('j1'), true);
});

test('isDone: EXHAUSTED at old version → NOT done (version bump re-queues)', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'exhausted', enricher_version: 88 } } });
  assert.strictEqual(q.isDone('j1'), false);
});

test('isDone: ENRICHED at current version WITH skills → done (ENR-P0)', () => {
  const q = makeQueue({
    enrichedJobsById: new Map([['j1', { enricher_version: 89, required_skills: ['python'] }]]),
  });
  assert.strictEqual(q.isDone('j1'), true);
});

test('isDone: ENRICHED at current version WITHOUT skills → NOT done (ENR-P0: skills required)', () => {
  const q = makeQueue({
    enrichedJobsById: new Map([['j1', { enricher_version: 89, required_skills: [] }]]),
  });
  assert.strictEqual(q.isDone('j1'), false);
});

test('isDone: ENRICHED at old version → NOT done (version bump)', () => {
  const q = makeQueue({
    enrichedJobsById: new Map([['j1', { enricher_version: 88, required_skills: ['python'] }]]),
  });
  assert.strictEqual(q.isDone('j1'), false);
});

test('isDone: RETRY → NOT done', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'retry', retry_count: 1 } } });
  assert.strictEqual(q.isDone('j1'), false);
});

// =====================
// isEnrichable tests
// =====================

test('isEnrichable: tech+US → true', () => {
  const q = makeQueue();
  assert.strictEqual(q.isEnrichable(techUSJob()), true);
});

test('isEnrichable: non-tech → false', () => {
  const q = makeQueue();
  assert.strictEqual(q.isEnrichable(techUSJob({ tags: { domains: ['finance'], locations: ['us'] } })), false);
});

test('isEnrichable: non-US → false', () => {
  const q = makeQueue();
  assert.strictEqual(q.isEnrichable(techUSJob({ tags: { domains: ['software'], locations: ['uk'] } })), false);
});

test('isEnrichable: structural source → false', () => {
  const q = makeQueue();
  assert.strictEqual(q.isEnrichable(techUSJob({ source: 'simplify' })), false);
});

test('isEnrichable: workday WITH description → true', () => {
  const q = makeQueue({ descriptionsMap: new Map([['wd-1', 'desc text']]) });
  assert.strictEqual(q.isEnrichable(techUSJob({ id: 'wd-1', source: 'workday' })), true);
});

test('isEnrichable: workday WITHOUT description → false', () => {
  const q = makeQueue();
  assert.strictEqual(q.isEnrichable(techUSJob({ id: 'wd-1', source: 'workday' })), false);
});

test('isEnrichable: smartrecruiters WITH description → true', () => {
  const q = makeQueue({ descriptionsMap: new Map([['sr-1', 'desc text']]) });
  assert.strictEqual(q.isEnrichable(techUSJob({ id: 'sr-1', source: 'smartrecruiters' })), true);
});

// =====================
// shouldResurrect tests
// =====================

test('shouldResurrect: skipped non-tech now enrichable → true', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'skipped', reason: 'non-tech' } } });
  // Job now has tech domain (tag changed since skip)
  const job = techUSJob({ id: 'j1' });
  assert.strictEqual(q.shouldResurrect(job), true);
});

test('shouldResurrect: skipped non-tech STILL non-tech → false', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'skipped', reason: 'non-tech' } } });
  const job = techUSJob({ id: 'j1', tags: { domains: ['finance'], locations: ['us'] } });
  assert.strictEqual(q.shouldResurrect(job), false);
});

test('shouldResurrect: skipped structural → false (not resurrectable)', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'skipped', reason: 'structural_no_desc' } } });
  assert.strictEqual(q.shouldResurrect(techUSJob({ id: 'j1' })), false);
});

test('shouldResurrect: not skipped → false', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'enriched' } } });
  assert.strictEqual(q.shouldResurrect(techUSJob({ id: 'j1' })), false);
});

// =====================
// shouldRescue tests
// =====================

test('shouldRescue: exhausted current + was missing desc + has desc now → true', () => {
  const q = makeQueue({
    processedMap: { 'j1': { status: 'exhausted', enricher_version: 89 } },
    enrichedJobsById: new Map(), // no enriched record → wasMissingDescription = true
    descriptionsMap: new Map([['j1', 'new desc text']]), // desc now available
  });
  assert.strictEqual(q.shouldRescue(techUSJob({ id: 'j1' })), true);
});

test('shouldRescue: exhausted at OLD version → false', () => {
  const q = makeQueue({
    processedMap: { 'j1': { status: 'exhausted', enricher_version: 88 } },
    descriptionsMap: new Map([['j1', 'desc']]),
  });
  assert.strictEqual(q.shouldRescue(techUSJob({ id: 'j1' })), false);
});

test('shouldRescue: already has description in enriched record → false', () => {
  const q = makeQueue({
    processedMap: { 'j1': { status: 'exhausted', enricher_version: 89 } },
    enrichedJobsById: new Map([['j1', { has_description: true }]]), // has_description = true → wasMissingDescription = false
    descriptionsMap: new Map([['j1', 'desc']]),
  });
  assert.strictEqual(q.shouldRescue(techUSJob({ id: 'j1' })), false);
});

test('shouldRescue: no description available now → false', () => {
  const q = makeQueue({
    processedMap: { 'j1': { status: 'exhausted', enricher_version: 89 } },
    descriptionsMap: new Map(), // no desc
  });
  assert.strictEqual(q.shouldRescue(techUSJob({ id: 'j1' })), false);
});

// =====================
// Transition tests
// =====================

test('markEnriched: sets correct processedMap entry', () => {
  const q = makeQueue();
  q.markEnriched('j1');
  assert.strictEqual(q.processedMap['j1'].status, 'enriched');
  assert.ok(q.processedMap['j1'].processed_at, 'should have processed_at');
});

test('markSkipped: sets status + reason', () => {
  const q = makeQueue();
  q.markSkipped('j1', 'non-tech');
  assert.strictEqual(q.processedMap['j1'].status, 'skipped');
  assert.strictEqual(q.processedMap['j1'].reason, 'non-tech');
});

test('markExhausted: sets status + retry_count + enricher_version', () => {
  const q = makeQueue();
  q.markExhausted('j1', 3);
  assert.strictEqual(q.processedMap['j1'].status, 'exhausted');
  assert.strictEqual(q.processedMap['j1'].retry_count, 3);
  assert.strictEqual(q.processedMap['j1'].enricher_version, 89);
});

test('markRetry: sets status + retry_count + enricher_version', () => {
  const q = makeQueue();
  q.markRetry('j1', 2);
  assert.strictEqual(q.processedMap['j1'].status, 'retry');
  assert.strictEqual(q.processedMap['j1'].retry_count, 2);
  assert.strictEqual(q.processedMap['j1'].enricher_version, 89);
});

test('resurrect: deletes processedMap entry', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'skipped' } } });
  q.resurrect('j1');
  assert.ok(!q.processedMap['j1'], 'entry should be deleted');
  assert.strictEqual(q.isDone('j1'), false, 'should NOT be done after resurrect');
});

test('rescue: deletes processedMap entry + isDone returns false', () => {
  const q = makeQueue({ processedMap: { 'j1': { status: 'exhausted', enricher_version: 89 } } });
  q.rescue('j1');
  assert.ok(!q.processedMap['j1'], 'entry should be deleted');
  assert.strictEqual(q.isDone('j1'), false, 'should NOT be done after rescue');
});

test('pruneStale: removes entries not in liveIds, keeps live ones', () => {
  const q = makeQueue({
    processedMap: {
      'live-1': { status: 'enriched' },
      'gone-1': { status: 'skipped' },
      'live-2': { status: 'retry' },
    },
  });
  q.pruneStale(new Set(['live-1', 'live-2']));
  assert.ok(q.processedMap['live-1'], 'live-1 should survive');
  assert.ok(q.processedMap['live-2'], 'live-2 should survive');
  assert.ok(!q.processedMap['gone-1'], 'gone-1 should be pruned');
});

// =====================
// Helper tests
// =====================

test('computeRetryCount: version bump resets to 1', () => {
  const q = makeQueue({
    processedMap: { 'j1': { status: 'retry', retry_count: 2, enricher_version: 88 } },
  });
  assert.strictEqual(q.computeRetryCount('j1'), 1, 'version bump (88<89) should reset to 1');
});

test('computeRetryCount: same version increments', () => {
  const q = makeQueue({
    processedMap: { 'j1': { status: 'retry', retry_count: 2, enricher_version: 89 } },
  });
  assert.strictEqual(q.computeRetryCount('j1'), 3, 'same version should increment to 3');
});

test('computeRetryCount: new job (no entry) starts at 1', () => {
  const q = makeQueue();
  assert.strictEqual(q.computeRetryCount('new-job'), 1);
});

test('shouldExhaust: at MAX_RETRIES → true', () => {
  const q = makeQueue({
    processedMap: { 'j1': { status: 'retry', retry_count: 2, enricher_version: 89 } },
    maxRetries: 3,
  });
  assert.strictEqual(q.shouldExhaust('j1'), true, 'retry_count 3 >= MAX_RETRIES 3');
});

test('shouldExhaust: below MAX_RETRIES → false', () => {
  const q = makeQueue({
    processedMap: { 'j1': { status: 'retry', retry_count: 1, enricher_version: 89 } },
    maxRetries: 3,
  });
  assert.strictEqual(q.shouldExhaust('j1'), false, 'retry_count 2 < MAX_RETRIES 3');
});

test('getSkipReason: non-tech → "non-tech"', () => {
  const q = makeQueue();
  const job = techUSJob({ tags: { domains: ['finance'], locations: ['us'] } });
  assert.strictEqual(q.getSkipReason(job), 'non-tech');
});

test('getSkipReason: tech but non-US → "non-us"', () => {
  const q = makeQueue();
  const job = techUSJob({ tags: { domains: ['software'], locations: ['uk'] } });
  assert.strictEqual(q.getSkipReason(job), 'non-us');
});

// =====================
// Integration: full lifecycle
// =====================

test('lifecycle: NEW → ENRICHED → done; version bump → re-queued', () => {
  const q = makeQueue();
  const id = 'lifecycle-1';

  // NEW: not done
  assert.strictEqual(q.isDone(id), false);

  // Enrich it
  q.markEnriched(id);
  q.enrichedJobsById.set(id, { enricher_version: 89, required_skills: ['python'] });
  assert.strictEqual(q.isDone(id), true, 'enriched at current version with skills → done');

  // Version bump
  q.currentVersion = 90;
  assert.strictEqual(q.isDone(id), false, 'version bump → not done (re-queued)');
});

test('lifecycle: NEW → SKIPPED → resurrected → ENRICHED', () => {
  const q = makeQueue();
  const id = 'lifecycle-2';
  const job = techUSJob({ id });

  // Skip it (non-tech at first)
  q.markSkipped(id, 'non-tech');
  assert.strictEqual(q.isDone(id), true, 'skipped → done');

  // Tags change → now enrichable
  assert.strictEqual(q.shouldResurrect(job), true, 'should resurrect (now enrichable)');

  // Resurrect
  q.resurrect(id);
  assert.strictEqual(q.isDone(id), false, 'resurrected → not done');

  // Enrich
  q.markEnriched(id);
  q.enrichedJobsById.set(id, { enricher_version: 89, required_skills: ['python'] });
  assert.strictEqual(q.isDone(id), true, 'enriched → done');
});

console.log(`\nQueueState: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
