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
  'New-Grad-Jobs-2026',
  'Internships-2026',
  'New-Grad-Software-Engineering-Jobs-2026',
  'New-Grad-Data-Science-Jobs-2026',
  'New-Grad-Hardware-Engineering-Jobs-2026',
  'New-Grad-Healthcare-Jobs-2026',
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

// Submodule → source repo + target repos mapping
const SUBMODULE_CONFIG = {
  shared: {
    source_repo: 'zapplyjobs/job-board-shared',
    repos: [
      'jobs-aggregator-private', 'jobs-data-2026',
      'New-Grad-Jobs-2026', 'Internships-2026',
      'New-Grad-Software-Engineering-Jobs-2026', 'New-Grad-Data-Science-Jobs-2026',
      'New-Grad-Hardware-Engineering-Jobs-2026', 'New-Grad-Healthcare-Jobs-2026',
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
      'New-Grad-Jobs-2026', 'Internships-2026',
      'New-Grad-Software-Engineering-Jobs-2026', 'New-Grad-Data-Science-Jobs-2026',
      'New-Grad-Hardware-Engineering-Jobs-2026', 'New-Grad-Healthcare-Jobs-2026',
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
          if (dur > 0 && dur < 24 * 60) status.aggregator_runtime_minutes = Math.round(dur * 10) / 10;
        }

        // Execution time from job-level timing
        if (timingRun.id) {
          try {
            const jobRes = await ghRequest(`https://api.github.com/repos/zapplyjobs/jobs-aggregator-private/actions/runs/${timingRun.id}/jobs`);
            if (jobRes.body?.jobs?.[0]) {
              const job = jobRes.body.jobs[0];
              if (job.created_at && timingRun.created_at) {
                const queueMin = (new Date(job.created_at) - new Date(timingRun.created_at)) / 60000;
                if (queueMin >= 0 && queueMin < 24 * 60) status.aggregator_queue_minutes = Math.round(queueMin * 10) / 10;
              }
              if (job.completed_at && job.started_at) {
                const execMin = (new Date(job.completed_at) - new Date(job.started_at)) / 60000;
                if (execMin > 0 && execMin < 24 * 60) status.aggregator_execution_minutes = Math.round(execMin * 10) / 10;
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
      tech_us_general_rate_pct: g1.tech_us_general_rate_pct,
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
      g1_breakdown: metadata?.g1_breakdown ?? null,
      source: 'jobs-metadata.json',
    };
  }

  // Enrichment data
  if (enrichStats) {
    const total = enrichStats.total_tech_us || 0;
    const enriched = enrichStats.total_enriched || 0;
    metrics.enrichment = {
      total_enriched: enriched,
      enrichment_rate_pct: total > 0 ? Math.round(enriched / total * 1000) / 10 : null,
      tiers: enrichStats.tiers || {},
      enricher_version: enrichStats.enricher_version || null,
      reenrichment_pending: enrichStats.reenrichment_pending ?? null,
      source: 'enrichment-stats.json',
    };
  } else {
    metrics.enrichment = { source: 'enrichment-stats.json (not available)' };
  }

  // Alerts from local file
  if (alertData) {
    metrics.alerts = {
      active: alertData.active ?? false,
      failures: alertData.failures ?? [],
      last_checked: alertData.checked_at ?? null,
      source: 'pipeline-alert.json',
    };
  } else {
    metrics.alerts = { active: null, source: 'pipeline-alert.json (not available)' };
  }

  // GitHub API calls (async)
  console.log('Querying GitHub API for alignment + freshness + sizes...');
  const [pipeline, submodules, consumers, repoSizes, r2Health, dedupeStore] = await Promise.all([
    getPipelineStatus(),
    getSubmoduleAlignment(),
    getConsumerFreshness(),
    getRepoSizes(),
    getR2Health(),
    getDedupeStoreInfo(),
  ]);

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
  metrics.repos = repoSizes;

  // AGG-QUALITY-1: Surface evergreen metrics from collect-metrics (latest.json)
  const latestMetrics = readLocalFile('metrics/latest.json');
  if (latestMetrics?.pipeline?.evergreen) {
    metrics.evergreen = latestMetrics.pipeline.evergreen;
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
  console.log(`  Repo sizes: ${metrics.repos.total_mb} MB total`);
  console.log(`  R2: ${metrics.r2.status}${metrics.r2.manifest_age_minutes != null ? ' (' + metrics.r2.manifest_age_minutes + ' min old, ' + metrics.r2.file_count + ' files, ' + metrics.r2.total_size_mb + ' MB)' : ''}`);
  console.log(`  Dedupe: ${metrics.dedupe.status}${metrics.dedupe.size_mb != null ? ' (' + metrics.dedupe.size_mb + ' MB)' : ''}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  // Don't exit with error — this is additive, shouldn't break the pipeline
});