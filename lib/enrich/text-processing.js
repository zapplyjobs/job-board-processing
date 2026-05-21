// ---------------------------------------------------------------------------
// ENR-ARCH-1: Text processing module
// HTML→text conversion and section splitting for job descriptions.
// Extracted from enrich-jobs.js for independent testing and maintainability.
// ---------------------------------------------------------------------------

'use strict';

const he = require('he');

function toPlainText(html) {
  if (!html) return '';
  // Double-decode: &amp;nbsp; → &nbsp; → (space). Handles double-encoded HTML from ATS sources.
  const decoded = he.decode(he.decode(html));

  // Step 1: Replace <h1>–<h4> with structural markers before any other processing.
  let marked = decoded.replace(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi, (_, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return text ? `\n###SECTION:${text}###\n` : '\n';
  });

  // Step 2: Replace block-level <p> and <div> that contain ONLY a <strong> or <b>
  marked = marked.replace(/<(p|div)[^>]*>\s*<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>\s*<\/\1>/gi, (_, _tag, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    return text ? `\n###SECTION:${text}###\n` : '\n';
  });

  // Step 3: Replace remaining block-level tags with newline for section splitting
  const withNewlines = marked.replace(/<\/(p|div|li|h[1-6]|br)>/gi, '\n');
  // Strip remaining tags
  const stripped = withNewlines.replace(/<[^>]+>/g, ' ');
  return stripped.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const REQUIRED_HEADERS = [
  /requirements?[:\s]?$/i,
  /(?<!preferred\s)(?<!desired\s)qualifications?[:\s]?$/i,
  /what you (need|bring|must have)[:\s]?$/i,
  /what you need to succeed[:\s]?$/i,
  /what we('?re| are) looking for[:\s]?$/i,
  /education (and|&).{0,10}experience[:\s]?$/i,
  /minimum qualifications?[:\s]?$/i,
  /basic qualifications?[:\s]?$/i,
  /required (skills?|qualifications?)[:\s]?$/i,
  /must[ -]have[:\s]?$/i,
  /you (will need|should have)[:\s]?$/i,
  /skills? you.ll need[:\s]?/i,
  /in practice this looks like[:\s]?$/i,
  /you might thrive here if[:\s]?$/i,
  /who you are[:\s]?$/i,
  /what you.ll bring[:\s]?$/i,
  /about you[:\s]?$/i,
  /the ideal candidate[:\s]?$/i,
  /^experience[:\s]?$/i,
  /successful candidates?.{0,50}(will|should|must)/i,
];

const PREFERRED_HEADERS = [
  /preferred (qualifications?|skills?|experience)/i,
  /nice[ -]to[ -]haves?[:\s]?$/i,
  /bonus (points?|if|qualifications?)?[:\s]?$/i,
  /desired qualifications?/i,
  /plus (if|points?)?[:\s]?$/i,
  /it'?s? (a )?(bonus|plus|nice)[:\s]?$/i,
  /while not required/i,
  /added (plus|bonus)/i,
];

function splitSections(text) {
  const lines = text.split('\n');
  let requiredStart = -1;
  let preferredStart = -1;
  const allBoundaries = [];

  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = lines[i].match(/^###SECTION:(.+?)###$/);
    const line = sectionMatch ? sectionMatch[1].trim() : lines[i];

    if (REQUIRED_HEADERS.some(r => r.test(line))) {
      allBoundaries.push({ idx: i, type: 'required' });
      if (requiredStart === -1) requiredStart = i;
    } else if (PREFERRED_HEADERS.some(r => r.test(line))) {
      allBoundaries.push({ idx: i, type: 'preferred' });
      if (preferredStart === -1) preferredStart = i;
    }
  }

  const extractSection = (start) => {
    if (start === -1) return '';
    const nextBoundary = allBoundaries.find(b => b.idx > start);
    const end = nextBoundary ? Math.min(nextBoundary.idx, start + 80) : start + 80;
    return lines.slice(start, end).join(' ');
  };

  return {
    required: extractSection(requiredStart),
    preferred: extractSection(preferredStart),
  };
}

module.exports = {
  toPlainText,
  splitSections,
  REQUIRED_HEADERS,
  PREFERRED_HEADERS,
};
