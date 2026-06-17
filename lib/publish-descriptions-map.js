#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const TECH_DOMAINS = new Set(['software', 'data_science', 'hardware', 'ai']);

function parseArgs(argv) {
  let dataDir = '.github/data';
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--data-dir' && argv[i + 1]) dataDir = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { dataDir };
}

function parseJsonOrNdjsonRecords(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  if (text[0] === '[') {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      // Fall through to NDJSON parsing.
    }
  }

  return text.split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function loadRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseJsonOrNdjsonRecords(fs.readFileSync(filePath, 'utf8'));
}

function loadDescriptionsMap(dataDir) {
  const map = new Map();
  const files = fs.readdirSync(dataDir)
    .filter(f => /^descriptions-.*\.jsonl$/.test(f))
    .sort();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(dataDir, file), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.id) map.set(row.id, row.description_text || row.description || null);
      } catch {}
    }
  }
  return map;
}

function isUsTech(job) {
  const tags = job.tags || {};
  const locations = tags.locations || job.location_tags || [];
  const domains = tags.domains || job.domain_tags || [];
  return locations.includes('us') && domains.some(domain => TECH_DOMAINS.has(domain));
}

function chooseBoardJobs(dataDir) {
  const usJobs = loadRecords(path.join(dataDir, 'us_jobs.json'));
  if (usJobs.length > 0) return usJobs.filter(isUsTech);
  return loadRecords(path.join(dataDir, 'all_jobs.json')).filter(isUsTech);
}

function buildDescriptionsMap(jobs, descriptionsMap) {
  const out = {};
  let fromSidecar = 0;
  let fromInline = 0;
  for (const job of jobs) {
    const text = descriptionsMap.get(job.id) || job.description || null;
    if (!text || String(text).trim().length < 50) continue;
    out[job.id] = text;
    if (descriptionsMap.has(job.id)) fromSidecar++;
    else fromInline++;
  }
  return { map: out, fromSidecar, fromInline };
}

function main() {
  const { dataDir } = parseArgs(process.argv);
  if (!fs.existsSync(dataDir)) throw new Error(`No data dir: ${dataDir}`);

  const jobs = chooseBoardJobs(dataDir);
  const descriptionsMap = loadDescriptionsMap(dataDir);
  const { map, fromSidecar, fromInline } = buildDescriptionsMap(jobs, descriptionsMap);
  const outPath = path.join(dataDir, 'softwarejobs-descriptions.json');
  fs.writeFileSync(outPath, JSON.stringify(map), 'utf8');
  console.log(`[publish-descriptions-map] Wrote ${Object.keys(map).length} descriptions (${fromSidecar} sidecar, ${fromInline} inline) to ${path.basename(outPath)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[publish-descriptions-map]', err.message);
    process.exit(1);
  }
}

module.exports = {
  parseJsonOrNdjsonRecords,
  loadRecords,
  loadDescriptionsMap,
  chooseBoardJobs,
  buildDescriptionsMap,
  isUsTech,
};
