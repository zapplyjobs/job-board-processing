/**
 * Check 15: Enrichment stats sanity — tier distribution and per-source field counts
 * Updated E75: Include T4 in tier totals (T4 restructure C74 moved most records to T4)
 */
module.exports = {
  id: 15,
  name: 'enrichment stats sanity',
  check(ctx) {
    if (!ctx.enrichStats) return null;
    const tiers = ctx.enrichStats.tiers || {};
    const t0 = tiers.t0 ?? 0;
    const t1 = tiers.t1 ?? 0;
    const t2 = tiers.t2 ?? 0;
    const t3 = tiers.t3 ?? 0;
    const t4 = tiers.t4 ?? 0;
    const tierTotal = t0 + t1 + t2 + t3 + t4;
    const failures = [];

    if (tierTotal > 0) {
      const t3PlusRate = (t3 + t4) / tierTotal;
      if (t3PlusRate < ctx.config.thresholds.enrichT3MinPct) {
        failures.push(`**Enrichment T3+ rate low**: ${Math.round(t3PlusRate * 100)}% (${t3 + t4}/${tierTotal}, expected 75-95%) — schema change may have broken field extraction`);
      }
      const t0Rate = t0 / tierTotal;
      if (t0Rate > ctx.config.thresholds.enrichT0MaxPct) {
        failures.push(`**Enrichment T0 rate high**: ${Math.round(t0Rate * 100)}% (${t0}/${tierTotal}, expected <10%) — jobs losing descriptions`);
      }
    }

    // Per-source field count sanity
    const bySource = ctx.enrichStats.by_source || {};
    for (const [src, stats] of Object.entries(bySource)) {
      const enriched = stats.enriched || 0;
      if (enriched < 10) continue;
      if (ctx.config.STRUCTURALLY_LOW_SKILLS.has(src)) continue;
      const skillsRate = (stats.required_skills || 0) / enriched;
      if (skillsRate < ctx.config.thresholds.enrichSkillsMinPct) {
        failures.push(`**Enrichment skills drop (${src})**: ${Math.round(skillsRate * 100)}% have skills (expected >70%) — skills extraction may have broken for this source`);
      }
    }

    return failures.length > 0 ? failures.join('\n') : null;
  },
};
