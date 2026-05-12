/**
 * Check 16: P-2 submodule drift — all 8 repos must have same submodule SHA
 */
const { ghRequest } = require('./utils');

module.exports = {
  id: 16,
  name: 'P-2 submodule drift',
  async check(ctx) {
    const shas = {};
    for (const repo of ctx.config.P2_REPOS) {
      const res = await ghRequest(`https://api.github.com/repos/${repo}/contents/.github/scripts/shared`, ctx.token);
      if (res.status === 200 && res.body?.sha) {
        shas[repo.split('/')[1]] = res.body.sha;
      }
    }
    const uniqueShas = [...new Set(Object.values(shas))];
    if (uniqueShas.length > 1) {
      const driftList = Object.entries(shas)
        .map(([repo, sha]) => `${repo}: ${sha.slice(0, 12)}`)
        .join(', ');
      return `**P-2 submodule drift detected**: ${uniqueShas.length} different SHAs across repos — ${driftList}`;
    }
    return null;
  },
};
