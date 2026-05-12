/**
 * Pure logic functions extracted from collect-metrics.js for testability.
 *
 * These functions have no external dependencies (no fs, no HTTP, no console).
 * They operate on plain data structures and return plain data.
 */

/**
 * Carry forward a single metric from previous snapshot when current read failed.
 * @param {*} current - Current value (null if read failed)
 * @param {*} previous - Previous snapshot value
 * @param {string} fieldName - Name for logging
 * @returns {*} previous if current is null and previous isn't; current otherwise
 */
function carryForwardMetric(current, previous, fieldName) {
  if (current === null && previous !== null) {
    return { carried: true, value: previous };
  }
  return { carried: false, value: current };
}

/**
 * Merge current repo metrics with previous snapshot, carrying forward null fields.
 * @param {Object} current - Current repo metrics
 * @param {Object} previous - Full previous snapshot
 * @returns {Object} Merged repo metrics with carried-forward fields
 */
function mergeWithPrevious(current, previous) {
  if (!previous?.repos) return current;
  const prevRepo = previous.repos[current.name];
  if (!prevRepo) return current;

  let carried = false;
  const result = { ...current };
  if (current.workflowStatus === null && prevRepo.workflowStatus !== null) {
    result.workflowStatus = prevRepo.workflowStatus;
    result.workflowLastRun = prevRepo.workflowLastRun;
    result._stale_since = prevRepo._stale_since || previous.timestamp;
    carried = true;
  }
  if (current.jobCount === null && prevRepo.jobCount !== null) {
    result.jobCount = prevRepo.jobCount;
    result._stale_since = prevRepo._stale_since || previous.timestamp;
    carried = true;
  }
  if (current.lastJobsUpdate === null && prevRepo.lastJobsUpdate !== null) {
    result.lastJobsUpdate = prevRepo.lastJobsUpdate;
    result._stale_since = prevRepo._stale_since || previous.timestamp;
    carried = true;
  }
  return result;
}

/**
 * Detect operational events by diffing current snapshot against previous.
 * @param {Object} current - Current metrics snapshot
 * @param {Object|null} previous - Previous metrics snapshot
 * @returns {Array<Object>} Detected events
 */
