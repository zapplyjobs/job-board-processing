/**
 * Check 2: post-to-discord.yml failed
 */
const { getLastWorkflowRun } = require('./utils');

module.exports = {
  id: 2,
  name: 'post-to-discord.yml failed',
  async check(ctx) {
    const run = await getLastWorkflowRun('zapplyjobs', 'jobs-data-2026', 'post-to-discord.yml', ctx.token);
    if (!run) return '**post-to-discord.yml**: No runs found';
    if (run.conclusion === 'failure') {
      return `**post-to-discord.yml**: Last run failed (<t:${Math.floor(new Date(run.updated_at).getTime() / 1000)}:R>)`;
    }
    return null;
  },
};
