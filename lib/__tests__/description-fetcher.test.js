/**
 * Unit test: prioritizeMissingDescriptionBatch recovery-first ordering (ENR-DESCRETRIEVE-1)
 *
 * Root cause (runtime-confirmed): the WD/SR description fetch is capped at ~260/run against a
 * ~12,700 backlog, and the batch was sorted newest-first — so enriched jobs that had LOST their
 * retrievable description text (user-visible degraded listings) were starved behind newer
 * never-fetched arrivals and never recovered. Fix: recovery (already-enriched) jobs outrank
 * never-fetched jobs for the limited fetch budget; within each group, newest first.
 *
 * Run: node lib/__tests__/description-fetcher.test.js
 * From: job-board-processing/ root
 */

const assert = require('assert');
const { prioritizeMissingDescriptionBatch } = require('../enrich/description-fetcher');

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

test('recovery (enriched) job ranks before never-fetched even when older', () => {
  const pending = [
    { id: 'new-1', posted_at: '2026-07-07', tags: { domains: ['software'] } },
    { id: 'old-enriched', posted_at: '2026-06-01', tags: { domains: ['software'] } },
    { id: 'new-2', posted_at: '2026-07-06', tags: { domains: ['software'] } },
  ];
  const enrichedIds = new Set(['old-enriched']);
  const { batch } = prioritizeMissingDescriptionBatch(pending, enrichedIds);
  assert.strictEqual(batch[0].id, 'old-enriched', 'enriched recovery job should rank first despite being oldest');
});

test('within recovery group, newest first', () => {
  const pending = [
    { id: 'e-old', posted_at: '2026-06-01', tags: { domains: ['software'] } },
    { id: 'e-new', posted_at: '2026-07-01', tags: { domains: ['software'] } },
  ];
  const { batch } = prioritizeMissingDescriptionBatch(pending, new Set(['e-old', 'e-new']));
  assert.strictEqual(batch[0].id, 'e-new');
  assert.strictEqual(batch[1].id, 'e-old');
});

test('within never-fetched group, newest first', () => {
  const pending = [
    { id: 'n-old', posted_at: '2026-06-01', tags: { domains: ['software'] } },
    { id: 'n-new', posted_at: '2026-07-01', tags: { domains: ['software'] } },
  ];
  const { batch } = prioritizeMissingDescriptionBatch(pending, new Set());
  assert.strictEqual(batch[0].id, 'n-new');
  assert.strictEqual(batch[1].id, 'n-old');
});

test('no enrichedIds arg = pure newest-first (backward compatible)', () => {
  const pending = [
    { id: 'a', posted_at: '2026-06-01', tags: { domains: ['software'] } },
    { id: 'b', posted_at: '2026-07-01', tags: { domains: ['software'] } },
  ];
  const { batch } = prioritizeMissingDescriptionBatch(pending);
  assert.strictEqual(batch[0].id, 'b');
  assert.strictEqual(batch[1].id, 'a');
});

test('recovery group is served before never-fetched when batch is size-limited', () => {
  // Many never-fetched (newer) + a few recovery (older). Recovery must come first in the batch.
  const pending = [];
  for (let i = 0; i < 20; i++) pending.push({ id: `nf-${i}`, posted_at: `2026-07-${(20 - i).toString().padStart(2, '0')}`, tags: { domains: ['software'] } });
  pending.push({ id: 'rec-1', posted_at: '2026-06-01', tags: { domains: ['software'] } });
  pending.push({ id: 'rec-2', posted_at: '2026-05-01', tags: { domains: ['software'] } });
  const { batch } = prioritizeMissingDescriptionBatch(pending, new Set(['rec-1', 'rec-2']));
  // first two batch entries are the recovery jobs (order: newest recovery first)
  assert.ok(batch.length >= 2, 'batch should have entries');
  const recInBatch = batch.filter(j => j.id === 'rec-1' || j.id === 'rec-2');
  assert.strictEqual(recInBatch.length, 2, 'both recovery jobs should be in the batch');
  assert.strictEqual(batch[0].id, 'rec-1', 'newer recovery job first');
  assert.strictEqual(batch[1].id, 'rec-2', 'older recovery job second');
});

console.log(`\ndescription-fetcher prioritizeMissingDescriptionBatch: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
