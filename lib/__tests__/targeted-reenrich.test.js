/**
 * Unit test: clearProcessedIds (ENR-QUEUE-3)
 *
 * Validates the pure logic that clears target ids from processed_ids.json so a
 * 'skipped'/'exhausted' entry can't keep them in enrich-jobs.js's skip-set and
 * silently no-op a forced re-enrichment (root cause of the D.E. Shaw skills
 * outage, ENR-QUALITY-10).
 *
 * Run: node lib/__tests__/targeted-reenrich.test.js
 * From: job-board-processing/ root
 */

const assert = require('assert');
const { clearProcessedIds } = require('../targeted-reenrich');

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

test('clears skipped + exhausted + enriched target entries, counts skipped', () => {
  const processed = {
    a: { status: 'skipped', reason: 'non-tech', processed_at: 't' },
    b: { status: 'skipped', reason: 'non-us', processed_at: 't' },
    c: { status: 'enriched', processed_at: 't' },
    d: { status: 'exhausted', retry_count: 3, enricher_version: 89, processed_at: 't' },
    e: { status: 'enriched', processed_at: 't' }, // not a target
  };
  const res = clearProcessedIds(processed, new Set(['a', 'b', 'c', 'd']));
  assert.strictEqual(res.supported, true);
  assert.strictEqual(res.cleared, 4);
  assert.strictEqual(res.clearedSkipped, 2);
  assert.ok(!('a' in res.updated) && !('d' in res.updated), 'targets removed');
  assert.ok('e' in res.updated, 'non-target preserved');
});

test('non-mutating on input', () => {
  const processed = { a: { status: 'skipped', reason: 'non-tech', processed_at: 't' } };
  clearProcessedIds(processed, new Set(['a']));
  assert.ok('a' in processed, 'input map unchanged');
  assert.strictEqual(processed.a.status, 'skipped', 'input entry unchanged');
});

test('target ids absent from processed_ids → cleared 0, others untouched', () => {
  const processed = { x: { status: 'enriched', processed_at: 't' } };
  const res = clearProcessedIds(processed, new Set(['nope', 'alsogone']));
  assert.strictEqual(res.cleared, 0);
  assert.strictEqual(res.clearedSkipped, 0);
  assert.ok('x' in res.updated);
});

test('empty targetIds → no change', () => {
  const processed = { x: { status: 'skipped', reason: 'non-tech', processed_at: 't' } };
  const res = clearProcessedIds(processed, new Set());
  assert.strictEqual(res.cleared, 0);
  assert.ok('x' in res.updated);
});

test('exhausted-at-current-version entry is cleared (unblocks line 336 skip-set)', () => {
  const processed = { j: { status: 'exhausted', enricher_version: 89, retry_count: 3, processed_at: 't' } };
  const res = clearProcessedIds(processed, new Set(['j']));
  assert.strictEqual(res.cleared, 1);
  assert.strictEqual(res.clearedSkipped, 0, 'exhausted is not counted as skipped');
  assert.ok(!('j' in res.updated));
});

test('legacy array format → supported:false, passed through unchanged', () => {
  const processed = ['a', 'b', 'c'];
  const res = clearProcessedIds(processed, new Set(['a', 'b']));
  assert.strictEqual(res.supported, false);
  assert.strictEqual(res.cleared, 0);
  assert.ok(Array.isArray(res.updated) && res.updated.length === 3);
});

test('null/undefined processed → supported:false', () => {
  assert.strictEqual(clearProcessedIds(null, new Set(['a'])).supported, false);
  assert.strictEqual(clearProcessedIds(undefined, new Set(['a'])).supported, false);
});

console.log(`\ntargeted-reenrich clearProcessedIds: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
