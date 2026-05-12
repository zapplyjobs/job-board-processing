/**
 * Check 4: total job count dropped >threshold vs previous snapshot
 */
module.exports = {
  id: 4,
  name: 'job count drop',
  check(ctx) {
    if (!ctx.prev) return null;
    const prevTotal = ctx.prev?.pipeline?.prevTotalJobs;
    if (!prevTotal || !ctx.metadata) return null;
    const currTotal = ctx.metadata.total_jobs;
    const threshold = ctx.config.thresholds.jobDropPct;
    if (currTotal && currTotal < prevTotal * threshold) {
      const dropPct = Math.round((1 - currTotal / prevTotal) * 100);
      return `**Job count drop**: ${currTotal} jobs (was ${prevTotal}, dropped ${dropPct}%)`;
    }
    return null;
  },
  warn(ctx) {
    if (!ctx.prev || !ctx.config.warnings) return null;
    const prevTotal = ctx.prev?.pipeline?.prevTotalJobs;
    if (!prevTotal || !ctx.metadata) return null;
    const currTotal = ctx.metadata.total_jobs;
    const warnThreshold = ctx.config.warnings.jobDropPct;
    const catThreshold = ctx.config.thresholds.jobDropPct;
    if (currTotal && currTotal < prevTotal * warnThreshold && currTotal >= prevTotal * catThreshold) {
      const dropPct = Math.round((1 - currTotal / prevTotal) * 100);
      return `Job count trending down: ${currTotal} jobs (was ${prevTotal}, down ${dropPct}%)`;
    }
    return null;
  },
};
