/**
 * Check 19: Per-company zero-yield streak tracking
 *
 * STATEFUL: Writes zero-yield-tracking.json to disk.
 * Tracks consecutive runs where a configured company returns 0 jobs.
 * Alerts at threshold (default 3) consecutive zero-yield runs.
 *
 * INF-ALERT-3: Probes ATS API at threshold to classify alert reason:
 * - dead_slug: API returns error (404/401/5xx). Action: remove or migrate.
 * - dormant: API returns 200 with 0 results. Action: no action needed.
 * Only fires Discord alert for dead_slug. Dormant companies tracked but suppressed.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

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

/**
 * Probe a company's ATS board to determine if slug is dead or just dormant.
 * Returns: 'dead_slug' | 'dormant' | 'unknown'
 */
function probeATS(companyInfo) {
  const { platform, slug, url, site } = companyInfo;

  if (platform === 'custom') return Promise.resolve('unknown');

  // WD uses POST — separate probe function
  if (platform === 'workday') {
    if (!url) return Promise.resolve('unknown');
    return probeWorkday(url, site);
  }

  const probeUrl = buildProbeUrl(platform, slug, url, site);
  if (!probeUrl) return Promise.resolve('unknown');

  return new Promise((resolve) => {
    const req = https.get(probeUrl, { timeout: 8000 }, (res) => {
      res.resume(); // Drain response

      if (res.statusCode >= 400) {
        resolve('dead_slug');
        return;
      }

      // 200 — board exists but has 0 postings
      if (platform === 'greenhouse') {
        // GH returns JSON with meta.total_count
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            // If board doesn't exist, GH returns 404 (caught above).
            // 200 means board is alive.
            resolve('dormant');
          } catch {
            resolve('dormant'); // Board alive, response unparseable
          }
        });
      } else {
        resolve('dormant');
      }
    });

    req.setTimeout(8000, () => {
      req.destroy();
      resolve('unknown'); // Timeout — don't classify
    });

    req.on('error', () => resolve('unknown'));
  });
}

function buildProbeUrl(platform, slug, url, site) {
  switch (platform) {
    case 'greenhouse':
      return slug ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` : null;
    case 'lever':
      return slug ? `https://api.lever.co/v0/postings/${slug}?mode=json` : null;
    case 'ashby':
      return slug ? `https://api.ashbyhq.com/posting-api/${slug}` : null;
    case 'workday':
      // WD requires POST — handled specially in probeATS
      return null;
    case 'smartrecruiters':
      return slug ? `https://api.smartrecruiters.com/v1/companies/${slug}/postings` : null;
    default:
      return null;
  }
}

/**
 * Probe Workday tenant via POST (WD API requires POST with body).
 */
function probeWorkday(url, site) {
  return new Promise((resolve) => {
    try {
      const baseUrl = url.replace(/\/$/, '');
      const endpoint = `${baseUrl}/wrc/${site || 'default'}/api/1/public/search`;
      const payload = JSON.stringify({ limit: 1, offset: 0, appliedFacets: [], searchText: '' });

      const parsed = new URL(endpoint);
      const options = {
        method: 'POST',
        hostname: parsed.hostname,
        path: parsed.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 8000,
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            resolve('dead_slug');
          } else {
            resolve('dormant');
          }
        });
      });

      req.setTimeout(8000, () => { req.destroy(); resolve('unknown'); });
      req.on('error', () => resolve('unknown'));
      req.write(payload);
      req.end();
    } catch {
      resolve('unknown');
    }
  });
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
          reason: prevReason, // Preserve previously determined reason
        };

        if (newStreak >= threshold && !knownZeroYield.has(company)) {
          // AGG-FETCH-14: TTL on reason classification — re-read from metadata every 30 days.
          const REASON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
          const reasonStale = prevReason && prev.last_zero &&
            (Date.now() - new Date(prev.last_zero).getTime()) > REASON_TTL_MS;
          const needsClassification = !prevReason || reasonStale;

          if (needsClassification) {
            const healthEntry = (ctx.metadata.fetcher_health || {})[company];
            if (healthEntry) {
              newState[company].reason = healthEntry.status === 'error' ? 'dead_slug' :
                                         healthEntry.jobs > 0 ? 'alive' : 'dormant';
            } else if (!prevReason) {
              // Fallback: no health data and no prior classification — probe ATS directly
              const info = companyLookup[company];
              if (info) {
                const reason = await probeATS(info);
                newState[company].reason = reason;
              }
            }
            // If reasonStale but no healthEntry: keep prevReason (don't downgrade to unknown)
          }

          const reason = newState[company].reason;
          if (reason === 'dead_slug') {
            alerting.push(`${company} (${newStreak} runs, dead slug)`);
          } else if (reason === 'dormant') {
            dormantAtThreshold.push(`${company} (${newStreak} runs, dormant)`);
          } else {
            // unknown — still alert as before (can't classify)
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
