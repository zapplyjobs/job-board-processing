// ---------------------------------------------------------------------------
// ENR-ARCH-1: Field extraction module
// Degree, experience level, and boilerplate detection — pure regex, no I/O.
// Extracted from enrich-jobs.js for independent testing and maintainability.
// ---------------------------------------------------------------------------

'use strict';

// Boilerplate openers: company-about sentences, NOT role description sentences.
const BOILERPLATE_OPENERS = [
  /^at [a-z]/i,
  /^(about us|about the company|company overview)/i,
  /^our (mission|vision|company|culture|values)/i,
  /^(founded in|incorporated in)/i,
  /^(we are a |we're a )/i,
  /^join (us|our team|the team)/i,
  /\bwith \d+\+?\s*years of experience\b/i,
];

// Degree regexes — ordered by priority in extractMinDegree()
const DEGREE_PHD = /\b(ph\.?d\.?|doctoral|doctorate)\b/i;
const DEGREE_MASTERS = /\b(master['’]?s?)\s*(degree|program|of science|of arts|of engineering|in\s+\w+|or higher|preferred|required|or phd|or doctoral|\/bs|\/bachelor)/i;
const DEGREE_MASTERS_ABBREV = /\bm\.?s\.?(\s|,|$)/i;
const DEGREE_MBA = /\bmba\b/i;
const DEGREE_BACHELORS = /\b(bachelor['’]?s?)\s*(degree|program|of science|of arts|of engineering|in\s+\w+|or higher|preferred|required|or master|\/ms|\/master)/i;
const DEGREE_BACHELORS_ABBREV = /\bb\.?s\.?(\s|,|$)|\bb\.?e\.?(\s|,|$)|\bba\s*(degree|$)/i;
const DEGREE_BACHELORS_SHORT = /\b(bachelor['’]?s?|bs|ba)\s*[\+\/]\s*\d/i;
const DEGREE_MS_BS = /\bms\s*\/\s*bs\b|\bbs\s*\/\s*ms\b/i;
const DEGREE_ASSOCIATE = /\b(associate['’]?s?)\s*(degree|in\s+\w+)/i;
const DEGREE_NONE = /\b(no (degree|college required)|equivalent experience|without (a )?degree|degree not required|equivalent combination|in lieu of degree|high school diploma|hs diploma|ged\b)/i;
const DEGREE_STANDALONE = /\bdegree\s+(required|preferred|in\s+\w+|or\s+(higher|equivalent))\b/i;

function extractMinDegree(text) {
  if (!text) return null;
  const hasBachelors = DEGREE_BACHELORS.test(text) || DEGREE_BACHELORS_ABBREV.test(text) || DEGREE_BACHELORS_SHORT.test(text) || DEGREE_MS_BS.test(text);
  const hasMasters = DEGREE_MASTERS.test(text) || DEGREE_MASTERS_ABBREV.test(text) || DEGREE_MBA.test(text) || DEGREE_MS_BS.test(text);
  const hasPhd = DEGREE_PHD.test(text);
  const hasAssociate = DEGREE_ASSOCIATE.test(text);
  const hasNone = DEGREE_NONE.test(text);
  const hasStandalone = DEGREE_STANDALONE.test(text);
  if (hasAssociate) return 'associates';
  if (hasBachelors) return 'bachelors';
  if (hasMasters) return 'masters';
  if (hasPhd) return 'phd';
  if (hasNone) return 'none';
  if (hasStandalone) return 'bachelors';
  return null;
}

// Title-based degree inference — first match wins.
const DEGREE_INFERENCE_RULES = [
  [/\bsoftware engineer\b/i, 'bachelors'],
  [/\bsoftware developer\b/i, 'bachelors'],
  [/\bfrontend engineer\b/i, 'bachelors'],
  [/\bbackend engineer\b/i, 'bachelors'],
  [/\bfullstack engineer\b/i, 'bachelors'],
  [/\bfull.?stack engineer\b/i, 'bachelors'],
  [/\bweb developer\b/i, 'bachelors'],
  [/\bandroid (?:engineer|developer)\b/i, 'bachelors'],
  [/\bios (?:engineer|developer)\b/i, 'bachelors'],
  [/\bmobile (?:engineer|developer)\b/i, 'bachelors'],
  [/\bdata scientist\b/i, 'bachelors'],
  [/\bdata engineer\b/i, 'bachelors'],
  [/\bdata analyst\b/i, 'bachelors'],
  [/\bmachine learning engineer\b/i, 'bachelors'],
  [/\bml engineer\b/i, 'bachelors'],
  [/\bai engineer\b/i, 'bachelors'],
  [/\bdevops engineer\b/i, 'bachelors'],
  [/\bsite reliability engineer\b/i, 'bachelors'],
  [/\bplatform engineer\b/i, 'bachelors'],
  [/\bcloud engineer\b/i, 'bachelors'],
  [/\bsecurity engineer\b/i, 'bachelors'],
  [/\bapplication security\b/i, 'bachelors'],
  [/\bproduct security\b/i, 'bachelors'],
  [/\bcybersecurity engineer\b/i, 'bachelors'],
  [/\bnetwork engineer\b/i, 'bachelors'],
  [/\binfrastructure engineer\b/i, 'bachelors'],
  [/\breliability engineer\b/i, 'bachelors'],
  [/\bautomation engineer\b/i, 'bachelors'],
  [/\belectrical engineer\b/i, 'bachelors'],
  [/\bmechanical engineer\b/i, 'bachelors'],
  [/\bhardware engineer\b/i, 'bachelors'],
  [/\bembedded engineer\b/i, 'bachelors'],
  [/\bfpga engineer\b/i, 'bachelors'],
  [/\bsilicon engineer\b/i, 'bachelors'],
  [/\baerospace engineer\b/i, 'bachelors'],
  [/\bmanufacturing engineer\b/i, 'bachelors'],
  [/\bsystems engineer\b/i, 'bachelors'],
  [/\btest engineer\b/i, 'bachelors'],
  [/\bqa engineer\b/i, 'bachelors'],
  [/\bquality engineer\b/i, 'bachelors'],
  [/\bdesign engineer\b/i, 'bachelors'],
  [/\bcompliance engineer\b/i, 'bachelors'],
  [/\bsupply chain engineer\b/i, 'bachelors'],
  [/\bflight software\b/i, 'bachelors'],
  [/\bforward deployed engineer\b/i, 'bachelors'],
  [/\bsolutions engineer\b/i, 'bachelors'],
  [/\bproduct manager\b/i, 'bachelors'],
  [/\bprogram manager\b/i, 'bachelors'],
  [/\btechnical program manager\b/i, 'bachelors'],
  [/\btechnical project manager\b/i, 'bachelors'],
  [/\bquantitative (?:researcher|analyst|developer|engineer)\b/i, 'bachelors'],
  [/\btechnical writer\b/i, 'bachelors'],
  [/\btechnologist\b/i, 'bachelors'],
  [/\bspecialist\b/i, 'bachelors'],
  [/\bengineer\b/i, 'bachelors'],
  [/\bdeveloper\b/i, 'bachelors'],
  [/\banalyst\b/i, 'bachelors'],
  [/\bscientist\b/i, 'masters'],
  [/\bresearcher\b/i, 'masters'],
  [/\bdesigner\b/i, 'bachelors'],
  [/\btechnician\b/i, 'associates'],
  [/\badministrator\b/i, 'bachelors'],
  [/\barchitect\b/i, 'bachelors'],
];

function inferDegreeFromTitle(title) {
  if (!title) return null;
  if (/\b(?:intern|apprentice|co-?op)\b/i.test(title)) return null;
  for (const [pattern, degree] of DEGREE_INFERENCE_RULES) {
    if (pattern.test(title)) return degree;
  }
  return null;
}

// Experience level extraction — year ranges map to levels.
const EXP_YEAR_RE = /(\d+)\+?\s*(?:[-–to]+\s*\d+\s*)?years?\s*(?:of\s*)?(?:relevant\s*|related\s*|professional\s*|work\s*)?(?:experience|exp\b)/i;

function extractExperienceLevel(text) {
  if (!text) return null;
  const filteredText = text.split(/(?<=[.!?])\s+/)
    .filter(s => !BOILERPLATE_OPENERS.some(re => re.test(s.trim())))
    .join(' ');
  const m = EXP_YEAR_RE.exec(filteredText);
  if (!m) return null;
  const years = parseInt(m[1], 10);
  if (years <= 2) return 'entry_level';
  if (years <= 5) return 'mid_level';
  return 'senior';
}

module.exports = {
  extractMinDegree,
  inferDegreeFromTitle,
  extractExperienceLevel,
  BOILERPLATE_OPENERS,
};
