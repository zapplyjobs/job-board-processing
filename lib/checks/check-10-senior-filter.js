/**
 * Check 10: Senior job presence — I-41 regression detection
 *
 * Originally monitored senior filter bypass rate.
 * After I-41 (Career Level Expansion), senior jobs should be PRESENT.
 * This check now alerts if senior jobs are ABSENT — indicating the
 * no-op senior-filter.js may have regressed or tag-engine is broken.
 */
const fs = require('fs');

module.exports = {
  id: 10,
  name: 'senior job presence (I-41 regression)',
  check(ctx) {
    if (!ctx.allJobsPath || !fs.existsSync(ctx.allJobsPath)) return null;
    try {
      const techDomains = ctx.config.TECH_DOMAINS;
      let techUSJobs = 0;
      let seniorJobs = 0;

      for (const job of ctx.allJobs) {
        const tags = job.tags || {};
        const domains = tags.domains || [];
        const locations = tags.locations || [];
        const employment = tags.employment || '';
        const isTech = techDomains.some(d => domains.includes(d));
        const isUS = locations.includes('us');
        if (isTech && isUS) {
          techUSJobs++;
          if (employment === 'senior') seniorJobs++;
        }
      }

      if (techUSJobs > 100 && seniorJobs === 0) {
        return `**No senior jobs detected in tech+US pool (I-41 regression)**: 0 senior out of ${techUSJobs} — senior-filter.js may have regressed to active filtering`;
      }
    } catch (err) {
      console.error('Error checking senior job presence:', err.message);
    }
    return null;
  },
  warn(ctx) {
    // No warning tier — either senior jobs are present (healthy) or absent (catastrophic)
    return null;
  },
};
