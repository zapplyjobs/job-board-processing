#!/usr/bin/env node

/**
 * ZJP Metrics Generator
 *
 * Consolidates pipeline health data from local files + GitHub API
 * into a single JSON that sessions read at startup instead of
 * running 10+ manual API calls.
 *
 * Runs as a step in collect-metrics.yml (every 15 min).
 * Reads local data files first, queries GitHub API for alignment/freshness.
 *
 * Input files (local, in .github/data/):
 *   - enrichment-stats.json
 *   - jobs-metadata.json
 *   - pipeline-alert.json
 *   - metrics/latest.json
 *
 * Output: .github/data/zjp-metrics.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'zjp-metrics.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// R2 configuration (optional — only available in jobs-data-2026)
const R2_ENABLED = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME);

const REPOS = [
  'jobs-aggregator-private',
  'jobs-data-2026',
  'New-Grad-Jobs-2027',
  'Internships-2027',
  'New-Grad-Software-Engineering-Jobs-2027',
  'New-Grad-Data-Science-Jobs-2027',
  'New-Grad-Hardware-Engineering-Jobs-2027',
  'New-Grad-Healthcare-Jobs-2027',
];

const CONSUMER_REPOS = REPOS.filter(r => r !== 'jobs-aggregator-private' && r !== 'jobs-data-2026');

function ghRequest(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'ZJP-Metrics-Generator',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    }).on('error', reject);
  });
}

function readLocalFile(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return null; }
}
function parseTimestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function chooseAlertSnapshot(localAlert, liveAlert) {
  if (!localAlert && !liveAlert) return null;
  const localCheckedAt = parseTimestamp(localAlert?.checked_at);
  const liveCheckedAt = parseTimestamp(liveAlert?.checked_at);
  if (liveCheckedAt !== null && (localCheckedAt === null || liveCheckedAt > localCheckedAt)) {
    return { data: liveAlert, source: 'pipeline-alert.json (live repo)' };
  }
  if (localAlert) return { data: localAlert, source: 'pipeline-alert.json (local workspace)' };
  return { data: liveAlert, source: 'pipeline-alert.json (live repo)' };
}

async function getLivePipelineAlert() {
  try {
    const res = await ghRequest('https://api.github.com/repos/zapplyjobs/jobs-data-2026/contents/.github/data/pipeline-alert.json');
    if (res.status !== 200 || typeof res.body?.content !== 'string') return null;
    return JSON.parse(Buffer.from(res.body.content, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}


// Submodule → source repo + target repos mapping
const SUBMODULE_CONFIG = {
  shared: {
    source_repo: 'zapplyjobs/job-board-shared',
    repos: [
      'jobs-aggregator-private', 'jobs-data-2026',
      'New-Grad-Jobs-2027', 'Internships-2027',
      'New-Grad-Software-Engineering-Jobs-2027', 'New-Grad-Data-Science-Jobs-2027',
      'New-Grad-Hardware-Engineering-Jobs-2027', 'New-Grad-Healthcare-Jobs-2027',
    ],
  },
  aggregator: {
    source_repo: 'zapplyjobs/job-board-aggregator',
    repos: ['jobs-aggregator-private'],
  },
  processing: {
    source_repo: 'zapplyjobs/job-board-processing',
    repos: ['jobs-data-2026'],
  },
  consumer: {
    source_repo: 'zapplyjobs/job-board-consumer',
    repos: [
      'New-Grad-Jobs-2027', 'Internships-2027',
      'New-Grad-Software-Engineering-Jobs-2027', 'New-Grad-Data-Science-Jobs-2027',
      'New-Grad-Hardware-Engineering-Jobs-2027', 'New-Grad-Healthcare-Jobs-2027',
    ],
  },
};

async function getSubmoduleAlignment() {
  const result = {};

  for (const [name, config] of Object.entries(SUBMODULE_CONFIG)) {
    const repos = {};
    const hashes = new Set();

    for (const repo of config.repos) {
      try {
        const res = await ghRequest(`https://api.github.com/repos/zapplyjobs/${repo}/contents/.github/scripts/${name}`);
        if (res.status === 200 && res.body?.sha) {
          repos[repo] = res.body.sha;
          hashes.add(res.body.sha);
        } else {
          repos[repo] = null;
        }
      } catch {
        repos[repo] = null;
      }
    }

    const aligned = hashes.size === 1;
    const hash = [...hashes][0] || null;
    result[name] = { aligned, hash, repos, p2_status: aligned ? 'PASS' : 'FAIL' };
  }

  // Legacy fields for backward compat — shared submodule as the top-level
  const shared = result.shared || {};
  return {
    ...result,
    // Backward-compat fields (shared)
    aligned: shared.aligned,
    hash: shared.hash,
    repos: shared.repos,
    p2_status: shared.p2_status,
  };
}

async function getPipelineStatus() {
  const status = {
    last_aggregator_run: null,
    last_aggregator_status: null,
    last_enrichment_run: null,
    last_enrichment_status: null,
    aggregator_runtime_minutes: null,
    aggregator_queue_minutes: null,
    aggregator_execution_minutes: null,
    aggregator_cancel_count: null,
  };

  // Aggregator run status — last 15 runs for stats + latest completed for timing
  try {
    const res = await ghRequest('https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/runs?per_page=15');
    if (res.body?.workflow_runs) {
      const runs = res.body.workflow_runs;
      const latest = runs[0];
      if (latest) {
        status.last_aggregator_run = latest.created_at;
        status.last_aggregator_status = latest.conclusion || 'in_progress';

        // Use the latest COMPLETED run for accurate timing (in-progress runs give false ~2-3 min)
        const completedRun = runs.find(r => r.conclusion === 'success' || r.conclusion === 'failure');
        const timingRun = completedRun || latest;

        if (timingRun.updated_at && timingRun.created_at) {
          const dur = (new Date(timingRun.updated_at) - new Date(timingRun.created_at)) / 60000;
          if (dur > 0 && dur < 60) status.aggregator_runtime_minutes = Math.round(dur * 10) / 10;
        }

        // Execution time from job-level timing
        if (timingRun.id) {
          try {
            const jobRes = await ghRequest(`https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/runs/${timingRun.id}/jobs`);
            if (jobRes.body?.jobs?.[0]) {
              const job = jobRes.body.jobs[0];
              if (job.created_at && timingRun.created_at) {
                const queueMin = (new Date(job.created_at) - new Date(timingRun.created_at)) / 60000;
                if (queueMin >= 0 && queueMin < 30) status.aggregator_queue_minutes = Math.round(queueMin * 10) / 10;
              }
              if (job.completed_at && job.started_at) {
                const execMin = (new Date(job.completed_at) - new Date(job.started_at)) / 60000;
                if (execMin > 0 && execMin < 30) status.aggregator_execution_minutes = Math.round(execMin * 10) / 10;
              }
            }
          } catch {}
        }

        // Count cancellations in last 15 runs
        const cancelled = runs.filter(r => r.conclusion === 'cancelled').length;
        status.aggregator_cancel_count = cancelled;
      }
    }
  } catch {}

  // Enrichment run status
  try {
    const res = await ghRequest('https://api.github.com/repos/zapplyjobs/jobs-data-2026/actions/runs?per_page=5');
    if (res.body?.workflow_runs) {
      const enrichRun = res.body.workflow_runs.find(r => r.name === 'Enrich Jobs');
      if (enrichRun) {
        status.last_enrichment_run = enrichRun.created_at;
        status.last_enrichment_status = enrichRun.conclusion || 'in_progress';
      }
    }
  } catch {}

  return status;
}

async function getConsumerFreshness() {
  const consumers = { last_update: null, repos: {} };

  for (const repo of CONSUMER_REPOS) {
    try {
      const res = await ghRequest(`https://api.github.com/repos/zapplyjobs/${repo}/commits?per_page=1`);
      if (res.body?.[0]) {
        const commit = res.body[0];
        const date = commit.commit.committer.date;
        const msg = commit.commit.message.split('\n')[0];
        const posMatch = msg.match(/(\d[\d,]+)\s+positions?/i);
        consumers.repos[repo] = {
          positions: posMatch ? parseInt(posMatch[1].replace(/,/g, '')) : null,
          last_commit: date,
        };
        if (!consumers.last_update || date > consumers.last_update) {
          consumers.last_update = date;
        }
      }
    } catch {
      consumers.repos[repo] = { positions: null, last_commit: null };
    }
  }

  return consumers;
}

// INF-CONSUMER-E2E-1: 9-consumer E2E freshness (age / lag / stale vs R2 baseline).
// Published as metrics.consumer_e2e — the operator dashboard (jobs-data-2026/index.html)
// reads it directly from raw.githubusercontent zjp-metrics.json. Mirrors the workspace
// script scripts/inf-consumer-e2e-lag.js; runs here in metrics CI with R2 + GH creds.
const E2E_STALE_MIN = 60; // consumers should refresh well within ~1h (pipeline cadence ~15 min)
const E2E_DATA_FRESHNESS_KINDS = new Set(['r2', 'supabase', 'discord']); // true write-recency vs refresh_recency_proxy

function httpGetJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'ZJP-Metrics-Generator' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function getConsumerE2E() {
  // The R2 baseline is the pipeline-alive signal AND the lag denominator. Without it the
  // measurement is meaningless, so degrade instead of emitting a bogus payload. Never throws
  // (returns a status object) so a transient R2/GH blip can't break metrics generation.
  if (!R2_ENABLED) {
    return { status: 'not_configured', note: 'R2 secrets not available — consumer_e2e needs the R2 baseline' };
  }
  try {
    const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
      maxAttempts: 2,
    });
    const r2Head = async (key) => {
      const r = await client.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
      return r.LastModified ? new Date(r.LastModified) : null;
    };

    const now = new Date();
    const baselineDate = await r2Head('data/all_jobs.json');
    if (!baselineDate) return { status: 'error', error: 'no baseline: R2 data/all_jobs.json HeadObject returned no LastModified' };

    const GH_2027 = [
      'New-Grad-Software-Engineering-Jobs-2027', 'New-Grad-Data-Science-Jobs-2027',
      'New-Grad-Hardware-Engineering-Jobs-2027', 'New-Grad-Healthcare-Jobs-2027',
      'Internships-2027', 'New-Grad-Jobs-2027',
    ];
    const ghLastCommit = async (repo) => {
      const res = await ghRequest(`https://api.github.com/repos/zapplyjobs/${repo}/commits?per_page=1`);
      const d = res.body?.[0]?.commit?.committer?.date;
      return d ? new Date(d) : null;
    };
    const discordLastSuccess = async () => {
      const res = await ghRequest('https://api.github.com/repos/zapplyjobs/jobs-data-2026/actions/workflows/post-to-discord.yml/runs?per_page=1&status=success');
      const d = res.body?.workflow_runs?.[0]?.created_at;
      return d ? new Date(d) : null;
    };
    const supabaseFreshness = async () => {
      const body = await httpGetJson('https://zapply.jobs/api/freshness/');
      const t = body?.last_update ? new Date(body.last_update) : null;
      return t && !isNaN(t.getTime()) ? t : null;
    };

    // Order mirrors scripts/inf-consumer-e2e-lag.js (stable screen-order for the dashboard).
    const specs = [
      { name: 'softwarejobs.dev (R2 us_jobs.json)', kind: 'r2', ts: () => r2Head('data/us_jobs.json') },
      ...GH_2027.map(r => ({ name: `GitHub: ${r}`, kind: 'gh', ts: () => ghLastCommit(r) })),
      { name: 'zapply.jobs (Supabase jobs)', kind: 'supabase', ts: supabaseFreshness },
      { name: 'Discord', kind: 'discord', ts: discordLastSuccess },
    ];

    const results = [];
    for (const c of specs) {
      const signal = E2E_DATA_FRESHNESS_KINDS.has(c.kind) ? 'data_freshness' : 'refresh_recency_proxy';
      const t = await c.ts();
      if (!t) { results.push({ name: c.name, kind: c.kind, signal, status: 'unknown', reason: 'no timestamp' }); continue; }
      const ageMin = (now - t) / 60000;
      const deltaMin = (baselineDate - t) / 60000;
      results.push({
        name: c.name, kind: c.kind, signal, last_update: t.toISOString(),
        age_minutes: +ageMin.toFixed(1), lag_vs_pipeline_minutes: +deltaMin.toFixed(1),
        stale: ageMin > E2E_STALE_MIN,
      });
    }

    const unknown = results.filter(r => r.status === 'unknown').length;
    const stale = results.filter(r => r.stale).length;
    return {
      generated_at: now.toISOString(),
      staleness_threshold_minutes: E2E_STALE_MIN,
      baseline: { source: 'R2 data/all_jobs.json', last_update: baselineDate.toISOString(), age_minutes: +((now - baselineDate) / 60000).toFixed(1) },
      summary: { measured: results.length, fresh: results.length - unknown - stale, stale, unknown },
      consumers: results,
    };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

async function getRepoSizes() {
  const sizes = {};
  for (const repo of REPOS) {
    try {
      const res = await ghRequest(`https://api.github.com/repos/zapplyjobs/${repo}`);
      if (res.status === 200 && res.body?.size != null) {
        sizes[repo] = Math.round(res.body.size / 1024); // KB → MB
      }
    } catch {}
  }
  const total_mb = Object.values(sizes).reduce((a, b) => a + b, 0);
  return { total_mb: total_mb || null, repos: sizes };
}

// R2 health check (INF-SELF-2) — verifies R2 data freshness
async function getR2Health() {
  if (!R2_ENABLED) {
    return { status: 'not_configured', note: 'R2 secrets not available in this environment' };
  }

  try {
    const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });

    // Check manifest freshness
    const manifestResp = await client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: 'data/last-updated.json',
    }));
    const manifestText = await manifestResp.Body.transformToString();
    const manifest = JSON.parse(manifestText);
    const manifestAge = Date.now() - new Date(manifest.timestamp).getTime();
    const manifestAgeMin = Math.round(manifestAge / 60000);

    // List files for count
    const listResp = await client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: 'data/',
      MaxKeys: 100,
    }));
    const fileCount = (listResp.Contents || []).length;
    const totalBytes = (listResp.Contents || []).reduce((sum, obj) => sum + (obj.Size || 0), 0);

    return {
      status: manifestAgeMin < 30 ? 'healthy' : 'stale',
      manifest_age_minutes: manifestAgeMin,
      manifest_timestamp: manifest.timestamp,
      files_uploaded: manifest.files_uploaded || null,
      files_failed: manifest.files_failed || null,
      file_count: fileCount,
      total_size_mb: Math.round(totalBytes / 1024 / 1024),
    };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

// INF-OBSERV-4: Dedupe store size tracking
async function getDedupeStoreInfo() {
  try {
    const headRes = await ghRequest(`https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/commits/main`);
    if (headRes.status !== 200) return { status: 'error', error: 'Could not fetch aggregator HEAD' };
    const headSha = headRes.body.sha;

    const treeRes = await ghRequest(`https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/git/trees/${headSha}?recursive=1`);
    if (treeRes.status !== 200) return { status: 'error', error: 'Could not fetch aggregator tree' };

    const entry = (treeRes.body.tree || []).find(e => e.path === '.github/data/dedupe-store.json');
    if (!entry) return { status: 'not_found', size_bytes: null, size_mb: null };

    return {
      status: 'tracked',
      size_bytes: entry.size,
      size_mb: Math.round(entry.size / 1024 / 1024 * 10) / 10,
    };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

function countSidecarEntries() {
  const counts = {};
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.match(/^descriptions-.+\.jsonl$/));
    for (const f of files) {
      const source = f.replace(/^descriptions-/, '').replace(/\.jsonl$/, '');
      const content = fs.readFileSync(path.join(DATA_DIR, f), 'utf8').trim();
      counts[source] = content ? content.split('\n').filter(Boolean).length : 0;
    }
  } catch { /* best effort */ }
  return counts;
}

