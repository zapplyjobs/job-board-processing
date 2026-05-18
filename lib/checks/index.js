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
  require('./check-10-senior-filter'),
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
];

module.exports = checks;