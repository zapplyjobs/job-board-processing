#!/usr/bin/env node
'use strict';

/**
 * Test: pipeline-alert check ID uniqueness + registration integrity
 *
 * ENR-INF-RUNNER-COORD-1 (2026-07-19): the check-31/check-32 naming collision
 * (C190 ENR file vs INF's deployed check-31-worker-dispatch-liveness) slipped
 * through because there was no test guarding the namespace. This test prevents
 * a recurrence: it fails if (a) any two check files declare the same id, (b)
 * index.js requires a file that doesn't exist, or (c) a check file exists but
 * isn't registered in index.js.
 *
 * Run: node lib/__tests__/check-id-uniqueness.test.js
 * From: job-board-processing/ root
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CHECKS_DIR = path.join(__dirname, '..', 'checks');
const INDEX_PATH = path.join(CHECKS_DIR, 'index.js');

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

console.log('\nCheck ID uniqueness + registration integrity:');

// Read all check files + extract their declared id
const checkFiles = fs.readdirSync(CHECKS_DIR).filter(f => /^check-\d+-.*\.js$/.test(f));
const idToFile = {};
for (const f of checkFiles) {
  const content = fs.readFileSync(path.join(CHECKS_DIR, f), 'utf8');
  const m = content.match(/^\s*id:\s*(\d+)/m);
  if (!m) throw new Error(`Check file ${f} missing 'id:' field — every check must declare a numeric id`);
  const id = parseInt(m[1], 10);
  if (!idToFile[id]) idToFile[id] = [];
  idToFile[id].push(f);
}

// Read index.js + extract require paths
const indexContent = fs.readFileSync(INDEX_PATH, 'utf8');
const registered = [...indexContent.matchAll(/require\(['"]\.\/(check-[\w-]+)['"]/g)].map(m => m[1]);

test('all check IDs are unique (no collisions)', () => {
  const collisions = Object.entries(idToFile).filter(([id, files]) => files.length > 1);
  if (collisions.length > 0) {
    const detail = collisions.map(([id, files]) => `id=${id}: ${files.join(', ')}`).join('; ');
    assert.fail(`Collision: ${detail}. Renumber one of the files to the next free integer (current max: ${Math.max(...Object.keys(idToFile).map(Number))}).`);
  }
});

test('every required check in index.js exists on disk', () => {
  const onDisk = new Set(checkFiles.map(f => f.replace(/\.js$/, '')));
  const missing = registered.filter(r => !onDisk.has(r));
  assert.strictEqual(missing.length, 0, `index.js references missing check files: ${missing.join(', ')}`);
});

test('every check file on disk is registered in index.js (or explicitly retired)', () => {
  const indexed = new Set(registered);
  const unregistered = checkFiles
    .map(f => f.replace(/\.js$/, ''))
    .filter(name => !indexed.has(name));
  // check-10-senior-filter is intentionally retired (EXPAND-1 Phase 2) — index.js has it commented out.
  // Add to this allowlist ONLY with a comment explaining the retirement.
  const RETIRED_ALLOWLIST = new Set(['check-10-senior-filter']);
  const actuallyUnregistered = unregistered.filter(name => !RETIRED_ALLOWLIST.has(name));
  assert.strictEqual(actuallyUnregistered.length, 0,
    `Check files exist on disk but aren't registered in index.js: ${actuallyUnregistered.join(', ')}. Either add to index.js or add to RETIRED_ALLOWLIST with retirement reason.`);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('FAILURES — fix before merge (renumber check IDs or update index.js).');
  process.exit(1);
} else {
  console.log('All tests passed.');
}
