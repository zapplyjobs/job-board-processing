#!/usr/bin/env node
// prune-sidecars.js — Remove stale entries from description sidecar files
//
// ENR-FLOW-1: Sidecar files grow indefinitely (append-only) but ~75% of entries
// are for IDs no longer in the pool. This bloats R2 download/upload by ~1.6 min
// per pipeline run. Pruning reduces sidecar sizes by ~70%.
//
// Usage: node prune-sidecars.js [--dry-run] [--data-dir PATH]
//   --dry-run      Report what would be pruned without modifying files
//   --data-dir     Override data directory (default: .github/data relative to cwd)

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dataDirIdx = args.indexOf('--data-dir');
const DATA_DIR = dataDirIdx >= 0 ? args[dataDirIdx + 1] : path.join(process.cwd(), '.github', 'data');

if (dryRun) console.log('[prune-sidecars] DRY RUN — no files will be modified');
console.log(`[prune-sidecars] Data dir: ${DATA_DIR}`);

// Step 1: Load active IDs from all_jobs.json
const allJobsPath = path.join(DATA_DIR, 'all_jobs.json');
if (!fs.existsSync(allJobsPath)) {
  console.error(`[prune-sidecars] ERROR: ${allJobsPath} not found`);
  process.exit(1);
}

const activeIds = new Set();
const lines = fs.readFileSync(allJobsPath, 'utf8').trim().split('\n');
for (const line of lines) {
  try {
    const job = JSON.parse(line);
    if (job.id) activeIds.add(job.id);
  } catch { /* skip */ }
}
console.log(`[prune-sidecars] Active IDs from all_jobs.json: ${activeIds.size.toLocaleString()}`);

// Step 2: Load pending IDs from processed_ids.json (they still need descriptions)
const processedPath = path.join(DATA_DIR, 'processed_ids.json');
if (fs.existsSync(processedPath)) {
  try {
    const processed = JSON.parse(fs.readFileSync(processedPath, 'utf8'));
    // processed_ids.json maps id → { version, timestamp, ... }
    // These IDs may still need re-enrichment → keep their descriptions
    if (typeof processed === 'object') {
      for (const id of Object.keys(processed)) {
        activeIds.add(id);
      }
    }
    console.log(`[prune-sidecars] + processed IDs: ${activeIds.size.toLocaleString()} total active`);
  } catch { /* skip */ }
}

// Step 3: Also keep IDs from enriched_jobs.json (they reference descriptions)
const enrichedPath = path.join(DATA_DIR, 'enriched_jobs.json');
if (fs.existsSync(enrichedPath)) {
  let enrichedCount = 0;
  const enrichedLines = fs.readFileSync(enrichedPath, 'utf8').trim().split('\n');
  for (const line of enrichedLines) {
    try {
      const job = JSON.parse(line);
      if (job.id && !activeIds.has(job.id)) {
        activeIds.add(job.id);
        enrichedCount++;
      }
    } catch { /* skip */ }
  }
  if (enrichedCount > 0) {
    console.log(`[prune-sidecars] + enriched-only IDs: ${enrichedCount.toLocaleString()} (${activeIds.size.toLocaleString()} total active)`);
  }
}

// Step 4: Prune each sidecar file
const descFiles = fs.readdirSync(DATA_DIR)
  .filter(f => /^descriptions-.*\.jsonl$/.test(f))
  .sort();

if (descFiles.length === 0) {
  console.log('[prune-sidecars] No sidecar files found');
  process.exit(0);
}

let totalBefore = 0;
let totalAfter = 0;
let totalSizeBefore = 0;
let totalSizeAfter = 0;

for (const filename of descFiles) {
  const filePath = path.join(DATA_DIR, filename);
  const sizeBefore = fs.statSync(filePath).size;

  const latestById = new Map();
  let kept = 0;
  let removed = 0;
  let malformed = 0;

  const fileLines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (activeIds.has(entry.id)) {
        latestById.set(entry.id, line); // last active entry wins
      } else {
        removed++;
      }
    } catch {
      malformed++;
      // Keep malformed lines to avoid data loss
      latestById.set(`__malformed_${i}`, line);
    }
  }

  const entries = [...latestById.values()];
  kept = entries.length - malformed;

  const sizeAfter = Buffer.byteLength(entries.join('\n') + '\n', 'utf8');
  totalBefore += kept + removed;
  totalAfter += kept;
  totalSizeBefore += sizeBefore;
  totalSizeAfter += sizeAfter;

  const pctKept = ((kept / (kept + removed)) * 100).toFixed(1);
  const savingsMB = ((sizeBefore - sizeAfter) / 1024 / 1024).toFixed(1);

  console.log(
    `[prune-sidecars] ${filename}: ${kept.toLocaleString()} kept, ${removed.toLocaleString()} removed ` +
    `(${pctKept}% active, ${malformed} malformed) — ${savingsMB} MB saved`
  );

  if (!dryRun && (removed > 0 || entries.length !== fileLines.filter(Boolean).length)) {
    fs.writeFileSync(filePath, entries.join('\n') + '\n', 'utf8');
  }
}

// Step 5: Handle enriched chunks — consolidate small chunks after pruning
// If the tail chunk is nearly empty after pruning, merge into previous chunk
const enrichedChunks = descFiles.filter(f => /^descriptions-enriched-\d+\.jsonl$/.test(f));
if (enrichedChunks.length > 1 && !dryRun) {
  const lastChunk = enrichedChunks[enrichedChunks.length - 1];
  const lastPath = path.join(DATA_DIR, lastChunk);
  const lastSize = fs.statSync(lastPath).size;

  // If last chunk is < 5 MB after pruning, merge into previous chunk
  if (lastSize < 5 * 1024 * 1024) {
    const prevChunk = enrichedChunks[enrichedChunks.length - 2];
    const prevPath = path.join(DATA_DIR, prevChunk);

    const prevContent = fs.readFileSync(prevPath, 'utf8').trim();
    const lastContent = fs.readFileSync(lastPath, 'utf8').trim();
    const merged = prevContent + '\n' + lastContent + '\n';

    // Check if merged fits in chunk limit (50 MB)
    if (Buffer.byteLength(merged, 'utf8') < 50 * 1024 * 1024) {
      fs.writeFileSync(prevPath, merged, 'utf8');
      fs.unlinkSync(lastPath);
      console.log(`[prune-sidecars] Merged ${lastChunk} into ${prevChunk} (${(lastSize / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}

console.log(
  `\n[prune-sidecars] ${dryRun ? 'WOULD save' : 'Saved'}: ` +
  `${totalBefore.toLocaleString()} → ${totalAfter.toLocaleString()} entries ` +
  `(${((1 - totalAfter / totalBefore) * 100).toFixed(1)}% reduction), ` +
  `${((totalSizeBefore - totalSizeAfter) / 1024 / 1024).toFixed(1)} MB`
);
