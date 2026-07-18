/**
 * Check 31: Worker dispatch liveness
 *
 * Ensures the Cloudflare Worker (job-board-cron-worker) is actively dispatching
 * fetch-jobs via workflow_dispatch. The Worker fires every 15 min; if its GH_PAT
 * goes stale/revoked or the Worker breaks, dispatches stop landing — but GitHub's
 * unreliable schedule cron keeps the pipeline limping at ~30-min cadence, making
 * the failure invisible to check-01 (stale run, 30-min threshold).
 *
 * This check isolates Worker-trigger health: it alerts when fetch-jobs has had NO
 * workflow_dispatch event within the threshold window, even if schedule runs keep
 * it "fresh enough" to pass check-01.
 *
 * Filed as INF-WORKER-RELIABILITY-1 (2026-07-18): the Worker's GH_PAT was invalid
 * (401 Bad credentials) for 6+ days, masked by the fetch-jobs→enrich-jobs chain
 * link and GitHub schedule. This check would have caught it within ~45 min.
 *
 * Note: fetch-jobs is the right probe target — it has NO chain-link dispatcher
 * (unlike enrich-jobs, which fetch-jobs dispatches on completion). So workflow_dispatch
 * events on fetch-jobs come ONLY from the Worker, making it a clean liveness signal.
 */
const { ghRequest } = require('./utils');

const OWNER = 'zapplyjobs';
const REPO = 'jobs-aggregator-private';
const WORKFLOW = 'fetch-jobs.yml';

module.exports = {
  id: 31,
  name: 'worker-dispatch-liveness',
  async check(ctx) {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=10`;
    try {
      const res = await ghRequest(url, ctx.token);
      if (res.status !== 200 || !res.body?.workflow_runs?.length) return null;
      const dispatchRuns = res.body.workflow_runs.filter(r => r.event === 'workflow_dispatch');
      if (dispatchRuns.length === 0) {
        return `**Worker dispatch failure**: no \`workflow_dispatch\` events in the last 10 fetch-jobs runs. The Cloudflare Worker trigger is broken — pipeline running on schedule only (~30-min cadence vs intended 15-min). Check Worker GH_PAT validity + cron schedule via CF API.`;
      }
      const lastDispatchMs = new Date(dispatchRuns[0].created_at).getTime();
      const ageMin = Math.floor((Date.now() - lastDispatchMs) / 60000);
      if (ageMin > ctx.config.thresholds.workerDispatchMaxMinutes) {
        return `**Worker dispatch failure**: fetch-jobs last \`workflow_dispatch\` ${ageMin}m ago (threshold: ${ctx.config.thresholds.workerDispatchMaxMinutes}m). Worker trigger broken — pipeline degrading to schedule-only cadence. Check Worker GH_PAT validity.`;
      }
      return null;
    } catch {
      return null; // API failure — don't false-alarm
    }
  },
};
