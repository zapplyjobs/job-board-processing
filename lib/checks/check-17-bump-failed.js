/**
 * Check 17: Bump-submodule workflow failure detection
 */
const { ghRequest } = require('./utils');

function latestCompletedRun(runs) {
  if (!Array.isArray(runs)) return null;
  return runs
    .filter(run => run?.status === 'completed')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] || null;
}

function unresolvedRecentFailure(runs, nowMs, windowMin) {
  const run = latestCompletedRun(runs);
  if (!run || run.conclusion !== 'failure') return null;

  const createdAtMs = new Date(run.created_at).getTime();
  if (!Number.isFinite(createdAtMs)) return null;

  const ageMin = Math.round((nowMs - createdAtMs) / 60000);
  return ageMin <= windowMin ? { run, ageMin } : null;
}


module.exports = {
  id: 17,
  name: 'bump-submodule failed',
  async check(ctx) {
    const res = await ghRequest(
      `https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/workflows/bump-submodule.yml/runs?per_page=3`,
      ctx.token
    );
    if (res.status === 200 && res.body?.workflow_runs) {
      const failure = unresolvedRecentFailure(
        res.body.workflow_runs,
        Date.now(),
        ctx.config.thresholds.bumpFailureWindowMin
      );
      if (failure) {
        const { run, ageMin } = failure;
        return `**Submodule bump failed** (run ${run.id}, ${ageMin} min ago): SHA validation or P-2 verification failed. Check [run log](${run.html_url}).`;
      }
    }
    return null;
  },
  _test: { latestCompletedRun, unresolvedRecentFailure },
};
