/**
 * Check 6: healthcare domain >threshold of US-tagged pool (composition drift)
 */
module.exports = {
  id: 6,
  name: 'healthcare composition drift',
  check(ctx) {
    if (!ctx.metadata) return null;
    const usTagged = ctx.metadata.tag_stats?.locations?.us ?? null;
    const healthcareCount = ctx.metadata.tag_stats?.domains?.healthcare ?? null;
    if (usTagged && healthcareCount !== null && usTagged > 0) {
      const pct = healthcareCount / usTagged;
      if (pct > ctx.config.thresholds.healthcarePct) {
        return `**Healthcare composition drift**: ${healthcareCount} healthcare / ${usTagged} US-tagged = ${Math.round(pct * 100)}% (threshold: ${Math.round(ctx.config.thresholds.healthcarePct * 100)}%)`;
      }
    }
    return null;
  },
};
