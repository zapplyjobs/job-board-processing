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

      // Sources with inline descriptions (GH, Lever, Ashby, Amazon, Netflix, Microsoft)
      if (noSidecar.inline.has(source)) continue;
      // Sources where descriptions come from enriched-*.jsonl (WD)
      if (noSidecar.enriched.has(source)) continue;
      // Sources that structurally have no descriptions (Simplify, EF, JSearch)
      if (noSidecar.structural.has(source)) continue;
      // A101: Disabled fetchers — suppress alerts while fetcher is off
      if (noSidecar.disabled && noSidecar.disabled.has(source)) continue;

      const sidecarPath = path.join(ctx.dataDir, `descriptions-${source}.jsonl`);
      if (!fs.existsSync(sidecarPath)) {
        alerts.push(`**Missing sidecar**: descriptions-${source}.jsonl (${count} pool jobs, no sidecar)`);
        continue;
      }

      try {
        const content = fs.readFileSync(sidecarPath, 'utf8').trim();
        const lineCount = content ? content.split('\n').filter(Boolean).length : 0;
        const ratio = lineCount / count;
        if (ratio < 0.20) {
          alerts.push(`**Low description coverage**: ${source} has ${lineCount} sidecar entries for ${count} pool jobs (${(ratio * 100).toFixed(1)}%)`);
        }
      } catch {
        alerts.push(`**Unreadable sidecar**: descriptions-${source}.jsonl`);
      }
    }

    return alerts.length > 0 ? alerts.join('\n') : null;
  },
};
