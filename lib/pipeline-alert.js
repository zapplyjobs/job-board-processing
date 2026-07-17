#!/usr/bin/env node

/**
 * Pipeline Alert — Thin Runner
 *
 * Loads all check modules from ./checks/, runs them with a shared context,
 * aggregates failures, writes pipeline-alert.json, and posts to Discord.
 *
 * Checks live in ./checks/check-NN-*.js. Each exports { id, name, check(ctx) }.
 * Thresholds live in ./checks/config.js. No hardcoded values here.
 *
 * Adding a new check: create checks/check-NN-name.js, add to checks/index.js. Done.
 */

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

const checks = require('./checks');
const config = require('./checks/config');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_PIPELINE_ALERT_CHANNEL_ID;
const GH_PAT_EXPIRY_DATE = process.env.GH_PAT_EXPIRY_DATE;
const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const METRICS_LATEST = path.join(DATA_DIR, 'metrics', 'latest.json');

async function buildContext() {
  const ctx = {
    token: GITHUB_TOKEN,
    config,
    dataDir: DATA_DIR,
    metadata: null,
    prev: null,
    enrichStats: null,
    metricsLatest: null,
    allJobs: null,
    allJobsPath: null,
    zjpMetrics: null,
  };

  // Load metadata (checks 4-12, 14, 19, 20 depend on this)
  const metadataPath = path.join(DATA_DIR, 'jobs-metadata.json');
  if (fs.existsSync(metadataPath)) {
    try { ctx.metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); }
    catch { /* checks will handle null */ }
  }

  // Load previous metrics snapshot (checks 4, 5, 14 depend on this)
  if (fs.existsSync(METRICS_LATEST)) {
    try {
      ctx.prev = JSON.parse(fs.readFileSync(METRICS_LATEST, 'utf8'));
      ctx.metricsLatest = ctx.prev;
    } catch { /* checks handle null */ }
  }

  // Load enrichment stats (checks 12, 15 depend on this)
  const enrichStatsPath = path.join(DATA_DIR, 'enrichment-stats.json');
  if (fs.existsSync(enrichStatsPath)) {
    try { ctx.enrichStats = JSON.parse(fs.readFileSync(enrichStatsPath, 'utf8')); }
    catch { /* checks handle null */ }
  }

  // Load all_jobs.json once for checks 10, 19 (memory-heavy, but shared)
  const allJobsPath = path.join(DATA_DIR, 'all_jobs.json');
  if (fs.existsSync(allJobsPath)) {
    ctx.allJobsPath = allJobsPath;
    try {
      const lines = fs.readFileSync(allJobsPath, 'utf8').trim().split('\n').filter(Boolean);
      ctx.allJobs = lines.map(line => JSON.parse(line));
    } catch { /* checks handle null */ }
  }

  // Load zjp-metrics.json (check 21 dedupe store size)
  const zjpMetricsPath = path.join(DATA_DIR, 'zjp-metrics.json');
  if (fs.existsSync(zjpMetricsPath)) {
    try { ctx.zjpMetrics = JSON.parse(fs.readFileSync(zjpMetricsPath, 'utf8')); }
    catch { /* checks handle null */ }
  }

  return ctx;
}

async function runChecks(ctx) {
  const failures = [];
  const warnings = [];

  for (const check of checks) {
    try {
      const result = await check.check(ctx);
      if (result) {
        // A check can return multiple failures separated by newlines
        for (const line of result.split('\n').filter(Boolean)) {
          failures.push(line);
        }
      }
    } catch (err) {
      console.error(`Check ${check.id} (${check.name}) threw:`, err.message);
    }

    // Warning tier (if check implements it)
    if (typeof check.warn === 'function' && !config.warnings) continue;
    if (typeof check.warn === 'function') {
      try {
        const warnResult = await check.warn(ctx);
        if (warnResult) {
          for (const line of warnResult.split('\n').filter(Boolean)) {
            warnings.push(line);
          }
        }
      } catch { /* warnings are best-effort */ }
    }
  }

  return { failures, warnings };
}

async function postAlert(failures) {
  if (!DISCORD_TOKEN || !CHANNEL_ID) {
    console.error('DISCORD_TOKEN or DISCORD_PIPELINE_ALERT_CHANNEL_ID not set');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  await client.login(DISCORD_TOKEN);
  await new Promise(r => client.once('ready', r));

  await Promise.all(client.guilds.cache.map(g => g.channels.fetch()));
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error(`Channel ${CHANNEL_ID} not found or not a text channel`);

  const embed = {
    title: '🚨 Pipeline Alert',
    color: 0xe74c3c,
    description: failures.map(f => `• ${f}`).join('\n'),
    footer: { text: `Checked at ${new Date().toISOString()}` }
  };

  await channel.send({ embeds: [embed] });
  await client.destroy();
}

async function main() {
  console.log('🔍 Running pipeline health checks...');

  if (!GITHUB_TOKEN) { console.error('GITHUB_TOKEN not set'); process.exit(1); }

  const ctx = await buildContext();
  const { failures, warnings } = await runChecks(ctx);

  // Read PREVIOUS alert state (before we overwrite it) for suppression
  const alertFile = path.join(DATA_DIR, 'pipeline-alert.json');
  let prevFailures = [];
  try {
    const prev = JSON.parse(fs.readFileSync(alertFile, 'utf8'));
    prevFailures = prev.failures || [];
  } catch { /* first run or file missing — alert everything */ }

  const secretWarnings = [];
  if (GH_PAT_EXPIRY_DATE) {
    const expiry = new Date(GH_PAT_EXPIRY_DATE);
    if (!isNaN(expiry.getTime())) {
      const daysLeft = Math.floor((expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      secretWarnings.push({ secret: 'GH_PAT', expires: GH_PAT_EXPIRY_DATE, days_left: daysLeft });
      if (daysLeft <= config.thresholds.patDaysLeft) {
        failures.push(
          `**GH_PAT expires in ${daysLeft} days** — all 8 repo workflows will fail. Rotate immediately.`
        );
      }
    }
  }
  const alertData = {
    checked_at: new Date().toISOString(),
    active: failures.length > 0,
    message: failures.length > 0 ? failures.join(' | ') : null,
    failures,
    warnings,
    warning_count: warnings.length,
    secrets: secretWarnings,
  };
  fs.writeFileSync(alertFile, JSON.stringify(alertData, null, 2), 'utf8');
  console.log(`📄 Written pipeline-alert.json (active: ${alertData.active}, warnings: ${warnings.length})`);

  if (warnings.length > 0) {
    console.log(`⚡ ${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`   • ${w}`));
  }

  if (failures.length === 0) {
    console.log('✅ All checks passed — no alert sent');
    return;
  }

  // Suppression: only post NEW failures (not already in previous alert)
  const newFailures = failures.filter(f => !prevFailures.includes(f));
  if (newFailures.length === 0) {
    console.log(`🔇 ${failures.length} failure(s) unchanged since last check — suppressing Discord alert`);
    return;
  }

  console.log(`⚠️  ${failures.length} check(s) failed (${newFailures.length} new):`);
  failures.forEach(f => console.log(`   • ${f}`));

  if (process.env.DISCORD_SILENT === 'true') {
    console.log('🔇 DISCORD_SILENT enabled — skipping Discord post. Dashboard alert still active.');
  } else {
    await postAlert(newFailures);
    console.log(`✅ Alert posted to Discord (${newFailures.length} new failure(s))`);
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
