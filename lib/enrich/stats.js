'use strict';

const fs = require('fs');
const path = require('path');

const TECH_DOMAINS = new Set(['software', 'data_science', 'hardware', 'ai']);

// Tier classification for a single enriched record
function classifyTier(obj) {
  const hasDesc = !!obj.has_description;
  const hasSkills = obj.required_skills?.length > 0;
  const hasDegree = obj.min_degree !== null && obj.min_degree !== undefined;
  const hasVisa = obj.sponsors_visa !== null || obj.visa_question_present !== null || obj.possible_sponsor !== null;

  if (!hasDesc) return 0;
  if (!hasSkills) return 1;
  if (hasDegree && hasVisa) return 4;
  if (hasDegree) return 3;
  return 2;
}

function generateStats(ctx) {
  const { allJobs, finalLines, descriptionsMap, DATA_DIR, ENRICHER_VERSION, descWaiting, reenrichmentPending } = ctx;

  const STATS_PATH = path.join(DATA_DIR, 'enrichment-stats.json');
  const TRUTH_PATH = path.join(DATA_DIR, 'tech-us-truth.json');
  const statsBySource = {};
  const descIdsBySource = {};

  // Build per-source counts from all_jobs.json pool
  for (const job of allJobs) {
    const src = job.source || 'unknown';
    if (!statsBySource[src]) {
      statsBySource[src] = { total: 0, tech_us: 0, has_desc: 0, enriched: 0,
        required_skills: 0, sponsors_visa: 0, sponsors_visa_true: 0, sponsors_visa_false: 0,
        question_count: 0, min_degree: 0, experience_level_from_desc: 0,
        possible_sponsor: 0, possible_sponsor_true: 0, possible_sponsor_false: 0,
        any_visa_signal: 0, visa_question_present: 0, visa_question_present_true: 0, visa_question_present_false: 0,
        actual_job_signal: 0, lca_only_signal: 0, no_visa_signal: 0, visa_explained_gaps: 0, visa_reason_counts: {} };
      descIdsBySource[src] = new Set();
    }
    statsBySource[src].total++;
    const domains = job.tags?.domains || [];
    const locs = job.tags?.locations || [];
    if (domains.some(d => TECH_DOMAINS.has(d)) && locs.includes('us')) {
      statsBySource[src].tech_us++;
      if (descriptionsMap.get(job.id)) descIdsBySource[src].add(job.id);
    }
  }

  // tech+US ID set + domain/location maps for dimensional breakdown
  const techUsIds = new Set();
  const jobDomainMap = new Map();
  const jobLocationMap = new Map();
  for (const j of allJobs) {
    const domains = j.tags?.domains || [];
    const locs = j.tags?.locations || [];
    if (domains.some(d => TECH_DOMAINS.has(d)) && locs.includes('us')) {
      techUsIds.add(j.id);
      const techDomain = domains.find(d => TECH_DOMAINS.has(d));
      if (techDomain) jobDomainMap.set(j.id, techDomain);
      jobLocationMap.set(j.id, locs);
    }
  }

  // Current tech-US records that are missing from enriched output
  const enrichedIdSet = new Set();

  // Per-company stats, tier classification, version breakdown
  const companyMap = {};
  const tiersBySource = {};
  const tiersByDomain = {};
  const tiersByLocation = {};
  let totalT0 = 0, totalT1 = 0, totalT2 = 0, totalT3 = 0, totalT4 = 0;
  const versionCounts = {};

  for (const line of finalLines) {
    try {
      const obj = JSON.parse(line);
      if (!techUsIds.has(obj.id)) continue;
      const src = obj.source || 'unknown';
      if (!statsBySource[src]) continue;
      statsBySource[src].enriched++;
      enrichedIdSet.add(obj.id);
      if (obj.has_description) descIdsBySource[src].add(obj.id);
      if (obj.required_skills?.length > 0) statsBySource[src].required_skills++;
      if (obj.sponsors_visa !== null) statsBySource[src].sponsors_visa++;
      if (obj.sponsors_visa === true) statsBySource[src].sponsors_visa_true++;
      if (obj.sponsors_visa === false) statsBySource[src].sponsors_visa_false++;
      if (obj.question_count !== null) statsBySource[src].question_count++;
      if (obj.min_degree !== null && obj.min_degree !== undefined) statsBySource[src].min_degree++;
      if (obj.experience_level_from_desc !== null && obj.experience_level_from_desc !== undefined) statsBySource[src].experience_level_from_desc++;
      if (obj.possible_sponsor !== null) statsBySource[src].possible_sponsor++;
      if (obj.possible_sponsor === true) statsBySource[src].possible_sponsor_true++;
      if (obj.possible_sponsor === false) statsBySource[src].possible_sponsor_false++;
      if (obj.visa_question_present !== null) statsBySource[src].visa_question_present++;
      if (obj.visa_question_present === true) statsBySource[src].visa_question_present_true++;
      if (obj.visa_question_present === false) statsBySource[src].visa_question_present_false++;
      if (obj.visa_no_signal_reason !== null && obj.visa_no_signal_reason !== undefined) {
        statsBySource[src].visa_explained_gaps++;
        statsBySource[src].visa_reason_counts[obj.visa_no_signal_reason] = (statsBySource[src].visa_reason_counts[obj.visa_no_signal_reason] || 0) + 1;
      }
      const hasSponsorOrForm = obj.sponsors_visa !== null || obj.visa_question_present !== null;
      const hasLca = obj.possible_sponsor !== null;
      if (hasSponsorOrForm || hasLca) statsBySource[src].any_visa_signal++;
      if (hasSponsorOrForm) statsBySource[src].actual_job_signal++;
      else if (hasLca) statsBySource[src].lca_only_signal++;
      else statsBySource[src].no_visa_signal++;

      // Tier classification
      const tier = classifyTier(obj);
      if (!tiersBySource[src]) tiersBySource[src] = { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0 };
      tiersBySource[src][`t${tier}`]++;

      // Tier by domain
      const domain = jobDomainMap.get(obj.id);
      if (domain) {
        if (!tiersByDomain[domain]) tiersByDomain[domain] = { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0 };
        tiersByDomain[domain][`t${tier}`]++;
      }

      // Tier by location (state-level from job tags)
      const locs = jobLocationMap.get(obj.id) || [];
      for (const loc of locs) {
        if (loc === 'us') continue;
        if (!tiersByLocation[loc]) tiersByLocation[loc] = { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0 };
        tiersByLocation[loc][`t${tier}`]++;
      }

      if (tier === 0) totalT0++; else if (tier === 1) totalT1++; else if (tier === 2) totalT2++; else if (tier === 3) totalT3++; else totalT4++;

      // Version counts
      const ver = obj.enricher_version || 0;
      versionCounts[ver] = (versionCounts[ver] || 0) + 1;

      // Per-company tracking
      const co = obj.company_name || 'Unknown';
      if (!companyMap[co]) companyMap[co] = { source: src, enriched: 0, has_skills: 0, has_desc: 0, has_degree: 0, has_visa: 0, has_any_visa: 0, t3: 0, t3_plus: 0 };
      companyMap[co].enriched++;
      if (obj.required_skills?.length > 0) companyMap[co].has_skills++;
      const hasDesc = !!obj.has_description;
      if (hasDesc) companyMap[co].has_desc++;
      const hasDegree = obj.min_degree !== null && obj.min_degree !== undefined;
      if (hasDegree) companyMap[co].has_degree++;
      if (obj.sponsors_visa !== null) companyMap[co].has_visa++;
      const hasVisa = obj.sponsors_visa !== null || obj.visa_question_present !== null || obj.possible_sponsor !== null;
      if (hasVisa) companyMap[co].has_any_visa++;
      if (tier === 3) companyMap[co].t3++;
      if (tier >= 3) companyMap[co].t3_plus = (companyMap[co].t3_plus || 0) + 1;
    } catch (_) {}
  }

  for (const [src, ids] of Object.entries(descIdsBySource)) {
    if (statsBySource[src]) statsBySource[src].has_desc = ids.size;
  }


  // Top 30 companies by enriched count
  const byCompany = Object.entries(companyMap)
    .sort((a, b) => b[1].enriched - a[1].enriched)
    .slice(0, 30)
    .map(([co, s]) => ({
      company: co, source: s.source, enriched: s.enriched,
      skills_pct: Math.round(100 * s.has_skills / s.enriched),
      desc_pct: Math.round(100 * s.has_desc / s.enriched),
      degree_pct: Math.round(100 * s.has_degree / s.enriched),
      visa_pct: Math.round(100 * s.has_any_visa / s.enriched),
      t3_pct: Math.round(100 * s.t3 / s.enriched),
    }));

  // Per-company funnel
  const funnelMap = {};
  for (const job of allJobs) {
    const co = job.company_name || 'Unknown';
    const src = job.source || 'unknown';
    const domains = job.tags?.domains || [];
    const locations = job.tags?.locations || [];
    const isTechUs = domains.some(d => TECH_DOMAINS.has(d)) && locations.includes('us');
    const pm = ctx.processedMap[job.id];

    if (!funnelMap[co]) {
      funnelMap[co] = { company: co, source: src, total_fetched: 0, tech_us: 0, non_tech_skipped: 0, non_us_skipped: 0, desc_waiting: 0, enriched: 0, t0: 0, t1: 0, t2: 0, t3: 0 };
    }
    funnelMap[co].total_fetched++;
    if (isTechUs) funnelMap[co].tech_us++;

    if (pm && pm.status === 'skipped') {
      if (pm.reason === 'non-tech') funnelMap[co].non_tech_skipped++;
      else if (pm.reason === 'non-us') funnelMap[co].non_us_skipped++;
    }
    if (!pm && (src === 'workday' || src === 'smartrecruiters') && isTechUs && !descriptionsMap.get(job.id)) {
      funnelMap[co].desc_waiting++;
    }
  }
  for (const [co, s] of Object.entries(companyMap)) {
    if (funnelMap[co]) {
      funnelMap[co].enriched = s.enriched;
      funnelMap[co].t0 = s.enriched - s.has_desc;
      funnelMap[co].t1 = s.has_desc - s.has_skills;
      funnelMap[co].t3 = s.t3;
      funnelMap[co].t2 = s.enriched - funnelMap[co].t0 - funnelMap[co].t1 - funnelMap[co].t3;
    }
  }
  const companyFunnel = Object.values(funnelMap)
    .filter(f => f.tech_us > 0)
    .sort((a, b) => b.tech_us - a.tech_us);

  const totalTechUs = Object.values(statsBySource).reduce((s, v) => s + v.tech_us, 0);
  const totalEnriched = Object.values(statsBySource).reduce((s, v) => s + v.enriched, 0);
  const totalHasDesc = Object.values(statsBySource).reduce((s, v) => s + v.has_desc, 0);
  const totalSkills = Object.values(statsBySource).reduce((s, v) => s + v.required_skills, 0);

  // Stuck-record detection
  const QUAL_MARKERS = ['minimum qualifications', 'preferred qualifications', 'basic qualifications'];
  const stuckRecords = [];
  const googleAppleEnriched = new Map();
  for (const line of finalLines) {
    try {
      const obj = JSON.parse(line);
      if ((obj.id?.startsWith('google-') || obj.id?.startsWith('apple-')) && techUsIds.has(obj.id)) {
        googleAppleEnriched.set(obj.id, obj);
      }
    } catch (_) {}
  }
  for (const [id, desc] of descriptionsMap) {
    if (!(id.startsWith('google-') || id.startsWith('apple-')) || !desc) continue;
    const low = desc.toLowerCase();
    if (!QUAL_MARKERS.some(m => low.includes(m))) continue;
    const rec = googleAppleEnriched.get(id);
    if (rec && rec.enricher_version > 0) {
      const tier = classifyTier(rec);
      if (tier < 3) stuckRecords.push({ id, source: rec.source || 'unknown', tier, version: rec.enricher_version });
    }
  }
  if (stuckRecords.length > 0) console.log(`[enrich-jobs] Stuck records: ${stuckRecords.length} (qualification-rich desc but below T3)`);

  const missingCurrentBySource = {};
  const missingCurrentByStatus = {};
  const missingCurrentByCompany = {};
  for (const job of allJobs) {
    if (!techUsIds.has(job.id)) continue;
    if (enrichedIdSet.has(job.id)) continue;
    const src = job.source || 'unknown';
    const status = ctx.processedMap?.[job.id]?.status || 'unprocessed';
    missingCurrentBySource[src] = (missingCurrentBySource[src] || 0) + 1;
    missingCurrentByStatus[status] = (missingCurrentByStatus[status] || 0) + 1;
    const company = job.company_name || 'Unknown';
    missingCurrentByCompany[company] = (missingCurrentByCompany[company] || 0) + 1;
  }

  const enrichmentStats = {
    enricher_version: ENRICHER_VERSION,
    generated: new Date().toISOString(),
    total_tech_us: totalTechUs,
    total_enriched: totalEnriched,
    total_has_description: totalHasDesc,
    desc_waiting: descWaiting,
    reenrichment_pending: reenrichmentPending,
    tiers: { t0: totalT0, t1: totalT1, t2: totalT2, t3: totalT3, t4: totalT4 },
    tiers_by_source: tiersBySource,
    tiers_by_domain: tiersByDomain,
    tiers_by_location: tiersByLocation,
    by_version: versionCounts,
    by_source: Object.fromEntries(
      Object.entries(statsBySource).map(([src, v]) => {
        const e = v.enriched || 1;
        return [src, { ...v,
          skills_pct: Math.round(100 * v.required_skills / e),
          degree_pct: Math.round(100 * v.min_degree / e),
          visa_pct: Math.round(100 * v.any_visa_signal / e),
          actual_job_signal_pct: Math.round(100 * v.actual_job_signal / e),
          lca_only_signal_pct: Math.round(100 * v.lca_only_signal / e),
          no_visa_signal_pct: Math.round(100 * v.no_visa_signal / e),
        }];
      })
    ),
    by_company: byCompany,
    current_missing: {
      total: Object.values(missingCurrentBySource).reduce((s, v) => s + v, 0),
      by_source: missingCurrentBySource,
      by_status: missingCurrentByStatus,
      top_companies: Object.entries(missingCurrentByCompany)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([company, count]) => ({ company, count })),
    },
    company_funnel: companyFunnel,
    stuck_records: { count: stuckRecords.length, sample: stuckRecords.slice(0, 10) },
  };

  fs.writeFileSync(STATS_PATH, JSON.stringify(enrichmentStats, null, 2), 'utf8');
  console.log(`[enrich-jobs] enrichment-stats.json written (${totalEnriched}/${totalTechUs} enriched, ${totalHasDesc} have description)`);

  const techUsTruth = {
    schema: 'tech-us-truth-v1',
    generated: enrichmentStats.generated,
    enricher_version: ENRICHER_VERSION,
    denominator: {
      source_artifact: 'all_jobs.json',
      pool_total_jobs: allJobs.length,
      tech_us_total_jobs: totalTechUs,
      logic: {
        tech_domains: Array.from(TECH_DOMAINS),
        location_tag_required: 'us',
        match_rule: 'job.tags.domains intersects tech_domains AND job.tags.locations contains us',
      },
      by_source: Object.fromEntries(
        Object.entries(statsBySource).map(([src, v]) => [src, {
          total_jobs: v.total,
          tech_us_jobs: v.tech_us,
          tech_us_with_description: v.has_desc,
        }])
      ),
    },
    numerator: {
      source_artifact: 'enriched_jobs.json',
      enriched_total_jobs: totalEnriched,
      enriched_with_description: totalHasDesc,
      t3_t4_total_jobs: totalT3 + totalT4,
      reenrichment_pending: reenrichmentPending,
    },
  };
  fs.writeFileSync(TRUTH_PATH, JSON.stringify(techUsTruth, null, 2), 'utf8');
  console.log(`[enrich-jobs] tech-us-truth.json written (${totalTechUs} tech-US jobs, ${totalEnriched} enriched)`);


  // Append daily snapshot to enrichment-history.jsonl
  const HISTORY_PATH = path.join(DATA_DIR, 'enrichment-history.jsonl');
  const today = new Date().toISOString().slice(0, 10);
  let shouldAppend = true;
  if (fs.existsSync(HISTORY_PATH)) {
    const lines = fs.readFileSync(HISTORY_PATH, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        if (last.date === today) shouldAppend = false;
      } catch (_) {}
    }
  }
  if (shouldAppend) {
    const srcSummary = {};
    for (const [src, v] of Object.entries(statsBySource)) {
      srcSummary[src] = {
        enriched: v.enriched,
        skills_pct: v.enriched > 0 ? Math.round(100 * v.required_skills / v.enriched) : 0,
        degree_pct: v.enriched > 0 ? Math.round(100 * v.min_degree / v.enriched) : 0,
        exp_pct: v.enriched > 0 ? Math.round(100 * v.experience_level_from_desc / v.enriched) : 0,
        visa_pct: v.enriched > 0 ? Math.round(100 * v.any_visa_signal / v.enriched) : 0,
      };
    }
    const postedToday = {};
    for (const job of allJobs) {
      const pa = job.posted_at;
      if (pa && String(pa).startsWith(today)) {
        const src = job.source || 'unknown';
        postedToday[src] = (postedToday[src] || 0) + 1;
      }
    }
    const snapshot = {
      date: today,
      enricher_version: ENRICHER_VERSION,
      total_enriched: totalEnriched,
      total_tech_us: totalTechUs,
      pool_total: allJobs.length,
      skills_pct: totalEnriched > 0 ? Math.round(100 * totalSkills / totalEnriched) : 0,
      degree_pct: totalEnriched > 0 ? Math.round(100 * Object.values(statsBySource).reduce((s, v) => s + v.min_degree, 0) / totalEnriched) : 0,
      exp_pct: totalEnriched > 0 ? Math.round(100 * Object.values(statsBySource).reduce((s, v) => s + v.experience_level_from_desc, 0) / totalEnriched) : 0,
      visa_pct: totalEnriched > 0 ? Math.round(100 * Object.values(statsBySource).reduce((s, v) => s + v.any_visa_signal, 0) / totalEnriched) : 0,
      t3_pct: totalEnriched > 0 ? Math.round(100 * totalT3 / totalEnriched) : 0,
      tiers: { t0: totalT0, t1: totalT1, t2: totalT2, t3: totalT3, t4: totalT4 },
      reenrichment_pending: reenrichmentPending,
      posted_today: postedToday,
      by_source: srcSummary,
    };
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(snapshot) + '\n', 'utf8');
    console.log(`[enrich-jobs] enrichment-history.jsonl: appended snapshot for ${today}`);
  }

  return enrichmentStats;
}

module.exports = { generateStats, classifyTier, TECH_DOMAINS };
