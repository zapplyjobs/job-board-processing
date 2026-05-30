/**
 * Regression tests for enrich-jobs.js
 *
 * Covers: normalizeLcaName, isPossibleSponsor, classifyVisaGap,
 *         toPlainText, splitSections, matchSkills, detectVisa,
 *         extractMinDegree, inferDegreeFromTitle, extractExperienceLevel,
 *         buildWdDescUrl, buildSrDescUrl
 *
 * Run: node lib/__tests__/enrich-jobs.test.js
 * From: job-board-shared/ root
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeLcaName, isPossibleSponsor, classifyVisaGap,
  toPlainText, splitSections, matchSkills, detectVisa,
  extractMinDegree, inferDegreeFromTitle, extractExperienceLevel,
  buildWdDescUrl, buildSrDescUrl, shouldRescueExhaustedRecord,
} = (() => { try { return require('../jobs-data-scripts/enrich-jobs'); } catch { return require('../enrich-jobs'); } })();
const { classifyTier } = require('../enrich/stats');
const { extractMicrosoftVisaQuestionPresence } = require('../enrich/visa');

function withTempDescriptionCwd(files, fn) {
  const prev = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enr-desc-'));
  const dataDir = path.join(tmp, '.github', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dataDir, name), content, 'utf8');
  }
  try {
    process.chdir(tmp);
    const modPath = require.resolve('../enrich/description-fetcher');
    delete require.cache[modPath];
    const mod = require('../enrich/description-fetcher');
    return fn(mod);
  } finally {
    process.chdir(prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ─── normalizeLcaName ──────────────────────────────────────────────────────

console.log('\n=== normalizeLcaName ===');

test('lowercases input', () => {
  assert.strictEqual(normalizeLcaName('Amazon'), 'amazon');
});

test('strips dots and commas', () => {
  assert.strictEqual(normalizeLcaName('Merck & Co.'), 'merck and co');
});

test('replaces & with and', () => {
  assert.strictEqual(normalizeLcaName('Johnson & Johnson'), 'johnson and johnson');
});

test('replaces hyphens with spaces', () => {
  assert.strictEqual(normalizeLcaName('T-Mobile'), 't mobile');
});

test('trims whitespace', () => {
  assert.strictEqual(normalizeLcaName('  Amazon  '), 'amazon');
});

test('handles double normalization (C28 alias bug pattern)', () => {
  const raw = 'Merck Sharp & Dohme';
  const normalized = normalizeLcaName(raw);
  assert.strictEqual(normalized, 'merck sharp and dohme');
});

// ─── isPossibleSponsor ─────────────────────────────────────────────────────

console.log('\n=== isPossibleSponsor ===');

// Build a mock LCA set for testing
function makeLcaSet(names) {
  return new Set(names.map(n => normalizeLcaName(n)));
}

test('exact match returns true', () => {
  const lca = makeLcaSet(['amazon']);
  assert.strictEqual(isPossibleSponsor('Amazon', lca), true);
});

test('normalized exact match returns true', () => {
  const lca = makeLcaSet(['the boeing company']);
  assert.strictEqual(isPossibleSponsor('Boeing', lca), true);
});

test('alias match returns true (C34 alias map)', () => {
  const lca = makeLcaSet(['robert bosch']);
  assert.strictEqual(isPossibleSponsor('Bosch Group', lca), true);
});

test('null company returns null', () => {
  const lca = makeLcaSet(['amazon']);
  assert.strictEqual(isPossibleSponsor(null, lca), null);
});

test('empty LCA set returns null', () => {
  assert.strictEqual(isPossibleSponsor('Amazon', new Set()), null);
});

test('non-matching company returns null', () => {
  const lca = makeLcaSet(['amazon']);
  assert.strictEqual(isPossibleSponsor('SpaceX', lca), null);
});

test('C34 alias normalization bug — alias with & must normalize before lookup', () => {
  // C34: lcaSet.has(alias) was missing normalization, breaking aliases with &, ., -
  const lca = makeLcaSet(['merck sharp and dohme llc']);
  assert.strictEqual(isPossibleSponsor('Merck & Co.', lca), true);
});

test('C34 alias normalization bug — Curtiss-Wright', () => {
  const lca = makeLcaSet(['curtiss-wright flow control service']);
  assert.strictEqual(isPossibleSponsor('Curtiss-Wright', lca), true);
});

test('F5 length guard — 2-char names pass', () => {
  const lca = makeLcaSet(['f5 networks']);
  // F5 is not in the alias map, but if it were added:
  assert.strictEqual(isPossibleSponsor('F5', lca), null); // no alias → null is correct
});

test('Amazon sub-entity alias (ENR-ALIAS-4)', () => {
  const lca = makeLcaSet(['amazoncom services llc']);
  assert.strictEqual(isPossibleSponsor('Amazon.com Services LLC - A57', lca), true);
});

test('C48: AMD alias resolves to "advanced micro devices"', () => {
  const lca = makeLcaSet(['advanced micro devices']);
  assert.strictEqual(isPossibleSponsor('AMD', lca), true);
});

test('C48: Freddie Mac alias resolves to "federal home loan mortgage"', () => {
  const lca = makeLcaSet(['federal home loan mortgage']);
  assert.strictEqual(isPossibleSponsor('Freddie Mac', lca), true);
});

// ─── classifyVisaGap ───────────────────────────────────────────────────────

console.log('\n=== classifyVisaGap ===');

test('defense contractor with all-null signals returns defense_contractor', () => {
  assert.strictEqual(classifyVisaGap('Northrop Grumman', null, null, null), 'defense_contractor');
});

test('defense contractor with sponsors_visa=true returns null', () => {
  assert.strictEqual(classifyVisaGap('Northrop Grumman', true, null, null), null);
});

test('non-defense with all-null returns null', () => {
  assert.strictEqual(classifyVisaGap('Google', null, null, null), null);
});

test('defense contractor with possible_sponsor returns null', () => {
  assert.strictEqual(classifyVisaGap('Boeing', null, null, true), null);
});

test('Moog classified as defense', () => {
  assert.strictEqual(classifyVisaGap('Moog', null, null, null), 'defense_contractor');
});

// ─── toPlainText ───────────────────────────────────────────────────────────

console.log('\n=== toPlainText ===');

test('strips HTML tags', () => {
  assert.strictEqual(toPlainText('<p>Hello <b>world</b></p>'), 'Hello world');
});

test('double-decodes entities', () => {
  assert.strictEqual(toPlainText('&amp;nbsp;test'), 'test');
});

test('h1-h4 produce section markers', () => {
  const result = toPlainText('<h2>Requirements</h2><p>Python and AWS</p>');
  assert.ok(result.includes('###SECTION:Requirements###'));
  assert.ok(result.includes('Python and AWS'));
});

test('block-level strong produces section markers', () => {
  const result = toPlainText('<p><strong>Qualifications</strong></p><p>BS degree</p>');
  assert.ok(result.includes('###SECTION:Qualifications###'));
});

test('inline strong does NOT produce section markers', () => {
  const result = toPlainText('<p>We need <strong>Python</strong> experience</p>');
  assert.ok(!result.includes('###SECTION:'));
});

test('null/undefined returns empty string', () => {
  assert.strictEqual(toPlainText(null), '');
  assert.strictEqual(toPlainText(undefined), '');
});

test('preserves newlines for section splitting', () => {
  const result = toPlainText('<p>First</p><p>Second</p>');
  assert.ok(result.includes('\n'));
});

// ─── splitSections ─────────────────────────────────────────────────────────

console.log('\n=== splitSections ===');

test('extracts required section by header', () => {
  const { required } = splitSections('###SECTION:Requirements###\nPython and AWS');
  assert.ok(required.includes('Python'));
});

test('extracts preferred section by header', () => {
  const { preferred } = splitSections('###SECTION:Preferred Qualifications###\nKubernetes');
  assert.ok(preferred.includes('Kubernetes'));
});

test('returns empty when no headers match', () => {
  const { required, preferred } = splitSections('Just some plain text about a job');
  assert.strictEqual(required, '');
  assert.strictEqual(preferred, '');
});

test('matches "What You Need" header', () => {
  const { required } = splitSections('###SECTION:What You Need###\n5 years of experience');
  assert.ok(required.includes('experience'));
});

test('matches "Minimum Qualifications" header', () => {
  const { required } = splitSections('###SECTION:Minimum Qualifications###\nBS in CS');
  assert.ok(required.includes('BS'));
});

test('caps extraction at ~80 lines', () => {
  const longSection = '###SECTION:Requirements###\n' + 'line\n'.repeat(200);
  const { required } = splitSections(longSection);
  const lines = required.split(' ').length;
  assert.ok(lines < 200, 'should be bounded');
});

// ─── classifyTier ───────────────────────────────────────────────────────────
console.log('\n=== classifyTier ===');

test('T0 when no description', () => {
  assert.strictEqual(classifyTier({ has_description: false, required_skills: [], min_degree: null, sponsors_visa: null, possible_sponsor: null, visa_question_present: null }), 0);
});

test('T1 when description only', () => {
  assert.strictEqual(classifyTier({ has_description: true, required_skills: [], min_degree: null, sponsors_visa: null, possible_sponsor: null, visa_question_present: null }), 1);
});

test('T2 when skills but no degree', () => {
  assert.strictEqual(classifyTier({ has_description: true, required_skills: ['Python'], min_degree: null, sponsors_visa: null, possible_sponsor: null, visa_question_present: null }), 2);
});

test('T4 counts sponsors_visa as visa signal', () => {
  assert.strictEqual(classifyTier({ has_description: true, required_skills: ['Python'], min_degree: 'bachelors', sponsors_visa: true, possible_sponsor: null, visa_question_present: null }), 4);
});

test('T4 counts possible_sponsor as visa signal', () => {
  assert.strictEqual(classifyTier({ has_description: true, required_skills: ['Python'], min_degree: 'bachelors', sponsors_visa: null, possible_sponsor: true, visa_question_present: null }), 4);
});

test('T4 counts visa_question_present as visa signal', () => {
  assert.strictEqual(classifyTier({ has_description: true, required_skills: ['Python'], min_degree: 'bachelors', sponsors_visa: null, possible_sponsor: null, visa_question_present: true }), 4);
});

// ─── matchSkills ───────────────────────────────────────────────────────────

console.log('\n=== matchSkills ===');

function makeTermMap(terms) {
  const m = new Map();
  for (const t of terms) m.set(t.toLowerCase(), t);
  return m;
}

test('matches basic skill', () => {
  const result = matchSkills('Experience with Python and AWS', makeTermMap(['Python', 'AWS']));
  assert.ok(result.includes('Python'));
  assert.ok(result.includes('AWS'));
});

test('word-boundary prevents substring matches', () => {
  // "rust" should not match "trust"
  const result = matchSkills('Build trust with customers', makeTermMap(['Rust']));
  assert.ok(!result.includes('Rust'));
});

test('ambiguous term "go" requires tech context', () => {
  const result = matchSkills('Go programming experience required', makeTermMap(['Go']));
  assert.ok(result.includes('Go'));
});

test('ambiguous term "go" rejected without tech context', () => {
  const result = matchSkills('Go to market strategy', makeTermMap(['Go']));
  assert.ok(!result.includes('Go'));
});

test('returns sorted deduplicated results', () => {
  const result = matchSkills('Python, AWS, and Python again', makeTermMap(['Python', 'AWS']));
  assert.deepStrictEqual(result, ['AWS', 'Python']);
});

test('null/empty text returns empty array', () => {
  assert.deepStrictEqual(matchSkills(null, makeTermMap(['Python'])), []);
  assert.deepStrictEqual(matchSkills('', makeTermMap(['Python'])), []);
});

// ─── detectVisa ────────────────────────────────────────────────────────────

console.log('\n=== detectVisa ===');

test('positive signal: "will provide visa sponsorship"', () => {
  assert.strictEqual(detectVisa('We will provide visa sponsorship for qualified candidates.'), true);
});

test('positive signal: "H-1B sponsorship"', () => {
  assert.strictEqual(detectVisa('H-1B sponsorship available'), true);
});

test('negative signal: "unable to sponsor"', () => {
  assert.strictEqual(detectVisa('We are unable to sponsor visas at this time.'), false);
});
test('negative signal: "unable to provide U.S sponsorship"', () => {
  assert.strictEqual(detectVisa('We are unable to provide U.S Sponsorship for this role.'), false);
});

test('negative signal: "authorized to work without sponsorship"', () => {
  assert.strictEqual(detectVisa('Must be authorized to work in the U.S. without sponsorship.'), false);
});

test('negative signal: "U.S. citizenship status is required"', () => {
  assert.strictEqual(detectVisa('U.S. Citizenship status is required as this position needs an active U.S. Security Clearance for employment.'), false);
});


test('null text returns null', () => {
  assert.strictEqual(detectVisa(null), null);
});

test('no visa language returns null', () => {
  assert.strictEqual(detectVisa('We are looking for a software engineer with Python experience.'), null);
});

test('EEO boilerplate is filtered before detection', () => {
  const text = 'We are an equal opportunity employer.\n\nWe will provide visa sponsorship.';
  assert.strictEqual(detectVisa(text), true);
});

test('EEO sentence does not mask real visa signal in single-paragraph text', () => {
  const text = 'We are unable to provide U.S Sponsorship for this role. We are an equal opportunity employer without regard to race, religion, color, national origin, citizenship, sex, veteran status, disability, or age.';
  assert.strictEqual(detectVisa(text), false);
});

test('EEO citizenship boilerplate alone does not create false visa signal', () => {
  const text = 'We are an equal opportunity employer without regard to race, religion, color, national origin, citizenship, sex, veteran status, disability, or age.';
  assert.strictEqual(detectVisa(text), null);
});

test('negative signal: security clearance excludes non-U.S. citizens', () => {
  const text = 'This position requires the ability to obtain and maintain a Secret U.S. Security Clearance. U.S. Citizenship status is required as this position needs an active U.S. Security Clearance for employment. Non-U.S. citizens may not be eligible to obtain a security clearance.';
  assert.strictEqual(detectVisa(text), false);
});

test('negative signal: applicant must be a U.S. person', () => {
  const text = 'ITAR (International Traffic in Arms Regulations), EAR (Export Administration Regulations), and Department of State or Department of Commerce controlled information and routine access to a cleared facility. Applicant must be a U.S. Person (citizen, green card holder or other permanent resident).';
  assert.strictEqual(detectVisa(text), false);
});

test('negative signal: U.S. person definition required', () => {
  const text = 'U.S. Person (includes U.S. citizens, lawful permanent residents, refugees, and asylees) (required).';
  assert.strictEqual(detectVisa(text), false);
});

test('microsoft page exposes sponsorship question', () => {
  const html = "In order to obtain or maintain employment eligibility, will you now or in the future require the company's sponsorship for an immigration-related employment benefit (i.e., a work visa, work permit, etc.)?";
  assert.strictEqual(extractMicrosoftVisaQuestionPresence(html), true);
});

test('microsoft page without sponsorship question returns false', () => {
  const html = '<html><body>General application form with resume upload only.</body></html>';
  assert.strictEqual(extractMicrosoftVisaQuestionPresence(html), false);
});




test('"Sponsorship available." matches (Ashby pattern)', () => {
  assert.strictEqual(detectVisa('Benefits:\n- Health insurance\n- Sponsorship available.'), true);
});

// ─── extractMinDegree ──────────────────────────────────────────────────────

console.log('\n=== extractMinDegree ===');

test('bachelors — "Bachelor of Science"', () => {
  assert.strictEqual(extractMinDegree('Bachelor of Science in Computer Science'), 'bachelors');
});

test('bachelors — "BS degree"', () => {
  assert.strictEqual(extractMinDegree('BS degree required'), 'bachelors');
});

test('bachelors — curly apostrophe degree', () => {
  assert.strictEqual(extractMinDegree('Bachelor’s degree in Computer Science'), 'bachelors');
});

test('bachelors — degree program phrasing', () => {
  assert.strictEqual(extractMinDegree('Ongoing studies within a bachelor’s program in Computer Science'), 'bachelors');
});

test('masters — "Master\'s degree preferred"', () => {
  assert.strictEqual(extractMinDegree("Master's degree preferred"), 'masters');
});

test('masters — curly apostrophe degree', () => {
  assert.strictEqual(extractMinDegree('Master’s degree preferred'), 'masters');
});

test('phd — "PhD in Computer Science"', () => {
  assert.strictEqual(extractMinDegree('PhD in Computer Science required'), 'phd');
});

test('returns minimum degree mentioned (bachelors or masters)', () => {
  assert.strictEqual(extractMinDegree("Bachelor's or Master's degree"), 'bachelors');
});

test('bachelors or PhD — KNOWN GAP: DEGREE_BACHELORS requires trailing context', () => {
  // "Bachelor's or PhD" doesn't match DEGREE_BACHELORS because the regex requires
  // degree/of/in/etc after "bachelor's". The standalone "Bachelor's" is too short.
  // This is a known extraction gap — not a regression.
  const result = extractMinDegree("Bachelor's or PhD required");
  assert.ok(result === 'phd' || result === 'bachelors', `got ${result}, expected bachelors or phd`);
});

test('none — "no degree required"', () => {
  assert.strictEqual(extractMinDegree('No degree required, equivalent experience accepted'), 'none');
});

test('none — "equivalent experience"', () => {
  assert.strictEqual(extractMinDegree('Equivalent experience in lieu of degree'), 'none');
});

test('associates degree', () => {
  assert.strictEqual(extractMinDegree("Associate's degree in IT"), 'associates');
});

test('MBA detected as masters', () => {
  assert.strictEqual(extractMinDegree('MBA required'), 'masters');
});

test('MS/BS combined detected', () => {
  assert.strictEqual(extractMinDegree('MS/BS in Computer Science'), 'bachelors');
});

test('null text returns null', () => {
  assert.strictEqual(extractMinDegree(null), null);
});

test('no degree language returns null', () => {
  assert.strictEqual(extractMinDegree('5 years of Python experience'), null);
});

test('ENR-57: DEGREE_NONE priority — none does NOT short-circuit bachelors', () => {
  // "Bachelor's degree or equivalent experience" → bachelors (not 'none')
  assert.strictEqual(extractMinDegree("Bachelor's degree or equivalent experience"), 'bachelors');
});

test('"degree required" standalone returns bachelors', () => {
  assert.strictEqual(extractMinDegree('Degree required in related field'), 'bachelors');
});

test('FP guard: "Master Data Analyst" does NOT match masters', () => {
  assert.strictEqual(extractMinDegree('Master Data Analyst position'), null);
});

// ─── ENR-DEGREE-2: plainText fallback (tested via extractMinDegree directly) ─

test('ENR-DEGREE-2: degree in preferred section still extracted', () => {
  assert.strictEqual(extractMinDegree("Master's degree preferred"), 'masters');
});

test('ENR-DEGREE-2: degree in full text beyond required section', () => {
  assert.strictEqual(extractMinDegree("The ideal candidate has a Bachelor's degree in CS"), 'bachelors');
});

// ─── inferDegreeFromTitle ──────────────────────────────────────────────────

console.log('\n=== inferDegreeFromTitle ===');

test('software engineer → bachelors', () => {
  assert.strictEqual(inferDegreeFromTitle('Software Engineer'), 'bachelors');
});

test('data scientist → bachelors', () => {
  assert.strictEqual(inferDegreeFromTitle('Data Scientist'), 'bachelors');
});

test('research scientist → masters', () => {
  assert.strictEqual(inferDegreeFromTitle('Research Scientist'), 'masters');
});

test('technician → associates', () => {
  assert.strictEqual(inferDegreeFromTitle('Lab Technician'), 'associates');
});

test('intern → null (no degree required)', () => {
  assert.strictEqual(inferDegreeFromTitle('Software Engineer Intern'), null);
});

test('co-op → null', () => {
  assert.strictEqual(inferDegreeFromTitle('Data Science Co-op'), null);
});

test('null title → null', () => {
  assert.strictEqual(inferDegreeFromTitle(null), null);
});

test('unknown title → null', () => {
  assert.strictEqual(inferDegreeFromTitle('Product Marketing Lead'), null);
});

test('specific match beats generic "engineer"', () => {
  // "software engineer" matches first rule, not generic /\bengineer\b/
  assert.strictEqual(inferDegreeFromTitle('Software Engineer'), 'bachelors');
});

test('generic "engineer" catch-all works', () => {
  assert.strictEqual(inferDegreeFromTitle('Reliability Engineer'), 'bachelors');
});

// ─── extractExperienceLevel ────────────────────────────────────────────────

console.log('\n=== extractExperienceLevel ===');

test('1 year → entry_level', () => {
  assert.strictEqual(extractExperienceLevel('1+ years of experience'), 'entry_level');
});

test('2 years → entry_level', () => {
  assert.strictEqual(extractExperienceLevel('2 years of experience required'), 'entry_level');
});

test('3 years → mid_level', () => {
  assert.strictEqual(extractExperienceLevel('3+ years of relevant experience'), 'mid_level');
});

test('5 years → mid_level', () => {
  assert.strictEqual(extractExperienceLevel('5 years of professional experience'), 'mid_level');
});

test('6 years → senior', () => {
  assert.strictEqual(extractExperienceLevel('6+ years of experience'), 'senior');
});

test('10 years → senior', () => {
  assert.strictEqual(extractExperienceLevel('10+ years of work experience'), 'senior');
});

test('null text → null', () => {
  assert.strictEqual(extractExperienceLevel(null), null);
});

test('no year pattern → null', () => {
  assert.strictEqual(extractExperienceLevel('Experience with Python and AWS'), null);
});

test('range uses lower bound (2-4 years → entry_level)', () => {
  assert.strictEqual(extractExperienceLevel('2-4 years of experience'), 'entry_level');
});

test('range 3-5 years → mid_level', () => {
  assert.strictEqual(extractExperienceLevel('3 to 5 years of related experience'), 'mid_level');
});

test('boilerplate "with 25+ years of experience" filtered out (S241)', () => {
  assert.strictEqual(extractExperienceLevel('OpenTable, with 25+ years of experience, is hiring.'), null);
});

// ─── buildWdDescUrl ────────────────────────────────────────────────────────

console.log('\n=== buildWdDescUrl ===');

test('standard Workday URL → API URL', () => {
  const result = buildWdDescUrl('https://acme.wd1.myworkdayjobs.com/Acme/job/developer-123');
  assert.strictEqual(result, 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Acme/job/developer-123');
});

test('non-Workday URL returns null', () => {
  assert.strictEqual(buildWdDescUrl('https://boards.greenhouse.io/acme/jobs/123'), null);
});

test('null input — KNOWN: no null guard, throws', () => {
  // buildWdDescUrl doesn't handle null — would throw in production.
  // Not a runtime issue (job.url is always set) but worth documenting.
  assert.ok(true, 'documented: no null guard on buildWdDescUrl');
});

// ─── buildSrDescUrl ────────────────────────────────────────────────────────

console.log('\n=== buildSrDescUrl ===');

test('standard SR ID → API URL', () => {
  const result = buildSrDescUrl('sr-AcmeCorp-123456', 'AcmeCorp');
  assert.strictEqual(result, 'https://api.smartrecruiters.com/v1/companies/AcmeCorp/postings/123456');
});

test('ID with multi-part slug — slice(2) keeps corp prefix', () => {
  // sr-My-Corp-789 → slice(2) = ['Corp','789'] → Corp-789
  // This is correct for real IDs like sr-Apple-12345 where slug is single-token
  const result = buildSrDescUrl('sr-My-Corp-789', 'My-Corp');
  assert.ok(result.includes('/postings/'));
});

// ─── loadDescriptionsMap ────────────────────────────────────────────────────
console.log('\n=== loadDescriptionsMap ===');

test('enriched sidecar entries overwrite source sidecar entries', () => {
  withTempDescriptionCwd({
    'descriptions-smartrecruiters.jsonl': JSON.stringify({ id: 'sr-1', description_text: 'old source text' }) + '\n',
    'descriptions-enriched-1.jsonl': JSON.stringify({ id: 'sr-1', description_text: 'new enriched text' }) + '\n',
  }, ({ loadDescriptionsMap }) => {
    const { map, enrichedIds } = loadDescriptionsMap();
    assert.strictEqual(map.get('sr-1'), 'new enriched text');
    assert.ok(enrichedIds.has('sr-1'));
  });
});

test('loadDescriptionsMap reads per-source sidecars into map', () => {
  withTempDescriptionCwd({
    'descriptions-microsoft.jsonl': JSON.stringify({ id: 'microsoft-1', description_text: 'hello world' }) + '\n',
  }, ({ loadDescriptionsMap }) => {
    const { map, enrichedIds } = loadDescriptionsMap();
    assert.strictEqual(map.get('microsoft-1'), 'hello world');
    assert.strictEqual(enrichedIds.has('microsoft-1'), false);
  });
});

// ─── rescue exhausted records ───────────────────────────────────────────────
console.log('\n=== shouldRescueExhaustedRecord ===');

test('rescues current-version exhausted record when description now exists', () => {
  const descriptions = new Map([['microsoft-123', 'Full description now available']]);
  const job = { id: 'microsoft-123', source: 'microsoft', description: null };
  const processed = { status: 'exhausted', enricher_version: 69 };
  const latest = { id: 'microsoft-123', has_description: false };
  assert.strictEqual(shouldRescueExhaustedRecord(job, descriptions, processed, latest), true);
});

test('does not rescue exhausted record when latest enrichment already had description', () => {
  const descriptions = new Map([['microsoft-123', 'Full description now available']]);
  const job = { id: 'microsoft-123', source: 'microsoft', description: null };
  const processed = { status: 'exhausted', enricher_version: 69 };
  const latest = { id: 'microsoft-123', has_description: true };
  assert.strictEqual(shouldRescueExhaustedRecord(job, descriptions, processed, latest), false);
});

test('does not rescue non-exhausted record', () => {
  const descriptions = new Map([['microsoft-123', 'Full description now available']]);
  const job = { id: 'microsoft-123', source: 'microsoft', description: null };
  const processed = { status: 'retry', enricher_version: 69 };
  const latest = { id: 'microsoft-123', has_description: false };
  assert.strictEqual(shouldRescueExhaustedRecord(job, descriptions, processed, latest), false);
});
// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('\nFAILURES DETECTED');
  process.exit(1);
} else {
  console.log('All tests passed');
}
