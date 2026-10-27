#!/usr/bin/env python3
"""
index_heal.py — repair _INDEX.md and _SUMMARIES.md coverage mechanically.

Finds wiki articles not covered by the master index (or any wiki/*/_INDEX*.md)
and raw/ files missing from _SUMMARIES.md, then APPENDS entries — never rewrites
existing content. Idempotent: run it any time; it only adds what's missing.
One-liners come from each note's frontmatter title + first blockquote/paragraph.

Usage: python tools/index_heal.py [--dry-run]
"""

import re
import sys
from pathlib import Path

VAULT = Path(__file__).resolve().parent.parent
WIKI = VAULT / "wiki"
RAW = VAULT / "raw"
INDEX = WIKI / "_INDEX.md"
SUMMARIES = WIKI / "_SUMMARIES.md"

WL = re.compile(r"\[\[([^\]]+)\]\]")
FM = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def one_liner(f: Path) -> str:
    text = f.read_text(encoding="utf-8", errors="ignore")
    m = FM.match(text)
    title = ""
    if m:
        for line in m.group(1).splitlines():
            if line.startswith("title:"):
                title = line.split(":", 1)[1].strip().strip('"')
    body = FM.sub("", text)
    desc = ""
    for line in body.splitlines():
        s = line.strip()
        if s.startswith(">"):
            desc = s.lstrip("> ").strip()
            break
        if s and not s.startswith("#") and not s.startswith("["):
            desc = s
            break
    desc = re.sub(r"\[\[([^\]|]+)(\|[^\]]+)?\]\]", r"\1", desc)
    desc = desc.replace("**", "")
    if len(desc) > 140:
        desc = desc[:137] + "..."
    return f"{title or f.stem} — {desc}" if desc else (title or f.stem)


def covered_index_targets() -> set[str]:
    text = INDEX.read_text(encoding="utf-8", errors="ignore") if INDEX.exists() else ""
    for sub in WIKI.glob("*/_INDEX*.md"):
        text += "\n" + sub.read_text(encoding="utf-8", errors="ignore")
    return {l.split("#")[0].strip().removesuffix(".md") for l in WL.findall(text)}


def heal_index(dry: bool) -> int:
    covered = covered_index_targets()
    missing = []
    for f in sorted(WIKI.rglob("*.md")):
        if f.name.startswith("_"):
            continue
        rel = str(f.relative_to(VAULT)).replace("\\", "/").removesuffix(".md")
        if rel.startswith("wiki/claude-memory/"):
            continue
        if rel not in covered:
            missing.append((rel, f))
    if not missing:
        return 0
    by_folder = {}
    for rel, f in missing:
        folder = "/".join(rel.split("/")[1:-1]) or "wiki"
        by_folder.setdefault(folder, []).append((rel, f))
    lines = ["", f"## Cobertura restaurada (index_heal)", ""]
    for folder in sorted(by_folder):
        lines.append(f"### {folder}/")
        for rel, f in by_folder[folder]:
            lines.append(f"- [[{rel}]] — {one_liner(f)}")
        lines.append("")
    if dry:
        print("\n".join(lines))
    else:
        with INDEX.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
    return len(missing)


def heal_summaries(dry: bool) -> int:
    text = SUMMARIES.read_text(encoding="utf-8", errors="ignore") if SUMMARIES.exists() else ""
    missing = []
    for f in sorted(RAW.rglob("*.md")):
        rel = str(f.relative_to(VAULT)).replace("\\", "/")
        if rel.startswith("raw/notion/"):
            continue
        short = str(f.relative_to(RAW)).replace("\\", "/")
        if short in text or rel in text or f.name in text:
            continue
        parts = short.split("/")[:-1]
        if any("/".join(parts[: i + 1]) + "/" in text for i in range(len(parts))):
            continue
        missing.append((short, f))
    if not missing:
        return 0
    lines = ["", "## Raw adicionados (index_heal)", ""]
    for short, f in missing:
        lines.append(f"- `{short}` — {one_liner(f)}")
    lines.append("")
    if dry:
        print("\n".join(lines))
    else:
        with SUMMARIES.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
    return len(missing)


def main():
    dry = "--dry-run" in sys.argv
    n_idx = heal_index(dry)
    n_sum = heal_summaries(dry)
    print(f"index: {n_idx} entrada(s) {'faltando' if dry else 'adicionada(s)'}; "
          f"summaries: {n_sum} entrada(s) {'faltando' if dry else 'adicionada(s)'}")


if __name__ == "__main__":
    main()
