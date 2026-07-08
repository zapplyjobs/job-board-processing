'use strict';

// ---------------------------------------------------------------------------
// ENR-DONECHECK-CONSOLIDATION-1: QueueState — single-owner FSM for the enrichment queue.
//
// Consolidates the scattered done-check logic (loadEnrichedIds + isEnrichable +
// shouldRescueExhaustedRecord + shouldResurrectSkippedRecord + inline mutations) into one
// module with explicit states + transitions. Eliminates: two-store drift (ENR-QUEUE-3),
// stale-flag-vs-live (ENR-DESCRETRIEVE-1), resurrection one-run-delay, same-version gating.
//
// Design spec: projects/zjp/research/ENR_DONECHECK_FSM_DESIGN_C186_2026_07_07.md
// Pattern: FSM-over-flags + single-state-owner (birdhouss.com/finite-state-machines-vs-booleans)
//
// Key improvement over the current scattered code:
//   isDone() computes from the IN-MEMORY state (processedMap + enrichedJobsById) each call —
//   no stale file-re-read → eliminates the resurrection one-run-delay (the scatter bug where
//   resurrection mutates processedMap but loadEnrichedIds re-reads the file).
// ---------------------------------------------------------------------------

class QueueState {
  /**
   * @param {Object} opts
   * @param {Object} opts.processedMap - The processed_ids map {id: {status, ...}}
   * @param {Map} opts.enrichedJobsById - Enriched records keyed by id
   * @param {Map} opts.descriptionsMap - Description text keyed by id
   * @param {number} opts.currentVersion - The current ENRICHER_VERSION
   * @param {Set} opts.techDomains - TECH_DOMAINS set
   * @param {Set} opts.structuralSources - STRUCTURAL_SOURCES set
   * @param {number} opts.maxRetries - MAX_RETRIES before exhaustion
   */
  constructor({ processedMap, enrichedJobsById, descriptionsMap, currentVersion, techDomains, structuralSources, maxRetries }) {
    this.processedMap = processedMap;
    this.enrichedJobsById = enrichedJobsById;
    this.descriptionsMap = descriptionsMap;
    this.currentVersion = currentVersion;
    this.techDomains = techDomains;
    this.structuralSources = structuralSources;
    this.maxRetries = maxRetries;
  }

  // =====================
  // Queries (read state)
  // =====================

  /**
   * Is this job "done" (should be skipped in the next batch)?
   * Consolidates loadEnrichedIds skip-set logic.
   * Computed from in-memory state each call (no stale file re-read).
   */
  isDone(id) {
    const entry = this.processedMap[id];
    if (entry) {
      // SKIPPED jobs are permanently done (unless resurrected)
      if (entry.status === 'skipped') return true;
      // EXHAUSTED at current version are done (unless rescued)
      if (entry.status === 'exhausted' && (entry.enricher_version || 0) >= this.currentVersion) return true;
    }
    // ENRICHED at current version WITH skills are done (ENR-P0: skills required, not just has_description)
    const enriched = this.enrichedJobsById.get(id);
    if (enriched && (enriched.enricher_version || 0) >= this.currentVersion) {
      if (enriched.required_skills?.length > 0) return true;
    }
    return false;
  }

  /**
   * Should this NEW job enter the enrichment path?
   * Consolidates isEnrichable (tech/US/structural/WD-SR-description gates).
   */
  isEnrichable(job) {
    const domains = job.tags?.domains || [];
    const locations = job.tags?.locations || [];
    if (!domains.some(d => this.techDomains.has(d))) return false;
    if (!locations.includes('us')) return false;
    if (this.structuralSources.has(job.source)) return false;
    // ENRICH-OBS-2: WD/SR jobs need a description available
    if (job.source === 'workday' || job.source === 'smartrecruiters') {
      return !!this.descriptionsMap.get(job.id);
    }
    return true;
  }

  /**
   * Is description text available RIGHT NOW (live signal, not stored flag)?
   * Consolidates hasDescriptionNow.
   */
  hasDescriptionNow(job) {
    return !!(this.descriptionsMap.get(job.id) || job.description);
  }

  /**
   * Should a SKIPPED job transition back to NEW (resurrect)?
   * Consolidates shouldResurrectSkippedRecord.
   */
  shouldResurrect(job) {
    const entry = this.processedMap[job.id];
    if (entry?.status !== 'skipped') return false;
    if (!['non-tech', 'non-us'].includes(entry.reason)) return false;
    return this.isEnrichable(job);
  }

  /**
   * Should an EXHAUSTED job transition back to NEW (rescue)?
   * Consolidates shouldRescueExhaustedRecord.
   */
  shouldRescue(job) {
    const entry = this.processedMap[job.id];
    const currentlyExhausted = entry?.status === 'exhausted' && (entry.enricher_version || 0) >= this.currentVersion;
    const latest = this.enrichedJobsById.get(job.id);
    const wasMissingDescription = !latest || latest.has_description === false;
    return currentlyExhausted && wasMissingDescription && this.hasDescriptionNow(job);
  }

  // ========================
  // Transitions (mutate state)
  // ========================

  /** NEW/PENDING → ENRICHED */
  markEnriched(id, now = new Date().toISOString()) {
    this.processedMap[id] = { status: 'enriched', processed_at: now };
  }

  /** NEW/PENDING → SKIPPED */
  markSkipped(id, reason, now = new Date().toISOString()) {
    this.processedMap[id] = { status: 'skipped', reason, processed_at: now };
  }

  /** NEW/PENDING → EXHAUSTED */
  markExhausted(id, retryCount, now = new Date().toISOString()) {
    this.processedMap[id] = { status: 'exhausted', retry_count: retryCount, enricher_version: this.currentVersion, processed_at: now };
  }

  /** NEW/PENDING → RETRY */
  markRetry(id, retryCount, now = new Date().toISOString()) {
    this.processedMap[id] = { status: 'retry', retry_count: retryCount, enricher_version: this.currentVersion, processed_at: now };
  }

  /** SKIPPED → NEW (resurrect) */
  resurrect(id) {
    delete this.processedMap[id];
  }

  /** EXHAUSTED → NEW (rescue) */
  rescue(id) {
    delete this.processedMap[id];
  }

  /** Any → GONE (prune — remove entries for jobs no longer in the live pool) */
  pruneStale(liveIds) {
    for (const id of Object.keys(this.processedMap)) {
      if (!liveIds.has(id)) delete this.processedMap[id];
    }
  }

  // ===========
  // Helpers
  // ===========

  /** Determine the skip reason for a non-enrichable job (replicates L736 inline logic) */
  getSkipReason(job) {
    const domains = job.tags?.domains || [];
    if (!domains.some(d => this.techDomains.has(d))) return 'non-tech';
    return 'non-us';
  }

  /** Compute retry count with version-bump reset (replicates L852-856) */
  computeRetryCount(id) {
    const prev = this.processedMap[id];
    const prevVersion = prev?.enricher_version || 0;
    const isVersionBump = prevVersion < this.currentVersion;
    return isVersionBump ? 1 : (prev?.retry_count || 0) + 1;
  }

  /** Check if this job has exceeded MAX_RETRIES (should be exhausted, not retried) */
  shouldExhaust(id) {
    return this.computeRetryCount(id) >= this.maxRetries;
  }

  /** Get the current processedMap (for serialization at end of run) */
  getProcessedMap() {
    return this.processedMap;
  }
}

module.exports = { QueueState };
