/**
 * Check 28: Aggregator cancel rate — catches cancel cascades early
 *
 * Monitors the ratio of cancelled runs to total recent runs.
 * Cancel cascades (E116/E119) wasted 6+ hours of data freshness.
 * Threshold: alert when >50% cancelled, warn when >30%.
 */
const { ghRequest } = require('./utils');

const SAMPLE_SIZE = 15;

module.exports = {
  id: 28,
  name: 'aggregator cancel rate',
  async check(ctx) {
    const alertThreshold = ctx.config.thresholds.cancelRatePct;
    try {
      const res = await ghRequest(
        `https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/workflows/fetch-jobs.yml/runs?per_page=${SAMPLE_SIZE}&status=completed`,
        ctx.token
      );
      if (res.status !== 200 || !res.body?.workflow_runs) return null;

      const runs = res.body.workflow_runs;
      if (runs.length < 5) return null; // not enough data

      const cancelled = runs.filter(r => r.conclusion === 'cancelled').length;
      const rate = cancelled / runs.length;

      if (rate >= alertThreshold) {
        const lastSuccess = runs.find(r => r.conclusion === 'success');
        const staleHours = lastSuccess
          ? ((Date.now() - new Date(lastSuccess.created_at).getTime()) / 3600000).toFixed(1)
          : 'unknown';
        return `**Cancel cascade**: ${cancelled}/${runs.length} recent fetch runs cancelled (${(rate * 100).toFixed(0)}%). Last successful fetch: ${staleHours}h ago. Pipeline data is stale.`;
      }
    } catch (err) {
      console.error('Error checking cancel rate:', err.message);
    }
    return null;
  },
  async warn(ctx) {
    if (!ctx.config.warnings) return null;
    const warnThreshold = ctx.config.warnings.cancelRatePct;
    try {
      const res = await ghRequest(
        `https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/workflows/fetch-jobs.yml/runs?per_page=${SAMPLE_SIZE}&status=completed`,
        ctx.token
      );
      if (res.status !== 200 || !res.body?.workflow_runs) return null;

      const runs = res.body.workflow_runs;
      if (runs.length < 5) return null;

      const cancelled = runs.filter(r => r.conclusion === 'cancelled').length;
      const rate = cancelled / runs.length;

      if (rate >= warnThreshold && rate < (ctx.config.thresholds.cancelRatePct || 0.5)) {
        return `Cancel rate elevated: ${cancelled}/${runs.length} (${(rate * 100).toFixed(0)}%). Monitor for cascade.`;
      }
    } catch {}
    return null;
  },
};
