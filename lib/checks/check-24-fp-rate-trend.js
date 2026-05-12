/**
 * Check 24: Senior filter FP rate trend
 *
 * Monitors the false-positive rate of the senior filter from sampled filtered jobs.
 * If the FP rate exceeds thresholds, entry-level jobs are being wrongly filtered.
 *
 * AGG-SELF-4 (Check C) — Origin: A46 design doc. The CTO keyword bug (AGG-PIPE-14)
 * filtered ~460 entry-level jobs/run for weeks before detection. This check would
 * have caught it in 1-2 runs.
 *
 * Data source: senior_filter_stats.fp_rate_pct (written by pipeline Step 4b)
 */
module.exports = {
  id: 24,
  name: 'senior filter FP rate',
  check(ctx) {
    if (!ctx.metadata) return null;
    const stats = ctx.metadata.senior_filter_stats;
    if (!stats) return '**Senior filter stats missing**: no FP rate data in metadata';

    const fpRate = parseFloat(stats.fp_rate_pct);
    const sampleSize = stats.sample_size || 0;

    if (sampleSize === 0) return null;
    if (isNaN(fpRate)) return null;

    if (fpRate > 15) {
      return `**Senior filter FP rate critical**: ${fpRate}% (${stats.potential_fp_count}/${sampleSize} sampled). Over 1 in 7 filtered jobs may be entry-level. Investigate keyword changes.`;
    }
    return null;
  },
  warn(ctx) {
    if (!ctx.config.warnings) return null;
    if (!ctx.metadata) return null;
    const stats = ctx.metadata.senior_filter_stats;
    if (!stats) return null;

    const fpRate = parseFloat(stats.fp_rate_pct);
    const sampleSize = stats.sample_size || 0;

    if (sampleSize === 0 || isNaN(fpRate)) return null;

    if (fpRate > 10) {
      return `Senior filter FP rate elevated: ${fpRate}% (${stats.potential_fp_count}/${sampleSize}). May indicate keyword over-matching.`;
    }
    return null;
  },
};