function detectEvents(current, previous) {
  if (!previous) return [];
  const events = [];
  const ts = current.timestamp;

  try {
    // Pool drops/rises
    const prevTotal = previous.pipeline?.pipelineTotal;
    const currTotal = current.pipeline?.pipelineTotal;
    if (prevTotal != null && currTotal != null) {
      const delta = currTotal - prevTotal;
      const pct = prevTotal > 0 ? Math.abs(delta / prevTotal) : 0;
      if (delta < -500 || (delta < 0 && pct > 0.05)) {
        events.push({ type: 'pool_drop', severity: 'high', module: 'AGG', details: { from: prevTotal, to: currTotal, delta, pct: Math.round(pct * 100) }, timestamp: ts });
      } else if (delta > 500) {
        events.push({ type: 'pool_rise', severity: 'info', module: 'AGG', details: { from: prevTotal, to: currTotal, delta }, timestamp: ts });
      }
    }

    // Source zero / recovered
    const prevSources = previous.pipeline?.bySource || {};
    const currSources = current.pipeline?.bySource || {};
    for (const src of new Set([...Object.keys(prevSources), ...Object.keys(currSources)])) {
      const prev = prevSources[src] ?? 0;
      const curr = currSources[src] ?? 0;
      if (prev > 20 && curr === 0) {
        events.push({ type: 'source_zero', severity: 'high', module: 'AGG', source: src, details: { from: prev, to: 0 }, timestamp: ts });
      } else if (prev === 0 && curr > 0) {
        events.push({ type: 'source_recovered', severity: 'info', module: 'AGG', source: src, details: { from: 0, to: curr }, timestamp: ts });
      }
    }

    // Enrichment rate shift
    const prevEnrTotal = previous.enrichment?.totalEnriched;
    const currEnrTotal = current.enrichment?.totalEnriched;
    const prevTechUs = previous.enrichment?.totalTechUs;
    const currTechUs = current.enrichment?.totalTechUs;
    if (prevEnrTotal && currEnrTotal && prevTechUs && currTechUs) {
      const prevRate = prevEnrTotal / prevTechUs;
      const currRate = currEnrTotal / currTechUs;
      const shiftPct = prevRate > 0 ? Math.abs((currRate - prevRate) / prevRate) : 0;
      if (shiftPct > 0.05) {
        events.push({ type: 'enrichment_shift', severity: 'medium', module: 'ENR', details: { from: Math.round(prevRate * 100) / 100, to: Math.round(currRate * 100) / 100, shiftPct: Math.round(shiftPct * 100) }, timestamp: ts });
      }
    }

    // Repo workflow status transitions
    for (const [name, repo] of Object.entries(current.repos || {})) {
      const prevRepo = previous.repos?.[name];
      if (!prevRepo) continue;
      if (prevRepo.workflowStatus === 'success' && repo.workflowStatus === 'failure') {
        events.push({ type: 'repo_failure', severity: 'high', module: 'OUT', repo: name, details: { workflow: 'update-jobs' }, timestamp: ts });
      } else if (prevRepo.workflowStatus === 'failure' && repo.workflowStatus === 'success') {
        events.push({ type: 'repo_recovered', severity: 'info', module: 'OUT', repo: name, details: { workflow: 'update-jobs' }, timestamp: ts });
      }
      if (repo._stale_since && !prevRepo._stale_since) {
        events.push({ type: 'repo_stale', severity: 'medium', module: 'OUT', repo: name, details: { stale_since: repo._stale_since }, timestamp: ts });
      }
    }

    // Star milestones
    for (const [name, repo] of Object.entries(current.repos || {})) {
      const prevStars = previous.repos?.[name]?.stars;
      const currStars = repo.stars;
      if (prevStars == null || currStars == null) continue;
      const milestones = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
      for (const m of milestones) {
        if (prevStars < m && currStars >= m) {
          events.push({ type: 'star_milestone', severity: 'info', module: 'OUT', repo: name, details: { milestone: m, stars: currStars }, timestamp: ts });
        }
      }
    }
  } catch (err) {
    // Non-fatal — event detection never breaks metrics collection
  }

  return events;
}

/**
 * Compute growth trends by comparing current pipeline metrics against a 7-day-old snapshot.
 * @param {Object|null} currentPipeline - Current pipeline metrics
 * @param {Array<Object>|null} historyLines - Parsed history entries (newest first)
 * @returns {Object|null} Growth trend data or null if insufficient data
 */
function computeGrowthTrend(currentPipeline, historyLines) {
  if (!historyLines || historyLines.length < 2 || !currentPipeline) return null;

  const now = Date.now();
  const TARGET_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  let best = null;
  let bestDiff = Infinity;
  for (const snap of historyLines) {
    const age = now - new Date(snap.timestamp).getTime();
    const diff = Math.abs(age - TARGET_AGE_MS);
    if (diff < bestDiff) { bestDiff = diff; best = snap; }
  }

  if (!best || bestDiff > TARGET_AGE_MS) return null;

  const prevTotal = best.pipeline?.pipelineTotal ?? null;
  const currTotal = currentPipeline.pipelineTotal ?? null;
  const prevBySource = best.pipeline?.bySource ?? {};
  const currBySource = currentPipeline.bySource ?? {};

  const totalDelta = (currTotal !== null && prevTotal !== null) ? currTotal - prevTotal : null;
  const bySourceDelta = {};
  for (const src of new Set([...Object.keys(prevBySource), ...Object.keys(currBySource)])) {
    const prev = prevBySource[src] ?? 0;
    const curr = currBySource[src] ?? 0;
    bySourceDelta[src] = curr - prev;
  }

  return {
    compared_to: best.timestamp,
    total_delta: totalDelta,
    total_delta_pct: (prevTotal && totalDelta !== null) ? Math.round((totalDelta / prevTotal) * 100) : null,
    by_source_delta: bySourceDelta,
  };
}

module.exports = { carryForwardMetric, mergeWithPrevious, detectEvents, computeGrowthTrend };
