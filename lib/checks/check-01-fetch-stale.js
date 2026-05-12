/**
 * Check 1: fetch-jobs.yml stale or failed
 */
const { getLastWorkflowRun } = require('./utils');

module.exports = {
  id: 1,
  name: 'fetch-jobs.yml stale or failed',
  async check(ctx) {
    const run = await getLastWorkflowRun('zapplyjobs', 'jobs-aggregator-private', 'fetch-jobs.yml', ctx.token);
    if (!run) return '**fetch-jobs.yml**: No runs found';
    if (run.conclusion === 'failure') {
      return `**fetch-jobs.yml**: Last run failed (<t:${Math.floor(new Date(run.updated_at).getTime() / 1000)}:R>)`;
    }
    const age = Date.now() - new Date(run.updated_at).getTime();
    if (age > ctx.config.thresholds.staleRunMinutes * 60 * 1000) {
      const mins = Math.floor(age / 60000);
      return `**fetch-jobs.yml**: Last run ${mins}m ago (expected ≤${ctx.config.thresholds.staleRunMinutes}m)`;
    }
    return null;
  },
};
