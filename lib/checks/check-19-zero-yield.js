/**
 * Check 19: Per-company zero-yield streak tracking
 *
 * STATEFUL: Writes zero-yield-tracking.json to disk.
 * Tracks consecutive runs where a configured company returns 0 jobs.
 * Alerts at threshold (default 3) consecutive zero-yield runs.
 *
 * INF-ALERT-4: Classifies alert reason from fetcher metadata only.
 * AGG-FETCH-14 writes per-company health status during fetch runs.
 * No outbound HTTP calls during alert runs.
 *
 * Classifications:
 * - dead_slug: fetcher reported error. Action: remove or migrate.
 * - dormant: fetcher succeeded but 0 jobs. Action: no action needed.
 * - unknown: no metadata and no prior classification. Alert fires.
 */
const fs = require('fs');
const path = require('path');

// Build company → { platform, slug, url, site } lookup from company-list.json
function buildCompanyLookup() {
  const lookup = {};
  const companyListPath = path.join(__dirname, '..', '..', 'aggregator', 'fetchers', 'company-list.json');
  if (!fs.existsSync(companyListPath)) return lookup;

  try {
    const cl = JSON.parse(fs.readFileSync(companyListPath, 'utf8'));
    for (const section of ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters']) {
      if (!cl[section]) continue;
      for (const entry of cl[section]) {
        if (entry.name) {
          lookup[entry.name] = { platform: section, slug: entry.slug, url: entry.url, site: entry.site };
        }
      }
    }
  } catch { /* fall through */ }

  // Custom fetcher companies
  const customCompanies = ['Apple', 'Google', 'Microsoft', 'Oracle', 'AMD', 'Uber', 'Two Sigma', 'Netflix', 'Amazon'];
  for (const name of customCompanies) {
    lookup[name] = { platform: 'custom' };
  }

  return lookup;
}

module.exports = {
  id: 19,
  name: 'company zero-yield streak',
  async check(ctx) {
    if (!ctx.metadata) return null;
    const trackingPath = path.join(ctx.dataDir, 'zero-yield-tracking.json');
    const threshold = ctx.config.thresholds.zeroYieldStreak;
    const companyLookup = buildCompanyLookup();

    // Load configured company names
    const configuredCompanies = new Set(Object.keys(companyLookup));

    // Load previous state
    let prevState = {};
    if (fs.existsSync(trackingPath)) {
      try { prevState = JSON.parse(fs.readFileSync(trackingPath, 'utf8')); } catch { prevState = {}; }
    }

    // Build current yield map from allJobs (pre-loaded by runner)
    const companyYield = {};
    if (ctx.allJobs) {
      for (const job of ctx.allJobs) {
        const company = job.company_name;
        if (company) companyYield[company] = (companyYield[company] || 0) + 1;
      }
    }

    // Only track configured companies
    const allCompanies = new Set([...Object.keys(prevState), ...Object.keys(companyYield)]
      .filter(c => configuredCompanies.has(c)));

    const knownZeroYield = ctx.config.KNOWN_ZERO_YIELD || new Set();
    const newState = {};
    const alerting = [];
    const dormantAtThreshold = [];

    for (const company of allCompanies) {
      const yield_ = companyYield[company] || 0;
      if (yield_ > 0) {
        newState[company] = { streak: 0, last_seen: new Date().toISOString() };
      } else {
        const prev = prevState[company] || { streak: 0 };
        const newStreak = (prev.streak || 0) + 1;
        const prevReason = prev.reason || null;

        newState[company] = {
          streak: newStreak,
          last_zero: new Date().toISOString(),
          reason: prevReason,
        };

        if (newStreak >= threshold && !knownZeroYield.has(company)) {
          // TTL on reason classification — re-read from metadata every 30 days
          const REASON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
          const reasonStale = prevReason && prev.last_zero &&
            (Date.now() - new Date(prev.last_zero).getTime()) > REASON_TTL_MS;
          const needsClassification = !prevReason || reasonStale;

          if (needsClassification) {
            const healthEntry = (ctx.metadata.fetcher_health || {})[company];
            if (healthEntry) {
              newState[company].reason = healthEntry.status === 'error' ? 'dead_slug' :
                                         healthEntry.jobs > 0 ? 'alive' : 'dormant';
            }
            // No metadata and no prior reason: stays unknown (fires alert).
            // No HTTP fallback — metadata is the only classification source.
          }

          const reason = newState[company].reason;
          if (reason === 'dead_slug') {
            alerting.push(`${company} (${newStreak} runs, dead slug)`);
          } else if (reason === 'dormant') {
            dormantAtThreshold.push(`${company} (${newStreak} runs, dormant)`);
          } else {
            alerting.push(`${company} (${newStreak} runs)`);
          }
        }
      }
    }

    // Persist tracking state
    fs.writeFileSync(trackingPath, JSON.stringify(newState, null, 2), 'utf8');

    const results = [];
    if (alerting.length > 0) {
      const shown = alerting.slice(0, 10);
      const suffix = alerting.length > 10 ? ` (+${alerting.length - 10} more)` : '';
      results.push(`**Dead slug alerts** (${threshold}+ runs): ${shown.join(', ')}${suffix} — ATS board returning errors, needs removal or migration`);
    }
    if (dormantAtThreshold.length > 0) {
      results.push(`Dormant (suppressed): ${dormantAtThreshold.slice(0, 5).join(', ')}${dormantAtThreshold.length > 5 ? ` (+${dormantAtThreshold.length - 5} more)` : ''}`);
    }

    return results.length > 0 ? results.join('\n') : null;
  },
};
