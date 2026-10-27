#!/usr/bin/env python3
"""Indice de busca textual sobre as mensagens do WhatsApp capturadas pelo Assessor.

Rodar: .venv/Scripts/python.exe tools/whatsapp_index.py [--rebuild]

Por que existe: o assessor.db guarda mensagens locais com texto que o modelo
precisa consultar por fontes. Sem isso, perguntar sobre um combinado pode ficar sem
resposta, mesmo quando a conversa está no disco.

Por que FTS5 e nao embeddings: a media e de 54 caracteres por mensagem -- "Boaa",
"pra Karen", "vou te mandar o link". Vetorizar fragmento desse tamanho produz ruido
caro. Busca textual acerta nome, telefone, valor e termo exato, que e a maior parte
das perguntas reais sobre conversa. O semantico fica para as notas destiladas.

Por que um banco separado: o app do Assessor esta escrevendo no assessor.db o tempo
todo. Este indice le de la em modo somente-leitura e escreve num arquivo proprio, para
que indexar nunca dispute lock com a captura de mensagem.
"""

import argparse
import os
import sqlite3
import sys
from pathlib import Path

VAULT_ROOT = Path(__file__).resolve().parent.parent
INDEX_DB = VAULT_ROOT / "tools" / "whatsapp.db"
# Sem ASSESSOR_DB no ambiente, procuramos o banco no lugar padrao relativo a este
# vault. Cravar caminho absoluto aqui foi o que quebrou a portabilidade da primeira
# vez: na maquina de outra pessoa ele aponta para uma pasta que nunca existiu.
_PADRAO = VAULT_ROOT.parent / "assessor-2.0" / "data" / "assessor.db"
ASSESSOR_DB = Path(os.environ.get("ASSESSOR_DB") or _PADRAO)

# Como o dono aparece na busca. Um nome fixo faria toda mensagem
# própria de outra pessoa ser indexada com o nome errado.
DONO = (os.environ.get("ASSESSOR_DONO") or "Eu").strip() or "Eu"

ESQUEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS mensagens USING fts5(
    texto,
    autor,
    conversa_nome,
    conversa_id UNINDEXED,
    origem_id   UNINDEXED,
    recebido_em UNINDEXED,
    evento_id   UNINDEXED
);
CREATE TABLE IF NOT EXISTS estado (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
"""


def abrir_indice() -> sqlite3.Connection:
    db = sqlite3.connect(INDEX_DB)
    db.executescript(ESQUEMA)
    return db


def abrir_assessor() -> sqlite3.Connection:
    if not ASSESSOR_DB.exists():
        raise SystemExit(f"assessor.db nao encontrado em {ASSESSOR_DB}. Defina ASSESSOR_DB.")
    # Somente leitura: indexar nunca pode atrapalhar a captura de mensagens.
    db = sqlite3.connect(f"file:{ASSESSOR_DB.as_posix()}?mode=ro", uri=True, timeout=30)
    db.execute("PRAGMA busy_timeout = 30000")
    return db


def ultimo_indexado(db: sqlite3.Connection) -> int:
    linha = db.execute("SELECT valor FROM estado WHERE chave='ultimo_evento_id'").fetchone()
    return int(linha[0]) if linha else 0


def indexar_transcricoes(idx: sqlite3.Connection, origem: sqlite3.Connection) -> int:
    """Traz as transcricoes de audio para o mesmo indice das mensagens.

    Audio e 5% de tudo que chega e o bloco que ninguem nunca leu. Transcricao que fica
    guardada numa tabela propria nao responde pergunta nenhuma; no indice, "o que o
    Isaelson falou sobre integracao bancaria" acha a fala mesmo que ela nunca tenha
    sido escrita.
    """
    try:
        linhas = origem.execute(
            """
            SELECT t.conversa_id, t.origem_id, t.texto, t.arquivo,
                   -- Ordem de confianca para "quando a pessoa falou": a mensagem que
                   -- citou o audio, a data gravada na transcricao, e so em ultimo caso
                   -- a data em que transcrevemos -- que nao e a data da fala.
                   COALESCE(e.recebido_em, t.quando, t.criado_em) AS quando,
                   COALESCE(g.nome, c.nome, t.conversa_id) AS conversa_nome,
                   CASE WHEN e.autor_e_dono = 1 THEN (DONO + ' (dono, audio)')
                        ELSE COALESCE(e.autor_id, '') || ' (audio)' END AS autor
            FROM transcricoes t
            LEFT JOIN eventos e ON e.conversa_id = t.conversa_id AND e.origem_id = t.origem_id
            LEFT JOIN grupos_app g ON g.id = t.conversa_id
            LEFT JOIN conversas_app c ON c.id = t.conversa_id
            WHERE t.estado = 'transcrito' AND t.texto IS NOT NULL AND t.texto <> ''
            """
        ).fetchall()
    except sqlite3.OperationalError:
        return 0  # tabela ainda nao existe: nada a indexar

    if not linhas:
        return 0

    # Reindexa o conjunto inteiro: sao poucos milhares e o texto pode ser reescrito
    # numa nova passada de transcricao.
    idx.execute("DELETE FROM mensagens WHERE origem_id LIKE 'transcricao:%'")
    idx.executemany(
        """INSERT INTO mensagens
           (texto, autor, conversa_nome, conversa_id, origem_id, recebido_em, evento_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL)""",
        [(r[2], r[6], r[5], r[0], f"transcricao:{r[1]}", r[4]) for r in linhas],
    )
    idx.commit()
    return len(linhas)


def indexar(rebuild: bool = False, lote: int = 5000) -> dict:
    if rebuild and INDEX_DB.exists():
        INDEX_DB.unlink()

    idx = abrir_indice()
    origem = abrir_assessor()
    try:
        desde = ultimo_indexado(idx)
        total = 0
        while True:
            linhas = origem.execute(
                """
                SELECT e.id, e.conversa_id, e.origem_id, e.autor_id, e.autor_e_dono,
                       e.texto, e.recebido_em,
                       COALESCE(g.nome, c.nome, e.conversa_id) AS conversa_nome
                FROM eventos e
                LEFT JOIN grupos_app g ON g.id = e.conversa_id
                LEFT JOIN conversas_app c ON c.id = e.conversa_id
                WHERE e.id > ? AND e.texto IS NOT NULL AND e.texto <> ''
                ORDER BY e.id LIMIT ?
                """,
                (desde, lote),
            ).fetchall()
            if not linhas:
                break
            idx.executemany(
                """INSERT INTO mensagens
                   (texto, autor, conversa_nome, conversa_id, origem_id, recebido_em, evento_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [
                    (r[5], (DONO + " (dono)") if r[4] else (r[3] or ""), r[7], r[1], r[2], r[6], r[0])
                    for r in linhas
                ],
            )
            desde = linhas[-1][0]
            total += len(linhas)
            idx.execute(
                "INSERT INTO estado (chave, valor) VALUES ('ultimo_evento_id', ?) "
                "ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                (str(desde),),
            )
            idx.commit()

        transcricoes = indexar_transcricoes(idx, origem)
        indexadas = idx.execute("SELECT COUNT(*) FROM mensagens").fetchone()[0]
        return {"novas": total, "transcricoes": transcricoes,
                "total_indexado": indexadas, "ultimo_evento_id": desde}
    finally:
        origem.close()
        idx.close()


def buscar(query: str, conversa: str = "", desde: str = "", limite: int = 20) -> list[dict]:
    """Busca textual. `conversa` casa por nome ou jid; `desde` e ISO (2026-09-01)."""
    if not query or not query.strip():
        return []
    if not INDEX_DB.exists():
        indexar()

    db = sqlite3.connect(f"file:{INDEX_DB.as_posix()}?mode=ro", uri=True)
    try:
        filtros, valores = ["mensagens MATCH ?"], [query]
        if conversa:
            filtros.append("(conversa_nome LIKE ? OR conversa_id = ?)")
            valores += [f"%{conversa}%", conversa]
        if desde:
            filtros.append("recebido_em >= ?")
            valores.append(desde)
        sql = (
            "SELECT conversa_nome, conversa_id, recebido_em, autor, texto, origem_id "
            f"FROM mensagens WHERE {' AND '.join(filtros)} "
            "ORDER BY rank LIMIT ?"
        )
        linhas = db.execute(sql, (*valores, limite)).fetchall()
        return [
            {
                "conversa": r[0], "conversa_id": r[1], "quando": r[2],
                "autor": r[3], "texto": r[4], "origem_id": r[5],
            }
            for r in linhas
        ]
    finally:
        db.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rebuild", action="store_true", help="apaga e reconstroi o indice")
    ap.add_argument("--buscar", help="testa uma busca em vez de indexar")
    ap.add_argument("--limite", type=int, default=10)
    args = ap.parse_args()

    if args.buscar:
        for r in buscar(args.buscar, limite=args.limite):
            print(f"{r['quando'][:16]} | {r['conversa'][:28]:28} | {r['autor'][:20]:20} | {r['texto'][:70]}")
        return 0

    print(indexar(rebuild=args.rebuild))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
