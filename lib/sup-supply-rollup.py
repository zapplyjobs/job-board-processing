#!/usr/bin/env python3
"""sup-supply-rollup.py - AGG weekly supply-trends rollup (AGG-TRENDS-LEDGER-SLUG-1).

Grain: week x entity x source_family, built from the SUP posting ledger (JSONL,
streamed line-by-line - never whole-file json.loads) joined to the current pool
snapshot (one JSON document; loading it whole is accepted).

Formula law mirrors the frozen v2 reader scripts/sup-supply-trends.py exactly:
  - repost_ratio = new_fps / max(exited_fps, 1)  (reader formula, 2dp)
  - OPS_RE / INTERN_RE title regexes verbatim from the reader
  - slugless entity fallback: "~" + [^a-z0-9]-stripped lowercase company name
    (reader's exact normalization)
Entity layer (review finding 2026-10-18, RollupReview): the rollup runs NO
name resolver. entity_class is "canon" only when the writer slug exists;
every slugless row is "~name"/"unresolved" - including the large workday/
custom-fetcher class whose normalized names the reader's resolver treats as
DIRECT entity ids (design s8: 331/332 workday rows carry no slug and can
never gain one from backfill). At consumption, the reader remaps "~name"
buckets by stripping the prefix and re-running its resolver; the remap is
the SUP advisory's subject, not a rollup-side guess. Counts inside every
bucket are exact regardless of the class label.
Pool membership is the A294 canonical basis (current all_jobs fingerprints): a
row whose fingerprint is still in the pool is never counted as an exit. Pool
shape tolerance: JSONL (real R2 format) or whole-doc array | {jobs: ...} | dict.

CLI:
  python3 lib/sup-supply-rollup.py --ledger PATH.jsonl --pool PATH.json --out PATH.json
  python3 lib/sup-supply-rollup.py --self-test
"""
import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone

OPS_RE = re.compile(
    r"barista|clerk|associate|cashier|stock|warehouse|driver|store|shift|crew|"
    r"team member|merchandis|fulfillment|courier|restaurant|retail|sales associate|"
    r"packer|loader|technician|assembler|operator", re.I)
INTERN_RE = re.compile(r"\bintern", re.I)


def week_monday(d):
    """Monday date of the ISO week (Mon-Sun UTC bucket) containing d."""
    return d - timedelta(days=d.isocalendar()[2] - 1)


def entity_of(row):
    """(entity, entity_class): canon slug, or the reader's exact '~' fallback."""
    slug = row.get("slug")
    if slug:
        return slug, "canon"
    return "~" + re.sub(r"[^a-z0-9]", "", str(row.get("c") or "").lower()), "unresolved"


def parse_ledger_lines(lines, source="ledger"):
    """Yield ledger rows one line at a time (streaming law). Blank lines are
    skipped; a line failing json.loads aborts nonzero with a clear message
    (ledger corruption is fatal, never silent)."""
    for lineno, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            yield json.loads(line)
        except ValueError as exc:
            sys.stderr.write("sup-supply-rollup: FATAL: corrupt ledger line %d in %s: %s\n"
                             % (lineno, source, exc))
            sys.exit(1)


def load_pool_fingerprints(path):
    """all_jobs.json on R2 is JSONL (one row per line, 185MB class) - the REAL
    format (verified live 2026-10-18). Whole-doc shapes (root array, {"jobs":
    ...}, dict) stay supported to mirror lib/sup-posting-ledger.js tolerance."""
    with open(path, "r", encoding="utf-8") as fh:
        first = fh.read(1)
    if first in ("[", "{"):
        # Could still be a whole-doc dict OR a JSONL stream starting with '{'.
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                rows = data
            elif isinstance(data, dict) and "jobs" in data:
                jobs = data["jobs"]
                rows = list(jobs.values()) if isinstance(jobs, dict) else list(jobs)
            elif isinstance(data, dict):
                rows = list(data.values())
            else:
                rows = []
            return {(r.get("fingerprint") or r.get("f")) for r in rows if isinstance(r, dict) and (r.get("fingerprint") or r.get("f"))}
        except json.JSONDecodeError:
            pass  # JSONL stream of objects - fall through to line parsing
    fps = set()
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if isinstance(r, dict):
                fp = r.get("fingerprint") or r.get("f")
                if fp:
                    fps.add(fp)
    return fps


