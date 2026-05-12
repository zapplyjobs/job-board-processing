/**
 * Check 22: Metadata field completeness
 *
 * Validates that expected fields exist and are non-null in jobs-metadata.json.
 * Catches silent data loss from code regressions (e.g., TAG-SELF-9 killed
 * keyword_overlap for 2+ runs with zero alerts).
 *
 * AGG-SELF-4 (Check B) — Origin: A46 design doc.
 */
module.exports = {
  id: 22,
  name: 'metadata completeness',
  check(ctx) {
    if (!ctx.metadata) return '**Metadata missing**: jobs-metadata.json not loaded';

    const REQUIRED_FIELDS = [
      { path: 'keyword_overlap', desc: 'cross-domain keyword overlap report' },
      { path: 'keyword_health', desc: 'per-domain keyword health' },
      { path: 'tag_drift', desc: 'carry-forward tag drift rate' },
      { path: 'tag_precision', desc: 'tag precision warnings' },
      { path: 'senior_filter_stats', desc: 'senior filter metrics' },
      { path: 'tag_stats', desc: 'domain/employment tag distribution' },
      { path: 'stage_timings', desc: 'pipeline stage timing breakdown' },
      { path: 'validation_stats', desc: 'job validation statistics' },
    ];

    const missing = [];
    for (const field of REQUIRED_FIELDS) {
      const val = ctx.metadata[field.path];
      if (val === undefined || val === null) {
        missing.push(field.path);
      }
    }

    if (missing.length >= 3) {
      return `**Metadata severely incomplete**: ${missing.length} fields missing (${missing.join(', ')}). Pipeline code may have a regression.`;
    }
    if (missing.length > 0) {
      return `**Metadata field missing**: ${missing.join(', ')}`;
    }
    return null;
  },
};
