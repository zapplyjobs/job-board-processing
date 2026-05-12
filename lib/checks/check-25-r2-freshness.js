/**
 * Check 25: R2 data freshness — alert if R2 manifest is stale
 */
module.exports = {
  id: 25,
  name: 'R2 data freshness',
  check(ctx) {
    if (!ctx.zjpMetrics?.r2) return null;
    const r2 = ctx.zjpMetrics.r2;

    if (r2.status === 'error') {
      return `**R2 health check failing**: ${r2.error || 'unknown error'}. R2 data pipeline may be broken.`;
    }

    if (r2.status === 'stale' && r2.manifest_age_minutes != null) {
      return `**R2 manifest stale**: ${r2.manifest_age_minutes} min old (threshold: ${ctx.config.thresholds.r2StaleMinutes} min). Pipeline may not be writing to R2.`;
    }

    return null;
  },
  warn(ctx) {
    if (!ctx.zjpMetrics?.r2) return null;
    const r2 = ctx.zjpMetrics.r2;

    if (r2.status === 'not_configured') {
      return 'R2 secrets not configured in this environment — health check unavailable';
    }

    if (r2.status === 'healthy' && r2.manifest_age_minutes != null && r2.manifest_age_minutes >= ctx.config.warnings.r2StaleMinutes) {
      return `R2 manifest ${r2.manifest_age_minutes} min old (warning at ${ctx.config.warnings.r2StaleMinutes} min)`;
    }

    return null;
  },
};