def build_rollup(ledger_rows, live_f, generated_at=None):
    """Single pass over the ledger; buckets are sparse - only (week, entity,
    source_family) combos with at least one new or exited row are emitted.
    Rows sorted by (week, entity, source_family)."""
    new_ct, exit_ct, ops_ct, intern_ct = Counter(), Counter(), Counter(), Counter()
    canon_keys, lane_by_key = set(), {}
    rows_read = rows_used = 0

    for row in ledger_rows:
        rows_read += 1
        if not isinstance(row, dict):
            continue
        try:
            s_d = date.fromisoformat(str(row["s"])[:10])
            e_d = date.fromisoformat(str(row["e"])[:10])
        except (KeyError, TypeError, ValueError):
            continue  # counted as read; unusable without valid s and e
        rows_used += 1
        ent, eclass = entity_of(row)
        source_family = row.get("src") or "unknown"
        key_n = (week_monday(s_d).isoformat(), ent, source_family)
        new_ct[key_n] += 1
        keys = [key_n]
        if eclass == "canon":
            canon_keys.add(key_n)
        if row.get("f") not in live_f:  # still-live rows are never exits
            key_x = (week_monday(e_d).isoformat(), ent, source_family)
            exit_ct[key_x] += 1
            title = str(row.get("t") or "")
            if OPS_RE.search(title):
                ops_ct[key_x] += 1
            if INTERN_RE.search(title):
                intern_ct[key_x] += 1
            keys.append(key_x)
            if eclass == "canon":
                canon_keys.add(key_x)
        if row.get("ln"):
            for k in keys:
                lane_by_key.setdefault(k, row["ln"])

    rows = []
    for key in sorted(set(new_ct) | set(exit_ct)):
        week, ent, source_family = key
        new_fps, exited_fps = new_ct.get(key, 0), exit_ct.get(key, 0)
        rows.append({
            "week": week,
            "entity": ent,
            "entity_class": "canon" if key in canon_keys else "unresolved",
            "source_family": source_family,
            "lane": lane_by_key.get(key),
            "new_fps": new_fps,
            "exited_fps": exited_fps,
            "net": new_fps - exited_fps,
            "repost_ratio": round(new_fps / max(exited_fps, 1), 2),
            "ops_share": round(ops_ct.get(key, 0) / exited_fps, 2) if exited_fps else 0.0,
            "intern_share": round(intern_ct.get(key, 0) / exited_fps, 2) if exited_fps else 0.0,
            "ingest_flags": [],
        })

    return {
        "schema_version": 1,
        "schema": "sup_supply_trends_rollup_v1",
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(),
        "grain": "week x entity x source_family",
        "basis": {
            "ledger_rows_read": rows_read,
            "ledger_rows_used": rows_used,
            "pool_fingerprints": len(live_f),
            "pool_membership": "A294 canonical basis (current all_jobs fingerprints)",
            "week_bucket": "ISO week, Monday date label, Mon-Sun UTC",
            "entity_layer": "writer slug (canon) or ~normalized-name (unresolved); reader remaps ~name buckets via its resolver at consumption",
            "retention_note": "ledger retention is 400d: buckets older than the retained horizon lose their exited rows and rewrite on each weekly run",
            "denominators": "ops_share/intern_share = titled share of that bucket's exited_fps; "
                            "repost_ratio = new_fps/max(exited_fps,1) (reader formula)",
        },
        "rows": rows,
    }


