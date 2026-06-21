// sidecar-standard.js — shared ENR description-sidecar constants.
// Single source of truth for the singular cross-module sidecar standard
// (AGG_CONTRACT.md 'Storage & Canonical Store / Description Sidecar Standard').
// ENR-SIDECAR-STANDARD-1: consolidates the previously-duplicated chunk-limit
// constant and aligns ENR to the AGG-authored 40MB standard (was 50MB).

// Max byte size of a single enriched description sidecar chunk. A new chunk
// file (descriptions-enriched-N.jsonl) is started when the active chunk exceeds
// this. Aligns ENR to the AGG 40MB standard.
const CHUNK_LIMIT_BYTES = 40 * 1024 * 1024;

module.exports = { CHUNK_LIMIT_BYTES };
