/**
 * Check 32: Per-source enrichment regression
 *
 * Detects per-source retrievable-text regressions that aggregate check-30
 * masks (e.g. one source at 0% retrievable can coexist with aggregate 86%
 * while other sources compensate).
 *
 * Catches the silent-loss class: any single source with ≥50 jobs dropping
 * below 90% retrievable-text rate.
 *
 * Sources in STRUCTURALLY_LOW_RETRIEVABLE (config) are exempt — their low
 * rate reflects content absence (short platform descriptions), not regression
 * (ENR-ORACLE-RETRIEVABLE-DISCREPANCY-1, 2026-07-19: oracle median desc len
 * = 131 chars → 75% retrievable is chronic baseline, not a regression).
 *
 * Pairs with check-30 (aggregate regression). Uses tiers_by_source (already
 * exposed in enrichment-stats), so chunking-agnostic and producer-side change
 * not required.
 *
 * Filed by ENR (ENR-DETECT-ARCH-1). Renamed from check-31 (C191, 2026-07-19) to
 * avoid collision with INF's deployed check-31-worker-dispatch-liveness.
 */
module.exports = {
  id: 32,
  name: 'enrichment source regression',
  check(ctx) {
    if (!ctx.enrichStats || !ctx.enrichStats.tiers_by_source) return null;

    const tiersBySource = ctx.enrichStats.tiers_by_source;
    const minJobs = ctx.config.thresholds.enrichPerSourceMinJobs;
    const minPct = ctx.config.thresholds.enrichPerSourceMinPct;
    const structuralLow = ctx.config.STRUCTURALLY_LOW_RETRIEVABLE || new Set();

    const failures = [];
    for (const [src, tiers] of Object.entries(tiersBySource)) {
      if (structuralLow.has(src)) continue;  // ENR-ORACLE-RETRIEVABLE-DISCREPANCY-1: content absence, not regression
      const t0 = tiers.t0 || 0;
      const t1 = tiers.t1 || 0;
      const t2 = tiers.t2 || 0;
      const t3 = tiers.t3 || 0;
      const t4 = tiers.t4 || 0;
      const total = t0 + t1 + t2 + t3 + t4;
      if (total < minJobs || total === 0) continue;

      const retrievable = t1 + t2 + t3 + t4;
      const rate = retrievable / total;
      if (rate < minPct) {
        failures.push(`**Per-source retrievable drop (${src})**: ${Math.round(rate * 100)}% retrievable (${retrievable}/${total}) — source-level description-text loss masked by aggregate`);
      }
    }

    return failures.length > 0 ? failures.join('\n') : null;
  },
};
