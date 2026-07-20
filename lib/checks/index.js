/**
 * Pipeline Alert Checks — auto-loaded index
 *
 * Each check module exports: { id, name, check(ctx) }
 * check() returns a failure string or null.
 * Checks 1-3, 13, 16-18 are async (API calls). Others are sync.
 */

const checks = [
  require('./check-01-fetch-stale'),
  require('./check-02-discord-failed'),
  require('./check-03-consumer-failed'),
  require('./check-04-job-drop'),
  require('./check-05-source-drop'),
  require('./check-06-healthcare-drift'),
  require('./check-07-us-tagger'),
  require('./check-09-domain-empty'),
  // check-10-senior-filter RETIRED (EXPAND-1 Phase 2, 2026-07-09): the pipeline senior
  // filter was removed — seniors are now EXPECTED in the pool by design. check-10 detected
  // "senior filter bypass" (high senior rate) which would now always fire (false alert).
  // Module + dedicated tests kept for reference/rollback. A future "tagging health" check
  // could replace this if senior-rate anomalies need monitoring post-Phase-2.
  // require('./check-10-senior-filter'),
  require('./check-11-g1-rate'),
  require('./check-12-enrich-coverage'),
  require('./check-13-runtime'),
  require('./check-14-fetcher-silent'),
  require('./check-15-enrich-sanity'),
  require('./check-16-p2-drift'),
  require('./check-17-bump-failed'),
  require('./check-18-consumer-stale'),
  require('./check-19-zero-yield'),
  require('./check-20-carryforward-stale'),
  require('./check-21-dedupe-size'),
  require('./check-22-metadata-completeness'),
  require('./check-23-description-coverage'),
  require('./check-24-fp-rate-trend'),
  require('./check-25-r2-freshness'),
  require('./check-26-sidecar-growth'),
  require('./check-27-source-fetch-failure'),
  require('./check-28-cancel-rate'),
  require('./check-29-wd-429-alert'),
  require('./check-30-enrich-quality-regression'),
  require('./check-31-worker-dispatch-liveness'),
  require('./check-32-enrichment-source-regression'),  // ENR-DETECT-ARCH-1 (per-source retrievable regression)
  require('./check-33-sidecar-integrity'),  // ENR-SIDECAR-INTEGRITY-CHECK-1 (empty-write detection)
];

module.exports = checks;