# Golden Corpus (ENR-GOLDENCORPUS-1)

Frozen corpus of REAL job descriptions with HUMAN-EXPECTED extraction outputs, run by
`lib/__tests__/golden-corpus.test.js` on every `npm test`. A red build means extraction
changed: either a regression (fix the code) or a legitimate judgment move (update the row
in the SAME commit, citing the judged artifact).

## Format (JSONL, one row per line)

- `{id, family, source, text, expect, basis}` - a corpus case. `text` is the FROZEN real
  description (no network at test time). `basis` names where the expectation comes from:
  - `judged-C244-gate` / `judged-v122-wave`: human-judged degree verdicts.
  - `contract-rule-curated-C254`: visa three-state truth-table curation.
  - `curated-C254`: curator-pinned soft-skill expectations (notes in `curation_note`).
- `{id: "_meta", family: "meta", excluded: [...]}` - rows considered but EXCLUDED with
  reasons (suspect-stored inputs, non-reproducible enrich-time text, login-wall class).

## Families and production call paths

| family | expect | production path |
|---|---|---|
| `degree` | `{degree: null\|none\|associates\|bachelors\|masters\|phd}` | splitSections -> extractMinDegreeFromSections |
| `visa` | `{visa: true\|false\|null}` | detectVisa (three honest states, negative precedence) |
| `lane-soft` | `{soft: string[]}` | matchSoftSkills (v102 O*NET-anchored list) |

## Growth convention (+1)

Every incident or judged sample that reveals a new extraction defect class adds at least
one real row here IN THE SAME COMMIT as the fix, with `basis` citing the judged artifact.
Suspect inputs (stored values that contradict the visible text) are NOT pinned - they go
to the owning audit task and land as rows only after adjudication.

## Provenance

Seeded 2026-09-19 (C254) from material already collected: the C241/C244 degree judged
gates (`enr-degree-judged-sample-rerun-2026_09_10.json`), the v122 preferred-label
corrective cohort (`enr-preferred-scope-cohort-fullscan-2026_09_16.json`), the lane FP
sample (`enr-earlylane-fpsample_2026_09_04.json`), and a contract-curated real-text visa
stratum. Exclusions and their reasons live in the `_meta` row.
