#!/usr/bin/env python3
"""
embed.py — build/refresh the semantic index (sqlite-vec) over the vault.

Run with the vault venv:
  .venv/Scripts/python.exe tools/embed.py            # incremental (skip unchanged files)
  .venv/Scripts/python.exe tools/embed.py --rebuild  # wipe and re-embed everything

Embeds wiki/ + Timeline/ + raw/notion/ via Ollama bge-m3 (local). Chunks by heading.
"""

import argparse
import sys
from pathlib import Path

import brain_lib as B


def reindex(rebuild: bool):
    if rebuild and B.DB_PATH.exists():
        B.DB_PATH.unlink()
    db = B.connect()
    B.init_db(db)

    known = dict(db.execute("SELECT path, mtime FROM files").fetchall())
    seen = set()
    batch_texts, batch_meta = [], []
    n_files = n_chunks = 0

    skipped = [0]

    def embed_indexed(texts):
        """Embed, bisecting on server errors so one bad chunk can't kill the batch.
        Returns [(local_index, embedding)] for successes; logs+skips hard failures."""
        try:
            return list(enumerate(B.embed_texts(texts)))
        except Exception as e:
            if len(texts) == 1:
                skipped[0] += 1
                print(f"  ! skipped 1 chunk (len={len(texts[0])}): {str(e)[:60]}")
                return []
            mid = len(texts) // 2
            left = embed_indexed(texts[:mid])
            right = embed_indexed(texts[mid:])
            return left + [(i + mid, em) for i, em in right]

    def flush_batch():
        nonlocal n_chunks
        if not batch_texts:
            return
        for i, emb in embed_indexed(batch_texts):
            meta = batch_meta[i]
            cur = db.execute(
                "INSERT INTO chunks(path,heading,year,type,tags,text) VALUES(?,?,?,?,?,?)",
                meta)
            db.execute("INSERT INTO vec_chunks(rowid, embedding) VALUES(?,?)",
                       (cur.lastrowid, B.serialize(emb)))
            n_chunks += 1
        batch_texts.clear(); batch_meta.clear()
        db.commit()

    for f in B.iter_note_files():
        rel = str(f.relative_to(B.VAULT_ROOT)).replace("\\", "/")
        seen.add(rel)
        mtime = f.stat().st_mtime
        if not rebuild and known.get(rel) == mtime:
            continue  # unchanged
        # changed/new: drop old chunks for this file
        ids = [r[0] for r in db.execute("SELECT id FROM chunks WHERE path=?", (rel,)).fetchall()]
        for cid in ids:
            db.execute("DELETE FROM vec_chunks WHERE rowid=?", (cid,))
        db.execute("DELETE FROM chunks WHERE path=?", (rel,))
        text = f.read_text(encoding="utf-8", errors="ignore")
        meta = B.parse_frontmatter(text)
        for heading, chunk in B.chunk_markdown(text):
            batch_texts.append(f"{meta.get('title','')} — {heading}\n{chunk}")
            batch_meta.append((rel, heading, str(meta.get("year", "")),
                               meta.get("type", ""), meta.get("tags", ""), chunk))
            if len(batch_texts) >= 8:
                flush_batch()
        db.execute("INSERT OR REPLACE INTO files(path,mtime) VALUES(?,?)", (rel, mtime))
        n_files += 1
        if n_files % 100 == 0:
            print(
                f"progress: {n_files} changed file(s), {n_chunks} new chunk(s), "
                f"{skipped[0]} skipped",
                flush=True,
            )
    flush_batch()

    # prune deleted files
    for rel in list(known):
        if rel not in seen:
            ids = [r[0] for r in db.execute("SELECT id FROM chunks WHERE path=?", (rel,)).fetchall()]
            for cid in ids:
                db.execute("DELETE FROM vec_chunks WHERE rowid=?", (cid,))
            db.execute("DELETE FROM chunks WHERE path=?", (rel,))
            db.execute("DELETE FROM files WHERE path=?", (rel,))
    db.commit()

    total = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    print(f"indexed {n_files} changed file(s), {n_chunks} new chunk(s), "
          f"{skipped[0]} skipped. Total chunks in index: {total}.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()
    try:
        reindex(args.rebuild)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        print("Check Ollama is running (`ollama list`) and bge-m3 is pulled.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
