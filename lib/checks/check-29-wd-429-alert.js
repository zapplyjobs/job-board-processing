/**
 * Check 29: Workday 429 rate-limit alert
 *
 * Catches silent Cloudflare rate-limit changes on the Workday fetcher.
 * AGG deployed wd_rate_limited_count in jobs-metadata.json (AGG-WD-429MONITOR-1).
 * Threshold 5 allows transient 429s without false alarms.
 * Filed by AGG, implemented by INF (INF-AGG-429ALERT-1).
 */
module.exports = {
  id: 29,
  name: 'wd-429-rate-limit',
  check(ctx) {
    if (!ctx.metadata) return null;
    const count = ctx.metadata.wd_rate_limited_count;
    if (typeof count === 'number' && count > 5) {
      return `**Workday 429 rate-limiting detected**: ${count} HTTP 429 responses this run (threshold: 5). Cloudflare may have changed rate limits — WD tenants could be silently skipped, causing missing jobs.`;
    }
    return null;
  },
};