# --- self-test fixtures (inline synthetic; no files needed) -----------------
# 2026-09-07 and 2026-09-14 are Mondays (verified ISO weeks).
FIXED_TS = "2026-10-18T12:00:00+00:00"

SELF_TEST_LEDGER = [
    # f1: exited (absent from pool), ops-titled exit
    {"f": "f1", "c": "Kroger", "t": "Warehouse Associate", "l": "US",
     "s": "2026-09-07", "e": "2026-09-08", "slug": "kroger", "ln": "us", "src": "indeed"},
    # f2: decoy - e in the same week but f IS in the pool -> never an exit
    {"f": "f2", "c": "Kroger", "t": "Barista", "l": "US",
     "s": "2026-09-07", "e": "2026-09-09", "slug": "kroger", "ln": "us", "src": "indeed"},
    # f6: intern-titled exit
    {"f": "f6", "c": "Kroger", "t": "Summer Intern - Engineering", "l": "US",
     "s": "2026-09-07", "e": "2026-09-10", "slug": "kroger", "ln": "us", "src": "indeed"},
    # f4: second source_family for the same slug; live in pool (e never exits)
    {"f": "f4", "c": "Kroger", "t": "Data Analyst", "l": "US",
     "s": "2026-09-07", "e": "2026-10-30", "slug": "kroger", "ln": "us", "src": "linkedin"},
    # f3: second ISO week for kroger/indeed (new + exit both land in W 2026-09-14)
    {"f": "f3", "c": "Kroger", "t": "Software Engineer", "l": "US",
     "s": "2026-09-14", "e": "2026-09-20", "slug": "kroger", "ln": "us", "src": "indeed"},
    # f5: slugless legacy row -> unresolved "~coxcommunicationsinc"; new in W 09-07,
    # exit lands in the LATER week W 09-14; ops-titled exit; src null -> unknown
    {"f": "f5", "c": "Cox Communications, Inc.", "t": "Crew Member", "l": "US",
     "s": "2026-09-08", "e": "2026-09-15", "slug": None, "ln": None, "src": None},
]

SELF_TEST_ROWS = [
    {"week": "2026-09-07", "entity": "kroger", "entity_class": "canon",
     "source_family": "indeed", "lane": "us", "new_fps": 3, "exited_fps": 2,
     "net": 1, "repost_ratio": 1.5, "ops_share": 0.5, "intern_share": 0.5,
     "ingest_flags": []},
    {"week": "2026-09-07", "entity": "kroger", "entity_class": "canon",
     "source_family": "linkedin", "lane": "us", "new_fps": 1, "exited_fps": 0,
     "net": 1, "repost_ratio": 1.0, "ops_share": 0.0, "intern_share": 0.0,
     "ingest_flags": []},
    {"week": "2026-09-07", "entity": "~coxcommunicationsinc", "entity_class": "unresolved",
     "source_family": "unknown", "lane": None, "new_fps": 1, "exited_fps": 0,
     "net": 1, "repost_ratio": 1.0, "ops_share": 0.0, "intern_share": 0.0,
     "ingest_flags": []},
    {"week": "2026-09-14", "entity": "kroger", "entity_class": "canon",
     "source_family": "indeed", "lane": "us", "new_fps": 1, "exited_fps": 1,
     "net": 0, "repost_ratio": 1.0, "ops_share": 0.0, "intern_share": 0.0,
     "ingest_flags": []},
    {"week": "2026-09-14", "entity": "~coxcommunicationsinc", "entity_class": "unresolved",
     "source_family": "unknown", "lane": None, "new_fps": 0, "exited_fps": 1,
     "net": -1, "repost_ratio": 0.0, "ops_share": 1.0, "intern_share": 0.0,
     "ingest_flags": []},
]


class _StrBuf:
    """Minimal write-trap so the exercised fatal path stays off stderr on green runs."""
    def __init__(self):
        self.parts = []

    def write(self, s):
        self.parts.append(s)
        return len(s)

    def flush(self):
        pass