async function main() {
  console.log('Generating zjp-metrics.json...');

  // Read local data files
  const enrichStats = readLocalFile('enrichment-stats.json');
  const metadata = readLocalFile('jobs-metadata.json');
  const alertData = readLocalFile('pipeline-alert.json');

  // Build metrics object
  const metrics = {
    schema: 'zjp-metrics-v1',
    generated_at: new Date().toISOString(),
  };

  // Pool data from metadata
  const tagDomains = metadata?.tag_stats?.domains || {};
  const generalCount = tagDomains['general'] ?? null;
  const totalJobs = metadata?.total_jobs ?? null;
  const g1 = metadata?.tag_stats?.g1 ?? null;
  metrics.pool = {
    total_jobs: totalJobs,
    tech_us: enrichStats?.total_tech_us ?? null,
    domains: tagDomains,
    general_rate_pct: (generalCount !== null && totalJobs && totalJobs > 0)
      ? Math.round(generalCount / totalJobs * 1000) / 10 : null,
    g1_us: g1 ? {
      us_total: g1.us_total,
      us_general: g1.us_general,
      us_general_rate_pct: g1.us_general_rate_pct,
      tech_scope_general_rate_pct: g1.tech_scope_general_rate_pct ?? g1.tech_us_general_rate_pct,
      tech_us_general_rate_pct: g1.tech_us_general_rate_pct ?? g1.tech_scope_general_rate_pct,
    } : null,
    fetch_results: metadata?.fetch_results || null,
    sidecar_counts: countSidecarEntries(),
    source: 'jobs-metadata.json + enrichment-stats.json',
  };

  // TAG-SELF-2: Tag monitoring snapshots (drift + precision)
  const tagDrift = metadata?.tag_drift ?? null;
  const tagPrecision = metadata?.tag_precision ?? null;
  if (tagDrift || tagPrecision) {
    metrics.tag = {
      drift: tagDrift ? {
        drift_rate: tagDrift.drift_rate,
        drift_pct: (tagDrift.drift_rate * 100).toFixed(1) + '%',
        sample_size: tagDrift.sample_size,
        drifted: tagDrift.drifted,
        warnings: tagDrift.warnings || [],
      } : null,
      precision: tagPrecision ? {
        domains: Object.fromEntries(
          Object.entries(tagPrecision.domains).map(([d, r]) => [d, {
            total: r.total,
            fps: r.fps,
            fp_rate: r.fp_rate,
            fp_pct: (r.fp_rate * 100).toFixed(2) + '%',
          }])
        ),
        warnings: tagPrecision.warnings || [],
      } : null,
      keyword_health: metadata?.keyword_health ?? null,
      engine_version: metadata?.tag_engine_version ?? null,
      source: 'jobs-metadata.json',
    };
  }

  // Enrichment data
  if (enrichStats) {
    const total = enrichStats.total_tech_us || 0;
    const enriched = enrichStats.total_enriched || 0;
    const bySource = enrichStats.by_source || {};
    const visaActual = Object.values(bySource).reduce((s, v) => s + (v.actual_job_signal || 0), 0);
    const visaLcaOnly = Object.values(bySource).reduce((s, v) => s + (v.lca_only_signal || 0), 0);
    const visaUnresolved = Object.values(bySource).reduce((s, v) => s + (v.no_visa_signal || 0), 0);
    const visaReasonCounts = {};
    for (const v of Object.values(bySource)) {
      const reasonCounts = v.visa_reason_counts || {};
      for (const [reason, count] of Object.entries(reasonCounts)) {
        visaReasonCounts[reason] = (visaReasonCounts[reason] || 0) + count;
      }
    }
    const missingCurrent = enrichStats.current_missing || {};
    metrics.enrichment = {
      total_enriched: enriched,
      enrichment_rate_pct: total > 0 ? Math.round(enriched / total * 1000) / 10 : null,
      tiers: enrichStats.tiers || {},
      enricher_version: enrichStats.enricher_version || null,
      reenrichment_pending: enrichStats.reenrichment_pending ?? null,
      description_quality: {
        has_description_flag: enrichStats.total_has_description ?? null,
        retrievable_description: enrichStats.total_retrievable_description ?? null,
        retrievable_description_pct: enrichStats.retrievable_description_pct ?? null,
        silent_rot_count: enrichStats.silent_rot_count ?? null,
      },
      current_missing: {
        total: missingCurrent.total ?? null,
        by_source: missingCurrent.by_source || {},
        by_status: missingCurrent.by_status || {},
        top_companies: missingCurrent.top_companies || [],
      },
      visa_paths: {
        actual_job_signal: visaActual,
        lca_only_signal: visaLcaOnly,
        unresolved_signal: visaUnresolved,
        unresolved_reasons: visaReasonCounts,
        by_source: Object.fromEntries(
          Object.entries(bySource).map(([src, v]) => [src, {
            actual_job_signal: v.actual_job_signal ?? null,
            actual_job_signal_pct: v.actual_job_signal_pct ?? null,
            lca_only_signal: v.lca_only_signal ?? null,
            lca_only_signal_pct: v.lca_only_signal_pct ?? null,
            unresolved_signal: v.no_visa_signal ?? null,
            unresolved_signal_pct: v.no_visa_signal_pct ?? null,
            unresolved_reasons: v.visa_reason_counts ?? {},
          }])
        ),
      },
      source: 'enrichment-stats.json',
    };
  } else {
    metrics.enrichment = { source: 'enrichment-stats.json (not available)' };
  }

  // GitHub API calls (async)
  console.log('Querying GitHub API for alignment + freshness + sizes...');
  const [liveAlertData, pipeline, submodules, consumers, repoSizes, r2Health, dedupeStore, consumerE2E] = await Promise.all([
    getLivePipelineAlert(),
    getPipelineStatus(),
    getSubmoduleAlignment(),
    getConsumerFreshness(),
    getRepoSizes(),
    getR2Health(),
    getDedupeStoreInfo(),
    getConsumerE2E(),
  ]);

  const selectedAlert = chooseAlertSnapshot(alertData, liveAlertData);
  if (selectedAlert) {
    metrics.alerts = {
      active: selectedAlert.data.active ?? false,
      failures: selectedAlert.data.failures ?? [],
      warnings: selectedAlert.data.warnings ?? [],
      warning_count: selectedAlert.data.warning_count ?? (selectedAlert.data.warnings || []).length,
      last_checked: selectedAlert.data.checked_at ?? null,
      source: selectedAlert.source,
    };
  } else {
    metrics.alerts = { active: null, source: 'pipeline-alert.json (not available)' };
  }

  metrics.pipeline = pipeline;
  metrics.r2 = r2Health;
  metrics.dedupe = dedupeStore;
  // INF-OBSERV-3: Surface per-stage timings from jobs-metadata.json
  // stage_timings instruments steps 1-9 inside index.js (fetch, tag, dedup, write).
  // It does NOT include: checkout, setup, git push to aggregator, git push to jobs-data.
  // Keep GH API execution/queue (accurate from Jobs API) and add pipeline_internal
  // as a separate field for the internal instrumentation breakdown.
  if (metadata?.stage_timings) {
    metrics.pipeline.stage_timings = metadata.stage_timings;
    const stageTotalMs = Object.values(metadata.stage_timings).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    if (stageTotalMs > 0) {
      const stageExecMin = Math.round(stageTotalMs / 60000 * 10) / 10;
      metrics.pipeline.pipeline_internal_minutes = stageExecMin;
      // Push overhead = wall-clock minus queue minus pipeline-internal
      if (pipeline.aggregator_runtime_minutes && pipeline.aggregator_queue_minutes != null) {
        const pushOverhead = Math.max(0, Math.round((pipeline.aggregator_runtime_minutes - pipeline.aggregator_queue_minutes - stageExecMin) * 10) / 10);
        metrics.pipeline.push_overhead_minutes = pushOverhead;
      }
    }
  }
  metrics.submodules = submodules;
  metrics.consumers = consumers;
  metrics.consumer_e2e = consumerE2E;
  metrics.repos = repoSizes;

  // AGG-QUALITY-1: Surface evergreen metrics from collect-metrics (latest.json)
  const latestMetrics = readLocalFile('metrics/latest.json');
  if (latestMetrics?.pipeline?.evergreen) {
    metrics.evergreen = latestMetrics.pipeline.evergreen;
  }

  if (latestMetrics?.pipeline?.g1Breakdown) {
    if (!metrics.tag) metrics.tag = { source: 'metrics/latest.json' };
    metrics.tag.g1_breakdown = metrics.tag.g1_breakdown ?? latestMetrics.pipeline.g1Breakdown;
  }

  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(metrics, null, 2), 'utf8');
  console.log(`Written ${OUTPUT_FILE}`);
  console.log(`  Pool: ${metrics.pool.total_jobs} jobs, ${metrics.pool.tech_us} tech-US`);
  console.log(`  Enrichment: ${metrics.enrichment.enrichment_rate_pct}% T3`);
  console.log(`  Pipeline: ${metrics.pipeline.aggregator_runtime_minutes}min wall (${metrics.pipeline.aggregator_queue_minutes}min queue + ${metrics.pipeline.aggregator_execution_minutes}min execution)`);
  if (metrics.pipeline.pipeline_internal_minutes) {
    console.log(`    Internal pipeline: ${metrics.pipeline.pipeline_internal_minutes}min, Push overhead: ${metrics.pipeline.push_overhead_minutes}min`);
  }
  const subSummary = Object.entries(SUBMODULE_CONFIG).map(([name, cfg]) => {
    const sub = metrics.submodules[name];
    return `${name}: ${sub?.p2_status || '?'}`;
  }).join(' | ');
  console.log(`  P-2: ${subSummary}`);
  console.log(`  Consumers: ${Object.keys(metrics.consumers.repos).length} repos checked`);
  console.log(`  Consumer E2E: ${metrics.consumer_e2e.summary ? metrics.consumer_e2e.summary.measured + ' measured / ' + metrics.consumer_e2e.summary.stale + ' stale' : metrics.consumer_e2e.status}`);
  console.log(`  Repo sizes: ${metrics.repos.total_mb} MB total`);
  console.log(`  R2: ${metrics.r2.status}${metrics.r2.manifest_age_minutes != null ? ' (' + metrics.r2.manifest_age_minutes + ' min old, ' + metrics.r2.file_count + ' files, ' + metrics.r2.total_size_mb + ' MB)' : ''}`);
  console.log(`  Dedupe: ${metrics.dedupe.status}${metrics.dedupe.size_mb != null ? ' (' + metrics.dedupe.size_mb + ' MB)' : ''}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  // Don't exit with error — this is additive, shouldn't break the pipeline
});
