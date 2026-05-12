/**
 * Check 17: Bump-submodule workflow failure detection
 */
const { ghRequest } = require('./utils');

module.exports = {
  id: 17,
  name: 'bump-submodule failed',
  async check(ctx) {
    const res = await ghRequest(
      `https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/workflows/bump-submodule.yml/runs?per_page=3`,
      ctx.token
    );
    if (res.status === 200 && res.body?.workflow_runs) {
      const recentFailed = res.body.workflow_runs.filter(
        r => r.conclusion === 'failure' && r.status === 'completed'
      );
      for (const run of recentFailed) {
        const ageMin = Math.round((Date.now() - new Date(run.created_at).getTime()) / 60000);
        if (ageMin <= ctx.config.thresholds.bumpFailureWindowMin) {
          return `**Submodule bump failed** (run ${run.id}, ${ageMin} min ago): SHA validation or P-2 verification failed. Check [run log](${run.html_url}).`;
        }
      }
    }
    return null;
  },
};
