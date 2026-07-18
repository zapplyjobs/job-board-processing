/**
 * Check 23: Per-source description coverage
 *
 * Verifies sidecar files exist and are non-empty for each source that has
 * jobs in the pool. Catches silent description loss (Google dropped from
 * ~100% to 72% sidecar coverage over weeks with zero alerts).
 *
 * AGG-SELF-4 (Check A) — Origin: A46 design doc.
 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 23,
  name: 'description coverage',
  check(ctx) {
    if (!ctx.metadata || !ctx.dataDir) return null;
    const noSidecar = ctx.config.NO_SIDECAR_SOURCES;

    const bySource = ctx.metadata.by_source || {};
    const alerts = [];

    for (const [source, count] of Object.entries(bySource)) {
      if (count < 10) continue;

      // Sources with inline descriptions — RETIRED (AGG-ORACLE-DESC-1, 2026-07-18). See config.js.
      if (noSidecar.inline && noSidecar.inline.has(source)) continue;
      // Sources where descriptions come from enriched-*.jsonl (WD)
      if (noSidecar.enriched.has(source)) continue;
      // Sources that structurally have no descriptions (Simplify, EF, JSearch)
      if (noSidecar.structural.has(source)) continue;
      // A101: Disabled fetchers — suppress alerts while fetcher is off
      if (noSidecar.disabled && noSidecar.disabled.has(source)) continue;

      // AGG-ORACLE-DESC-1: glob per Description Sidecar Standard — a source may be single-file
      // (descriptions-X.jsonl) OR chunked (descriptions-X-1.jsonl, -2.jsonl, ...). The old
      // single-file check silently missed chunked sources (e.g. greenhouse) and reported them
      // as "Missing sidecar". glob both forms; aggregate entries across chunks.
      const sidecarFiles = fs.readdirSync(ctx.dataDir)
        .filter(f => new RegExp(`^descriptions-${source}(-\\d+)?\\.jsonl$`).test(f));
      if (sidecarFiles.length === 0) {
        alerts.push(`**Missing sidecar**: descriptions-${source}(-N)?.jsonl (${count} pool jobs, no sidecar)`);
        continue;
      }

      let lineCount = 0;
      let unreadable = false;
      for (const fname of sidecarFiles) {
        try {
          const content = fs.readFileSync(path.join(ctx.dataDir, fname), 'utf8').trim();
          lineCount += content ? content.split('\n').filter(Boolean).length : 0;
        } catch {
          unreadable = true;
        }
      }
      if (unreadable) {
        alerts.push(`**Unreadable sidecar**: descriptions-${source}*.jsonl`);
        continue;
      }
      const ratio = lineCount / count;
      if (ratio < 0.20) {
        alerts.push(`**Low description coverage**: ${source} has ${lineCount} sidecar entries for ${count} pool jobs (${(ratio * 100).toFixed(1)}%)`);
      }
    }

    return alerts.length > 0 ? alerts.join('\n') : null;
  },
};
