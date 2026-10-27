#!/usr/bin/env python3
"""
mcp_server.py — Punk Records as an MCP server. Any AI (Claude, Hermes, n8n) plugs in and
queries the second brain as tools, instead of rglob-ing the vault.

Run with the vault venv (stdio transport):
  .venv/Scripts/python.exe tools/mcp_server.py

Register in an MCP client, e.g. claude.json / .mcp.json:
  "assessor-brain": {
    "command": "<SEU_VAULT>/.venv/Scripts/python.exe",
    "args": ["<SEU_VAULT>/tools/mcp_server.py"]
  }
O instalador imprime esses dois caminhos ja preenchidos no fim.

Tools: search (semantic+keyword), keyword_search, get_note, get_entity,
get_timeline, get_index, get_graph.
"""

import re
from pathlib import Path

from mcp.server.fastmcp import FastMCP

import brain_lib as B

VAULT = B.VAULT_ROOT
mcp = FastMCP("punk-records")


def _read(rel: str) -> str:
    p = (VAULT / rel)
    if not p.exists() or p.suffix != ".md":
        return f"(not found: {rel})"
    return p.read_text(encoding="utf-8", errors="ignore")


def _slug(s: str) -> str:
    import unicodedata
    s = "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


@mcp.tool()
def search(query: str, limit: int = 8, year: str = "", type: str = "") -> str:
    """Semantic search across the whole brain (entities, synthesis, distilled docs, timeline,
    raw Notion pages). Optional filters: year ('2025'/'2026'/'undated'), type (e.g. 'synthesis',
    'entity/project', 'timeline'). Falls back to keyword search if the semantic index is absent."""
    try:
        q = B.embed_texts([query])[0]
        db = B.connect()
        k = limit * 15 if (year or type) else limit
        rows = db.execute(
            """SELECT c.path, c.heading, c.year, c.type, c.text, v.distance
               FROM vec_chunks v JOIN chunks c ON c.id=v.rowid
               WHERE v.embedding MATCH ? AND k=? ORDER BY v.distance""",
            (B.serialize(q), k)).fetchall()
        out = []
        for path, heading, yr, typ, text, dist in rows:
            if year and yr != year:
                continue
            if type and type not in (typ or ""):
                continue
            snippet = " ".join(text.split())[:300]
            out.append(f"[{round(1-dist,3)}] {path} › {heading} ({yr})\n  {snippet}")
            if len(out) >= limit:
                break
        return "\n\n".join(out) if out else f"No semantic results for {query!r}."
    except Exception as e:
        return keyword_search(query, limit=limit) + f"\n\n(semantic unavailable: {e})"


@mcp.tool()
def keyword_search(query: str, limit: int = 10) -> str:
    """Literal keyword search across wiki/, Timeline/, and raw/notion/. Use for exact names,
    IDs, or when the semantic index is not built."""
    terms = query.lower().split()
    hits = []
    for d in ("wiki", "Timeline", "raw/notion"):
        base = VAULT / d
        if not base.exists():
            continue
        for f in base.rglob("*.md"):
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            low = text.lower()
            if all(t in low for t in terms):
                rel = str(f.relative_to(VAULT)).replace("\\", "/")
                idx = low.find(terms[0])
                snippet = " ".join(text[max(0, idx-80):idx+160].split())
                hits.append((low.count(terms[0]), rel, snippet))
    hits.sort(reverse=True)
    if not hits:
        return f"No keyword results for {query!r}."
    return "\n\n".join(f"{rel}\n  …{snip}…" for _, rel, snip in hits[:limit])


@mcp.tool()
def get_note(path: str) -> str:
    """Return the full markdown of a note by its vault-relative path (e.g.
    'wiki/synthesis/docs/projeto-exemplo.md' or 'wiki/entities/projects/projeto-exemplo.md')."""
    return _read(path)


def _lista_yaml(valor: str) -> list[str]:
    """Lê `aliases: ["a", "b"]` ou `aliases: a, b`. O frontmatter do vault é escrito à
    mão, então as duas formas aparecem."""
    valor = (valor or "").strip()
    if not valor:
        return []
    valor = valor.removeprefix("[").removesuffix("]")
    return [item.strip().strip('"').strip("'") for item in valor.split(",") if item.strip()]


def _indice_entidades() -> dict[str, str]:
    """Mapa apelido -> caminho da nota, cobrindo nome do arquivo, `title`, `name` e
    `aliases`.

    Existe porque a grafia correta de uma pessoa costuma estar escrita em prosa dentro
    da nota (por exemplo, um alias corrigido), onde nenhuma máquina lê.
    São ~56 arquivos e só o cabeçalho é lido, então varrer a cada chamada sai mais
    barato do que manter cache coerente com edições feitas no Obsidian.
    """
    indice: dict[str, str] = {}
    raiz = VAULT / "wiki" / "entities"
    if not raiz.exists():
        return indice
    for p in raiz.rglob("*.md"):
        if p.name.startswith("_"):
            continue
        rel = str(p.relative_to(VAULT)).replace("\\", "/")
        try:
            cabecalho = p.read_text(encoding="utf-8", errors="ignore")[:1200]
        except OSError:
            continue
        meta = B.parse_frontmatter(cabecalho)
        chaves = [p.stem, meta.get("title", ""), meta.get("name", "")]
        chaves += _lista_yaml(meta.get("aliases", ""))
        for chave in chaves:
            s = _slug(chave)
            # Primeiro a registrar vence: o nome do arquivo tem prioridade sobre o
            # alias de outra pessoa que por acaso colida.
            if s and s not in indice:
                indice[s] = rel
    return indice


