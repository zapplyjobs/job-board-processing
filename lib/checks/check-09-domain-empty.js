/**
 * Check 9: per-domain job counts — alert if any key domain hits 0
 */
module.exports = {
  id: 9,
  name: 'domain empty',
  check(ctx) {
    if (!ctx.metadata) return null;
    const domains = ctx.metadata.tag_stats?.domains || {};
    const failures = [];
    for (const domain of ctx.config.KEY_DOMAINS) {
      const count = domains[domain] ?? null;
      if (count === 0) {
        failures.push(`**Domain empty (${domain})**: 0 jobs tagged — tag-engine or fetcher broken for this domain`);
      }
    }
    return failures.length > 0 ? failures.join('\n') : null;
  },
};
