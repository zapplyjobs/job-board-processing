/**
 * Contract test: enriched_jobs.json output matches enrichment_contract.json
 *
 * Validates that enrich-jobs.js produces output conforming to the schema contract
 * that backend pipeline.ts depends on. Prevents silent data loss from field renames,
 * type changes, or removals.
 *
 * Run: node lib/__tests__/enrichment-contract.test.js
 * From: job-board-processing/ root
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const contractPath = path.join(__dirname, '../../schemas/enrichment_contract.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const fields = contract.fields;

console.log('\nEnrichment Contract Tests (v' + contract.version + ')\n');

// 1. Contract file is valid
test('contract file has required metadata', () => {
  assert.ok(contract.version, 'Missing version');
  assert.ok(contract.producer, 'Missing producer');
  assert.ok(contract.consumer, 'Missing consumer');
  assert.ok(contract.fields, 'Missing fields');
});

// 2. All required fields have expected types
test('all required fields are defined', () => {
  const requiredFields = Object.entries(fields).filter(([, f]) => f.required);
  assert.ok(requiredFields.length > 0, 'No required fields defined');
  for (const [name, def] of requiredFields) {
    assert.ok(def.type, `Required field "${name}" missing type`);
    assert.ok(def.description, `Required field "${name}" missing description`);
  }
});

// 3. Consumer fields are documented
test('consumer fields have consumer_field mapping', () => {
  const consumerFields = Object.entries(fields).filter(([, f]) => f.consumer_reads);
  for (const [name, def] of consumerFields) {
    assert.ok(def.consumer_field, `Consumer field "${name}" missing consumer_field mapping`);
  }
});

// 4. Required fields are not removable without coordination
test('consumer-read fields are all required', () => {
  const consumerFields = Object.entries(fields).filter(([, f]) => f.consumer_reads);
  for (const [name, def] of consumerFields) {
    assert.ok(def.required !== false, `Consumer field "${name}" is not marked required — backend expects it`);
  }
});

// 5. Type string format is parseable
test('field types are recognizable', () => {
  const validTypes = new Set([
    'string', 'number', 'boolean', 'array[string]',
    'string|null', 'boolean|null', 'number|null',
    'array[object]', 'object',
  ]);
  for (const [name, def] of Object.entries(fields)) {
    assert.ok(validTypes.has(def.type), `Field "${name}" has unrecognized type: "${def.type}"`);
  }
});

// 6. Change rules are present
test('change rules are defined', () => {
  assert.ok(contract.change_rules, 'Missing change_rules');
  assert.ok(contract.change_rules.adding_fields, 'Missing adding_fields rule');
  assert.ok(contract.change_rules.removing_fields, 'Missing removing_fields rule');
  assert.ok(contract.change_rules.renaming_fields, 'Missing renaming_fields rule');
});

// 7. Sample validation against contract (if enriched_jobs.json exists locally)
const dataDir = process.env.ENRICHED_DATA_DIR || path.join(__dirname, '../../../jobs-data-2026/.github/data');
const enrichedPath = path.join(dataDir, 'enriched_jobs.json');

if (fs.existsSync(enrichedPath)) {
  console.log('\n  Sample validation (against local enriched_jobs.json):\n');

  test('enriched_jobs.json records have all required fields', () => {
    const content = fs.readFileSync(enrichedPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    assert.ok(lines.length > 0, 'enriched_jobs.json is empty');

    // Check latest-version records (enricher_version >= current - 1)
    const allRecords = lines.map(l => JSON.parse(l));
    const maxVersion = Math.max(...allRecords.map(r => r.enricher_version || 0));
    const recentRecords = allRecords.filter(r => (r.enricher_version || 0) >= maxVersion - 1);
    const sampleSize = Math.min(10, recentRecords.length);

    assert.ok(sampleSize > 0, `No records found at version >= ${maxVersion - 1}`);

    for (let i = 0; i < sampleSize; i++) {
      const record = recentRecords[i];
      const recordVersion = record.enricher_version || 0;
      for (const [fieldName, fieldDef] of Object.entries(fields)) {
        if (!fieldDef.required) continue;
        // Skip fields that weren't required until a later version
        if (fieldDef.required_since_version && recordVersion < fieldDef.required_since_version) continue;
        assert.ok(
          fieldName in record,
          `Record ${record.id || 'unknown'} (v${recordVersion}) missing required field: ${fieldName}`
        );
      }
    }
  });

  test('enriched_jobs.json field types match contract', () => {
    const content = fs.readFileSync(enrichedPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const sample = JSON.parse(lines[0]);

    const typeChecks = {
      'string': (v) => typeof v === 'string',
      'number': (v) => typeof v === 'number',
      'boolean': (v) => typeof v === 'boolean',
      'array[string]': (v) => Array.isArray(v) && v.every(i => typeof i === 'string'),
      'string|null': (v) => v === null || typeof v === 'string',
      'boolean|null': (v) => v === null || typeof v === 'boolean',
      'number|null': (v) => v === null || typeof v === 'number',
    };

    for (const [name, def] of Object.entries(fields)) {
      if (!(name in sample)) continue;
      const checker = typeChecks[def.type];
      if (checker) {
        assert.ok(
          checker(sample[name]),
          `Field "${name}" type mismatch: contract says ${def.type}, got ${typeof sample[name]} (${JSON.stringify(sample[name])})`
        );
      }
    }
  });
} else {
  console.log('\n  ⚠ enriched_jobs.json not found locally — skipping sample validation');
  console.log(`  Set ENRICHED_DATA_DIR to run sample validation\n`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
