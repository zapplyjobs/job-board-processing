/**
 * Check 10: Senior filter bypass — senior rate in tech+US exceeds threshold
 * Reads all_jobs.json to calculate tech+US senior rate (senior-only, mid_level excluded).
 */
const fs = require('fs');

module.exports = {
  id: 10,
  name: 'senior filter bypass',
  check(ctx) {
    if (!ctx.allJobsPath || !fs.existsSync(ctx.allJobsPath)) return null;
    try {
      const techDomains = ctx.config.TECH_DOMAINS;
      let techUSJobs = 0;
      let seniorOnlyJobs = 0;

      for (const job of ctx.allJobs) {
        const tags = job.tags || {};
        const domains = tags.domains || [];
        const locations = tags.locations || [];
        const employment = tags.employment || '';
        const isTech = techDomains.some(d => domains.includes(d));
        const isUS = locations.includes('us');
        if (isTech && isUS) {
          techUSJobs++;
          if (employment === 'senior') seniorOnlyJobs++;
        }
      }

      if (techUSJobs > 0) {
        const rate = seniorOnlyJobs / techUSJobs;
        if (rate > ctx.config.thresholds.seniorFilterPct) {
          return `**Senior filter bypass detected (senior-only, mid_level excluded)**: ${Math.round(rate * 100)}% senior filtered in tech+US (${seniorOnlyJobs}/${techUSJobs}) (expected ≤${Math.round(ctx.config.thresholds.seniorFilterPct * 100)}%) — entry-level guards may be broken`;
        }
      }
    } catch (err) {
      console.error('Error calculating senior filter rate:', err.message);
    }
    return null;
  },
  warn(ctx) {
    if (!ctx.config.warnings || !ctx.allJobsPath || !require('fs').existsSync(ctx.allJobsPath)) return null;
    const techDomains = ctx.config.TECH_DOMAINS;
    let techUSJobs = 0, seniorOnlyJobs = 0;
    for (const job of ctx.allJobs) {
      const tags = job.tags || {};
      const isTech = techDomains.some(d => (tags.domains || []).includes(d));
      const isUS = (tags.locations || []).includes('us');
      if (isTech && isUS) { techUSJobs++; if (tags.employment === 'senior') seniorOnlyJobs++; }
    }
    if (techUSJobs > 0) {
      const rate = seniorOnlyJobs / techUSJobs;
      const warnPct = ctx.config.warnings.seniorFilterPct;
      const catPct = ctx.config.thresholds.seniorFilterPct;
      if (rate > warnPct && rate <= catPct) {
        return `Senior filter rate trending up: ${Math.round(rate * 100)}% (${seniorOnlyJobs}/${techUSJobs}) — approaching threshold`;
      }
    }
    return null;
  },
};
