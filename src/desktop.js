import {grafoDesktop,fontesGrafo} from './grafo-desktop.js';
import {listarConversas,detalheConversa} from './conversas-desktop.js';
import {listarContatos,detalheContato} from './contatos-desktop.js';
import {prepararNegocios} from './negocios-desktop.js';
import { diaLocal } from './relogio.js';
import { mapaDeNomes, nomeDe, prepararEsquemaCrm } from './crm.js';
import { LEITURA_PESSOAL_SQL } from './leitura-sql.js';
import {prepararTarefas,SUGESTAO_ATUAL_SQL} from './tarefas-esquema.js';
import { ACOES_POR_PAGINA, regraPrioridade } from './prioridade-desktop.js';
import {projecaoTranscricoes,qualidadeFonte} from './consulta-transcricao.js';
import {ComandosDesktop} from './comandos-desktop.js';
import {criarNomeVisivel} from './nomes-conversa.js';

export const VERSAO_TERMOS = 'beta-2026-10-01-leitura-pessoal';
// A mesma fronteira para contagens, busca, tarefas e grafo. NULL fica fechado.
const VISIVEL = LEITURA_PESSOAL_SQL;
const NOMES = `LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id`;

export class Desktop {
  constructor(db) {
    this.db = db;
    db.function('lume_texto_busca',{deterministic:true},value=>String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase());
    prepararEsquemaCrm(db);
    prepararTarefas(db);
    prepararNegocios(db);
    this.comandosDesktop = new ComandosDesktop(db);
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`);
  }
  perfil() {
    const salvo = this.db.prepare("SELECT valor FROM desktop_config WHERE chave='perfil'").get();
    const perfil = salvo ? JSON.parse(salvo.valor) : null;
    return { nome: perfil?.nome || '', aceito: perfil?.versao === VERSAO_TERMOS,
      versaoTermos: VERSAO_TERMOS, aceitoEm: perfil?.aceitoEm || null, modo: 'local',
      guiaDispensado: this.db.prepare("SELECT valor FROM desktop_config WHERE chave='guia-dispensado'").get()?.valor === 'true' };
  }
  configurarGuia({dispensado}={}) {
    if(!this.perfil().aceito)throw new Error('Conclua o primeiro acesso.');
    if(typeof dispensado!=='boolean')throw new Error('Escolha se deseja mostrar o guia.');
    this.db.prepare("INSERT INTO desktop_config VALUES('guia-dispensado',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor").run(String(dispensado));
    return this.perfil();
  }
  aceitar({ nome, aceito, versao } = {}) {
    if (aceito !== true || versao !== VERSAO_TERMOS) throw new Error('Leia e aceite a versão atual dos termos para continuar.');
    if (typeof nome !== 'string' || !nome.trim() || nome.trim().length > 80 || /[\x00-\x1f]/.test(nome)) throw new Error('Informe seu nome (até 80 caracteres).');
    const perfil = { nome: nome.trim(), versao, aceitoEm: new Date().toISOString() };
    this.db.prepare("INSERT INTO desktop_config VALUES('perfil',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor").run(JSON.stringify(perfil));
    return this.perfil();
  }
  resumo({ ordem = 'compromissos', pagina = 1, tag = '', somenteAcoes = false } = {}) {
    if (typeof ordem !== 'string') throw new Error('Ordem de ações inválida.');
    const regra = regraPrioridade(ordem);
    if (!Number.isSafeInteger(pagina) || pagina < 1) throw new Error('Página de ações inválida.');
    if (typeof somenteAcoes !== 'boolean') throw new Error('Opção de resumo inválida.');
    // Internal projection: Clareza already computes coverage in its own aggregation.
    // Keep the exact same task/command ACL and ordering without scanning messages twice.
    const metricas = somenteAcoes ? {} : this.db.prepare(`SELECT COUNT(*) mensagens, COALESCE(SUM(e.tipo != 'nota'),0) mensagensWhatsapp, COUNT(DISTINCT e.conversa_id) conversas,
      COALESCE(SUM(e.dia_local=?),0) hoje, MAX(e.recebido_em) ultimaMensagemEm FROM eventos e WHERE ${VISIVEL}`).get(diaLocal(new Date()));
    const nomes = mapaDeNomes(this.db);
    const nomeVisivel = criarNomeVisivel(this.db);
    const recorte = `FROM itens_crm i JOIN eventos e ON e.conversa_id=i.conversa_id AND e.origem_id=i.origem_id
      ${NOMES} WHERE i.estado='aberto' AND ${VISIVEL} AND NOT EXISTS(SELECT 1 FROM desktop_tarefas_sugestoes s WHERE s.item_id=i.id AND NOT ${SUGESTAO_ATUAL_SQL})`;
    const itensComando = this.comandosDesktop.itensHoje({tag});
    if (tag || itensComando.length) {
      const tarefasCrm = tag ? [] : this.db.prepare(`SELECT i.id,i.resumo,i.tipo,i.quando,i.extraido_em,i.conversa_id,i.origem_id,e.id evento_id,
        COALESCE(g.nome,c.nome,e.conversa_id) conversa_nome, i.responsavel
        ${recorte}`).all();
      const grupos = ordem === 'compromissos'
        ? ['compromisso','pendencia','lead','decisao']
        : ordem === 'oportunidades' ? ['lead','compromisso','pendencia','decisao'] : null;
      const data = valor => Number.isFinite(Date.parse(valor)) ? Date.parse(valor) : null;
      const compararId = (a,b) => typeof a.id === 'number' && typeof b.id === 'number'
        ? a.id-b.id : String(a.id).localeCompare(String(b.id));
      const compararAntigas = (a,b) => {
        const da=data(a.extraido_em),db=data(b.extraido_em);
        if(da===null&&db!==null)return 1;if(da!==null&&db===null)return -1;
        return (da??0)-(db??0)||compararId(a,b);
      };
      const comparar = grupos ? (a,b) => {
        const ga=grupos.indexOf(a.tipo),gb=grupos.indexOf(b.tipo);
        return (ga<0?4:ga)-(gb<0?4:gb)||compararAntigas(a,b);
      } : ordem === 'antigas' ? compararAntigas : (a,b) => {
        const da=data(a.extraido_em),db=data(b.extraido_em);
        if(da===null&&db!==null)return 1;if(da!==null&&db===null)return -1;
        return (db??0)-(da??0)||-compararId(a,b);
      };
      const todas = [...tarefasCrm, ...itensComando].sort(comparar);
      const total = todas.length;
      const paginas = Math.max(1, Math.ceil(total / ACOES_POR_PAGINA));
      pagina = Math.min(pagina, paginas);
      const tarefas = todas.slice((pagina - 1) * ACOES_POR_PAGINA, pagina * ACOES_POR_PAGINA);
      return { ...metricas, tarefas: tarefas.map(i => ({ ...i, conversa_nome: nomeVisivel(i.conversa_nome,i.conversa_id), prioridade: regra.motivo(i.tipo), responsavel: i.responsavel ? nomeDe(i.responsavel, nomes) : null })),
        fila: { ordem, explicacao: regra.explicacao, total, pagina, paginas, porPagina: ACOES_POR_PAGINA }, ...(!somenteAcoes ? {recentes: this.buscar({ limite: 8 })} : {}) };
    }
    const total = this.db.prepare(`SELECT COUNT(*) total ${recorte}`).get().total;
    const paginas = Math.max(1, Math.ceil(total / ACOES_POR_PAGINA));
    pagina = Math.min(pagina, paginas);
    const tarefas = this.db.prepare(`SELECT i.id,i.resumo,i.tipo,i.quando,i.extraido_em,i.conversa_id,i.origem_id,e.id evento_id,
      COALESCE(g.nome,c.nome,e.conversa_id) conversa_nome, i.responsavel
      ${recorte} ORDER BY ${regra.sql} LIMIT ? OFFSET ?`).all(ACOES_POR_PAGINA, (pagina - 1) * ACOES_POR_PAGINA);
    return { ...metricas, tarefas: tarefas.map(i => ({ ...i, conversa_nome: nomeVisivel(i.conversa_nome,i.conversa_id), prioridade: regra.motivo(i.tipo), responsavel: i.responsavel ? nomeDe(i.responsavel, nomes) : null })),
      fila: { ordem, explicacao: regra.explicacao, total, pagina, paginas, porPagina: ACOES_POR_PAGINA }, ...(!somenteAcoes ? {recentes: this.buscar({ limite: 8 })} : {}) };
  }
  comandos(filtro) { return this.comandosDesktop.listar(filtro); }
  tags(filtro) { return this.comandosDesktop.listarTags(filtro); }
  tarefasComando(filtro) { return this.comandosDesktop.listarEfeitos({tipo: 'tarefa', ...filtro}); }
  lembretesComando(filtro) { return this.comandosDesktop.listarEfeitos({tipo: 'lembrete', ...filtro}); }
  buscar({ q = '', conversa = '', antes = Number.MAX_SAFE_INTEGER, limite = 50, pessoa = '', assunto = '', de = '', ate = '', tipo = '' } = {}) {
    if (typeof q !== 'string' || q.length > 300 || typeof conversa !== 'string' || conversa.length > 200) throw new Error('Busca inválida.');
    if(typeof pessoa!=='string'||pessoa.length>200||typeof assunto!=='string'||assunto.length>200||
      !['','texto','audio','documento','imagem','video','nota','notetaker_trecho'].includes(tipo))throw new Error('Filtro de memória inválido.');
    for(const value of [de,ate])if(typeof value!=='string'||value&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value))throw new Error('Período inválido.');
    if(de&&ate&&de>ate)throw new Error('O início deve vir antes do fim do período.');
    if (!Number.isSafeInteger(antes) || antes < 1 || !Number.isSafeInteger(limite) || limite < 1 || limite > 100) throw new Error('Paginação inválida.');
    const transcricao=projecaoTranscricoes(this.db),texto=transcricao.texto;
    const filtros = [VISIVEL, `((${texto} IS NOT NULL AND ${texto} <> '') OR e.tipo='audio')`];
    const args = [];
    if(antes!==Number.MAX_SAFE_INTEGER){
      const anchor=this.db.prepare(`SELECT e.recebido_em FROM desktop_fontes e WHERE e.id=? AND ${VISIVEL}`).get(antes);
      if(!anchor)return {mensagens:[],proximoAntes:null};
      filtros.push('(e.recebido_em < ? OR (e.recebido_em = ? AND e.id < ?))');
      args.push(anchor.recebido_em,anchor.recebido_em,antes);
    }
    if (conversa) { filtros.push('e.conversa_id=?'); args.push(conversa); }
    if(pessoa){
      const ids=/^(?:a:[0-9a-f]{64}|p:\d+)$/.test(pessoa)?this.contatoDetalhe({contato:pessoa}).identificadores:[pessoa];
      filtros.push('(e.autor_id IN (SELECT value FROM json_each(?)) OR e.conversa_id IN (SELECT value FROM json_each(?)))');args.push(JSON.stringify(ids),JSON.stringify(ids));
    }
    if(tipo){filtros.push('e.tipo=?');args.push(tipo);}
    if(de){filtros.push('e.recebido_em>=?');args.push(de+'T00:00:00.000Z');}
    if(ate){filtros.push('e.recebido_em<?');args.push(new Date(Date.parse(ate+'T00:00:00Z')+86400000).toISOString());}
    if(assunto.trim()){filtros.push(`instr(lume_texto_busca(${texto}),?)>0`);args.push(assunto.trim().normalize('NFD').replace(/\p{M}/gu,'').toLowerCase());}
    const termos=q.match(/[\p{L}\p{N}]+/gu)||[];
    if(termos.length>1&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='desktop_fontes_fts' AND type='table'").get()){
      filtros.push('e.id IN (SELECT rowid FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH ?)');args.push(termos.slice(0,40).map(t=>'"'+t+'"').join(' AND '));
    }else if(termos.length>1){
      for(const termo of termos.slice(0,40)){filtros.push(`instr(lume_texto_busca(${texto}),?)>0`);args.push(termo.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase());}
    }else if (q.trim()) { filtros.push(`instr(lume_texto_busca(${texto}),?)>0`); args.push(q.trim().normalize('NFD').replace(/\p{M}/gu,'').toLowerCase()); }
    const nomeVisivel=criarNomeVisivel(this.db);
    const linhas = this.db.prepare(`SELECT e.id,e.tipo,e.origem_id,e.conversa_id,e.recebido_em,${texto} texto,e.permissao,e.autor_id,e.autor_e_dono,e.origem_compartilhamento,
      COALESCE(g.nome,c.nome,e.conversa_id) conversa_nome FROM desktop_fontes e ${NOMES} ${transcricao.join}
      WHERE ${filtros.join(' AND ')} ORDER BY e.recebido_em DESC,e.id DESC LIMIT ?`).all(...args, limite + 1);
    return { mensagens: linhas.slice(0, limite).map(e => ({ ...e,conversa_nome:nomeVisivel(e.conversa_nome,e.conversa_id),...qualidadeFonte(this.db,e,{colunas:transcricao.colunas}), autor_nome: e.autor_e_dono ? 'Você' : nomeVisivel(null,e.autor_id) })),
      proximoAntes: linhas.length > limite ? linhas[limite - 1].id : null };
  }
  grafo(filtro) { return grafoDesktop(this.db,filtro); }
  carteira(filtro) { return listarConversas(this.db,filtro); }
  conversaDetalhe(filtro) { return detalheConversa(this.db,filtro); }
  contatos(filtro) { return listarContatos(this.db,filtro); }
  contatoDetalhe(filtro) { return detalheContato(this.db,filtro); }
  fontesGrafo(filtro) {
    const r=fontesGrafo(this.db,filtro);
    return {mensagens:r.ids.map(id=>this.fonte(id,{detalhes:false})),proximoAntes:r.proximoAntes};
  }
  fonte(id,{detalhes=true}={}) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Fonte inválida.');
    const transcricao=projecaoTranscricoes(this.db);
    const e = this.db.prepare(`SELECT e.id,e.tipo,e.origem_id,e.conversa_id,e.recebido_em,${transcricao.texto} texto,e.permissao,e.autor_id,e.autor_e_dono,e.origem_compartilhamento,
      COALESCE(g.nome,c.nome,e.conversa_id) conversa_nome FROM desktop_fontes e ${NOMES} ${transcricao.join} WHERE e.id=? AND ${VISIVEL}`).get(id);
    if (!e) throw new Error('Fonte indisponível ou revogada.');
    const nomeVisivel=criarNomeVisivel(this.db);
    return { ...e,conversa_nome:nomeVisivel(e.conversa_nome,e.conversa_id),...qualidadeFonte(this.db,e,{detalhes,colunas:transcricao.colunas}), autor_nome: e.autor_e_dono ? 'Você' : nomeVisivel(null,e.autor_id) };
  }
  conversas() {
    return this.db.prepare(`SELECT c.id,c.nome,COALESCE(p.politica,'so-minhas') politica
      FROM conversas_app c LEFT JOIN politicas_conversa p ON p.conversa_id=c.id ORDER BY c.nome LIMIT 1000`).all();
  }
  politica({ conversa, politica } = {}) {
    if (typeof conversa !== 'string' || !['so-minhas', 'tudo'].includes(politica)) throw new Error('Política inválida.');
    if (!this.db.prepare('SELECT 1 FROM conversas_app WHERE id=?').get(conversa)) throw new Error('Conversa não encontrada.');
    this.db.prepare(`INSERT INTO politicas_conversa VALUES(?,?,?) ON CONFLICT(conversa_id) DO UPDATE SET politica=excluded.politica,atualizado_em=excluded.atualizado_em`)
      .run(conversa, politica, new Date().toISOString());
    return { ok: true };
  }
  resolver({ id } = {}) {
    if (typeof id === 'string') {
      const comando = /^comando:(tarefa|lembrete):([1-9]\d*)$/u.exec(id);
      if (!comando) throw new Error('Tarefa inválida.');
      const registroId = Number(comando[2]);
      if (!Number.isSafeInteger(registroId)) throw new Error('Tarefa inválida.');
      return this.comandosDesktop.resolverEfeito({tipo: comando[1], id: registroId});
    }
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Tarefa inválida.');
    const resultado = this.db.prepare(`UPDATE itens_crm SET estado='resolvido',estado_em=?,estado_motivo='decidido no aplicativo'
      WHERE id=? AND EXISTS (SELECT 1 FROM eventos e WHERE e.conversa_id=itens_crm.conversa_id AND e.origem_id=itens_crm.origem_id AND ${VISIVEL})
      AND NOT EXISTS(SELECT 1 FROM desktop_tarefas_sugestoes s WHERE s.item_id=itens_crm.id AND NOT ${SUGESTAO_ATUAL_SQL})`)
      .run(new Date().toISOString(), id);
    if (!resultado.changes) throw new Error('Tarefa indisponível.');
    return { ok: true };
  }
}