def run_self_test():
    failures = []

    def check(name, ok, detail=""):
        if not ok:
            failures.append("%s: %s" % (name, detail))

    out = build_rollup(iter(SELF_TEST_LEDGER), {"f2", "f4"}, generated_at=FIXED_TS)

    if out["rows"] != SELF_TEST_ROWS:
        if len(out["rows"]) != len(SELF_TEST_ROWS):
            failures.append("row count: expected %d actual %d"
                            % (len(SELF_TEST_ROWS), len(out["rows"])))
        for i in range(max(len(SELF_TEST_ROWS), len(out["rows"]))):
            exp = SELF_TEST_ROWS[i] if i < len(SELF_TEST_ROWS) else None
            got = out["rows"][i] if i < len(out["rows"]) else None
            if exp != got:
                failures.append("row[%d] delta:\n  expected: %s\n  actual:   %s" % (i, exp, got))

    # named coverage of the required fixture minimums (rows above assert exact dicts)
    def row_at(week, entity, source_family):
        for r in out["rows"]:
            if (r["week"], r["entity"], r["source_family"]) == (week, entity, source_family):
                return r
        return None

    r_kroger = row_at("2026-09-07", "kroger", "indeed")
    check("canon-row-with-slug", r_kroger is not None and r_kroger["entity_class"] == "canon")
    check("slugless-unresolved-fallback",
          row_at("2026-09-07", "~coxcommunicationsinc", "unknown") is not None
          and row_at("2026-09-07", "~coxcommunicationsinc", "unknown")["entity_class"] == "unresolved")
    check("exit-detection-live-decoy", r_kroger is not None and r_kroger["exited_fps"] == 2,
          "decoy f2 (in pool) must not count as exit; expected 2 exited, got %s"
          % (r_kroger and r_kroger["exited_fps"]))
    check("two-iso-weeks-one-entity",
          row_at("2026-09-07", "kroger", "indeed") is not None
          and row_at("2026-09-14", "kroger", "indeed") is not None)
    check("two-source-families-one-slug",
          row_at("2026-09-07", "kroger", "indeed") is not None
          and row_at("2026-09-07", "kroger", "linkedin") is not None)
    check("ops-title-exit-drives-ops-share", r_kroger is not None and r_kroger["ops_share"] == 0.5)
    check("intern-title-exit-drives-intern-share",
          r_kroger is not None and r_kroger["intern_share"] == 0.5)
    check("ops-share-1.0-single-exit",
          row_at("2026-09-14", "~coxcommunicationsinc", "unknown")["ops_share"] == 1.0)
    check("repost-ratio-exited-0",
          row_at("2026-09-07", "kroger", "linkedin")["repost_ratio"] == 1.0,
          "exited=0 must divide new by max(exited,1)=1")
    check("repost-ratio-exit-only-bucket",
          row_at("2026-09-14", "~coxcommunicationsinc", "unknown")["repost_ratio"] == 0.0)
    check("sparse-buckets-only", len(out["rows"]) == 5, "got %d rows" % len(out["rows"]))

    b = out["basis"]
    check("basis-counts",
          (b["ledger_rows_read"], b["ledger_rows_used"], b["pool_fingerprints"]) == (6, 6, 2),
          "got read=%s used=%s pool=%s" % (b["ledger_rows_read"], b["ledger_rows_used"],
                                           b["pool_fingerprints"]))

    # (8) blank ledger lines tolerated
    blanked = list(parse_ledger_lines(['{"f": "a"}', "", "   ", "\n", '{"f": "b"}']))
    check("blank-lines-tolerated", len(blanked) == 2, "got %d rows" % len(blanked))

    # corrupt ledger line is fatal (nonzero exit, clear message naming line + source)
    buf, orig_err, raised = _StrBuf(), sys.stderr, None
    sys.stderr = buf
    try:
        list(parse_ledger_lines(['{"f": "a"}', "{not json"], source="selftest.jsonl"))
    except SystemExit as exc:
        raised = exc
    finally:
        sys.stderr = orig_err
    fatal_msg = "".join(buf.parts)
    check("corrupt-line-fatal",
          raised is not None and raised.code != 0
          and "corrupt ledger line 2" in fatal_msg and "selftest.jsonl" in fatal_msg,
          "raised=%r stderr=%r" % (raised, fatal_msg))

    # (9) output determinism: same inputs -> byte-identical output
    dump_a = json.dumps(build_rollup(iter(SELF_TEST_LEDGER), {"f2", "f4"}, generated_at=FIXED_TS),
                        indent=1, ensure_ascii=False)
    dump_b = json.dumps(build_rollup(iter(SELF_TEST_LEDGER), {"f2", "f4"}, generated_at=FIXED_TS),
                        indent=1, ensure_ascii=False)
    check("determinism-byte-identical", dump_a == dump_b)

    # (10) pool loader: REAL R2 format is JSONL (verified live 2026-10-18);
    # whole-doc shapes stay tolerated; pool rows carry long-key 'fingerprint'.
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        jsonl_pool = os.path.join(td, "pool.jsonl")
        with open(jsonl_pool, "w", encoding="utf-8") as fh:
            fh.write('{"id": "x1", "fingerprint": "f2", "source": "workday"}\n\n{"id": "x2", "fingerprint": "f4"}\n')
        check("pool-jsonl-real-format", load_pool_fingerprints(jsonl_pool) == {"f2", "f4"},
              "got %r" % sorted(load_pool_fingerprints(jsonl_pool)))
        arr_pool = os.path.join(td, "pool_arr.json")
        with open(arr_pool, "w", encoding="utf-8") as fh:
            json.dump([{"f": "f2"}, {"f": "f4"}], fh)
        check("pool-array-tolerated", load_pool_fingerprints(arr_pool) == {"f2", "f4"})
        jobs_pool = os.path.join(td, "pool_jobs.json")
        with open(jobs_pool, "w", encoding="utf-8") as fh:
            json.dump({"jobs": {"a": {"f": "f2"}, "b": {"f": "f4"}}}, fh)
        check("pool-jobs-dict-tolerated", load_pool_fingerprints(jobs_pool) == {"f2", "f4"})

    if failures:
        for f in failures:
            sys.stderr.write("FAIL %s\n" % f)
        sys.stderr.write("sup-supply-rollup: self-test FAILED (%d checks failed)\n" % len(failures))
        sys.exit(1)
    print("sup-supply-rollup: self-test OK")


