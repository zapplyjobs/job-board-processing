/**
 * Pipeline Alert Configuration
 *
 * All thresholds and constants centralized here.
 * Checks import from this file — no hardcoded thresholds in check logic.
 */

const CONSUMER_REPOS = [
  'New-Grad-Jobs-2027',
  'Internships-2027',
  'New-Grad-Software-Engineering-Jobs-2027',
  'New-Grad-Data-Science-Jobs-2027',
  'New-Grad-Hardware-Engineering-Jobs-2027',
  'New-Grad-Healthcare-Jobs-2027',
];

const P2_REPOS = [
  'zapplyjobs/jobs-aggregator-private',
  'zapplyjobs/jobs-data-2026',
  'zapplyjobs/New-Grad-Jobs-2027',
  'zapplyjobs/Internships-2027',
  'zapplyjobs/New-Grad-Software-Engineering-Jobs-2027',
  'zapplyjobs/New-Grad-Data-Science-Jobs-2027',
  'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2027',
  'zapplyjobs/New-Grad-Healthcare-Jobs-2027',
];

const CUSTOM_FETCHERS = ['apple', 'twosigma', 'amazon', 'netflix', 'google', 'uber', 'simplify', 'microsoft', 'oracle', 'amd'];
const KEY_DOMAINS = ['software', 'data_science', 'hardware', 'healthcare', 'ai'];
const TECH_DOMAINS = ['software', 'data_science', 'hardware', 'ai'];
// Sources where low skills% is structural (vague descriptions, no descriptions, or version-mixing during re-enrichment)
const STRUCTURALLY_LOW_SKILLS = new Set(['simplify', 'apple', 'google', 'jsearch', 'microsoft', 'oracle', 'eightfold', 'uber']);  // AGG-UBER-DESC-API-1 (2026-07-19): uber API stopped returning descriptions in search results; 0% skills is now structural, not a regression. Mirrors A212's NO_SIDECAR_SOURCES.structural addition (commit 75c88d5).
// Sources where low retrievable_description_pct is structural (short platform descriptions only, no missing-sidecar gap).
// ENR-ORACLE-RETRIEVABLE-DISCREPANCY-1 (2026-07-19): originally added oracle here based on MEDIAN desc len = 131 chars.
// OPERATOR AUDIT caught this as shallow — full sampling showed oracle has a MIX: 25% MISSING from sidecar
// (real coverage gap, same class as workday race — see AGG-SIDECAR-VOLATILITY-ARCH-1), 45% short text
// (true structural), 30% healthy. The exemption was masking the real 25% coverage gap. REVERSED.
// To re-add a source here, sample its t0 jobs FIRST and confirm they're short-text, not missing-sidecar.
const STRUCTURALLY_LOW_RETRIEVABLE = new Set([]);

// Sources that don't use sidecar files for description-coverage alerting.
// AGG-ORACLE-DESC-1 (2026-07-18): `inline` set RETIRED (now empty). AGG strips ALL descriptions
// from all_jobs at Step 9 merge — every source is sidecar-dependent. The inline classification
// was obsolete since that strip happened; keeping it caused check-23 to silently skip oracle's
// empty-sidecar regression for 6+ days. See also ENR-DETECT-ARCH-1 for the broader analysis.
// To re-add a source here, justify why its sidecar SHOULDN'T be monitored; default = monitor all.
const NO_SIDECAR_SOURCES = {
  inline: new Set(),
  enriched: new Set(['workday']),        // descriptions-enriched-*.jsonl, not descriptions-workday.jsonl
  structural: new Set(['simplify', 'eightfold', 'jsearch', 'smartrecruiters', 'uber']),  // SR: listing API has no descriptions; uber: custom fetcher produces title+URL only (no description path)
  // A101: Disabled fetchers — suppress sidecar coverage alerts while fetchers are off.
  // Jobs drain via TTL. Remove when fetchers are re-enabled.
  disabled: new Set(['apple', 'google']),
};

// Companies known to have zero entry-level tech-US jobs (senior-only, verified)
// Suppresses zero-yield alerts for companies where the pipeline correctly filters all their jobs
const KNOWN_ZERO_YIELD = new Set(['Sonos', 'Reach Financial', 'Deep Genomics', 'InterDigital']);

module.exports = {
  CONSUMER_REPOS,
  P2_REPOS,
  CUSTOM_FETCHERS,
  KEY_DOMAINS,
  TECH_DOMAINS,
  STRUCTURALLY_LOW_SKILLS,
  STRUCTURALLY_LOW_RETRIEVABLE,
  NO_SIDECAR_SOURCES,
  KNOWN_ZERO_YIELD,

  thresholds: {
    staleRunMinutes: 30,
    jobDropPct: 0.60,
    sourceDropPct: 0.40,
    healthcarePct: 0.30,
    seniorFilterPct: 0.05,
    g1GeneralPct: 30,
    enrichCoveragePct: 0.70,  // restored — enrichment at 77.6% (was temp 0.50 during backfill)
    enrichT3MinPct: 0.70,
    enrichT0MaxPct: 0.15,
    enrichSkillsMinPct: 0.50,
    runtimeExecutionMin: 10,
    runtimeWallMin: 14,
    consumerStaleHours: 2,
    zeroYieldStreak: 3,
    patDaysLeft: 7,
    bumpFailureWindowMin: 60,
    dedupeStoreMbWarning: 10,
    dedupeStoreMbCatastrophic: 20,
    sourceFetchFloor: 50,  // A91: min pool size to alert when fetch produces 0 (catches Google/Apple timeout scenario)
    r2StaleMinutes: 60,
    cancelRatePct: 0.50,
    enrichRetrievableMin: 80,  // ENR-MONITOR-1: min retrievable_description_pct
    enrichWciMin: 80,          // ENR-MONITOR-1: min weighted_completeness_index
    enrichSilentRotMax: 3000,  // ENR-MONITOR-1: max silent_rot_count
    workerDispatchMaxMinutes: 45,  // INF-WORKER-RELIABILITY-1: max minutes since last Worker workflow_dispatch on fetch-jobs (Worker fires every 15m; 45m = 3 missed ticks)
    enrichPerSourceMinJobs: 50,    // ENR-DETECT-ARCH-1 (check-32): min tech-US jobs per source to alert
    enrichPerSourceMinPct: 0.90,   // ENR-DETECT-ARCH-1 (check-32): per-source retrievable rate floor
  },

  warnings: {
    jobDropPct: 0.80,
    sourceDropPct: 0.70,
    healthcarePct: 0.20,
    seniorFilterPct: 0.03,
    g1GeneralPct: 25,
    enrichCoveragePct: 0.80,
    enrichT3MinPct: 0.80,
    runtimeExecutionMin: 7,
    runtimeWallMin: 12,
    consumerStaleHours: 1,
    r2StaleMinutes: 30,
    cancelRatePct: 0.30,
  },
};
