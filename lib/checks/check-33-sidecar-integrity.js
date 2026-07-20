/**
 * Check 33: Sidecar integrity — empty-write detection
 *
 * Detects when AGG writes sidecar entries with empty description_text. This is
 * the actual root-cause class behind the 2026-07-19 production alarms: AGG's
 * workday/oracle/bytedance fetchers wrote entries with description_text=""
 * (sample: 5/5 t0 workday jobs BorgWarner/Semtech/Dow-Jones/Boston-Dynamics/Fox
 * had sidecar entries with desc len 0).
 *
 * Distinct from:
 *  - check-23 (description coverage): checks entry COUNT vs pool, not entry CONTENT
 *  - check-32 (per-source retrievable): checks downstream tier-0 rate, not sidecar quality
 *
 * Uses sidecar_integrity.by_source from enrichment-stats.json (computed in stats.js
 * from loadDescriptionsMap's per-source empty-count tracking).
 *
 * Threshold: 5% empty entries per source (conservative; tunable). At 5%, current
 * workday (~1.5% empty overall but concentrated in t0 class) wouldn't fire, but a
 * regression where AGG starts writing 10%+ empty entries would.
 *
 * Filed by ENR (ENR-SIDECAR-INTEGRITY-CHECK-1, C198 blindspot audit).
 */
module.exports = {
  id: 33,
  name: 'sidecar integrity (empty-write detection)',
  check(ctx) {
    if (!ctx.enrichStats || !ctx.enrichStats.sidecar_integrity) return null;

    const integrity = ctx.enrichStats.sidecar_integrity;
    const minJobs = ctx.config.thresholds.sidecarIntegrityMinEntries || 100;
    const maxEmptyPct = ctx.config.thresholds.sidecarIntegrityMaxEmptyPct || 5;

    const failures = [];
    for (const [src, stats] of Object.entries(integrity)) {
      if (stats.total < minJobs) continue;  // skip tiny sources
      if (stats.empty_pct > maxEmptyPct) {
        failures.push(`**Sidecar empty-write (${src})**: ${stats.empty_pct}% of ${stats.total} entries have empty description_text (${stats.empty} empty) — AGG fetcher writing entries with no content`);
      }
    }

    return failures.length > 0 ? failures.join('\n') : null;
  },
};
