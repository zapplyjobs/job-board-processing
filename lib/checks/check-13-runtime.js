/**
 * Check 13: Aggregator runtime — execution time threshold
 * Uses stage_timings from metadata (accurate), falls back to API wall time.
 */
const { ghRequest } = require('./utils');

module.exports = {
  id: 13,
  name: 'aggregator runtime',
  async check(ctx) {
    if (!ctx.metadata) return null;
    const threshold = ctx.config.thresholds.runtimeExecutionMin;
    try {
      const stageTimings = ctx.metadata?.stage_timings;
      let execMin = null;
      if (stageTimings) {
        const totalMs = Object.values(stageTimings).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
        if (totalMs > 0) execMin = totalMs / 60000;
      }

      if (execMin !== null && execMin > threshold) {
        const queueMin = execMin < (ctx.metadata?.wall_time_min || 999)
          ? Math.max(0, ((ctx.metadata?.wall_time_min || execMin) - execMin)).toFixed(1)
          : 'unknown';
        return `**Aggregator execution time high**: ${execMin.toFixed(1)} min (threshold: ${threshold} min). Queue: ${queueMin} min. At 25 min execution, 15-min cadence breaks.`;
      }

      if (execMin === null) {
        // Fallback: check API for recent run times
        const res = await ghRequest(
          `https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/workflows/fetch-jobs.yml/runs?per_page=10&status=completed`,
          ctx.token
        );
        if (res.status === 200 && res.body?.workflow_runs) {
          const successful = res.body.workflow_runs.filter(r => r.conclusion === 'success').slice(0, 3);
          if (successful.length >= 2) {
            const runtimes = successful.map(r => {
              const start = new Date(r.run_started_at).getTime();
              const end = new Date(r.updated_at).getTime();
              return (end - start) / 60000;
            });
            const avg = runtimes.reduce((a, b) => a + b, 0) / runtimes.length;
            const max = Math.max(...runtimes);
            if (avg > ctx.config.thresholds.runtimeWallMin) {
              return `**Aggregator runtime high** (wall time, incl. queue): avg ${avg.toFixed(1)} min over ${successful.length} runs (max ${max.toFixed(1)} min). Execution data unavailable — check stage_timings in metadata.`;
            }
          }
        }
      }
    } catch (err) {
      console.error('Error checking runtime:', err.message);
    }
    return null;
  },
  async warn(ctx) {
    if (!ctx.metadata || !ctx.config.warnings) return null;
    const stageTimings = ctx.metadata?.stage_timings;
    if (!stageTimings) return null;
    const totalMs = Object.values(stageTimings).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    if (totalMs <= 0) return null;
    const execMin = totalMs / 60000;
    const warnMin = ctx.config.warnings.runtimeExecutionMin;
    const catMin = ctx.config.thresholds.runtimeExecutionMin;
    if (execMin > warnMin && execMin <= catMin) {
      return `Runtime trending up: ${execMin.toFixed(1)} min (warning at ${warnMin}, alert at ${catMin})`;
    }
    return null;
  },
};
