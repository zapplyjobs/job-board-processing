/**
 * Check 27: Source fetch failure — source has pool entries but fetched 0 jobs
 *
 * Detects when a source produces 0 fresh jobs in the current run despite having
 * entries in the pool (from carry-forward). This catches timeout failures, broken
 * HTML extraction, and API changes that would otherwise be invisible because
 * carry-forward keeps the pool count stable.
 *
 * Origin: Google and Apple both produced 0 jobs for 5+ days (May 14-18, 2026)
 * while carrying forward 400+300 stale entries. Check 5 (source-drop) and check 14
 * (fetcher-silent) both use pool-level counts (by_source) and didn't detect the
 * failure because carry-forward masked it.
 */
module.exports = {
  id: 27,
  name: 'source fetch failure',
  check(ctx) {
    if (!ctx.metadata) return null;
    const fetchResults = ctx.metadata.fetch_results || {};
    const poolBySource = ctx.metadata.by_source || {};
    const threshold = ctx.config.thresholds.sourceFetchFloor;
    const failures = [];

    // All known sources (union of fetch_results and by_source keys)
    const allSources = new Set([...Object.keys(fetchResults), ...Object.keys(poolBySource)]);

    for (const source of allSources) {
      const fetched = fetchResults[source] ?? null;
      const inPool = poolBySource[source] || 0;

      // Only alert if: source has significant pool presence (>threshold) AND
      // fetch produced exactly 0 (not missing — missing means no fetcher for it)
      if (fetched === 0 && inPool >= threshold) {
        failures.push(
          `**Source fetch failure (${source})**: 0 jobs fetched this run despite ${inPool} in pool (carry-forward). Fetcher likely timed out or broken.`
        );
      }
    }

    return failures.length > 0 ? failures.join('\n') : null;
  },
};