def main():
    ap = argparse.ArgumentParser(
        description="AGG weekly supply-trends rollup (week x entity x source_family) "
                    "from the posting ledger + current pool (AGG-TRENDS-LEDGER-SLUG-1)")
    ap.add_argument("--ledger", help="posting ledger JSONL (streamed line-by-line)")
    ap.add_argument("--pool", help="current pool snapshot (JSONL - the real R2 format - or whole-doc)")
    ap.add_argument("--out", help="output rollup JSON path")
    ap.add_argument("--self-test", action="store_true",
                    help="run inline synthetic fixtures and exit")
    args = ap.parse_args()

    if args.self_test:
        run_self_test()
        return

    missing = [flag for flag in ("--ledger", "--pool", "--out")
               if not getattr(args, flag[2:])]
    if missing:
        ap.error("missing required args: %s (or run --self-test)" % ", ".join(missing))

    live_f = load_pool_fingerprints(args.pool)
    with open(args.ledger, "r", encoding="utf-8") as fh:
        out = build_rollup(parse_ledger_lines(fh, args.ledger), live_f)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)

    basis = out["basis"]
    print("sup-supply-rollup: %d buckets | ledger read %d used %d | pool fps %d -> %s"
          % (len(out["rows"]), basis["ledger_rows_read"], basis["ledger_rows_used"],
             basis["pool_fingerprints"], args.out))


if __name__ == "__main__":
    main()