@mcp.tool()
def get_entity(name: str) -> str:
    """Find and return an entity note (person / company / project) by name.
    Accepts aliases and misspellings declared in the note's `aliases:` frontmatter."""
    slug = _slug(name)
    for kind in ("projects", "companies", "people"):
        p = VAULT / "wiki" / "entities" / kind / f"{slug}.md"
        if p.exists():
            return p.read_text(encoding="utf-8", errors="ignore")

    indice = _indice_entidades()
    if slug in indice:
        conteudo = _read(indice[slug])
        if _slug(Path(indice[slug]).stem) != slug:
            # Chegou por apelido: diz qual é o nome canônico, senão quem perguntou
            # via alias continua sem saber qual é o nome canônico.
            conteudo = f"(resolvido de {name!r} via alias -> {indice[slug]})\n\n{conteudo}"
        return conteudo

    # Aproximação: primeiro substring, depois distância de edição.
    matches = [rel for s, rel in indice.items() if slug and (slug in s or s in slug)]
    if not matches:
        import difflib
        proximos = difflib.get_close_matches(slug, list(indice), n=5, cutoff=0.6)
        matches = [indice[s] for s in proximos]
    matches = list(dict.fromkeys(matches))
    if matches:
        return "Multiple/closest matches:\n" + "\n".join(matches)
    return f"No entity matching {name!r}. Try search('{name}')."


@mcp.tool()
def whatsapp_search(query: str, conversa: str = "", desde: str = "", limite: int = 20) -> str:
    """Search the owner's WhatsApp history (237k+ messages captured by the Assessor).

    Use this for what was actually said in a conversation: who promised what, when a
    price was quoted, whether a lead ever answered. The vault notes hold the distilled
    knowledge; this holds the raw record behind it.

    query: FTS5 terms ("projeto", "mensalidade contrato", "propos*").
    conversa: optional filter by conversation name or jid.
    desde: optional ISO lower bound ("2026-08-01").
    Every hit returns conversation, timestamp, author and message id, so any claim
    built on this can be traced back.
    """
    try:
        import whatsapp_index as W
        W.indexar()  # incremental: pega o que chegou desde a ultima busca
        hits = W.buscar(query, conversa=conversa, desde=desde, limite=max(1, min(limite, 100)))
    except Exception as e:  # noqa: BLE001 - degradar com motivo e melhor que sumir
        return f"(whatsapp search unavailable: {e})"
    if not hits:
        return f"No WhatsApp message matching {query!r}."
    linhas = [
        f"{h['quando'][:16]} | {h['conversa']} | {h['autor']} | {h['texto']}"
        f"\n    (origem_id: {h['origem_id']}  conversa_id: {h['conversa_id']})"
        for h in hits
    ]
    return f"{len(hits)} mensagem(ns):\n" + "\n".join(linhas)


@mcp.tool()
def get_timeline(year: str = "", month: str = "") -> str:
    """Return timeline events. year='2026' returns that year's months; month='2026-02' returns
    one month; no args returns the timeline index. Years are kept strictly separate."""
    if month:
        return _read(f"Timeline/{month.split('-')[0]}/{month}.md")
    if year:
        ydir = VAULT / "Timeline" / year
        if not ydir.exists():
            return f"No timeline for {year}. Available: " + \
                   ", ".join(p.name for p in (VAULT / "Timeline").iterdir() if p.is_dir())
        return "\n\n---\n\n".join(f.read_text(encoding="utf-8", errors="ignore")
                                  for f in sorted(ydir.glob("*.md")))
    return _read("Timeline/_TIMELINE_INDEX.md")


@mcp.tool()
def get_index(which: str = "central") -> str:
    """Return a navigation index. which ∈ {central, wiki, entities, synthesis, docs, timeline,
    pages, manifest, graph}."""
    m = {
        "central": "00_Punk_Records_Central.md",
        "wiki": "wiki/_INDEX.md",
        "entities": "wiki/entities/_INDEX.md",
        "synthesis": "wiki/synthesis/_INDEX.md",
        "docs": "wiki/synthesis/docs/_INDEX.md",
        "timeline": "Timeline/_TIMELINE_INDEX.md",
        "pages": "raw/notion/_PAGES.md",
        "manifest": "raw/notion/_MANIFEST.md",
        "graph": "wiki/_GRAPH.md",
        "ledger": "wiki/ledger/RADAR_FINANCEIRO.md",
    }
    return _read(m.get(which, m["central"]))


@mcp.tool()
def get_financial_radar() -> str:
    """Return the real-time operational financial radar: active monthly recurring revenue (MRR),
    unbilled clients requiring invoices (e.g. WEBi), approved signals awaiting Pix confirmation
    (e.g. Malu Zarro), hot deals with expiring SLAs (e.g. Isaelson), and operational blockers."""
    p_md = VAULT / "wiki" / "ledger" / "RADAR_FINANCEIRO.md"
    if p_md.exists():
        return p_md.read_text(encoding="utf-8", errors="ignore")
    return "Radar financeiro não encontrado em wiki/ledger/RADAR_FINANCEIRO.md."


@mcp.tool()
def get_graph() -> str:
    """Return the relationship graph (person↔project↔company synapses)."""
    return _read("wiki/_GRAPH.md")


if __name__ == "__main__":
    mcp.run()
