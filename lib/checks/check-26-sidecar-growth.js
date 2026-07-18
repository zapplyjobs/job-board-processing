/**
 * Check 26: Sidecar growth monitoring
 *
 * Detects when description sidecar entries stop growing while the pool
 * for that source grows. This catches silent extraction failures — the
 * fetcher produces jobs but description extraction silently breaks
 * (HTML change, regex drift, API field rename).
 *
 * Data source: zjp-metrics.json pool.sidecar_counts (current) vs
 * metrics/latest.json pool.sidecar_counts (previous run).
 *
 * AGG-SELF-4 (Check D) — Origin: A46 design doc.
 */

const INLINE_SOURCES = new Set(['greenhouse', 'lever', 'ashby', 'amazon', 'netflix']);

module.exports = {
  id: 26,
  name: 'sidecar growth',
  check(ctx) {
    if (!ctx.zjpMetrics || !ctx.prev) return null;

    const currentCounts = ctx.zjpMetrics.pool?.sidecar_counts;
    const prevCounts = ctx.prev.pool?.sidecar_counts;
    if (!currentCounts || !prevCounts) return null;

    const bySource = ctx.metadata?.by_source || {};
    const alerts = [];

    for (const [source, current] of Object.entries(currentCounts)) {
      if (INLINE_SOURCES.has(source)) continue;

      const prev = prevCounts[source];
      if (prev === undefined) continue;

      // AGG-ORACLE-DESC-1 (6C fix): old `if (current < 50) continue` self-disabled the check
      // exactly when a sidecar emptied (regression to 0 < 50 → silently un-monitored).
      // Skip only when BOTH current AND prev are tiny — that's a genuinely small source,
      // not a regression to zero. A source that dropped from many to few MUST remain checked.
      if (current < 50 && prev < 50) continue;

      const poolCurrent = bySource[source] || 0;

      // 6C: explicit drop detection — catches large fractional drops even when stagnant-logic
      // would miss them. Fires before the stagnant check so the message is more accurate.
      if (prev > 0 && current < prev * 0.5 && poolCurrent > 100) {
        const dropPct = ((1 - current / prev) * 100).toFixed(0);
        alerts.push(`**Sidecar dropped**: ${source} has ${current} entries (was ${prev}, -${dropPct}%) with ${poolCurrent} pool jobs. Sidecar may have emptied — check fetcher + sidecar-writer.`);
        continue;
      }

      const sidecarDelta = current - prev;
      // Sidecar grew by less than 5 entries but pool is substantial
      if (sidecarDelta < 5 && poolCurrent > 200) {
        alerts.push(`**Sidecar stagnant**: ${source} has ${current} entries (was ${prev}, +${sidecarDelta}) with ${poolCurrent} pool jobs. Description extraction may have stopped.`);
      }
    }

    return alerts.length > 0 ? alerts.join('\n') : null;
  },
};