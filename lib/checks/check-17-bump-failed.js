/**
 * Check 17: Bump-submodule workflow failure detection
 */
const { ghRequest } = require('./utils');

const SUBMODULE_PATHS = {
  shared: '.github/scripts/shared',
  aggregator: '.github/scripts/aggregator',
  processing: '.github/scripts/processing',
  consumer: '.github/scripts/consumer',
};

const SOURCE_REPOS = {
  shared: 'zapplyjobs/job-board-shared',
  aggregator: 'zapplyjobs/job-board-aggregator',
  processing: 'zapplyjobs/job-board-processing',
  consumer: 'zapplyjobs/job-board-consumer',
};

const TARGET_REPOS = {
  shared: [
    'zapplyjobs/jobs-aggregator-private',
    'zapplyjobs/jobs-data-2026',
    'zapplyjobs/New-Grad-Jobs-2027',
    'zapplyjobs/Internships-2027',
    'zapplyjobs/New-Grad-Software-Engineering-Jobs-2027',
    'zapplyjobs/New-Grad-Data-Science-Jobs-2027',
    'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2027',
    'zapplyjobs/New-Grad-Healthcare-Jobs-2027',
  ],
  aggregator: ['zapplyjobs/jobs-aggregator-private'],
  processing: ['zapplyjobs/jobs-data-2026'],
  consumer: [
    'zapplyjobs/New-Grad-Jobs-2027',
    'zapplyjobs/Internships-2027',
    'zapplyjobs/New-Grad-Software-Engineering-Jobs-2027',
    'zapplyjobs/New-Grad-Data-Science-Jobs-2027',
    'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2027',
    'zapplyjobs/New-Grad-Healthcare-Jobs-2027',
  ],
};

async function getCommitSha(repo, token) {
  const res = await ghRequest(`https://api.github.com/repos/${repo}/commits/main`, token);
  return res.status === 200 ? res.body?.sha || null : null;
}

async function getSubmoduleSha(repo, submodulePath, token) {
  const res = await ghRequest(`https://api.github.com/repos/${repo}/contents/${submodulePath}?ref=main`, token);
  return res.status === 200 ? res.body?.sha || null : null;
}

async function findLiveSubmoduleDrift(token) {
  const drifts = [];
  for (const [submoduleName, sourceRepo] of Object.entries(SOURCE_REPOS)) {
    const sourceSha = await getCommitSha(sourceRepo, token);
    if (!sourceSha) continue;
    const submodulePath = SUBMODULE_PATHS[submoduleName];
    for (const repo of TARGET_REPOS[submoduleName]) {
      const actualSha = await getSubmoduleSha(repo, submodulePath, token);
      if (!actualSha || actualSha !== sourceSha) {
        drifts.push({ submoduleName, repo, expected: sourceSha, actual: actualSha || 'missing' });
      }
    }
  }
  return drifts;
}


module.exports = {
  id: 17,
  name: 'bump-submodule failed',
  async check(ctx) {
    const res = await ghRequest(
      'https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/workflows/bump-submodule.yml/runs?per_page=3',
      ctx.token
    );
    if (res.status === 200 && res.body?.workflow_runs) {
      const recentFailed = res.body.workflow_runs.filter(
        r => r.conclusion === 'failure' && r.status === 'completed'
      );
      for (const run of recentFailed) {
        const ageMin = Math.round((Date.now() - new Date(run.created_at).getTime()) / 60000);
        if (ageMin > ctx.config.thresholds.bumpFailureWindowMin) continue;
        const drifts = await findLiveSubmoduleDrift(ctx.token);
        if (drifts.length === 0) {
          continue; // stale/noisy failed run; live state is already aligned
        }
        const top = drifts.slice(0, 4).map(d => `${d.submoduleName}:${d.repo.replace('zapplyjobs/','')}`).join(', ');
        return `**Submodule bump failed** (run ${run.id}, ${ageMin} min ago) and live drift remains in ${drifts.length} target(s): ${top}. Check [run log](${run.html_url}).`;
      }
    }
    return null;
  },
};
