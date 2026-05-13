/**
 * Check 16: P-2 submodule drift — all repos within each submodule group must have same SHA
 */
const { ghRequest } = require('./utils');

const SUBMODULE_REPOS = {
  shared: [
    'zapplyjobs/jobs-aggregator-private', 'zapplyjobs/jobs-data-2026',
    'zapplyjobs/New-Grad-Jobs-2026', 'zapplyjobs/Internships-2026',
    'zapplyjobs/New-Grad-Software-Engineering-Jobs-2026', 'zapplyjobs/New-Grad-Data-Science-Jobs-2026',
    'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2026', 'zapplyjobs/New-Grad-Healthcare-Jobs-2026',
  ],
  aggregator: ['zapplyjobs/jobs-aggregator-private'],
  processing: ['zapplyjobs/jobs-data-2026'],
  consumer: [
    'zapplyjobs/New-Grad-Jobs-2026', 'zapplyjobs/Internships-2026',
    'zapplyjobs/New-Grad-Software-Engineering-Jobs-2026', 'zapplyjobs/New-Grad-Data-Science-Jobs-2026',
    'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2026', 'zapplyjobs/New-Grad-Healthcare-Jobs-2026',
  ],
};

module.exports = {
  id: 16,
  name: 'P-2 submodule drift',
  async check(ctx) {
    const failures = [];

    for (const [subName, repos] of Object.entries(SUBMODULE_REPOS)) {
      const shas = {};
      for (const repo of repos) {
        const res = await ghRequest(`https://api.github.com/repos/${repo}/contents/.github/scripts/${subName}`, ctx.token);
        if (res.status === 200 && res.body?.sha) {
          shas[repo.split('/')[1]] = res.body.sha;
        }
      }
      const uniqueShas = [...new Set(Object.values(shas))];
      if (uniqueShas.length > 1) {
        const driftList = Object.entries(shas)
          .map(([repo, sha]) => `${repo}: ${sha.slice(0, 12)}`)
          .join(', ');
        failures.push(`${subName}: ${uniqueShas.length} different SHAs — ${driftList}`);
      }
    }

    if (failures.length > 0) {
      return `**P-2 submodule drift detected**: ${failures.join(' | ')}`;
    }
    return null;
  },
};
