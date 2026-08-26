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
    const p = snap.pipeline;
    // AGG-GROWTH-DELTA-REGRESS-1: skip baseline snapshots with null/missing pipeline metrics —
    // diffing against them yields delta = curr - 0 = count (misleading) + total_delta null.
    // A legitimately-empty bySource ({}) is kept; only null/undefined (data unavailable) is skipped.
    if (!p || p.pipelineTotal == null || p.bySource == null) continue;
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

/**
 * DASH-AGG-TRENDS-1 (2026-08-22): nested cross-tab trend series. For each
 * family (by_source_job_type / by_source_domain / by_domain_job_type) build
 * series[family][outerKey][innerKey] = number[] aligned to sortedDates.
 * Semantics match by_source: a day whose family object exists but lacks an
 * inner key = measured 0; a day without the family at all = null (gap).
 * Build-forward: days before the field existed (2026-08-22) stay null.
 */
function buildCrossTabSeries(dailyMap, sortedDates, families) {
  const fams = families ?? ['by_source_job_type', 'by_source_domain', 'by_domain_job_type'];
  const out = {};
  for (const family of fams) {
    const outerKeys = new Set();
    const innerKeys = new Set();
    for (const d of sortedDates) {
      const fam = dailyMap.get(d)?.cross_tabs?.[family];
      if (!fam) continue;
      for (const [outer, inner] of Object.entries(fam)) {
        outerKeys.add(outer);
        for (const innerKey of Object.keys(inner ?? {})) innerKeys.add(innerKey);
      }
    }
    if (outerKeys.size === 0) continue;
    // DASH-SIGNAL-METRICS-SIZE-GROWTH-1: cap the OUTER dimension at top-N by
    // latest populated total; the rest aggregate into `other` (inner-summed).
    // The dashboard renders top-10 selectors — the cap matches the visible
    // surface exactly, so no displayed information is lost while the payload
    // stays bounded as source/domain counts grow.
    const latestTotal = (outer) => {
      let best = -1;
      for (let i = sortedDates.length - 1; i >= 0; i -= 1) {
        const fam = dailyMap.get(sortedDates[i])?.cross_tabs?.[family];
        if (fam?.[outer]) { best = i; break; }
      }
      if (best < 0) return 0;
      const fam = dailyMap.get(sortedDates[best])?.cross_tabs?.[family];
      return Object.values(fam?.[outer] ?? {}).reduce((s, v) => s + (v ?? 0), 0);
    };
    const ranked = [...outerKeys].sort((a, b) => latestTotal(b) - latestTotal(a));
    const MAX_OUTERS = 10;
    const kept = ranked.slice(0, MAX_OUTERS);
    const rest = ranked.slice(MAX_OUTERS);
    const valueAt = (outer, inner, d) => {
      const fam = dailyMap.get(d)?.cross_tabs?.[family];
      if (!fam) return null;
      const row = fam[outer];
      return row ? (row[inner] ?? 0) : 0;
    };
    const familySeries = {};
    for (const outer of kept) {
      familySeries[outer] = {};
      for (const inner of innerKeys) {
        familySeries[outer][inner] = sortedDates.map(d => valueAt(outer, inner, d));
      }
    }
    if (rest.length > 0) {
      familySeries.other = {};
      for (const inner of innerKeys) {
        familySeries.other[inner] = sortedDates.map(d => {
          const vals = rest.map(o => valueAt(o, inner, d));
          if (vals.some(v => v === null)) return null;
          return vals.reduce((s, v) => s + (v ?? 0), 0);
        });
      }
    }
    out[family] = familySeries;
  }
  return out;
}

/**
 * Build daily trend arrays from history for DASH anomaly detection.
 * Deduplicates to one point per day (last entry wins) for clean trends.
 * INF-TREND-DATA-EXPANSION-1: trend families are sourced from the fields
 * captured in each history snapshot.
 * @param {Array<Object>|null} historyLines - Parsed history entries (any order)
 * @param {number} maxDays - Trailing days to include (default 30)
 * @returns {Object|null} Trend data, or null if fewer than 2 entries
 */
/**
 * DASH-TREND-PROGRAM-1 (2026-08-22): flat keyed-object trend series. For a
 * daily field that is {key: number} (freshness buckets, lifecycle totals,
 * conversion totals, status counts), build series[key] = number[] aligned to
 * sortedDates. Key-set = union across the window; a present object missing a
 * key = measured 0; a null object that day = gap (null).
 */
