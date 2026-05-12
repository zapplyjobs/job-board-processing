/**
 * Check 21: Dedupe store size — alert if store grows beyond threshold
 */
module.exports = {
  id: 21,
  name: 'dedupe store size',
  check(ctx) {
    if (!ctx.zjpMetrics?.dedupe) return null;
    const dedupe = ctx.zjpMetrics.dedupe;
    if (dedupe.status !== 'tracked' || dedupe.size_mb == null) return null;

    if (dedupe.size_mb >= ctx.config.thresholds.dedupeStoreMbCatastrophic) {
      return `**Dedupe store ${dedupe.size_mb} MB** — exceeds catastrophic threshold (${ctx.config.thresholds.dedupeStoreMbCatastrophic} MB). Repo bloat risk. Investigate dedupe-store.json in aggregator.`;
    }
    return null;
  },
  warn(ctx) {
    if (!ctx.zjpMetrics?.dedupe) return null;
    const dedupe = ctx.zjpMetrics.dedupe;
    if (dedupe.status !== 'tracked' || dedupe.size_mb == null) return null;

    if (dedupe.size_mb >= ctx.config.thresholds.dedupeStoreMbWarning) {
      return `Dedupe store ${dedupe.size_mb} MB — approaching size limit (warning at ${ctx.config.thresholds.dedupeStoreMbWarning} MB)`;
    }
    return null;
  },
};
