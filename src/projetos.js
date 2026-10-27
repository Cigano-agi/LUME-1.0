import { agoraIso } from "./relogio.js";
import { posix, win32 } from "node:path";
import { realpathSync } from "node:fs";

export class ProjetoAmbiguo extends Error {
  constructor(conversaId, ids) {
    super(`conversa ${conversaId} ligada a mais de um projeto; escolha explicita: ${ids.join(", ")}`);
    this.name = "ProjetoAmbiguo";
  }
}

export class AcessoNegado extends Error {
  constructor(conversaId, projetoId) {
    super(`conversa ${conversaId} sem acesso ao projeto ${projetoId}`);
    this.name = "AcessoNegado";
  }
}

export class ReclassificacaoNegada extends Error {
  constructor(eventoId, atual, pedido) {
    super(`evento ${eventoId} ja pertence a ${atual}; reclassificacao para ${pedido} exige fluxo auditado`);
    this.name = "ReclassificacaoNegada";
  }
}

function canonizarRaiz(raiz, resolverRaiz) {
  const recebida = String(raiz).replaceAll("\\", "/").replace(/\/+$/, "");
  if (!/^(?:[A-Za-z]:\/|\/)/.test(recebida)) throw new Error("raiz do projeto precisa ser absoluta");
  if (process.platform === "win32" && !/^[A-Za-z]:\//.test(recebida)) {
    throw new Error("raiz no Windows exige unidade explicita");
  }
  if (recebida.split("/").includes("..")) throw new Error("raiz do projeto nao aceita travessia '..'");
  const windows = /^[A-Za-z]:\//.test(recebida);
  const lexical = windows ? win32.resolve(recebida) : posix.resolve(recebida);
  const resolvida = String(resolverRaiz(lexical)).replaceAll("\\", "/").replace(/\/+$/, "");
  const raizDoSistema = windows ? /^[A-Za-z]:\/$/.test(resolvida) : resolvida === "/";
  if (raizDoSistema) throw new Error("raiz do filesystem nao pode ser um projeto");
  return resolvida.replace(/^([a-z]):/i, (_, drive) => `${drive.toUpperCase()}:`);
}

function sobrepoe(a, b) {
  const windows = /^[A-Za-z]:\//.test(a) || /^[A-Za-z]:\//.test(b);
  const x = windows ? a.toLowerCase() : a;
  const y = windows ? b.toLowerCase() : b;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export class Projetos {
  #db;
  #resolverRaiz;
  constructor(db, { resolverRaiz = realpathSync.native } = {}) {
    this.#db = db;
    this.#resolverRaiz = resolverRaiz;
  }

  cadastrar({ id, cliente, nome, raiz }, agora = new Date()) {
    if (!id || !cliente || !nome || !raiz) throw new Error("projeto exige id, cliente, nome e raiz");
    const raizCanonica = canonizarRaiz(raiz, this.#resolverRaiz);
    const conflito = this.#db.prepare("SELECT id, raiz FROM projetos WHERE id<>?").all(String(id))
      .find((p) => sobrepoe(raizCanonica, p.raiz));
    if (conflito) throw new Error(`raiz sobrepoe projeto ${conflito.id}`);
    this.#db.prepare(
      `INSERT INTO projetos (id, cliente, nome, raiz, criado_em) VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET cliente=excluded.cliente, nome=excluded.nome, raiz=excluded.raiz`,
    ).run(String(id), String(cliente), String(nome), raizCanonica, agoraIso(agora));
    return this.buscar(id);
  }

  buscar(id) {
    return this.#db.prepare("SELECT * FROM projetos WHERE id=?").get(id) ?? null;
  }

  vincular(conversaId, projetoId, { decididoPor = null, agora = new Date() } = {}) {
    if (!decididoPor) throw new Error("vinculo de projeto exige dono identificado");
    if (!this.buscar(projetoId)) throw new Error(`projeto inexistente: ${projetoId}`);
    this.#db.prepare(
      `INSERT INTO conversa_projetos (conversa_id, projeto_id, decidido_por, decidido_em)
       VALUES (?,?,?,?) ON CONFLICT(conversa_id, projeto_id) DO UPDATE SET
       decidido_por=excluded.decidido_por, decidido_em=excluded.decidido_em`,
    ).run(conversaId, projetoId, decididoPor, agoraIso(agora));
  }

  vinculados(conversaId) {
    return this.#db.prepare(
      `SELECT p.* FROM projetos p JOIN conversa_projetos cp ON cp.projeto_id=p.id
       WHERE cp.conversa_id=? ORDER BY p.id`,
    ).all(conversaId);
  }

  resolver(conversaId, projetoId = null) {
    const permitidos = this.vinculados(conversaId);
    if (projetoId) {
      const projeto = permitidos.find((p) => p.id === projetoId);
      if (!projeto) throw new AcessoNegado(conversaId, projetoId);
      return projeto;
    }
    if (permitidos.length === 1) return permitidos[0];
    if (permitidos.length > 1) throw new ProjetoAmbiguo(conversaId, permitidos.map((p) => p.id));
    throw new AcessoNegado(conversaId, "(nenhum projeto vinculado)");
  }
}

export class ContextoIsolado {
  #db;
  #projetos;
  constructor(db, projetos) {
    this.#db = db;
    this.#projetos = projetos;
  }

  /**
   * A entrada crua nunca escolhe o projeto. Somente este roteador, depois de
   * conferir o vinculo exato da conversa, pode carimbar a fronteira de contexto.
   */
  atribuirEvento(conversaId, eventoId, projetoId) {
    const projeto = this.#projetos.resolver(conversaId, projetoId);
    const evento = this.#db.prepare("SELECT conversa_id, projeto_id FROM eventos WHERE id=?").get(eventoId);
    if (!evento || evento.conversa_id !== conversaId) throw new AcessoNegado(conversaId, projetoId);
    if (evento.projeto_id && evento.projeto_id !== projeto.id) {
      throw new ReclassificacaoNegada(eventoId, evento.projeto_id, projeto.id);
    }
    this.#db.prepare("UPDATE eventos SET projeto_id=? WHERE id=?").run(projeto.id, eventoId);
    return projeto;
  }

  eventos(conversaId, projetoId, limite = 200) {
    const projeto = this.#projetos.resolver(conversaId, projetoId);
    return this.#db.prepare(
      `SELECT * FROM eventos WHERE conversa_id=? AND projeto_id=? ORDER BY id ASC LIMIT ?`,
    ).all(conversaId, projeto.id, limite);
  }

  manifestoExecucao(conversaId, projetoId) {
    const projeto = this.#projetos.resolver(conversaId, projetoId);
    return {
      projetoId: projeto.id,
      cliente: projeto.cliente,
      nome: projeto.nome,
      raizesPermitidas: [projeto.raiz],
      negarPorPadrao: true,
    };
  }
}
