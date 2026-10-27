#!/usr/bin/env python3
"""
brain_lib.py — shared helpers for the semantic layer (embeddings + sqlite-vec store).
Used by embed.py, semsearch.py, and the MCP server. Run with the vault venv:
  .venv/Scripts/python.exe tools/embed.py
"""

import json
import os
import re
import sqlite3
import struct
from pathlib import Path

import requests
import sqlite_vec

VAULT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = VAULT_ROOT / "tools" / "brain.db"
OLLAMA = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
EMBED_MODEL = os.environ.get("BRAIN_EMBED_MODEL", "bge-m3")
EMBED_DIM = 1024  # bge-m3
CHUNK_CHARS = 1500
# Directories to index semantically. Distilled layer (wiki/, Timeline/) gives the cleanest RAG;
# raw/notion/ adds full-corpus recall over the raw transcripts (slower to build on CPU, but the
# owner wants total recall). Distilled chunks still rank highest for clean queries.
# raw/notion sozinho e 39 dos 44 MB do corpus. Poder indexar so o destilado primeiro
# faz a diferenca entre ter busca semantica hoje ou depois de uma noite de GPU.
INDEX_DIRS = [d.strip() for d in os.environ.get(
    "BRAIN_INDEX_DIRS", "wiki,Timeline,raw/notion").split(",") if d.strip()]


# ------------------------------------------------------------------ embeddings (Ollama)

MAX_EMBED_CHARS = 6000  # ~well under bge-m3's 8192-token context; long lines are truncated


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Batch-embed via Ollama /api/embed. Returns one vector per input. Inputs are
    truncated to MAX_EMBED_CHARS so oversized transcript chunks don't 500 the server."""
    if not texts:
        return []
    safe = [(t[:MAX_EMBED_CHARS] if t and t.strip() else ".") for t in texts]
    r = requests.post(f"{OLLAMA}/api/embed",
                      json={"model": EMBED_MODEL, "input": safe}, timeout=600)
    r.raise_for_status()
    embs = r.json().get("embeddings")
    if not embs:
        raise RuntimeError(f"Ollama returned no embeddings (model {EMBED_MODEL}). "
                           f"Is it pulled? `ollama pull {EMBED_MODEL}`")
    return embs


def serialize(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


# ------------------------------------------------------------------------------ store

def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    return db


def init_db(db: sqlite3.Connection):
    db.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[{EMBED_DIM}])")
    db.execute("""CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        path TEXT, heading TEXT, year TEXT, type TEXT, tags TEXT, text TEXT)""")
    db.execute("""CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, mtime REAL)""")
    db.commit()


# ------------------------------------------------------------------ frontmatter + chunk

_FM = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def parse_frontmatter(text: str) -> dict:
    m = _FM.match(text)
    meta = {}
    if not m:
        return meta
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip('"')
    return meta


def chunk_markdown(text: str) -> list[tuple[str, str]]:
    """Split into (heading, chunk_text). Breaks on headings, caps chunk size."""
    body = _FM.sub("", text)
    chunks, heading, buf, size = [], "", [], 0
    def flush():
        nonlocal buf, size
        if buf and "".join(buf).strip():
            chunks.append((heading, "".join(buf).strip()))
        buf, size = [], 0
    for line in body.splitlines(keepends=True):
        if re.match(r"^#{1,6} ", line):
            flush()
            heading = line.lstrip("#").strip()
        buf.append(line); size += len(line)
        if size >= CHUNK_CHARS:
            flush()
    flush()
    return chunks


def iter_note_files():
    for d in INDEX_DIRS:
        base = VAULT_ROOT / d
        if base.exists():
            for f in base.rglob("*.md"):
                yield f
