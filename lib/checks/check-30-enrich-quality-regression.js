/**
 * Check 30: Enrichment quality regression
 *
 * Guards the 66%-hidden regression class (ENR-MONITOR-1).
 * Catches silent drops in description retrievability, weighted completeness,
 * or silent rotation buildup that would indicate enrichment pipeline degradation.
 *
 * Thresholds calibrated from enrichment-history (normal: retrievable 85-90%, WCI 83-88%, silent_rot <1500).
 * Incident baseline: retrievable dropped to 66% during the 2026-06 regression.
 *
 * Filed by ENR (ENR-MONITOR-1). Deployed by INF (INF-ENR-MONITOR-DEPLOY-1).
 */
module.exports = {
  id: 30,
  name: 'enrichment-quality-regression',
  check(ctx) {
    if (!ctx.enrichStats) return null;

    const retrievable = ctx.enrichStats.retrievable_description_pct;
    const wci = ctx.enrichStats.weighted_completeness_index;
    const silentRot = ctx.enrichStats.silent_rot_count;

    const failures = [];

    if (typeof retrievable === 'number' && retrievable < ctx.config.thresholds.enrichRetrievableMin) {
      failures.push(`retrievable descriptions ${retrievable}% < ${ctx.config.thresholds.enrichRetrievableMin}%`);
    }

    if (typeof wci === 'number' && wci < ctx.config.thresholds.enrichWciMin) {
      failures.push(`weighted completeness ${wci} < ${ctx.config.thresholds.enrichWciMin}`);
    }

    if (typeof silentRot === 'number' && silentRot > ctx.config.thresholds.enrichSilentRotMax) {
      failures.push(`silent rotation ${silentRot} > ${ctx.config.thresholds.enrichSilentRotMax}`);
    }

    if (failures.length > 0) {
      return `**Enrichment quality regression**: ${failures.join('; ')}`;
    }
    return null;
  },
};
