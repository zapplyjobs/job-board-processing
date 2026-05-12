/**
 * Check 14: Custom fetcher silent — 0 jobs for 2+ consecutive runs
 */
module.exports = {
  id: 14,
  name: 'custom fetcher silent',
  check(ctx) {
    if (!ctx.metadata || !ctx.prev) return null;
    const currBySource = ctx.metadata.by_source || {};
    const prevBySource = ctx.prev?.pipeline?.bySource || {};
    const failures = [];

    for (const fetcher of ctx.config.CUSTOM_FETCHERS) {
      const curr = currBySource[fetcher] ?? 0;
      const prev = prevBySource[fetcher] ?? 0;
      if (curr === 0 && prev === 0) {
        // Only alert if fetcher was ever active
        if (currBySource[fetcher] !== undefined || prevBySource[fetcher] !== undefined) {
          failures.push(
            `**Custom fetcher silent (${fetcher})**: 0 jobs for 2+ consecutive runs. Fetcher may be broken — check HTML extraction regex.`
          );
        }
      }
    }
    return failures.length > 0 ? failures.join('\n') : null;
  },
};
