#!/usr/bin/env python3
"""
search.py — CLI search engine for the second brain vault.

Usage:
    python tools/search.py "query terms" [--dir wiki|raw|all] [--limit N] [--context N]

Options:
    --dir     Which directory to search: wiki, raw, or all (default: all)
    --limit   Max results to return (default: 10)
    --context Lines of context around each match (default: 2)
    --titles  Search titles/filenames only (no content scan)
    --tags    Filter by tag (matches frontmatter tags)
"""

import argparse
import os
import re
import sys
from pathlib import Path
from collections import defaultdict

VAULT_ROOT = Path(__file__).parent.parent


def search_dir(query: str, base_dir: Path, context_lines: int) -> list[dict]:
    terms = query.lower().split()
    results = []

    for md_file in sorted(base_dir.rglob("*.md")):
        try:
            text = md_file.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        lines = text.splitlines()
        matches = []

        for i, line in enumerate(lines):
            line_lower = line.lower()
            if all(t in line_lower for t in terms):
                start = max(0, i - context_lines)
                end = min(len(lines), i + context_lines + 1)
                snippet = "\n".join(lines[start:end])
                matches.append({"line": i + 1, "snippet": snippet})

        if matches:
            # Score: more matches = higher rank
            score = len(matches)
            # Boost if query terms appear in filename
            if all(t in md_file.name.lower() for t in terms):
                score += 5
            results.append({
                "file": str(md_file.relative_to(VAULT_ROOT)),
                "score": score,
                "match_count": len(matches),
                "matches": matches,
            })

    return sorted(results, key=lambda r: r["score"], reverse=True)


def search_titles(query: str, base_dir: Path) -> list[dict]:
    terms = query.lower().split()
    results = []
    for md_file in sorted(base_dir.rglob("*.md")):
        name = md_file.stem.lower()
        if all(t in name for t in terms):
            results.append({
                "file": str(md_file.relative_to(VAULT_ROOT)),
                "score": 1,
                "match_count": 1,
                "matches": [],
            })
    return results


def filter_by_tag(results: list[dict], tag: str) -> list[dict]:
    filtered = []
    tag_lower = tag.lower()
    for r in results:
        path = VAULT_ROOT / r["file"]
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        # Simple frontmatter tag check
        frontmatter_match = re.search(r"^tags:\s*\[([^\]]*)\]", text, re.MULTILINE)
        if frontmatter_match:
            tags = [t.strip().lower() for t in frontmatter_match.group(1).split(",")]
            if tag_lower in tags:
                filtered.append(r)
    return filtered


def main():
    parser = argparse.ArgumentParser(description="Search the second brain vault.")
    parser.add_argument("query", help="Search terms")
    parser.add_argument("--dir", choices=["wiki", "raw", "timeline", "all"], default="all")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--context", type=int, default=2)
    parser.add_argument("--titles", action="store_true", help="Search filenames only")
    parser.add_argument("--tags", type=str, default=None, help="Filter by tag")
    args = parser.parse_args()

    dirs = []
    if args.dir in ("wiki", "all"):
        dirs.append(VAULT_ROOT / "wiki")
    if args.dir in ("raw", "all"):
        dirs.append(VAULT_ROOT / "raw")
    if args.dir in ("timeline", "all"):
        dirs.append(VAULT_ROOT / "Timeline")

    all_results = []
    for d in dirs:
        if d.exists():
            if args.titles:
                all_results.extend(search_titles(args.query, d))
            else:
                all_results.extend(search_dir(args.query, d, args.context))

    if args.tags:
        all_results = filter_by_tag(all_results, args.tags)

    all_results = sorted(all_results, key=lambda r: r["score"], reverse=True)
    all_results = all_results[: args.limit]

    if not all_results:
        print(f"No results for: {args.query!r}")
        sys.exit(0)

    print(f"\n=== Results for: {args.query!r} ({len(all_results)} files) ===\n")

    for r in all_results:
        print(f"[{r['match_count']} matches] {r['file']}")
        if r["matches"] and not args.titles:
            for m in r["matches"][:2]:  # show first 2 matches
                print(f"  L{m['line']}: {m['snippet'].strip()[:200]}")
                print()
        else:
            print()


if __name__ == "__main__":
    main()
