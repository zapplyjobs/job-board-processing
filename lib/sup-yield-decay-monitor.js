#!/usr/bin/env node
'use strict';

/**
 * SUP Yield Decay Monitor
 *
 * Compares stored CSV company yield signals against current final destination output.
 * This is an audit/control surface only. It does not mutate CSV, source truth, or credit.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CSV = path.join(__dirname, '..', 'company-research-log.csv');
const DEFAULT_OUT = path.join(__dirname, '..', 'state', 'generated', 'sup_yield_decay_monitor.json');
const R2_LOADER = path.resolve(__dirname, '..', '..', '..', '..', 'Job_Listings', 'job-board-shared', 'tools', 'r2-loader');
const TECH_DOMAINS = new Set(['software', 'hardware', 'data_science', 'ai']);

function parseArgs(argv) {
  const args = {
    csv: DEFAULT_CSV,
    jobs: null,
    remote: true,
    write: null,
    json: false,
    decayRatio: 0.5,
    minBaseline: 10,
    minInternBaseline: 3,
    failOnDecay: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--csv') {
      args.csv = argv[++i];
    } else if (arg === '--jobs') {
      args.jobs = argv[++i];
      args.remote = false;
    } else if (arg === '--remote') {
      args.remote = true;
    } else if (arg === '--write') {
      const next = argv[i + 1];
      args.write = next && !next.startsWith('--') ? next : DEFAULT_OUT;
      if (args.write !== DEFAULT_OUT) i += 1;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--decay-ratio') {
      args.decayRatio = Number(argv[++i]);
      if (!Number.isFinite(args.decayRatio) || args.decayRatio < 0 || args.decayRatio > 1) {
        throw new Error('--decay-ratio must be a number between 0 and 1');
      }
    } else if (arg === '--min-baseline') {
      args.minBaseline = Number(argv[++i]);
      if (!Number.isInteger(args.minBaseline) || args.minBaseline < 1) {
        throw new Error('--min-baseline must be a positive integer');
      }
    } else if (arg === '--min-intern-baseline') {
      args.minInternBaseline = Number(argv[++i]);
      if (!Number.isInteger(args.minInternBaseline) || args.minInternBaseline < 1) {
        throw new Error('--min-intern-baseline must be a positive integer');
      }
    } else if (arg === '--fail-on-decay') {
      args.failOnDecay = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node projects/zjp/scripts/sup-yield-decay-monitor.js [--csv PATH] [--jobs PATH | --remote] [--decay-ratio N] [--min-baseline N] [--min-intern-baseline N] [--write [PATH]] [--json] [--fail-on-decay]\n\nCompares company-research-log.csv historical yield fields against current final all_jobs output. Defaults to live R2 and writes to projects/zjp/state/generated/sup_yield_decay_monitor.json when --write is passed.`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function readCsv(file) {
  const parsed = parseCsv(fs.readFileSync(file, 'utf8'));
  if (parsed.length === 0) throw new Error(`CSV is empty: ${file}`);
  const header = parsed[0];
  const required = ['company', 'ats', 'slug', 'status', 'enriched_count', 'tech_us_count', 'intern_count', 'date', 'notes', 'notes2'];
  for (const name of required) {
    if (!header.includes(name)) throw new Error(`CSV missing required column: ${name}`);
  }
  return parsed.slice(1)
    .filter(cols => cols.some(value => value !== ''))
    .map((cols, index) => {
      const row = { __line: index + 2 };
      for (let i = 0; i < header.length; i += 1) row[header[i]] = cols[i] || '';
      return row;
    });
}

function readJobsFile(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  if (text[0] === '[') return JSON.parse(text);
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function loadJobs(args) {
  if (args.jobs) return readJobsFile(args.jobs);
  if (!args.remote) throw new Error('No --jobs path supplied and --remote disabled');
  const { loadJsonFromR2 } = require(R2_LOADER);
  return loadJsonFromR2('all_jobs.json');
}

function normalizeCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\b(inc|incorporated|corp|corporation|llc|ltd|limited|co|company)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toInt(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function csvFinalPoolTotal(row) {
  for (const key of ['total_jobs', 'enriched_count', 'pool_total']) {
    const value = row[key];
    if (String(value || '').trim() === '') continue;
    const parsed = toInt(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function isUSJob(job) {
  const locations = (job.tags && Array.isArray(job.tags.locations)) ? job.tags.locations : [];
  return locations.includes('us');
}

function isTechJob(job) {
  const domains = (job.tags && Array.isArray(job.tags.domains)) ? job.tags.domains : [];
  return domains.some(domain => TECH_DOMAINS.has(domain));
}

function isInternship(job) {
  return job.tags && job.tags.employment === 'internship';
}

function summarizeJobs(jobs) {
  const byCompany = new Map();
  for (const job of jobs) {
    const key = normalizeCompany(job.company_name || job.company || '');
    if (!key) continue;
    if (!byCompany.has(key)) {
      byCompany.set(key, {
        company_name: job.company_name || job.company || key,
        final_pool_total: 0,
        tech_us_count: 0,
        intern_count: 0,
        intern_tech_us_count: 0,
        sources: new Set(),
      });
    }
    const row = byCompany.get(key);
    row.final_pool_total += 1;
    if (job.source) row.sources.add(job.source);
    const techUs = isUSJob(job) && isTechJob(job);
    if (techUs) row.tech_us_count += 1;
    if (isInternship(job)) row.intern_count += 1;
    if (techUs && isInternship(job)) row.intern_tech_us_count += 1;
  }

  for (const row of byCompany.values()) row.sources = [...row.sources].sort();
  return byCompany;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function isExcludedBaseline(row) {
  const text = `${row.notes || ''} ${row.notes2 || ''}`.toLowerCase();
  return /not added to company-list|decision: skip fetcher|skip fetcher|not used for external posting|unfetchable|removed from target_companies/.test(text);
}

function buildBaselines(csvRows) {
  return csvRows
    .filter(row => row.status === 'accepted')
    .filter(row => isIsoDate(row.date))
    .filter(row => !isExcludedBaseline(row))
    .map(row => {
      const slugKey = plainSlugKey(row.slug);
      return {
        line: row.__line,
        company: row.company,
        key: normalizeCompany(row.company),
        slug_key: slugKey,
        ats: row.ats,
        slug: row.slug,
        status: row.status,
        csv_date: row.date,
        baseline_final_pool_total: csvFinalPoolTotal(row),
        baseline_tech_us_count: toInt(row.tech_us_count),
        baseline_intern_count: toInt(row.intern_count),
        notes_summary: summarize(`${row.notes || ''} ${row.notes2 || ''}`),
        review_note: row.notes2 || '',
      };
    })
    .filter(row => row.key && (row.baseline_final_pool_total || row.baseline_tech_us_count || row.baseline_intern_count));
}

function plainSlugKey(slug) {
  const value = String(slug || '').trim();
  if (!value || value.includes('/') || value.includes(':')) return '';
  return normalizeCompany(value);
}

function summarize(value) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

function classifiedReviewOverride(baseline) {
  const text = `${baseline.review_note || ''} ${baseline.notes_summary || ''}`.toLowerCase();
  if (!text.includes('sup-decay')) return null;

  if (text.includes('fresh residual')) {
    return {
      review_bucket: 'producer_survival_fresh_residual',
      likely_owner: 'AGG',
      review_reason: 'Post-AGG closeout same-day residual: rerun current source fetch through AGG gates before reopening broad survival work.',
    };
  }

  if (text.includes('agg-survive-1') || text.includes('route agg-survive')) {
    return {
      review_bucket: 'producer_survival_handoff',
      likely_owner: 'AGG',
      review_reason: 'SUP reviewed the source-specific signal and routed the live-source-to-final survival gap to AGG-SURVIVE-1. Do not prune the source from SUP aggregate decay alone.',
    };
  }

  if (text.includes('active-window rebaseline') || text.includes('route sup rebaseline')) {
    return {
      review_bucket: 'active_window_rebaseline_review',
      likely_owner: 'SUP',
      review_reason: 'SUP reviewed the source-specific signal as stale-baseline or active-window drift. Rebaseline before treating this as producer loss.',
    };
  }
  if (text.includes('stale/dead') || text.includes('stale source mapping')) {
    return {
      review_bucket: 'stale_source_mapping_review',
      likely_owner: 'SUP',
      review_reason: 'SUP reviewed the source-specific signal as a dead, moved, or stale source mapping. Update/rebaseline the source path before treating it as producer loss.',
    };
  }

  if (text.includes('route sup/tag') || text.includes('route tag')) {
    return {
      review_bucket: 'tag_or_market_mix_review',
      likely_owner: 'SUP/TAG',
      review_reason: 'SUP reviewed the source-specific signal as a tag/domain or market-mix issue rather than source survival loss.',
    };
  }


  return null;
}

function classifyReviewBucket(baseline, currentCounts, flags) {
  const override = classifiedReviewOverride(baseline);
  if (override) return override;

  if (flags.includes('company_missing_from_final_output')) {
    return {
      review_bucket: 'final_output_missing_review',
      likely_owner: 'SUP/AGG',
      review_reason: 'Accepted source had a meaningful historical baseline but has no current final-output rows. Verify source still fetches and that final pipeline output is not dropping it before pruning.',
    };
  }

  if (flags.includes('final_pool_decay')) {
    return {
      review_bucket: 'source_yield_decay_review',
      likely_owner: 'SUP/AGG',
      review_reason: 'Final pool output materially decayed. Review source-specific cause, live source output, and final pipeline survival before source downgrade or removal.',
    };
  }

  if (flags.includes('tech_us_zero') && currentCounts.final_pool_total > 0) {
    return {
      review_bucket: 'tag_or_market_mix_review',
      likely_owner: 'SUP/TAG',
      review_reason: 'Source still emits jobs, but none are currently final tech-US. Review whether this is a real market mix shift, stale baseline, or tagging/location/domain regression.',
    };
  }

  if (flags.includes('internship_decay') && !flags.includes('tech_us_decay') && currentCounts.tech_us_count > 0) {
    return {
      review_bucket: 'seasonal_internship_review',
      likely_owner: 'SUP',
      review_reason: 'Source still emits final tech-US jobs and only internship volume fell. Treat as seasonal/expected until repeated or source-specific evidence proves a fetch/tag defect.',
    };
  }

  if (flags.includes('tech_us_decay') && currentCounts.final_pool_total > 0) {
    return {
      review_bucket: 'stale_baseline_or_tag_review',
      likely_owner: 'SUP/TAG',
      review_reason: 'Current final output exists and total jobs did not collapse, but tech-US share fell. Review baseline freshness and tag/domain behavior before changing source truth.',
    };
  }

  if (flags.includes('tech_us_decay')) {
    return {
      review_bucket: 'source_yield_decay_review',
      likely_owner: 'SUP/AGG',
      review_reason: 'Final tech-US output materially decayed. Review source-specific cause, live source output, and final pipeline survival before source downgrade or removal.',
    };
  }

  return {
    review_bucket: 'manual_review',
    likely_owner: 'SUP',
    review_reason: 'Flagged by yield-decay policy; needs source-specific review.',
  };
}

function sourceMatches(currentCounts, ats) {
  const source = String(ats || '').toLowerCase();
  return Boolean(source) && currentCounts.sources.some(value => String(value || '').toLowerCase() === source);
}

function findCurrentCounts(baseline, liveByCompany) {
  const companyMatch = liveByCompany.get(baseline.key);
  if (companyMatch) return { counts: companyMatch, match_basis: 'company_name' };

  if (baseline.slug_key && baseline.slug_key !== baseline.key) {
    const slugMatch = liveByCompany.get(baseline.slug_key);
    if (slugMatch && sourceMatches(slugMatch, baseline.ats)) {
      return { counts: slugMatch, match_basis: 'ats_slug_company_alias' };
    }
  }

  return { counts: null, match_basis: 'none' };
}

function classifyDecay(baseline, current, args, matchBasis) {
  const currentCounts = current || {
    company_name: baseline.company,
    final_pool_total: 0,
    tech_us_count: 0,
    intern_count: 0,
    intern_tech_us_count: 0,
    sources: [],
  };

  const flags = [];
  if (baseline.baseline_tech_us_count >= args.minBaseline) {
    const threshold = Math.floor(baseline.baseline_tech_us_count * args.decayRatio);
    if (currentCounts.tech_us_count <= threshold) flags.push('tech_us_decay');
    if (currentCounts.tech_us_count === 0) flags.push('tech_us_zero');
  }
  if (baseline.baseline_final_pool_total >= args.minBaseline) {
    const threshold = Math.floor(baseline.baseline_final_pool_total * args.decayRatio);
    if (currentCounts.final_pool_total <= threshold) flags.push('final_pool_decay');
  }
  if (baseline.baseline_intern_count >= args.minInternBaseline && currentCounts.intern_count < baseline.baseline_intern_count) {
    flags.push('internship_decay');
  }
  const hasMeaningfulBaseline =
    baseline.baseline_final_pool_total >= args.minBaseline ||
    baseline.baseline_tech_us_count >= args.minBaseline ||
    baseline.baseline_intern_count >= args.minInternBaseline;
  if (hasMeaningfulBaseline && currentCounts.final_pool_total === 0) {
    flags.push('company_missing_from_final_output');
  }

  if (flags.length === 0) return null;

  const review = classifyReviewBucket(baseline, currentCounts, flags);

  return {
    line: baseline.line,
    company: baseline.company,
    ats: baseline.ats,
    slug: baseline.slug,
    csv_date: baseline.csv_date,
    flags: [...new Set(flags)],
    review_bucket: review.review_bucket,
    likely_owner: review.likely_owner,
    review_reason: review.review_reason,
    baseline: {
      final_pool_total: baseline.baseline_final_pool_total,
      tech_us_count: baseline.baseline_tech_us_count,
      intern_count: baseline.baseline_intern_count,
    },
    match_basis: matchBasis,
    current: {
      company_name: currentCounts.company_name,
      final_pool_total: currentCounts.final_pool_total,
      tech_us_count: currentCounts.tech_us_count,
      intern_count: currentCounts.intern_count,
      intern_tech_us_count: currentCounts.intern_tech_us_count,
      sources: currentCounts.sources,
    },
    notes_summary: baseline.notes_summary,
  };
}

function countBy(items, field) {
  const counts = new Map();
  for (const item of items) {
    const values = Array.isArray(item[field]) ? item[field] : [item[field] || 'unknown'];
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function buildMonitor(csvRows, jobs, args) {
  const liveByCompany = summarizeJobs(jobs);
  const baselines = buildBaselines(csvRows);
  const flagged = baselines
    .map(row => {
      const match = findCurrentCounts(row, liveByCompany);
      return classifyDecay(row, match.counts, args, match.match_basis);
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aDrop = a.baseline.tech_us_count - a.current.tech_us_count;
      const bDrop = b.baseline.tech_us_count - b.current.tech_us_count;
      return bDrop - aDrop || a.company.localeCompare(b.company);
    });

  return {
    generated_at: new Date().toISOString(),
    csv: args.csv,
    jobs_source: args.jobs || 'r2:all_jobs.json',
    policy: {
      decay_ratio: args.decayRatio,
      min_baseline: args.minBaseline,
      min_intern_baseline: args.minInternBaseline,
      credit_rule: 'Yield decay is an audit signal only; source credit still requires final destination target-visible output.',
      action_rule: 'Flagged companies need source-specific review before source removal, fetcher work, or credit changes.',
    },
    summary: {
      jobs_scanned: jobs.length,
      accepted_csv_baselines: baselines.length,
      flagged_companies: flagged.length,
      by_flag: countBy(flagged, 'flags'),
      by_review_bucket: countBy(flagged, 'review_bucket'),
      by_likely_owner: countBy(flagged, 'likely_owner'),
    },
    flagged_companies: flagged,
  };
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function printHuman(payload) {
  console.log('SUP Yield Decay Monitor');
  console.log(`Generated: ${payload.generated_at}`);
  console.log(`Jobs source: ${payload.jobs_source}`);
  console.log(`Jobs scanned: ${payload.summary.jobs_scanned}`);
  console.log(`Accepted CSV baselines: ${payload.summary.accepted_csv_baselines}`);
  console.log(`Flagged companies: ${payload.summary.flagged_companies}`);
  console.log('');
  if (payload.flagged_companies.length) {
    console.log('Top decay signals:');
    for (const row of payload.flagged_companies.slice(0, 20)) {
      console.log(`- L${row.line} ${row.company} (${row.ats}:${row.slug || 'unknown'}) bucket=${row.review_bucket} owner=${row.likely_owner} flags=${row.flags.join('|')} tech_us ${row.baseline.tech_us_count}->${row.current.tech_us_count} interns ${row.baseline.intern_count}->${row.current.intern_count} final_pool ${row.baseline.final_pool_total}->${row.current.final_pool_total}`);
    }
  } else {
    console.log('No yield decay signals above threshold.');
  }
  console.log('Review buckets:');
  for (const [bucket, count] of Object.entries(payload.summary.by_review_bucket || {})) {
    console.log(`- ${bucket}: ${count}`);
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvRows = readCsv(args.csv);
  const jobs = await loadJobs(args);
  const payload = buildMonitor(csvRows, jobs, args);
  if (args.write) writeJson(args.write, payload);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printHuman(payload);
  if (args.failOnDecay && payload.summary.flagged_companies > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
