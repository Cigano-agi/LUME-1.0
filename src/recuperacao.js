import { diaLocal } from './relogio.js';
import { LEITURA_SQL, PROJETO_SQL } from './leitura-sql.js';
import { unidadesConsulta, trechoRelevante } from './trechos-recuperacao.js';
import {prepararIndiceFontes} from './fontes-desktop.js';
export { LEITURA_SQL } from './leitura-sql.js';
export const IA_SQL = `EXISTS (SELECT 1 FROM desktop_ia_conversas a WHERE a.conversa_id=e.conversa_id AND a.permitida=1)`;

export function prepararRecuperacao(db) { prepararIndiceFontes(db); }

export function recorte({ pergunta, conversa = '', projeto = '', periodo = 'semana' } = {}, agora = new Date()) {
  if (typeof pergunta !== 'string' || !pergunta.trim() || pergunta.length > 600) throw new Error('Escreva uma pergunta de até 600 caracteres.');
  if (typeof conversa !== 'string' || conversa.length > 200 || typeof projeto !== 'string' || projeto.length > 200) throw new Error('Recorte inválido.');
  if (!['hoje','ontem','semana','30dias','tudo'].includes(periodo)) throw new Error('Escolha um período válido.');
  const hoje = diaLocal(agora);
  const base = new Date(hoje + 'T12:00:00Z');
  let desde = null, ate = hoje;
  if (periodo === 'hoje') desde = hoje;
  if (periodo === 'ontem') { base.setUTCDate(base.getUTCDate() - 1); desde = ate = base.toISOString().slice(0,10); }
  if (periodo === 'semana') { base.setUTCDate(base.getUTCDate() - (base.getUTCDay() + 6) % 7); desde = base.toISOString().slice(0,10); }
  if (periodo === '30dias') { base.setUTCDate(base.getUTCDate() - 29); desde = base.toISOString().slice(0,10); }
  return { pergunta: pergunta.trim(), conversa, projeto, periodo, desde, ate, fuso: 'America/Sao_Paulo' };
}

export function recuperar(db, filtro, { limite = 12, remoto = true } = {}) {
  const where = [LEITURA_SQL, "e.texto IS NOT NULL AND trim(e.texto)<>''", 'e.dia_local<=?'];
  const args = [filtro.ate];
  if (remoto) where.push(IA_SQL);
  if (filtro.desde) { where.push('e.dia_local>=?'); args.push(filtro.desde); }
  if (filtro.conversa) { where.push('e.conversa_id=?'); args.push(filtro.conversa); }
  if (filtro.projeto) { where.push(PROJETO_SQL); args.push(filtro.projeto,filtro.projeto,filtro.projeto); }
  const units = unidadesConsulta(filtro.pergunta);
  const select = `SELECT e.id,e.conversa_id,e.origem_id,e.texto,e.transcricao_meta,e.recebido_em,e.permissao,e.projeto_id,e.origem_compartilhamento,e.autor_id,e.autor_e_dono,
    CASE WHEN e.autor_e_dono=1 THEN 'Você' ELSE COALESCE(e.autor_id,'Não identificado') END autor_nome,
    COALESCE(g.nome,c.nome,e.conversa_id) conversa_nome FROM desktop_fontes e
    LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id`;
  const order = 'ORDER BY e.recebido_em DESC,e.id DESC LIMIT ?';
  const rows = !units.length ? db.prepare(`${select} WHERE ${where.join(' AND ')} ${order}`).all(...args,limite)
    : db.prepare(`${select} JOIN desktop_fontes_fts f ON f.rowid=e.id WHERE desktop_fontes_fts MATCH ? AND ${where.join(' AND ')}
      ORDER BY bm25(desktop_fontes_fts),e.recebido_em DESC LIMIT ?`).all(units.map(u => '"' + u.tokens.join(' ') + '"').join(' OR '),...args,limite);
  return rows.map(e=>({...e,...trechoRelevante(e.texto,units)}));
}
