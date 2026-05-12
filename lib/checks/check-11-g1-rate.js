/**
 * Check 11: G1 US non-senior general rate regression
 */
module.exports = {
  id: 11,
  name: 'G1 general rate',
  check(ctx) {
    if (!ctx.metadata) return null;
    const g1 = ctx.metadata?.tag_stats?.g1;
    if (g1?.us_general_rate_pct != null) {
      if (g1.us_general_rate_pct > ctx.config.thresholds.g1GeneralPct) {
        return `**US G1 rate high**: ${g1.us_general_rate_pct}% of US non-senior jobs are general-tagged (threshold: ${ctx.config.thresholds.g1GeneralPct}%) — tag engine may have regressed or pool composition shifted`;
      }
    } else {
      // Fallback: legacy total-pool general rate check
      const domains = ctx.metadata.tag_stats?.domains || {};
      const generalCount = domains['general'] ?? null;
      const currTotal = ctx.metadata.total_jobs;
      if (generalCount !== null && currTotal > 0) {
        const rate = generalCount / currTotal;
        if (rate > ctx.config.thresholds.g1FallbackPct) {
          return `**G1 general rate high**: ${Math.round(rate * 100)}% of pool is general-tagged (threshold: ${Math.round(ctx.config.thresholds.g1FallbackPct * 100)}%) — tag engine may have regressed`;
        }
      }
    }
    return null;
  },
  warn(ctx) {
    if (!ctx.metadata || !ctx.config.warnings) return null;
    const g1 = ctx.metadata?.tag_stats?.g1;
    if (g1?.us_general_rate_pct != null) {
      const warnPct = ctx.config.warnings.g1GeneralPct;
      const catPct = ctx.config.thresholds.g1GeneralPct;
      if (g1.us_general_rate_pct > warnPct && g1.us_general_rate_pct <= catPct) {
        return `G1 rate trending up: ${g1.us_general_rate_pct}% (warning at ${warnPct}%, alert at ${catPct}%)`;
      }
    }
    return null;
  },
};
