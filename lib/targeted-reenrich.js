#!/usr/bin/env node
/**
 * targeted-reenrich.js — Force specific enriched rows back through enrichment,
 * WITHOUT a global ENRICHER_VERSION bump (which re-enriches the whole pool).
 *
 * Mechanism: the existing queue logic (loadEnrichedIds) re-enriches any row whose
 * enricher_version is below the current version. This script marks selected rows
 * one version behind in enriched_jobs.json (in R2) AND clears their entries from
 * processed_ids.json — a 'skipped'/'exhausted' entry there keeps a row in the
 * skip-set regardless of version, so without the clear the reset silently no-ops
 * (ENR-QUEUE-3; root cause of the D.E. Shaw skills outage, ENR-QUALITY-10). The
 * next Enrich Jobs run re-enriches exactly those rows via the proven version-bump
 * path. Non-destructive (rows stay in enriched_jobs; re-enrichment replaces them)
 * and self-contained (no workflow or enrich-jobs code change).
 *
 * Re-enrichment is gradual: buildFastBatch's adaptive stale reserve re-includes
 * below-version rows in bounded batches, so a large selection drains over a few runs.
 *
 * Selectors:
 *   --ids <file>              one id per line
 *   --source <name>           e.g. workday, greenhouse
 *   --company <substring>     case-insensitive company_name match
 *   --condition <name>        no-skills | no-degree | no-visa  (missing-text: see note)
 *   --limit <n>               cap the selection
 *
 * Safety:
 *   --dry-run (DEFAULT)       resolve + print the selection, change nothing
 *   --apply                   write the version reset to enriched_jobs.json in R2
 *
 * CAVEAT: run --apply between Enrich Jobs runs — uploading enriched_jobs.json
 * while an enrichment run is mid-flight would conflict (both write the file).
 *
 * Usage:
 *   node lib/targeted-reenrich.js --source workday --company flir --dry-run
 *   node lib/targeted-reenrich.js --condition no-visa --source workday --limit 50 --apply
 */
'use strict';

const fs = require('fs');
const { createR2Client } = require('./storage/r2-client');

