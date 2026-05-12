/**
 * Check 18: Consumer repo freshness — flag any consumer >2h behind shared
 */
const { ghRequest } = require('./utils');

module.exports = {
  id: 18,
  name: 'consumer repos stale',
  async check(ctx) {
    const staleMs = ctx.config.thresholds.consumerStaleHours * 60 * 60 * 1000;
    const sharedRes = await ghRequest(
      `https://api.github.com/repos/zapplyjobs/job-board-shared/commits?per_page=1`,
      ctx.token
    );
    if (sharedRes.status !== 200 || !sharedRes.body?.[0]?.commit?.committer?.date) return null;
    const sharedTime = new Date(sharedRes.body[0].commit.committer.date).getTime();
    const staleRepos = [];

    const consumerFullRepos = ctx.config.CONSUMER_REPOS.map(r => `zapplyjobs/${r}`);
    for (const repo of consumerFullRepos) {
      const res = await ghRequest(`https://api.github.com/repos/${repo}/commits?per_page=1`, ctx.token);
      if (res.status === 200 && res.body?.[0]?.commit?.committer?.date) {
        const repoTime = new Date(res.body[0].commit.committer.date).getTime();
        const lagMin = Math.round((sharedTime - repoTime) / 60000);
        if (lagMin > staleMs / 60000) {
          staleRepos.push(`${repo.split('/')[1]}: ${lagMin} min behind`);
        }
      }
    }

    if (staleRepos.length > 0) {
      return `**Consumer repos stale** (>${ctx.config.thresholds.consumerStaleHours}h behind shared): ${staleRepos.join(', ')}`;
    }
    return null;
  },
};