function buildNestedObjectSeries(dailyMap, sortedDates, field, innerKey) {
  const keys = new Set();
  for (const d of sortedDates) {
    const obj = dailyMap.get(d)?.[field]?.[innerKey];
    if (obj) for (const k of Object.keys(obj)) keys.add(k);
  }
  if (keys.size === 0) return undefined;
  const out = {};
  for (const k of keys) {
    out[k] = sortedDates.map(d => {
      const obj = dailyMap.get(d)?.[field]?.[innerKey];
      return obj ? (obj[k] ?? 0) : null;
    });
  }
  return out;
}

function buildObjectSeries(dailyMap, sortedDates, field) {
  const keys = new Set();
  for (const d of sortedDates) {
    const obj = dailyMap.get(d)?.[field];
    if (obj) for (const k of Object.keys(obj)) keys.add(k);
  }
  if (keys.size === 0) return undefined;
  const out = {};
  for (const k of keys) {
    out[k] = sortedDates.map(d => {
      const obj = dailyMap.get(d)?.[field];
      return obj ? (obj[k] ?? 0) : null;
    });
  }
  return out;
}

/**
 * DASH-TREND-PROGRAM-1: rate series from a nested {outer: {g1, total}} object
 * (per-source G1). series[outer] = rate%[] — null when the day or source is
 * absent, rate computed only when both g1 and total are present (total=0 with
 * g1=0 is a measured 0% only when the source existed that day).
 */
