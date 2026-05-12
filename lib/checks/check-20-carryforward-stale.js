/**
 * Check 20: Carry-forward staleness — repos with stale data >24h
 */
module.exports = {
  id: 20,
  name: 'carry-forward stale',
  check(ctx) {
    if (!ctx.metricsLatest) return null;
    const staleWarnings = ctx.metricsLatest.stale_warnings || [];
    if (staleWarnings.length > 0) {
      const shown = staleWarnings.slice(0, 10);
      const suffix = staleWarnings.length > 10 ? ` (+${staleWarnings.length - 10} more)` : '';
      return `**Metrics carry-forward stale** (${staleWarnings.length} repo(s) >24h): ` +
        shown.map(w => `${w.repo} (${w.stale_hours}h)`).join(', ') + suffix +
        ` — API data unreliable, check repo access`;
    }
    return null;
  },
};
