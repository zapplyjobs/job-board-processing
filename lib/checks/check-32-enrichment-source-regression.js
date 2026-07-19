/**
 * Check 31: Per-source enrichment regression
 *
 * Detects per-source retrievable-text regressions that aggregate check-30
 * masks (e.g. oracle 0% + workday 55% can coexist with aggregate 86%).
 * Catches the silent-loss class: any single source with ≥50 jobs dropping
 * below 90% retrievable-text rate.
 *
 * Threshold drives improvement per S266 contract directive ("aim for 100%
 * coverage"). At 90%, current state fires on oracle (regression) + workday
 * (chronic backlog) — both real user-impact issues.
 *
 * Pairs with check-30 (aggregate regression). Uses tiers_by_source (already
 * exposed in enrichment-stats), so chunking-agnostic and producer-side change
 * not required.
 *
 * Filed by ENR (ENR-DETECT-ARCH-1).
 */
module.exports = {
  id: 32,
  name: 'enrichment source regression',
  check(ctx) {
    if (!ctx.enrichStats || !ctx.enrichStats.tiers_by_source) return null;

    const tiersBySource = ctx.enrichStats.tiers_by_source;
    const minJobs = ctx.config.thresholds.enrichPerSourceMinJobs;
    const minPct = ctx.config.thresholds.enrichPerSourceMinPct;

    const failures = [];
    for (const [src, tiers] of Object.entries(tiersBySource)) {
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