function buildRateSeries(dailyMap, sortedDates, field, pick, numKey = 'g1') {
  const outers = new Set();
  for (const d of sortedDates) {
    const obj = pick(dailyMap.get(d)?.[field]);
    if (obj) for (const k of Object.keys(obj)) outers.add(k);
  }
  if (outers.size === 0) return undefined;
  const out = {};
  for (const o of outers) {
    out[o] = sortedDates.map(d => {
      const row = pick(dailyMap.get(d)?.[field])?.[o];
      if (!row || row.total == null) return null;
      return row.total > 0 ? Math.round(((row[numKey] ?? 0) / row.total) * 1000) / 10 : 0;
    });
  }
  return out;
}
function computeTrendArrays(historyLines, maxDays = 30) {
  if (!historyLines || historyLines.length < 2) return null;

  // Map: date -> latest entry for that day (deduplicates sub-daily entries)
  const dailyMap = new Map();
  for (const snap of historyLines) {
    const date = snap?.timestamp?.slice(0, 10);
    if (!date) continue;
    const pool = snap.pipeline?.pipelineTotal ?? null;
    const techUs = snap.enrichment?.totalTechUs ?? null;
    const enriched = snap.enrichment?.totalEnriched ?? null;
    const hasDesc = snap.enrichment?.totalHasDescription ?? null;
    // INF-DESCCOVERAGE-OVER100-1 (2026-08-18): denominator was totalEnriched, but during
    // re-enrichment transitions (08-14 recovery, 08-18 v98 wave) totalHasDescription
    // temporarily EXCEEDS totalEnriched (fields sample different populations mid-transition)
    // -> impossible >100% trend values. The structurally-sound denominator is the tech-US
    // pool (hasDesc is a subset of it in all observed history). Still NOT the per-source
    // weighted retrievable_description_pct from enrichment-stats.json (live-only).
    const descCoveragePct = (hasDesc && techUs && techUs > 0) ? Math.round((hasDesc / techUs) * 100) : null;
    dailyMap.set(date, { pool_total: pool, pool_tech_us: techUs, desc_coverage_pct: descCoveragePct, by_source: snap.pipeline?.bySource ?? null, canada: snap.canada ?? null, tiers: snap.enrichment?.tiers ?? null, discord: snap.discord ?? null, cross_tabs: snap.pipeline?.crossTabs ?? null, g1: snap.pipeline?.g1Breakdown ?? null, freshness: snap.pipeline?.evergreen?.age_buckets ?? null, lifecycle: snap.pipeline?.lifecycleTotals ?? null, conversion: snap.pipeline?.conversionTotals ?? null, company_health: snap.pipeline?.companyHealth ?? null, consumers_freshness: snap.pipeline?.consumersFreshness ?? null, tag_precision: snap.pipeline?.tagPrecisionDomains ?? null, company_coverage: snap.pipeline?.companyCoverage ?? null, infra_growth: snap.pipeline?.infraGrowth ?? null, ats_reach: snap.pipeline?.atsReach ?? null });
  }

  const sortedDates = [...dailyMap.keys()].sort().slice(-maxDays);
  if (sortedDates.length === 0) return null;

  // Union of sources across the windowed days; each series aligns with `dates`.
  // A day whose by_source is present but a source is absent -> 0 (measured zero,
  // e.g. a source that died). A day whose by_source is null entirely -> null
  // (data unavailable that day, renders as a gap).
  const allSources = new Set();
  for (const d of sortedDates) {
    const bs = dailyMap.get(d).by_source;
    if (bs) for (const src of Object.keys(bs)) allSources.add(src);
  }
  const bySourceSeries = {};
  for (const src of allSources) {
    bySourceSeries[src] = sortedDates.map(d => {
      const bs = dailyMap.get(d).by_source;
      return bs ? (bs[src] ?? 0) : null;
    });
  }
  // INF-CANADA-TREND-1 → extended by INF-CANADATREND-LOGIC-1 (2026-08-20): canada trend,
  // tech lane (canada_total/canada_by_level from canada_tech_jobs + by_job_type) AND
  // all-lane (canada_jobs/canada_internships). Canonical metric definition: trends derive
  // from metrics/history.jsonl snapshot `canada` fields, written by collect-metrics from
  // the AGG canada-tech-summary artifact (which carries both lanes since 2026-08-20).
  // Build-forward only (all-lane fields are new — absent days = null gaps, never zero;
  // Nixtla missing-value semantics: absent observation ≠ measured zero).
  const canadaTotal = sortedDates.map(d => dailyMap.get(d).canada?.canada_tech_jobs ?? null);
  const canadaAllJobs = sortedDates.map(d => dailyMap.get(d).canada?.canada_jobs ?? null);
  const canadaAllInternships = sortedDates.map(d => dailyMap.get(d).canada?.canada_internships ?? null);
  const allLevels = new Set();
  for (const d of sortedDates) {
    const bj = dailyMap.get(d).canada?.by_job_type;
    if (bj) for (const lvl of Object.keys(bj)) allLevels.add(lvl);
  }
  const canadaByLevel = {};
  for (const lvl of allLevels) {
    canadaByLevel[lvl] = sortedDates.map(d => {
      const bj = dailyMap.get(d).canada?.by_job_type;
      return bj ? (bj[lvl] ?? null) : null;
    });
  }
  // INF-TREND-DATA-EXPANSION-1: tier distribution trend (per-tier arrays, like by_source).
  // Tiers = enrichment quality (t0=no data, t4=fully enriched). Backfills from existing
  // history (enrichment.tiers has been recorded since collect-metrics began).
  const allTiers = new Set();
  for (const d of sortedDates) {
    const t = dailyMap.get(d).tiers;
    if (t) for (const tier of Object.keys(t)) allTiers.add(tier);
  }
  const tierDistribution = {};
  for (const tier of allTiers) {
    tierDistribution[tier] = sortedDates.map(d => {
      const t = dailyMap.get(d).tiers;
      return t ? (t[tier] ?? null) : null;
    });
  }
  // INF-TREND-DATA-EXPANSION-1: Discord channel trend. A present snapshot with
  // an absent channel is a measured zero; a missing Discord snapshot is a gap.
  const allDiscordChannels = new Set();
  for (const d of sortedDates) {
    const byChannel = dailyMap.get(d).discord?.by_channel;
    if (byChannel) for (const channel of Object.keys(byChannel)) allDiscordChannels.add(channel);
  }
  const discordByChannel = {};
  for (const channel of allDiscordChannels) {
    discordByChannel[channel] = sortedDates.map(d => {
      const byChannel = dailyMap.get(d).discord?.by_channel;
      return byChannel ? (byChannel[channel] ?? 0) : null;
    });
  }
  return {
    dates: sortedDates,
    pool_total: sortedDates.map(d => dailyMap.get(d).pool_total),
    pool_tech_us: sortedDates.map(d => dailyMap.get(d).pool_tech_us),
    desc_coverage_pct: sortedDates.map(d => dailyMap.get(d).desc_coverage_pct),
    by_source: bySourceSeries,
    canada_total: canadaTotal,
    canada_jobs: canadaAllJobs,
    canada_internships: canadaAllInternships,
    canada_by_level: canadaByLevel,
    tier_distribution: tierDistribution,
    discord_by_channel: discordByChannel,
    // DASH-AGG-TRENDS-1 (2026-08-22, operator-directed): cross-tab trends from
    // history snapshots' pipeline.crossTabs (by_source_job_type /
    // by_source_domain / by_domain_job_type — written by collect-metrics since
    // 2026-08-22; earlier days are null gaps, build-forward). Nested per outer
    // key like by_source: series[family][outer][inner] aligns with `dates`.
    // Outer present + inner absent = measured zero; family absent = gap.
    cross_tabs: buildCrossTabSeries(dailyMap, sortedDates),
    // DASH-TREND-PROGRAM-1 (2026-08-22): trend families for the widget-conversion
    // program. freshness_buckets backfills from EXISTING history; the rest build
    // forward. g1_by_source + consumers_freshness REMOVED 2026-08-25 (INF-PAYLOADTRIM-DEADFIELDS-1:
    // zero consumers anywhere; g1_by_source superseded by fp_by_domain-class rate series, consumers_freshness by E2E table+alerts).
    freshness_buckets: buildObjectSeries(dailyMap, sortedDates, 'freshness'),
    lifecycle: buildObjectSeries(dailyMap, sortedDates, 'lifecycle'),
    conversion: buildObjectSeries(dailyMap, sortedDates, 'conversion'),
    company_health: buildObjectSeries(dailyMap, sortedDates, 'company_health'),
    // DASH-TREND-PROGRAM-1 (2026-08-23): per-domain TAG FP-rate trend
    // (operator-directed conversion; build-forward from 2026-08-23).
    fp_by_domain: buildRateSeries(dailyMap, sortedDates, 'tag_precision', s => s, 'fps'),
    // DASH-TREND-PROGRAM-1 (2026-08-23): distinct-company coverage families
    // (operator principle: trend widgets START the data recording).
    companies_by_domain: buildNestedObjectSeries(dailyMap, sortedDates, 'company_coverage', 'by_domain'),
    companies_by_level: buildNestedObjectSeries(dailyMap, sortedDates, 'company_coverage', 'by_level'),
    distinct_companies: sortedDates.map(d => dailyMap.get(d)?.company_coverage?.distinct_companies ?? null),
    infra_growth: buildObjectSeries(dailyMap, sortedDates, 'infra_growth'),
    ats_reach: buildObjectSeries(dailyMap, sortedDates, 'ats_reach'),
    // AUDIT FIX 2026-08-23: the /canada Domain Lanes widget shipped with the
    // history-row field but this builder call missing — the family was absent
    // from trends (widget stuck on its empty state). by_domain lives inside
    // the canada snapshot; extract flat via the pick-style accessor.
    canada_by_source: (() => {
      const sources = new Set();
      for (const d of sortedDates) {
        const bs = dailyMap.get(d).canada?.by_source;
        if (bs) for (const k of Object.keys(bs)) sources.add(k);
      }
      if (sources.size === 0) return undefined;
      const out = {};
      for (const k of sources) {
        out[k] = sortedDates.map(d => {
          const bs = dailyMap.get(d).canada?.by_source;
          return bs ? (bs[k] ?? 0) : null;
        });
      }
      return out;
    })(),
    canada_by_domain: (() => {
      const domains = new Set();
      for (const d of sortedDates) {
        const bd = dailyMap.get(d).canada?.by_domain;
        if (bd) for (const k of Object.keys(bd)) domains.add(k);
      }
      if (domains.size === 0) return undefined;
      const out = {};
      for (const k of domains) {
        out[k] = sortedDates.map(d => {
          const bd = dailyMap.get(d).canada?.by_domain;
          return bd ? (bd[k] ?? 0) : null;
        });
      }
      return out;
    })(),
  };
}



