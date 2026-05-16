/**
 * Pipeline Alert Configuration
 *
 * All thresholds and constants centralized here.
 * Checks import from this file — no hardcoded thresholds in check logic.
 */

const CONSUMER_REPOS = [
  'New-Grad-Jobs-2026',
  'Internships-2026',
  'New-Grad-Software-Engineering-Jobs-2026',
  'New-Grad-Data-Science-Jobs-2026',
  'New-Grad-Hardware-Engineering-Jobs-2026',
  'New-Grad-Healthcare-Jobs-2026',
];

const P2_REPOS = [
  'zapplyjobs/jobs-aggregator-private',
  'zapplyjobs/jobs-data-2026',
  'zapplyjobs/New-Grad-Jobs-2026',
  'zapplyjobs/Internships-2026',
  'zapplyjobs/New-Grad-Software-Engineering-Jobs-2026',
  'zapplyjobs/New-Grad-Data-Science-Jobs-2026',
  'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2026',
  'zapplyjobs/New-Grad-Healthcare-Jobs-2026',
];

const CUSTOM_FETCHERS = ['apple', 'twosigma', 'amazon', 'netflix', 'google', 'uber', 'simplify', 'microsoft', 'oracle', 'amd'];
const KEY_DOMAINS = ['software', 'data_science', 'hardware', 'healthcare', 'ai'];
const TECH_DOMAINS = ['software', 'data_science', 'hardware', 'ai'];
// Sources where low skills% is structural (vague descriptions, no descriptions, or version-mixing during re-enrichment)
const STRUCTURALLY_LOW_SKILLS = new Set(['simplify', 'apple', 'google', 'jsearch', 'microsoft', 'oracle']);

// Sources that don't use sidecar files (descriptions fetched inline or via enriched-*.jsonl)
const NO_SIDECAR_SOURCES = {
  inline: new Set(['greenhouse', 'lever', 'ashby', 'amazon', 'netflix', 'microsoft']),
  enriched: new Set(['workday']),        // descriptions-enriched-*.jsonl, not descriptions-workday.jsonl
  structural: new Set(['simplify', 'eightfold', 'jsearch']),  // no descriptions available
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
  NO_SIDECAR_SOURCES,
  KNOWN_ZERO_YIELD,

  thresholds: {
    staleRunMinutes: 30,
    jobDropPct: 0.60,
    sourceDropPct: 0.40,
    healthcarePct: 0.30,
    seniorFilterPct: 0.05,
    g1GeneralPct: 30,
    g1FallbackPct: 0.55,
    enrichCoveragePct: 0.70,
    enrichT3MinPct: 0.70,
    enrichT0MaxPct: 0.15,
    enrichSkillsMinPct: 0.50,
    runtimeExecutionMin: 8,
    runtimeWallMin: 12,
    consumerStaleHours: 2,
    zeroYieldStreak: 3,
    patDaysLeft: 7,
    bumpFailureWindowMin: 60,
    dedupeStoreMbWarning: 10,
    dedupeStoreMbCatastrophic: 20,
    r2StaleMinutes: 60,
  },

  warnings: {
    jobDropPct: 0.80,
    sourceDropPct: 0.70,
    healthcarePct: 0.20,
    seniorFilterPct: 0.03,
    g1GeneralPct: 25,
    enrichCoveragePct: 0.80,
    enrichT3MinPct: 0.80,
    runtimeExecutionMin: 5,
    runtimeWallMin: 10,
    consumerStaleHours: 1,
    r2StaleMinutes: 30,
  },
};
