#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
import os
import tempfile
import urllib.request

TECH_DOMAINS = {"software", "data_science", "hardware", "ai", "cybersecurity"}


@dataclass
class PoolRow:
    name: str
    total: int = 0
    tech_us: int = 0
    intern: int = 0
    domain_counts: dict[str, int] = field(default_factory=dict)


@dataclass
class DescRow:
    has_count: int = 0
    total: int = 0


def normalize(value: str) -> str:
    return (value or "").strip().lower()


def first_match(key: str, mapping: dict[str, object]) -> object | None:
    # Exact-match only. The prior substring fallback (tel↔teleo, loop↔loopio, nium↔tanium,
    # fireworks-ai↔firework) wrote DISTINCT companies' counts onto each other — all false
    # positives. Companies without an exact pool/stats match now stay empty (honest) rather
    # than inherit an unrelated company's counts. (SUP cleanup 2026-08-08.)
    return mapping.get(key)


def load_stats(path: Path) -> dict[str, dict]:
    if not path.exists():
        print(f"Warning: {path} not found — enrichment columns will not be updated")
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    stats = {
        normalize(row.get("company", "")): row
        for row in data.get("by_company", [])
        if row.get("company")
    }
    print(f"Enrichment stats: {len(stats)} companies (generated {data.get('generated')})")
    return stats


