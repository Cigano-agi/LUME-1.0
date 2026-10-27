import { createHash } from 'node:crypto';
import { LEITURA_SQL,LEITURA_PESSOAL_SQL,leituraFonteSql,fonteLocalIntegra } from '../leitura-sql.js';
import { assinaturaFonte, HASH_FONTE_SQL } from '../tarefas-esquema.js';

const TRECHO_MAX = 1200;
const texto = value => String(value || '').replace(/\b[\w.-]+@(g\.us|s\.whatsapp\.net|lid|c\.us)\b/gi, '[identificador protegido]').slice(0, TRECHO_MAX);
const nomeConversa = row => row.conversa_nome && !/(?:file:\/\/|[\\/]|@(g\.us|s\.whatsapp\.net|lid|c\.us)$)/i.test(row.conversa_nome) ? row.conversa_nome : 'Conversa';
const fonteSelect = `SELECT e.id,e.tipo,e.texto,e.permissao,e.conversa_id,e.origem_id,e.recebido_em,e.dia_local,e.projeto_id,e.origem_compartilhamento,e.autor_id,e.autor_e_dono,e.transcricao_meta,
  COALESCE(g.nome,c.nome) conversa_nome,
  (SELECT i.resumo FROM itens_crm i WHERE i.conversa_id=e.conversa_id AND i.origem_id=e.origem_id AND i.estado='aberto' ORDER BY i.id LIMIT 1) next_step
  FROM desktop_fontes e
  LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function comTempoLocal(db,row){
  if(row.tipo!=='notetaker_trecho')return row;
  const t=db.prepare('SELECT p.posicao,f.inicio_ms,f.fim_ms,f.audio_sha256,f.revisao FROM notetaker_fontes f JOIN notetaker_partes p ON p.id=f.parte_id WHERE f.evento_id=?').get(row.id);
  return t?{...row,source_time_ms:t.posicao*60000+t.inicio_ms,source_end_ms:t.posicao*60000+t.fim_ms,source_audio_sha256:t.audio_sha256,source_revision:t.revisao}:row;
}

function existe(db, tabela) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(tabela));
}

function escopo(scope, args, where) {
  if (scope.kind === 'today') { where.push('e.dia_local=?'); args.push(scope.date); }
  else if (scope.kind === 'projects') {
    if (!scope.ids?.length) { where.push('0'); return; }
    where.push(`e.projeto_id IN (${scope.ids.map(() => '?').join(',')})`); args.push(...scope.ids);
  } else if (scope.kind === 'conversations') {
    if (!scope.ids?.length) { where.push('0'); return; }
    where.push(`e.conversa_id IN (${scope.ids.map(() => '?').join(',')})`); args.push(...scope.ids);
  } else if (scope.kind !== 'all') where.push('0');
}

function periodo({ start, end }, args, where) {
  if (start) { where.push('e.recebido_em>=?'); args.push(start); }
  if (end) { where.push('e.recebido_em<?'); args.push(end); }
}

function pagina(cursor, args, where, alias = 'e') {
  if (!cursor) return;
  where.push(`(${alias}.recebido_em<? OR (${alias}.recebido_em=? AND ${alias}.id<?))`);
  args.push(cursor.at, cursor.at, cursor.id);
}

function resultadoFonte(row, { question = '', anchor = '', offset } = {}) {
  const sourceHash = assinaturaFonte(row);
  const original = String(row.texto || '');
  let inicio = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  if (offset === undefined) {
    const termos = anchor ? [anchor] : question.toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}]{3,}/gu) || [];
    const indices = termos.map(t => original.toLocaleLowerCase('pt-BR').indexOf(t.toLocaleLowerCase('pt-BR'))).filter(i => i >= 0);
    if (indices.length) inicio = Math.max(0, Math.min(...indices) - 120);
  }
  inicio = Math.min(inicio, Math.max(0, original.length - 1));
  const trecho = texto(original.slice(inicio, inicio + TRECHO_MAX));
  return {
    _id: Number(row.id),
    _hash: sourceHash,
    _kind: 'source',
    _ref: Number(row.id),
    _integrity: hash(['source', sourceHash, row.next_step || null,...(row.tipo==='notetaker_trecho'?[row.source_audio_sha256,row.source_time_ms,row.source_end_ms,row.source_revision]:[])]),
    title: row.tipo==='notetaker_trecho'?'Reunião local':nomeConversa(row),
    summary: trecho,
    excerpt: trecho,
    excerpt_start: inicio,
    excerpt_truncated: inicio > 0 || original.length > TRECHO_MAX,
    conversation: row.tipo==='notetaker_trecho'?'Reunião local':nomeConversa(row),
    author: row.tipo==='notetaker_trecho'?'Autoria não identificada':row.autor_e_dono ? 'Você' : 'Participante',
    occurred_at: row.recebido_em,
    ...(row.tipo==='notetaker_trecho'?{source_type:'reuniao_local',source_time_ms:row.source_time_ms,source_end_ms:row.source_end_ms}:{}),
    ...(row.next_step ? { next_step: texto(row.next_step) } : {})
  };
}

function resultadoPendencia(row) {
  const base = resultadoFonte(row);
  return {
    ...base,
    _kind: 'pending',
    _ref: Number(row.derivado_id),
    _integrity: hash(['pending', base._hash, row.derivado_id, row.item_resumo, row.item_tipo, row.item_estado]),
    _cursor_ref: row.cursor_ref,
    title: row.item_tipo === 'compromisso' ? 'Compromisso' : 'Pendência',
    summary: texto(row.item_resumo)
  };
}
// The MCP grant and LEITURA_SQL remain mandatory. Personal local reading alone
// never widens the external scope; it only recognizes existing durable actions.
function acaoAtualSql(db) {
  const exclusao=existe(db,'pessoal_politicas')?` AND NOT EXISTS(SELECT 1 FROM pessoal_politicas pp WHERE pp.conversa_id=e.conversa_id AND (NOT json_valid(pp.atendimento) OR json_extract(pp.atendimento,'$.excluida')=1))`:'';
  const ignorada=existe(db,'autorizacoes')?` AND NOT EXISTS(SELECT 1 FROM autorizacoes au WHERE au.conversa_id=e.conversa_id AND au.modo='ignorar')`:'';
  return `((EXISTS(SELECT 1 FROM lume_acoes_conversas p WHERE p.conversa_id=e.conversa_id) OR
    (e.permissao<>'compartilhado' AND ${LEITURA_PESSOAL_SQL} AND NOT EXISTS(SELECT 1 FROM f10_procedencias fp WHERE fp.evento_id=e.id)))${exclusao}${ignorada})`;
}

function resultadoAcao(row) {
  const base = resultadoFonte(row, { anchor: row.acao_trecho });
  return { ...base, _kind: 'action', _ref: row.derivado_id, _cursor_ref: row.cursor_ref,
    _integrity: hash(['action', base._hash, row.derivado_id, row.item_resumo, row.item_tipo, row.item_estado, row.acao_trecho, row.acao_responsavel, row.acao_lembrar]),
    action_id: row.derivado_id, state: row.item_estado,
    title: row.item_tipo === 'compromisso' ? 'Compromisso' : 'Pendência', summary: texto(row.item_resumo) };
}

function resultadoNegocio(row) {
  const base = resultadoFonte(row);
  return {
    ...base,
    _kind: 'business',
    _ref: row.derivado_id,
    _integrity: hash(['business', base._hash, row.derivado_id, row.negocio_titulo, row.negocio_etapa, row.valor_centavos, row.proximo_contato, row.negocio_revisao, row.negocio_atualizado_em]),
    title: texto(row.negocio_titulo),
    summary: `${row.negocio_etapa}${row.proximo_contato ? ` · próximo contato ${row.proximo_contato}` : ''}`,
    stage: row.negocio_etapa,
    value_cents: row.valor_centavos,
    next_contact: row.proximo_contato
  };
}

export class LumeMcpReadService {
  constructor(db) { this.db = db; }

  fontes({ scope, start, end, date, question = '', projectNames = [], conversationNames = [], cursor, limit }) {
    const where = [leituraFonteSql(this.db), "e.texto IS NOT NULL AND trim(e.texto)<>''"], args = [];
    escopo(scope, args, where); periodo({ start, end }, args, where);
    if (date) { where.push('e.dia_local=?'); args.push(date); }
    if (question.trim()) {
      const termos = [...new Set(question.toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}]{3,}/gu) || [])].slice(0, 8);
      if (termos.length) { where.push(`(${termos.map(() => 'instr(lower(e.texto),?)>0').join(' OR ')})`); args.push(...termos); }
      else { where.push('instr(lower(e.texto),?)>0'); args.push(question.trim().toLocaleLowerCase('pt-BR')); }
    }
    if (projectNames.length) { where.push(`e.projeto_id IN (SELECT id FROM projetos WHERE nome IN (${projectNames.map(() => '?').join(',')}))`); args.push(...projectNames); }
    if (conversationNames.length) { where.push(`COALESCE(g.nome,c.nome) IN (${conversationNames.map(() => '?').join(',')})`); args.push(...conversationNames); }
    pagina(cursor, args, where);
    const rows=[],cache=new Map(),batch=Math.max(16,Math.min(200,limit+1));
    let after=null;
    while(rows.length<=limit){
      const extra=after?' AND (e.recebido_em<? OR (e.recebido_em=? AND e.id<?))':'';
      const values=after?[after.recebido_em,after.recebido_em,after.id]:[];
      const page=this.db.prepare(`${fonteSelect} WHERE ${where.join(' AND ')}${extra} ORDER BY e.recebido_em DESC,e.id DESC LIMIT ?`).all(...args,...values,batch);
      for(const row of page)if(fonteLocalIntegra(this.db,row,cache))rows.push(row);
      if(page.length<batch)break;
      after=page.at(-1);
    }
    return { rows: rows.slice(0, limit).map(row => resultadoFonte(comTempoLocal(this.db,row), { question })), more: rows.length > limit };
  }

  fonte(id, scope, trecho = {}) {
    const where = [leituraFonteSql(this.db), 'e.id=?'], args = [id]; escopo(scope, args, where);
    const row = this.db.prepare(`${fonteSelect} WHERE ${where.join(' AND ')}`).get(...args);
    return row&&fonteLocalIntegra(this.db,row) ? resultadoFonte(comTempoLocal(this.db,row), trecho) : null;
  }

  revalidar(row, scope) {
    if (!row || !Number.isSafeInteger(row._id) || typeof row._integrity !== 'string') return false;
    if (row._kind === 'source') return this.fonte(row._id, scope)?._integrity === row._integrity;
    const where = [LEITURA_SQL, 'e.id=?'], args = [row._id]; escopo(scope, args, where);
    if (row._kind === 'pending') {
      if (!Number.isSafeInteger(row._ref) || !existe(this.db, 'itens_crm')) return false;
      where.push('i.id=?'); args.push(row._ref);
      const atual = this.db.prepare(`SELECT e.*,COALESCE(g.nome,c.nome) conversa_nome,i.id derivado_id,i.resumo item_resumo,i.tipo item_tipo,i.estado item_estado
        FROM itens_crm i JOIN desktop_fontes e ON e.conversa_id=i.conversa_id AND e.origem_id=i.origem_id
        LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id
        WHERE ${where.join(' AND ')}`).get(...args);
      return Boolean(atual && resultadoPendencia(atual)._integrity === row._integrity);
    }
    if (row._kind === 'action') {
      if (typeof row._ref !== 'string' || !existe(this.db, 'lume_acoes')) return false;
      where.push('a.id=?', `a.fonte_assinatura=${HASH_FONTE_SQL}`,acaoAtualSql(this.db)); args.push(row._ref);
      const atual = this.db.prepare(`SELECT e.*,COALESCE(g.nome,c.nome) conversa_nome,a.id derivado_id,a.resumo item_resumo,a.tipo item_tipo,a.estado item_estado,a.trecho acao_trecho,a.responsavel_id acao_responsavel,a.lembrar_em acao_lembrar
        FROM lume_acoes a JOIN desktop_fontes e ON e.id=a.evento_id
        LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE ${where.join(' AND ')}`).get(...args);
      return Boolean(atual && resultadoAcao(atual)._integrity === row._integrity);
    }
    if (row._kind === 'business') {
      if (typeof row._ref !== 'string' || !existe(this.db, 'desktop_negocios')) return false;
      where.push('n.id=?', `n.assinatura=${HASH_FONTE_SQL}`); args.push(row._ref);
      const atual = this.db.prepare(`SELECT e.*,COALESCE(g.nome,c.nome) conversa_nome,n.id derivado_id,n.titulo negocio_titulo,n.etapa negocio_etapa,n.valor_centavos,n.proximo_contato,n.revisao negocio_revisao,n.atualizado_em negocio_atualizado_em
        FROM desktop_negocios n JOIN desktop_fontes e ON e.id=n.evento_id
        LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id
        WHERE ${where.join(' AND ')}`).get(...args);
      return Boolean(atual && resultadoNegocio(atual)._integrity === row._integrity);
    }
    return false;
  }

  pendencias({ scope, state, start, end, cursor, limit }) {
    const partes = [], args = [];
    for (const kind of ['crm', 'action']) {
      if (!existe(this.db, kind === 'crm' ? 'itens_crm' : 'lume_acoes')) continue;
      const where = [LEITURA_SQL], values = []; escopo(scope, values, where); periodo({ start, end }, values, where);
      const joins = 'LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id';
      if (kind === 'crm') {
        where.push('i.estado=?'); values.push(state);
        partes.push(`SELECT e.*,COALESCE(g.nome,c.nome) conversa_nome,i.id derivado_id,i.resumo item_resumo,i.tipo item_tipo,i.estado item_estado,NULL acao_trecho,NULL acao_responsavel,NULL acao_lembrar,'crm' tipo_derivado,printf('c:%020d',i.id) cursor_ref
          FROM itens_crm i JOIN desktop_fontes e ON e.conversa_id=i.conversa_id AND e.origem_id=i.origem_id ${joins} WHERE ${where.join(' AND ')}`);
      } else {
        where.push(`a.fonte_assinatura=${HASH_FONTE_SQL}`,acaoAtualSql(this.db), state === 'resolvido' ? "a.estado='resolvido'" : "a.estado IN ('sugerido','confirmado','estacionado')");
        partes.push(`SELECT e.*,COALESCE(g.nome,c.nome) conversa_nome,a.id derivado_id,a.resumo item_resumo,a.tipo item_tipo,a.estado item_estado,a.trecho acao_trecho,a.responsavel_id acao_responsavel,a.lembrar_em acao_lembrar,'action' tipo_derivado,'a:'||a.id cursor_ref
          FROM lume_acoes a JOIN desktop_fontes e ON e.id=a.evento_id ${joins} WHERE ${where.join(' AND ')}`);
      }
      args.push(...values);
    }
    if (!partes.length) return { rows: [], more: false };
    let pagina = '';
    if (cursor) {
      pagina = 'WHERE (recebido_em<? OR (recebido_em=? AND id<?) OR (recebido_em=? AND id=? AND cursor_ref<?))';
      args.push(cursor.at, cursor.at, cursor.id, cursor.at, cursor.id, cursor.ref || '');
    }
    const rows = this.db.prepare(`SELECT * FROM (${partes.join(' UNION ALL ')}) ${pagina} ORDER BY recebido_em DESC,id DESC,cursor_ref DESC LIMIT ?`).all(...args, limit + 1);
    return { rows: rows.slice(0, limit).map(row => row.tipo_derivado === 'action' ? resultadoAcao(row) : resultadoPendencia(row)), more: rows.length > limit };
  }

  negocios({ scope, stage, nextContactBefore, cursor, limit }) {
    if (!existe(this.db, 'desktop_negocios')) return { rows: [], more: false };
    const where = [LEITURA_SQL, `n.assinatura=${HASH_FONTE_SQL}`], args = []; escopo(scope, args, where);
    if (stage) { where.push('n.etapa=?'); args.push(stage); }
    if (nextContactBefore) { where.push('n.proximo_contato IS NOT NULL AND n.proximo_contato<=?'); args.push(nextContactBefore); }
    pagina(cursor, args, where);
    const rows = this.db.prepare(`SELECT e.*,COALESCE(g.nome,c.nome) conversa_nome,n.id derivado_id,n.titulo negocio_titulo,n.etapa negocio_etapa,n.valor_centavos,n.proximo_contato,n.revisao negocio_revisao,n.atualizado_em negocio_atualizado_em
      FROM desktop_negocios n JOIN desktop_fontes e ON e.id=n.evento_id
      LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id
      WHERE ${where.join(' AND ')} ORDER BY e.recebido_em DESC,e.id DESC LIMIT ?`).all(...args, limit + 1);
    return { rows: rows.slice(0, limit).map(resultadoNegocio), more: rows.length > limit };
  }
}
