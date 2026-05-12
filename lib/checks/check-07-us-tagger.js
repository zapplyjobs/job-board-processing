/**
 * Check 7: us-tagged count = 0 (location tagger broken)
 */
module.exports = {
  id: 7,
  name: 'US location tagger',
  check(ctx) {
    if (!ctx.metadata) return null;
    const usTagged = ctx.metadata.tag_stats?.locations?.us ?? null;
    if (usTagged === 0) {
      return '**US location tagger broken**: 0 jobs tagged `us` — check tagLocations() in tag-engine.js';
    }
    return null;
  },
};
