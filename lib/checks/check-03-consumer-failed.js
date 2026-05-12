/**
 * Check 3: consumer update-jobs.yml failures
 */
const { getLastWorkflowRun } = require('./utils');

module.exports = {
  id: 3,
  name: 'consumer update-jobs.yml failed',
  async check(ctx) {
    const checks = await Promise.all(
      ctx.config.CONSUMER_REPOS.map(async repo => {
        const run = await getLastWorkflowRun('zapplyjobs', repo, 'update-jobs.yml', ctx.token);
        if (run?.conclusion === 'failure') return repo;
        return null;
      })
    );
    const failed = checks.filter(Boolean);
    if (failed.length > 0) {
      return `**update-jobs.yml failed**: ${failed.join(', ')}`;
    }
    return null;
  },
};
