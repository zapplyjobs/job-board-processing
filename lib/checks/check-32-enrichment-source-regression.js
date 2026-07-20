/**
 * Check 32: Per-source enrichment regression
 *
 * Detects per-source retrievable-text regressions that aggregate check-30
 * masks (e.g. one source at 0% retrievable can coexist with aggregate 86%
 * while other sources compensate).
 *
 * Catches the silent-loss class: any single source with ≥50 jobs dropping
 * below 90% retrievable-text rate (or below its per-source override floor).
 *
 * Per-source floor overrides (config.PER_SOURCE_RETRIEVABLE_FLOOR_OVERRIDES):
 * sources with known chronic-below-90% baselines get a lower floor so the alarm
 * only fires on REAL regression (drop below chronic baseline), not on the
 * chronic condition itself (avoids alert fatigue). Example: oracle median desc
 * len = 131 chars → ~62% retrievable is chronic baseline; floor set to 0.50
 * so alarm only fires if oracle drops below 50% (real regression).
 *
 * Stats-lag detection (ENR-SIDECAR-READAT-1 + ENR-AUTOSUPPRESS-STATSLAG-1):
 * when sidecar_read_at < sidecars_written_at (AGG updated sidecars after ENR
 * read them), a diagnostic NOTE is appended to each failure. This doesn't
 * suppress the alarm (could mask real regression) — it adds context so the
 * operator can distinguish timing-lag from real loss.
 *
 * Pairs with check-30 (aggregate regression) + check-33 (sidecar integrity).
 *
 * Filed by ENR (ENR-DETECT-ARCH-1). Renamed from check-31 (C191) to avoid
 * collision with INF's check-31-worker-dispatch-liveness.
 */
module.exports = {
  id: 32,
  name: 'enrichment source regression',
  check(ctx) {
    if (!ctx.enrichStats || !ctx.enrichStats.tiers_by_source) return null;

    const tiersBySource = ctx.enrichStats.tiers_by_source;
    const minJobs = ctx.config.thresholds.enrichPerSourceMinJobs;
    const defaultFloor = ctx.config.thresholds.enrichPerSourceMinPct;
    const overrides = ctx.config.PER_SOURCE_RETRIEVABLE_FLOOR_OVERRIDES || {};

    // ENR-AUTOSUPPRESS-STATSLAG-1: detect stats-lag (AGG updated sidecars after ENR read).
    // Append diagnostic note to failures — doesn't suppress (preserves regression detection).
    let statsLagNote = '';
    const readAt = ctx.enrichStats.sidecar_read_at;
    const writtenAt = ctx.metadata?.latency_markers?.sidecars_written_at;
    if (readAt && writtenAt) {
      const readMs = new Date(readAt).getTime();
      const writtenMs = new Date(writtenAt).getTime();
      if (writtenMs > readMs) {
        const lagSec = Math.round((writtenMs - readMs) / 1000);
        statsLagNote = ` | NOTE: stats-lag ${lagSec}s (AGG wrote sidecars ${lagSec}s after ENR read — alarm may be inflated; recheck next cycle)`;
      }
    }

    const failures = [];
    for (const [src, tiers] of Object.entries(tiersBySource)) {
      const t0 = tiers.t0 || 0;
      const t1 = tiers.t1 || 0;
      const t2 = tiers.t2 || 0;
      const t3 = tiers.t3 || 0;
      const t4 = tiers.t4 || 0;
      const total = t0 + t1 + t2 + t3 + t4;
      if (total < minJobs || total === 0) continue;

      const retrievable = t1 + t2 + t3 + t4;
      const rate = retrievable / total;
      const floor = overrides[src] !== undefined ? overrides[src] : defaultFloor;
      if (rate < floor) {
        const floorLabel = overrides[src] !== undefined ? ` (override floor ${Math.round(floor * 100)}%)` : '';
        failures.push(`**Per-source retrievable drop (${src})**: ${Math.round(rate * 100)}% retrievable (${retrievable}/${total}) — source-level description-text loss masked by aggregate${floorLabel}${statsLagNote}`);
      }
    }

    return failures.length > 0 ? failures.join('\n') : null;
  },
};
