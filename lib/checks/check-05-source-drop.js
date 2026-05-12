/**
 * Check 5: individual source dropped >threshold vs previous snapshot
 */
module.exports = {
  id: 5,
  name: 'source drop',
  check(ctx) {
    if (!ctx.prev || !ctx.metadata) return null;
    const prevBySource = ctx.prev?.pipeline?.bySource || {};
    const currBySource = ctx.metadata.by_source || {};
    const threshold = ctx.config.thresholds.sourceDropPct;
    const failures = [];
    for (const [source, currCount] of Object.entries(currBySource)) {
      const prevCount = prevBySource[source];
      if (prevCount && prevCount > 100 && currCount < prevCount * threshold) {
        const dropPct = Math.round((1 - currCount / prevCount) * 100);
        failures.push(`**Source drop (${source})**: ${currCount} jobs (was ${prevCount}, dropped ${dropPct}%)`);
      }
    }
    return failures.length > 0 ? failures.join('\n') : null;
  },
};