def iter_all_jobs(path: Path):
    if not path.exists():
        print(f"Warning: {path} not found — pool/description columns will not be updated")
        return
    with path.open(encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                yield json.loads(raw)
            except Exception:
                continue


def load_pool(path: Path) -> dict[str, PoolRow]:
    pool: dict[str, PoolRow] = {}
    for job in iter_all_jobs(path) or []:
        company = (job.get("company_name") or "").strip()
        if not company:
            continue
        key = normalize(company)
        row = pool.setdefault(key, PoolRow(name=company))
        row.total += 1
        domains = job.get("tags", {}).get("domains") or []
        locations = job.get("tags", {}).get("locations") or []
        if any(dom in TECH_DOMAINS for dom in domains) and "us" in locations:
            row.tech_us += 1
        if job.get("tags", {}).get("employment") == "internship":
            row.intern += 1
        if "us" in locations:
            for domain in domains:
                row.domain_counts[domain] = row.domain_counts.get(domain, 0) + 1
    print(f"Pool data: {len(pool)} companies from all_jobs.json")
    return pool


def load_description_ids(data_dir: Path) -> set[str]:
    desc_ids: set[str] = set()
    files = sorted(data_dir.glob("descriptions-*.jsonl"))
    for path in files:
        with path.open(encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    payload = json.loads(raw)
                except Exception:
                    continue
                job_id = payload.get("id")
                if job_id:
                    desc_ids.add(job_id)
    print(f"Descriptions: {len(desc_ids)} unique IDs across {len(files)} sidecar files")
    return desc_ids


def load_company_desc_counts(all_jobs_path: Path, desc_ids: set[str]) -> dict[str, DescRow]:
    counts: dict[str, DescRow] = {}
    for job in iter_all_jobs(all_jobs_path) or []:
        company = normalize(job.get("company_name", ""))
        if not company:
            continue
        row = counts.setdefault(company, DescRow())
        row.total += 1
        if job.get("id") in desc_ids:
            row.has_count += 1
    return counts


def domain_breakdown_text(domain_counts: dict[str, int]) -> str:
    return "|".join(
        f"{domain}:{count}"
        for domain, count in sorted(domain_counts.items(), key=lambda item: item[1], reverse=True)
        if count > 0
    )


def first_existing(fieldnames: list[str], *candidates: str) -> str | None:
    fields = set(fieldnames)
    for candidate in candidates:
        if candidate in fields:
            return candidate
    return None


def _storage_fetch(filename: str) -> Path | None:
    """Download pipeline-data/{filename} from Supabase Storage to a temp file.
    Returns None if creds are missing or the fetch fails (caller falls back to local).
    SUP-CSV-ENRICH-REPOINT-1: the legacy local source (.github/data) is empty post-R2-gitcutover."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None
    try:
        req = urllib.request.Request(
            f"{url.rstrip('/')}/storage/v1/object/pipeline-data/{filename}",
            headers={"Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=180) as resp, tempfile.NamedTemporaryFile(
            mode="wb", suffix=f"-{filename}", delete=False
        ) as tmp:
            tmp.write(resp.read())
        return Path(tmp.name)
    except Exception as exc:
        print(f"Warning: Storage fetch of {filename} failed ({exc}); falling back to local file")
        return None


def _resolve_data_path(local_path: Path, storage_filename: str) -> Path:
    """Prefer a non-empty local copy; else fetch the live Storage object; else fall back
    to the (possibly dead) local path so load_* emits its own warning."""
    if local_path.exists() and local_path.stat().st_size > 0:
        return local_path
    fetched = _storage_fetch(storage_filename)
    return fetched if fetched else local_path

def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh ZJP company CSV enrichment/pool columns")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--csv", default=None,
                        help="CSV path (default: workspace canonical .GenAI_Work path when run locally)")
    parser.add_argument("--data-dir", default=None,
                        help="data dir holding all_jobs.json/enrichment-stats.json "
                             "(default: workspace jobs-data-2026 .github/data; CI passes its download dir; "
                             "missing files fall back to Supabase Storage fetch via env creds)")
    args = parser.parse_args()

    genai_root = Path(__file__).resolve().parents[3]
    job_listings_root = genai_root.parent / "Job_Listings"
    data_dir = Path(args.data_dir) if args.data_dir else (job_listings_root / "jobs-data-2026" / ".github" / "data")
    stats_path = _resolve_data_path(data_dir / "enrichment-stats.json", "enrichment-stats.json")
    all_jobs_path = _resolve_data_path(data_dir / "all_jobs.json", "all_jobs.json")
    csv_path = Path(args.csv) if args.csv else (genai_root / "projects" / "zjp" / "company-research-log.csv")

    stats_map = load_stats(stats_path)
    pool_map = load_pool(all_jobs_path)
    desc_ids = load_description_ids(data_dir)
    desc_counts = load_company_desc_counts(all_jobs_path, desc_ids)

    with csv_path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        if "domain_breakdown" not in fieldnames:
            fieldnames.append("domain_breakdown")
        rows = list(reader)

    total_jobs_key = first_existing(fieldnames, "total_jobs", "pool_total")
    tech_us_key = first_existing(fieldnames, "tech_us_jobs", "tech_us_count")
    has_desc_key = first_existing(fieldnames, "has_descriptions", "enriched_status")
    # SUP-CSV-AUTOFIELDS-REFRESH-1 fix: never clobber the evaluation 'date' column —
    # the audit stamp goes to last_audit_date (appended if the CSV lacks it; the old
    # fallback silently overwrote original evaluation dates).
    audit_date_key = "last_audit_date"
    if audit_date_key not in fieldnames:
        fieldnames.append(audit_date_key)
    stats_targets = [
        ("enriched", first_existing(fieldnames, "enriched_count")),
        ("skills_pct", first_existing(fieldnames, "skills_pct")),
        ("summary_pct", first_existing(fieldnames, "summary_pct")),
    ]

    today = date.today().isoformat()
    updated = 0
    skipped = 0

    for row in rows:
        status = (row.get("status") or "").strip()
        if status != "accepted":
            skipped += 1
            continue

        company = (row.get("company") or "").strip()
        key = normalize(company)
        changed = False

        stats_match = first_match(key, stats_map)
        if isinstance(stats_match, dict):
            for source_key, target_key in stats_targets:
                if target_key is None:
                    continue
                new_value = str(stats_match.get(source_key, row.get(target_key, "") or ""))
                if row.get(target_key, "") != new_value:
                    row[target_key] = new_value
                    changed = True

        pool_match = first_match(key, pool_map)
        if isinstance(pool_match, PoolRow):
            updates = {
                target_key: new_value
                for target_key, new_value in [
                    (total_jobs_key, str(pool_match.total)),
                    (tech_us_key, str(pool_match.tech_us)),
                    ("intern_count", str(pool_match.intern)),
                    ("domain_breakdown", domain_breakdown_text(pool_match.domain_counts)),
                ]
                if target_key is not None
            }
            for target_key, new_value in updates.items():
                if row.get(target_key, "") != new_value:
                    row[target_key] = new_value
                    changed = True

        desc_match = desc_counts.get(key)
        if desc_match and desc_match.total:
            ratio = desc_match.has_count / desc_match.total
            has_desc = "yes" if ratio > 0.8 else ("partial" if ratio > 0.1 else "no")
            if has_desc_key and row.get(has_desc_key, "") != has_desc:
                row[has_desc_key] = has_desc
                changed = True

        if audit_date_key:
            row[audit_date_key] = today  # verified-current stamp (every matched accepted row)

        if changed:
            updated += 1
            if args.dry_run:
                print(
                    f"  [DRY-RUN] {company}: total={row.get(total_jobs_key or 'total_jobs','')} tech_us={row.get(tech_us_key or 'tech_us_jobs','')} "
                    f"intern={row.get('intern_count','')} skills={row.get('skills_pct','—')}% desc={row.get(has_desc_key or 'has_descriptions','')}"
                )
        else:
            skipped += 1

    if args.dry_run:
        print(f"[DRY-RUN] no file written ({updated} rows would update; {skipped} skipped)")
        return
    import shutil
    backup_path = csv_path.with_suffix(".csv.bak")
    shutil.copy2(csv_path, backup_path)
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Backup saved to {backup_path}")
    print(f"Updated {updated} accepted rows in {csv_path}")

    print(f"Skipped {skipped} rows (non-accepted or unchanged)")


if __name__ == "__main__":
    main()
