#!/usr/bin/env node
/**
 * targeted-reenrich.js — Force specific enriched rows back through enrichment,
 * WITHOUT a global ENRICHER_VERSION bump (which re-enriches the whole pool).
 *
 * Mechanism: the existing queue logic (loadEnrichedIds) re-enriches any row whose
 * enricher_version is below the current version. This script marks selected rows
 * one version behind in enriched_jobs.json (in R2); the next Enrich Jobs run
 * re-enriches exactly those rows via the proven version-bump path. Non-destructive
 * (the row stays in enriched_jobs; re-enrichment replaces it) and self-contained
 * (no workflow or enrich-jobs code change — uses the existing, tested mechanism).
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

  if (args.dryRun) {
    console.log(`\n[DRY RUN] No changes made. Re-run with --apply to reset these rows to v${targetVersion} in R2.`);
    return;
  }

  const targetIds = new Set(targets.map(r => r.id));
  let reset = 0;
  const updated = rows.map(r => {
    if (targetIds.has(r.id)) { reset++; return { ...r, enricher_version: targetVersion }; }
    return r;
  });
  await r2.uploadRaw('enriched_jobs.json', updated.map(r => JSON.stringify(r)).join('\n') + '\n', 'application/x-jsonlines');
  console.log(`\n[APPLIED] Reset ${reset} row(s) to v${targetVersion} in enriched_jobs.json (R2). The next Enrich Jobs run will re-enrich them (gradually, via the adaptive stale reserve).`);
})().catch(e => { console.error('ERR:', e.message); process.exit(2); });