/**
 * INF-LATENCY-TRENDS-WIDGET-1 (2026-08-19): per-stage pipeline latency trends.
 * Input: latency-history.jsonl rows { ts, stages: { fetch, enrich, metrics, discord, publisher } }
 * (duration minutes; null = unknown that cycle). Output: daily means per stage, trailing
 * maxDays, same gap semantics as the other trend series (null day = no data, renders as gap).
 * Bridge legs are v2 — the dev team's bridge-metrics history writer is broken since 08-03.
 */
function computeLatencyTrends(lines, maxDays = 30) {
  const byDay = new Map(); // date -> { stage -> [minutes] }
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const d = (j.ts || '').slice(0, 10);
    if (!d || !j.stages) continue;
    if (!byDay.has(d)) byDay.set(d, {});
    const day = byDay.get(d);
    for (const [stage, min] of Object.entries(j.stages)) {
      if (Number.isFinite(Number(min))) {
        (day[stage] = day[stage] || []).push(Number(min));
      }
    }
  }
  const dates = [...byDay.keys()].sort().slice(-maxDays);
  const stages = {};
  const stageNames = new Set();
  for (const d of dates) for (const s of Object.keys(byDay.get(d))) stageNames.add(s);
  for (const s of stageNames) {
    stages[s] = dates.map((d) => {
      const vals = (byDay.get(d) || {})[s];
      if (!vals || vals.length === 0) return null;
      return Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 10) / 10;
    });
  }
  if (dates.length === 0) return null;
  return { dates, stages };
}

module.exports = {
  computeLatencyTrends, carryForwardMetric, mergeWithPrevious, detectEvents, computeGrowthTrend, computeTrendArrays };
