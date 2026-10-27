#!/usr/bin/env python3
"""
semsearch.py — semantic search over the vault (sqlite-vec + bge-m3).

Run with the vault venv:
  .venv/Scripts/python.exe tools/semsearch.py "economia de narração de IA"
  .venv/Scripts/python.exe tools/semsearch.py "decisões da call" --year 2026 --limit 8
  .venv/Scripts/python.exe tools/semsearch.py "funil de vendas" --type synthesis --json

Filters: --year (2025/2026/undated), --type (entity/project, synthesis, timeline, ...).
"""

import argparse
import json
import sys

import brain_lib as B

# Windows consoles default to cp1252 and choke on PT/arrows/emoji — force UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def search(query: str, limit: int, year: str | None, type_: str | None) -> list[dict]:
    db = B.connect()
    q = B.embed_texts([query])[0]
    # over-fetch then filter by metadata (vec0 KNN doesn't filter arbitrary cols)
    k = limit * 15 if (year or type_) else limit
    rows = db.execute(
        """SELECT c.path, c.heading, c.year, c.type, c.text, v.distance
           FROM vec_chunks v JOIN chunks c ON c.id = v.rowid
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY v.distance""",
        (B.serialize(q), k)).fetchall()
    out = []
    for path, heading, yr, typ, text, dist in rows:
        if year and yr != year:
            continue
        if type_ and type_ not in (typ or ""):
            continue
        out.append({"path": path, "heading": heading, "year": yr, "type": typ,
                    "score": round(1 - dist, 4), "text": text})
        if len(out) >= limit:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--year", default=None)
    ap.add_argument("--type", dest="type_", default=None)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    try:
        res = search(args.query, args.limit, args.year, args.type_)
    except Exception as e:
        print(f"ERROR: {e}\nRun `embed.py` first and ensure Ollama is up.", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
        return
    if not res:
        print(f"No semantic results for {args.query!r}")
        return
    print(f"\n=== Semantic results for {args.query!r} ({len(res)}) ===\n")
    for r in res:
        print(f"[{r['score']}] {r['path']}  ›  {r['heading']}  ({r['year']})")
        snippet = " ".join(r["text"].split())[:200]
        print(f"   {snippet}\n")


if __name__ == "__main__":
    main()
