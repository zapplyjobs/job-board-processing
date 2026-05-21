// ---------------------------------------------------------------------------
// ENR-ARCH-1: Taxonomy module
// Skills taxonomy loading and matching.
// Extracted from enrich-jobs.js for independent testing and maintainability.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');

const TAXONOMY_PATH = path.join(__dirname, 'skills-taxonomy.json');

const SKILL_ALIASES = {
  'react.js': 'React', 'reactjs': 'React',
  'vue.js': 'Vue', 'vuejs': 'Vue',
  'node.js': 'Node.js',
  'postgres': 'PostgreSQL',
  'k8s': 'Kubernetes',
  'nlp': 'Natural Language Processing',
};

// Terms that are too ambiguous on their own — require a tech context signal
const AMBIGUOUS_TERMS = new Set(['go', 'r', 'c', 'rest', 'restful', 'assembly', 'lean', 'chef', 'classification', 'move']);

// Terms that match company names in boilerplate text
const COMPANY_NAME_TERMS = new Set(['openai']);

const TECH_CONTEXT_SIGNALS = [
  /\b(programming|language|developer|engineer|code|software|written in|experience with|proficien|framework|backend|api)\b/i,
];

function hasTechContext(text, matchIdx) {
  const window = text.slice(Math.max(0, matchIdx - 120), matchIdx + 120);
  return TECH_CONTEXT_SIGNALS.some(re => re.test(window));
}

function loadTaxonomy() {
  const raw = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
  const termMap = new Map();
  for (const [category, terms] of Object.entries(raw)) {
    if (category === '_meta') continue;
    for (const term of terms) {
      const canonical = SKILL_ALIASES[term.toLowerCase()] || term;
      termMap.set(term.toLowerCase(), canonical);
    }
  }
  return termMap;
}

function matchSkills(text, termMap) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = new Set();

  for (const [termLower, termCanonical] of termMap) {
    let searchFrom = 0;
    let idx;
    while ((idx = lower.indexOf(termLower, searchFrom)) !== -1) {
      searchFrom = idx + 1;

      const before = idx === 0 ? ' ' : lower[idx - 1];
      const after = idx + termLower.length >= lower.length ? ' ' : lower[idx + termLower.length];
      const wordBefore = /[a-z0-9]/.test(before);
      const wordAfter = /[a-z0-9]/.test(after);

      if (!wordBefore && !wordAfter) {
        if (AMBIGUOUS_TERMS.has(termLower) && !hasTechContext(lower, idx)) {
          continue;
        }
        found.add(termCanonical);
        break;
      }
    }
  }

  return Array.from(found).sort();
}

module.exports = {
  loadTaxonomy,
  matchSkills,
  SKILL_ALIASES,
  AMBIGUOUS_TERMS,
  COMPANY_NAME_TERMS,
  TECH_CONTEXT_SIGNALS,
  hasTechContext,
};
