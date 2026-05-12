/**
 * Check 12: Enrichment fill rate drop
 */
const fs = require('fs');

module.exports = {
  id: 12,
  name: 'enrichment coverage',
  check(ctx) {
    if (!ctx.enrichStats) return null;
    const total = ctx.enrichStats.total_enriched || 0;
    const techTotal = ctx.enrichStats.total_tech_us || 0;
    if (techTotal > 0) {
      const rate = total / techTotal;
      if (rate < ctx.config.thresholds.enrichCoveragePct) {
        return `**Enrichment coverage low**: ${total} enriched / ${techTotal} tech jobs = ${Math.round(rate * 100)}% (threshold: ${Math.round(ctx.config.thresholds.enrichCoveragePct * 100)}%)`;
      }
    }
    return null;
  },
};