function parseArgs(argv) {
  const args = { dryRun: true, apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--apply') { args.apply = true; args.dryRun = false; }
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--ids') args.idsFile = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--company') args.company = argv[++i];
    else if (a === '--condition') args.condition = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

// Pure: resolve a selector against enriched rows → target rows.
function resolveTargets(rows, args) {
  const want = new Set();
  if (args.idsFile) {
    fs.readFileSync(args.idsFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean).forEach(id => want.add(id));
  }
  // Selectors AND-combine: --source workday --company flir = workday rows at FLIR.
  const preds = [];
  if (args.source) preds.push(r => r.source === args.source);
  if (args.company) { const c = args.company.toLowerCase(); preds.push(r => (r.company_name || '').toLowerCase().includes(c)); }
  if (args.condition === 'no-skills') preds.push(r => (r.required_skills || []).length === 0);
  else if (args.condition === 'no-degree') preds.push(r => r.min_degree == null);
  else if (args.condition === 'no-visa') preds.push(r => r.sponsors_visa == null && r.possible_sponsor == null);
  else if (args.condition) throw new Error(`Unknown --condition: ${args.condition} (use no-skills|no-degree|no-visa; for missing-text use --ids from enr-honest-quality.js)`);
  if (preds.length === 0 && want.size === 0) throw new Error('Specify a selector: --ids <file> | --source | --company | --condition');
  const pred = r => preds.every(p => p(r));
  let targets = rows.filter(r => want.size === 0 ? pred(r) : (want.has(r.id) && pred(r)));
  if (args.limit) targets = targets.slice(0, args.limit);
  return targets;
}

// Pure (ENR-QUEUE-3): clear target ids from the processed_ids map so a 'skipped' or
// 'exhausted' entry cannot keep them in enrich-jobs.js's skip-set (loadEnrichedIds).
// Returns { supported, cleared, clearedSkipped, updated }. Non-mutating on input.
// Legacy array format is unsupported (passed through with supported:false) — the live
// store is a map (37k+ entries); enrich-jobs.js migrates legacy arrays only on read.
function clearProcessedIds(processed, targetIds) {
  const isMap = processed && typeof processed === 'object' && !Array.isArray(processed);
  if (!isMap) return { supported: false, cleared: 0, clearedSkipped: 0, updated: processed };
  let cleared = 0;
  let clearedSkipped = 0;
  const updated = { ...processed };
  for (const id of targetIds) {
    if (Object.prototype.hasOwnProperty.call(updated, id)) {
      if (updated[id] && updated[id].status === 'skipped') clearedSkipped++;
      delete updated[id];
      cleared++;
    }
  }
  return { supported: true, cleared, clearedSkipped, updated };
}

if (require.main === module) {
(async () => {
  const args = parseArgs(process.argv);
  if (args.help || (!args.idsFile && !args.source && !args.company && !args.condition)) {
    console.log('Usage: node lib/targeted-reenrich.js --source <s> | --company <c> | --condition <no-skills|no-degree|no-visa> | --ids <file> [--limit N] [--apply]');
    console.log('Default is --dry-run (no changes). --condition missing-text is unsupported here — use projects/zjp/scripts/enr-honest-quality.js to get the exact id set, then --ids <file>.');
    process.exit(args.help ? 0 : 1);
  }
  if (args.condition === 'missing-text') {
    console.log('--condition missing-text cannot be resolved from enriched_jobs.json (the has_description flag is unreliable). Run projects/zjp/scripts/enr-honest-quality.js to get the exact retrievable-text set, save those ids to a file, then re-run with --ids <file>.');
    process.exit(0);
  }

  const r2 = createR2Client({ prefix: 'data/' });
  const raw = await r2.downloadRaw('enriched_jobs.json');
  if (!raw) throw new Error('enriched_jobs.json missing from R2');
  const rows = Buffer.from(raw).toString('utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (rows.length === 0) throw new Error('enriched_jobs.json empty/unparseable from R2');

  const versions = rows.map(r => Number(r.enricher_version) || 0).filter(Boolean);
  const currentVersion = versions.length ? Math.max(...versions) : 0;
  const targetVersion = currentVersion - 1;
  if (targetVersion < 1) throw new Error(`Cannot reset: currentVersion=${currentVersion}`);

  const targets = resolveTargets(rows, args);
  if (args.idsFile) {
    const requestedIds = fs.readFileSync(args.idsFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    const rowIds = new Set(rows.map(r => r.id));
    const found = requestedIds.filter(id => rowIds.has(id)).length;
    if (found < requestedIds.length) console.log(`  note: ${found} of ${requestedIds.length} --ids present in enriched_jobs; ${requestedIds.length - found} not found (expired/unknown) — skipped.`);
  }
  console.log(`enriched_jobs.json: ${rows.length} rows; currentVersion=v${currentVersion}; ${args.apply ? 'WILL RESET' : 'would reset'} ${targets.length} target row(s) to v${targetVersion}.`);
  if (targets.length === 0) { console.log('No targets. Exiting.'); process.exit(0); }
  console.log('sample targets: ' + targets.slice(0, 8).map(r => r.id).join(', '));

  const targetIds = new Set(targets.map(r => r.id));

  // ENR-QUEUE-3: a 'skipped'/'exhausted' entry in processed_ids.json keeps a row in the
  // skip-set (enrich-jobs.js loadEnrichedIds) regardless of version, so the reset above
  // would silently no-op for those rows. Resolve the clear up front so --dry-run reports
  // it and --apply performs it alongside the enriched_jobs.json reset.
  let procClear = { supported: false, cleared: 0, clearedSkipped: 0, updated: null };
  try {
    const procRaw = await r2.downloadRaw('processed_ids.json');
    if (procRaw) {
      procClear = clearProcessedIds(JSON.parse(Buffer.from(procRaw).toString('utf8')), targetIds);
      if (procClear.supported) {
        console.log(`processed_ids.json: ${procClear.cleared} of ${targetIds.size} target(s) present${procClear.clearedSkipped ? ` (${procClear.clearedSkipped} currently 'skipped' — these would no-op without the clear)` : ''}.`);
      } else {
        console.log('processed_ids.json: legacy array format — skipping processed_ids clear (format unsupported).');
      }
    } else {
      console.log('processed_ids.json: not found in R2 — nothing to clear.');
    }
  } catch (e) {
    console.error(`  WARN: could not read processed_ids.json (${e.message}). The version reset may no-op for any 'skipped' targets.`);
  }

  if (args.dryRun) {
    console.log(`\n[DRY RUN] No changes made. Re-run with --apply to reset these rows to v${targetVersion} in enriched_jobs.json${procClear.cleared ? ' and clear their processed_ids entries' : ''} in R2.`);
    return;
  }

  let reset = 0;
  const updated = rows.map(r => {
    if (targetIds.has(r.id)) { reset++; return { ...r, enricher_version: targetVersion }; }
    return r;
  });
  await r2.uploadRaw('enriched_jobs.json', updated.map(r => JSON.stringify(r)).join('\n') + '\n', 'application/x-jsonlines');

  // ENR-QUEUE-3: persist the processed_ids clear (computed above) so re-enrichment is not gated.
  if (procClear.supported && procClear.cleared > 0 && procClear.updated) {
    try {
      await r2.uploadRaw('processed_ids.json', JSON.stringify(procClear.updated), 'application/json');
    } catch (e) {
      console.error(`  WARN: processed_ids.json clear FAILED (${e.message}) AFTER enriched_jobs.json was reset. Re-run --apply once Enrich Jobs is idle to finish the clear.`);
    }
  }

  console.log(`\n[APPLIED] Reset ${reset} row(s) to v${targetVersion} in enriched_jobs.json${procClear.supported && procClear.cleared > 0 ? ` + cleared ${procClear.cleared} processed_ids entr${procClear.cleared === 1 ? 'y' : 'ies'} (${procClear.clearedSkipped} skipped)` : ''} (R2). The next Enrich Jobs run will re-enrich them (gradually, via the adaptive stale reserve).`);
})().catch(e => { console.error('ERR:', e.message); process.exit(2); });
}

module.exports = { clearProcessedIds };
