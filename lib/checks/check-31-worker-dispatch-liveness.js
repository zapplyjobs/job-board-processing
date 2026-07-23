/**
 * Check 31: Worker dispatch liveness
 *
 * PRIMARY: reads worker-heartbeat.json from R2 (via public proxy). The Cloudflare
 * Worker writes this file on every cron tick with dispatch results. This directly
 * measures Worker cron health — no GitHub API dependency, no manual-dispatch spoofing.
 *
 * FALLBACK: if heartbeat is unavailable (R2/proxy issue), falls back to checking
 * GitHub workflow_dispatch events (original logic). This can't distinguish Worker
 * from manual dispatches but is better than no monitoring.
 *
 * INF-CHECK31-ACTOR-1 (2026-07-23): resolved by R2 heartbeat. The Worker now writes
 * dispatch results to R2 every 15 min. This check reads them directly.
 *
 * Error handling: returns an alert string (not null) on failure, so the monitor
 * doesn't silently disable during outages.
 */
const { ghRequest } = require('./utils');

const OWNER = 'zapplyjobs';
const REPO = 'jobs-aggregator-private';
const WORKFLOW = 'fetch-jobs.yml';
const HEARTBEAT_URL = 'https://zjp-data-proxy.wild-queen-069e.workers.dev/data/worker-heartbeat.json';

module.exports = {
  id: 31,
  name: 'worker-dispatch-liveness',
  async check(ctx) {
    // PRIMARY: R2 heartbeat (direct Worker liveness signal)
    try {
      const hbRes = await fetch(HEARTBEAT_URL, { signal: AbortSignal.timeout(8000) });
      if (hbRes.ok) {
        const hb = await hbRes.json();
        const ageMin = Math.floor((Date.now() - new Date(hb.timestamp).getTime()) / 60000);

        if (ageMin > ctx.config.thresholds.workerDispatchMaxMinutes) {
          return `**Worker dispatch failure**: heartbeat ${ageMin}m old (threshold: ${ctx.config.thresholds.workerDispatchMaxMinutes}m). The Cloudflare Worker cron is broken — not firing. Check Worker deployment + CF cron trigger.`;
        }

        const failed = (hb.dispatches || []).filter(d => d.status !== 204);
        if (failed.length > 0) {
          const details = failed.map(d => `${d.repo}/${d.workflow}: HTTP ${d.status}`).join('; ');
          return `**Worker dispatch failure**: heartbeat fresh (${ageMin}m) but dispatch(es) failed: ${details}. Check Worker GH_PAT validity.`;
        }

        return null; // Heartbeat fresh + all dispatches succeeded
      }
    } catch (err) {
      console.log('[check-31] Heartbeat unavailable, falling back to GitHub API:', err.message);
    }

    // FALLBACK: GitHub workflow_dispatch events (can't distinguish manual from Worker)
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=30&created=>=${since}`;
    try {
      const res = await ghRequest(url, ctx.token);
      if (res.status !== 200) {
        return `**Worker dispatch check**: GitHub API returned HTTP ${res.status} — cannot verify dispatch liveness (heartbeat also unavailable).`;
      }
      if (!res.body?.workflow_runs) {
        return `**Worker dispatch check**: GitHub API returned no runs data — cannot verify dispatch liveness (heartbeat also unavailable).`;
      }
      const dispatchRuns = res.body.workflow_runs.filter(r => r.event === 'workflow_dispatch');
      if (dispatchRuns.length === 0) {
        return `**Worker dispatch failure**: no \`workflow_dispatch\` events on fetch-jobs in 60 min (heartbeat also unavailable). Worker trigger broken — pipeline on schedule only.`;
      }
      const lastDispatchMs = new Date(dispatchRuns[0].created_at).getTime();
      const ageMin = Math.floor((Date.now() - lastDispatchMs) / 60000);
      if (ageMin > ctx.config.thresholds.workerDispatchMaxMinutes) {
        return `**Worker dispatch failure**: fetch-jobs last \`workflow_dispatch\` ${ageMin}m ago (threshold: ${ctx.config.thresholds.workerDispatchMaxMinutes}m). Worker trigger broken (heartbeat also unavailable).`;
      }
      return null;
    } catch (err) {
      return `**Worker dispatch check**: API error — cannot verify liveness: ${err.message}`;
    }
  },
};
