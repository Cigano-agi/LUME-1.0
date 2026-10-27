import { constants, lstatSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { decodificarAcervoV9, decodificarAcervoV10 } from './backup-acervo-codec.js';
import { CATALOGO_SHA256_V9, TABELAS_I_V9 } from './backup-acervo-catalogo.js';
import { CATALOGO_SHA256_V10, CATALOGO_SHA256_V10_MIDIAS, CATALOGO_SHA256_V10_LEGADO, TABELAS_I_V10, TABELAS_I_V10_MIDIAS, TABELAS_I_V10_LEGADO } from './backup-acervo-catalogo-v10.js';
import { verificarPacote } from './backup-stream.js';
import { prepararEsquemaRestoreV9Gerido, auditarEsquemaRestoreV9 } from './backup-acervo-schema-v9.js';
import { criarAreaStagingV9, conferirObjetoStagingV9, registrarObjetoStagingV9, limparAreaStagingV9, recuperarAreasStagingV9 } from './backup-staging-v9.js';
import { chaveConversa, chaveExclusao } from './exclusoes.js';
import { tratarTranscricao, validarRespostasTranscricao } from './qualidade-transcricao.js';
import { validarMetadadosAudio } from './audio-desktop-arquivos.js';
import { fingerprint } from './compartilhamento.js';
import { normalizarTag } from './comandos-whatsapp.js';
import { CICLO_COLUNAS, cicloRegistroId } from './privacidade.js';
import { assinaturaFonteCiclo } from './ciclo-captura.js';
import { MAX_AUDIO_DOWNLOAD } from './audio-whatsapp.js';
import { EXT_MIDIA_CICLO } from './ciclo-midia-worker.js';
import { hashArquivoV10, publicarAcervoV10 } from './backup-acervo-apply-v10.js';
import { setImmediate as nextTurn } from 'node:timers/promises';

const NOFOLLOW = constants.O_NOFOLLOW || 0;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const pending = new Map(); // somente planos, nunca linhas do acervo
const failed = new Set(); // capacidades locais com limpeza pendente
const MAX_FAILED = 8;
let inflight = 0;
const inflightRoots = new Set();
const FIVE_MINUTES = 5 * 60 * 1000;
const q = s => `"${s.replaceAll('"', '""')}"`;
const hash = value => createHash('sha256').update(value).digest('hex');
const rootKey = value => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
function fail(code, fase, detalhe = code) { const e = new Error(detalhe); e.code = code; e.fase = fase; throw e; }
function abort(signal) { if (signal?.aborted) fail('RESTORE_CANCELADO', 'cancelamento'); }
function same(a,b) { return a && b && a.dev === b.dev && a.ino === b.ino && !b.isSymbolicLink(); }
function sameFile(a,b) { return same(a,b) && a.size === b.size && a.mtimeMs === b.mtimeMs; }

async function safePath(p, type) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p) fail('CAMINHO_INVALIDO', 'staging');
  let current = path.parse(p).root;
  for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = await lstat(current, { bigint: true });
    if (st.isSymbolicLink()) fail('CAMINHO_INVALIDO', 'staging');
    if (current !== p && !st.isDirectory()) fail('CAMINHO_INVALIDO', 'staging');
    if (current === p && ((type === 'file' && !st.isFile()) || (type === 'dir' && !st.isDirectory()))) fail('CAMINHO_INVALIDO', 'staging');
  }
}

function conferirSqlite(area, fechamentoFinal = false) {
  conferirObjetoStagingV9(area, path.join(area.caminho, 'acervo.sqlite'));
  for (const name of ['acervo.sqlite-wal', 'acervo.sqlite-shm'])
    conferirObjetoStagingV9(area, path.join(area.caminho, name), { permitirAusente: fechamentoFinal });
}

async function limpar(area) {
  const recibo = await limparAreaStagingV9(area);
  if (recibo.limpezaPendente) failed.add(area);
  else {
    failed.delete(area);
    for (const [token, state] of pending) if (state.area === area && state.descartado) pending.delete(token);
  }
  return recibo;
}

async function prepararRaiz(raizStaging) {
  const mesmaRaiz = area => rootKey(path.dirname(area.caminho)) === rootKey(raizStaging);
  for (const area of [...failed]) if (mesmaRaiz(area)) await limpar(area);
  if (failed.size >= MAX_FAILED || [...failed].some(mesmaRaiz)) {
    const e = new Error('LIMPEZA_PENDENTE'); e.code = 'LIMPEZA_PENDENTE'; e.fase = 'staging';
    e.limpezaPendente = true; e.codigosLimpeza = ['LIMPEZA_PENDENTE']; throw e;
  }
  const recibo = await recuperarAreasStagingV9({ raizStaging });
  if (recibo.codigos.some(code => code !== 'AREA_EM_USO')) {
    const e = new Error('LIMPEZA_PENDENTE'); e.code = 'LIMPEZA_PENDENTE'; e.fase = 'staging';
    e.limpezaPendente = true; e.codigosLimpeza = recibo.codigos; throw e;
  }
}
const intPattern = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;
function cell(tag) {
  if (!Array.isArray(tag) || !Object.hasOwn(tag, 0) || (tag.length !== 1 && tag.length !== 2)) fail('TIPO_INVALIDO', 'row');
  switch (tag[0]) {
    case 'n': if (tag.length === 1) return { value: null, type: 'null' }; break;
    case 'i': {
      if (tag.length !== 2 || typeof tag[1] !== 'string' || tag[1].length > 20 || !intPattern.test(tag[1])) break;
      const x = BigInt(tag[1]);
      if (x < -(1n << 63n) || x > (1n << 63n) - 1n) break;
      return { value: x, type: 'integer' };
    }
    case 'r': if (tag.length === 2 && typeof tag[1] === 'number' && Number.isFinite(tag[1])) return { value: tag[1], type: 'real' }; break;
    case 't': if (tag.length === 2 && typeof tag[1] === 'string' && tag[1].isWellFormed()) return { value: tag[1], type: 'text' }; break;
    case 'b': {
      if (tag.length !== 2 || typeof tag[1] !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(tag[1])) break;
      const b = Buffer.from(tag[1], 'base64');
      if (b.toString('base64') === tag[1]) return { value: b, type: 'blob' };
      break;
    }
  }
  fail('TIPO_INVALIDO', 'row');
}

function parseRow(payload, table, ordinal, chave) {
  let raw; try { raw = utf8.decode(payload); } catch { fail('ROW_INVALIDA', 'row'); }
  let obj; try { obj = JSON.parse(raw); } catch { fail('ROW_INVALIDA', 'row'); }
  if (!obj || Object.getPrototypeOf(obj) !== Object.prototype || Object.keys(obj).length !== 1 || !Object.hasOwn(obj,'v') ||
      !Array.isArray(obj.v) || obj.v.length !== table.colunas.length || JSON.stringify(obj) !== raw) fail('ROW_INVALIDA', 'row');
  const cells = obj.v.map(cell);
  for (let i=0; i<table.colunas.length; i++) {
    const name = table.colunas[i];
    if (cells[i].type === 'text' && /^(?:id|hash|fingerprint|chave|nome|nome_exibido|nome_higienizado|origem_compartilhamento|arquivo|caminho)$|_id$/.test(name) &&
        /[\x00-\x1f\x7f]/.test(cells[i].value)) fail('DOMINIO_INVALIDO','row',`Controle em identificador/nome: ${table.nome}.${name}`);
  }
  const pk = table.pk.map(name => obj.v[table.colunas.indexOf(name)]);
  if (pk.some(v => v[0] === 'n')) fail('PK_INVALIDA', 'row');
  const expected = `${String(ordinal).padStart(10, '0')}:${hash(JSON.stringify(pk))}`;
  if (chave !== expected) fail('PK_INVALIDA', 'row');
  return cells;
}

function load(db, table) {
  const names = table.colunas.map(q).join(',');
  const values = table.colunas.map(() => '?').join(',');
  const returned = table.colunas.map(c => `typeof(${q(c)}) AS ${q(c)}`).join(',');
  const pk = table.pk.map((c,i) => `${q(c)} AS ${q(`__pk${i}`)}`).join(',');
  const statement = db.prepare(`INSERT INTO ${q(table.nome)}(${names}) VALUES(${values}) RETURNING ${returned},${pk}`);
  statement.setReadBigInts(true);
  return statement;
}

const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const date = x => typeof x === 'string' && Number.isFinite(Date.parse(x));
const string = (x,max) => typeof x === 'string' && x.length > 0 && x.length <= max;
const day = x => typeof x === 'string' && /^\d{4}-\d\d-\d\d$/.test(x);
const businessDay = x => day(x) && x >= '2000-01-01' && x <= '2100-12-31' &&
  Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x;
const exists = (db,sql,...args) => Boolean(db.prepare(sql).get(...args));
const bad = family => fail('SEMANTICA_INVALIDA', family);
// node:sqlite converte INTEGER para Number por padrão e lança em IDs int64 altos.
// A conversão só ocorre para valores comprovadamente seguros, por linha.
function* rows(db, sql) {
  const statement = db.prepare(sql); statement.setReadBigInts(true);
  for (const original of statement.iterate()) {
    const row = Object.create(null);
    for (const [key,value] of Object.entries(original)) row[key] = typeof value === 'bigint' &&
      value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
    yield row;
  }
}
async function* rowsAsync(db,sql,signal) {
  let count = 0;
  for (const row of rows(db,sql)) {
    abort(signal);
    if ((++count & 511) === 0) { await nextTurn(); abort(signal); }
    yield row;
  }
}

async function validateSpending(db,signal) {
  for await (const r of rowsAsync(db,'SELECT * FROM desktop_ia_gastos',signal)) {
    abort(signal);
    if (!string(r.id,200) || !Number.isSafeInteger(r.reservado_micros) || r.reservado_micros < 0 || !day(r.dia) ||
        !['reservado','concluido','incerto'].includes(r.estado)) bad('desktop_ia_gastos');
  }
}

async function validateTranscriptions(db,signal,fileMetas=[]) {
  const source = db.prepare('SELECT 1 FROM eventos WHERE conversa_id=? AND origem_id=?');
  const seen = new Set();
  for await (const r of rowsAsync(db,'SELECT * FROM transcricoes',signal)) {
    abort(signal);
    if (r.arquivo !== null && r.arquivo !== '') {
      const match = /^anexo:([1-9]\d*)$/.exec(r.arquivo);
      const id = match && Number(match[1]);
      const meta = fileMetas[id - 1];
      if (!meta || meta.id !== id || meta.classe !== 'transcricao' || seen.has(id)) fail('ANEXO_REFERENCIA_INVALIDA','transcricoes');
      seen.add(id);
      if (r.audio_metadados_json !== null) {
        let audio; try { audio = JSON.parse(r.audio_metadados_json); } catch { bad('transcricoes'); }
        if (audio.audioSha256 !== meta.sha256) fail('ANEXO_HASH_DIVERGENTE','transcricoes');
      }
    }
    if (r.audio_metadados_json !== null) {
      if (typeof r.audio_metadados_json !== 'string' || Buffer.byteLength(r.audio_metadados_json) > 1024*1024) bad('transcricoes');
      let metadata; try { metadata = JSON.parse(r.audio_metadados_json); validarMetadadosAudio(metadata); } catch { bad('transcricoes'); }
      if (r.modelo !== `whisper.cpp/${metadata.versaoMotor}` ||
          metadata.fonte.conversaId !== r.conversa_id || metadata.fonte.origemId !== r.origem_id ||
          !source.get(r.conversa_id,r.origem_id) ||
          (metadata.trechos.length ? metadata.trechos.map(t => t.texto.trim()).join(' ') : '(sem fala)') !== r.texto_original) bad('transcricoes');
    }
    if (r.texto_original === null) { if (r.respostas_json !== null) bad('transcricoes'); continue; }
    let answers; try { answers = JSON.parse(r.respostas_json); } catch { bad('transcricoes'); }
    if (typeof r.texto_original !== 'string' || !validarRespostasTranscricao(answers) ||
        answers.at(-1).textoOriginal !== r.texto_original || r.texto !== (r.estado === 'erro' ? null : tratarTranscricao(r.texto_original))) bad('transcricoes');
  }
  return seen;
}

async function validateCicloMidias(db,signal,fileMetas=[]){
  const seen=new Set();
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ciclo_midias'").get())return seen;
  const source=db.prepare('SELECT tipo,permissao FROM eventos WHERE id=?');
  const etapa=db.prepare("SELECT estado,resultado FROM etapas WHERE evento_id=? AND etapa='midia'");
  for await(const r of rowsAsync(db,'SELECT * FROM ciclo_midias',signal)){
    abort(signal);
    const match=typeof r.caminho==='string'&&/^anexo:([1-9]\d*)$/.exec(r.caminho);
    const id=match&&Number(match[1]),meta=fileMetas[id-1],evento=source.get(r.evento_id);
    if(!Number.isSafeInteger(r.evento_id)||r.evento_id<1||!meta||meta.id!==id||
      meta.classe!=='ciclo_midia'||seen.has(id)||!evento||evento.tipo!=='audio'||
      evento.permissao==='compartilhado'||r.sha256!==meta.sha256||r.tamanho!==meta.bytes||
      !Object.hasOwn(EXT_MIDIA_CICLO,r.mime)||!Number.isSafeInteger(r.tamanho)||
      r.tamanho<1||r.tamanho>MAX_AUDIO_DOWNLOAD||!date(r.criado_em))bad('ciclo_midias');
    const stage=etapa.get(r.evento_id);
    let receipt;try{receipt=JSON.parse(stage?.resultado);}catch{bad('ciclo_midias');}
    if(stage?.estado!=='concluida'||receipt?.resultado?.sha256!==r.sha256||receipt?.resultado?.mime!==r.mime||
      receipt?.resultado?.tamanho!==r.tamanho)bad('ciclo_midias');
    seen.add(id);
  }
  return seen;
}

async function validateTasks(db,signal) {
  for await (const a of rowsAsync(db,'SELECT * FROM desktop_tarefas_analises',signal)) {
    abort(signal);
    if (!sha(a.assinatura) || !date(a.analisado_em) || !exists(db,'SELECT 1 FROM eventos WHERE id=?',a.evento_id)) bad('desktop_tarefas_analises');
  }
  for await (const l of rowsAsync(db,'SELECT * FROM desktop_tarefas_lotes',signal)) {
    abort(signal);
    if (!string(l.id,200) || !day(l.dia) || !['manual','automatico'].includes(l.modo) ||
        !['iniciado','concluido','incerto'].includes(l.estado) || !date(l.criado_em) || l.terminado_em !== null && !date(l.terminado_em)) bad('desktop_tarefas_lotes');
  }
  const source = db.prepare('SELECT conversa_id,origem_id FROM eventos WHERE id=?');
  const item = db.prepare('SELECT conversa_id,origem_id,tipo FROM itens_crm WHERE id=?');
  const tally = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN evento_id=? THEN 1 ELSE 0 END) principal FROM desktop_tarefas_fontes WHERE sugestao_id=?');
  for await (const s of rowsAsync(db,'SELECT * FROM desktop_tarefas_sugestoes',signal)) {
    abort(signal);
    const e = source.get(s.evento_id), i = s.item_id === null ? null : item.get(s.item_id);
    const c = tally.get(s.evento_id,s.id);
    if (!string(s.id,200) || !e || !['compromisso','pendencia'].includes(s.tipo) || !string(s.resumo,500) ||
        !string(s.trecho,1800) || s.trecho.trim().length < 8 || typeof s.prazo_citado !== 'string' || s.prazo_citado.length > 200 ||
        !Number.isInteger(s.fontes_total) || s.fontes_total < 1 || s.fontes_total > 48 || !['pendente','aceita','descartada'].includes(s.estado) ||
        !date(s.criada_em) || s.revisada_em !== null && !date(s.revisada_em) ||
        s.item_id !== null && (!i || s.estado !== 'aceita' || i.conversa_id !== e.conversa_id || i.origem_id !== e.origem_id || i.tipo !== s.tipo) ||
        c.n !== s.fontes_total || c.principal !== 1) bad('desktop_tarefas_sugestoes');
  }
  for await (const f of rowsAsync(db,'SELECT * FROM desktop_tarefas_fontes',signal)) {
    abort(signal);
    const e = source.get(f.evento_id), s = db.prepare('SELECT evento_id FROM desktop_tarefas_sugestoes WHERE id=?').get(f.sugestao_id);
    const origin = s && source.get(s.evento_id);
    if (!sha(f.assinatura) || !e || !origin || e.conversa_id !== origin.conversa_id) bad('desktop_tarefas_fontes');
  }
}

async function validateBusinesses(db,signal) {
  const validFields = x => string(x.titulo,160) && x.titulo.trim() && !/[\x00-\x1f]/.test(x.titulo) &&
    ['interesse','proposta','conversa','fechado','encerrado'].includes(x.etapa) &&
    (x.valor_centavos === null || Number.isSafeInteger(x.valor_centavos) && x.valor_centavos >= 0 && x.valor_centavos <= 99999999999) &&
    (x.proximo_contato === null || businessDay(x.proximo_contato)) &&
    (!['fechado','encerrado'].includes(x.etapa) || x.proximo_contato === null);
  const last = db.prepare('SELECT * FROM desktop_negocios_historico WHERE negocio_id=? ORDER BY revisao DESC LIMIT 1');
  const gaps = db.prepare(`SELECT 1 FROM (SELECT revisao,LAG(revisao) OVER(ORDER BY revisao) prev FROM desktop_negocios_historico WHERE negocio_id=?) WHERE prev IS NOT NULL AND revisao<>prev+1 LIMIT 1`);
  for await (const n of rowsAsync(db,'SELECT * FROM desktop_negocios',signal)) {
    abort(signal);
    const h = last.get(n.id);
    if (!validFields(n) || !/^[a-f0-9-]{36}$/.test(n.id) || !sha(n.assinatura) || !Number.isSafeInteger(n.revisao) || n.revisao < 1 ||
        !date(n.criado_em) || !date(n.atualizado_em) || !exists(db,'SELECT 1 FROM eventos WHERE id=?',n.evento_id) ||
        !h || h.revisao !== n.revisao || h.confirmado_em !== n.atualizado_em ||
        ['titulo','etapa','valor_centavos','proximo_contato'].some(c => h[c] !== n[c]) || gaps.get(n.id)) bad('desktop_negocios');
  }
  for await (const h of rowsAsync(db,'SELECT * FROM desktop_negocios_historico',signal)) {
    abort(signal);
    if (!validFields(h) || !Number.isSafeInteger(h.revisao) || h.revisao < 1 || !date(h.confirmado_em) ||
        !exists(db,'SELECT 1 FROM desktop_negocios WHERE id=?',h.negocio_id)) bad('desktop_negocios_historico');
  }
}

async function validateF10(db,signal) {
  const revoked = db.prepare('SELECT 1 FROM f10_revogadas WHERE fingerprint=?');
  for await (const o of rowsAsync(db,'SELECT * FROM f10_origens',signal)) {
    abort(signal);
    let calculated; try { calculated = fingerprint(o.chave_publica); } catch { bad('f10_origens'); }
    if (!sha(o.fingerprint) || calculated !== o.fingerprint || revoked.get(o.fingerprint)) bad('f10_origens');
  }
  for await (const p of rowsAsync(db,'SELECT * FROM f10_procedencias',signal)) {
    abort(signal);
    if (!date(p.exportado_em) || !date(p.importado_em) || revoked.get(p.fingerprint)) bad('f10_procedencias');
  }
  for await (const r of rowsAsync(db,'SELECT * FROM f10_recebidos',signal)) {
    abort(signal);
    if (!sha(r.digest) || !date(r.recebido_em) || revoked.get(r.fingerprint) ||
        !exists(db,'SELECT 1 FROM f10_origens WHERE fingerprint=?',r.fingerprint)) bad('f10_recebidos');
  }
}

async function validateCommands(db,signal) {
  const cmd = db.prepare('SELECT conversa_id,origem_id FROM lume_comandos WHERE id=?');
  const event = db.prepare('SELECT conversa_id,origem_id,autor_e_dono,permissao FROM eventos WHERE id=?');
  for await (const c of rowsAsync(db,'SELECT * FROM lume_comandos',signal)) {
    abort(signal);
    const e = event.get(c.evento_id);
    if (!Number.isSafeInteger(c.id) || c.id < 1 || !Number.isSafeInteger(c.evento_id) || c.evento_id < 1 ||
        !string(c.idempotencia,4096) || !string(c.contrato,4096) ||
        !string(c.conversa_id,4096) || !string(c.origem_id,4096) ||
        !['feito','revisar','nao_reconhecido','nao_executado','origem_removida'].includes(c.estado) ||
        !string(c.motivo,4096) || !date(c.criado_em) || !date(c.atualizado_em) || !e ||
        e.conversa_id !== c.conversa_id || e.origem_id !== c.origem_id || !e.autor_e_dono || e.permissao !== 'minha') bad('lume_comandos');
    try { if (c.resultado_json !== null) JSON.parse(c.resultado_json); } catch { bad('lume_comandos'); }
  }
  for await (const t of rowsAsync(db,'SELECT * FROM lume_tags',signal)) {
    abort(signal);
    let normalized; try { normalized = normalizarTag(t.nome_exibido); } catch { bad('lume_tags'); }
    if (!Number.isSafeInteger(t.id) || t.id < 1 || !normalized.valida || normalized.chave !== t.chave || !date(t.criada_em)) bad('lume_tags');
  }
  for await (const e of rowsAsync(db,'SELECT * FROM lume_tags_entidades',signal)) {
    abort(signal);
    const c = cmd.get(e.comando_id);
    if (!exists(db,'SELECT 1 FROM lume_tags WHERE id=?',e.tag_id) || !c ||
        !['mensagem','conversa','contato','tarefa','lembrete','negocio'].includes(e.entidade_tipo) ||
        !string(e.entidade_id,4096) || e.conversa_id !== c.conversa_id || e.origem_id !== c.origem_id ||
        !['comando_local','interface','externa'].includes(e.procedencia) || !['ativa','revisar','origem_removida'].includes(e.estado) ||
        !date(e.criada_em)) bad('lume_tags_entidades');
  }
  for (const [table, states] of [['lume_comando_tarefas',['aberta','concluida','revisar','origem_removida']],
                                  ['lume_comando_lembretes',['agendado','concluido','revisar','origem_removida']]]) {
    for await (const item of rowsAsync(db,`SELECT * FROM ${q(table)}`,signal)) {
      abort(signal);
      const c = cmd.get(item.comando_id);
      if (!Number.isSafeInteger(item.id) || item.id < 1 || !c || !string(item.texto,4*1024*1024) ||
          item.conversa_id !== c.conversa_id || item.origem_id !== c.origem_id || !states.includes(item.estado) || !date(item.criada_em) ||
          table === 'lume_comando_lembretes' && (typeof item.prazo_local !== 'string' || !date(item.prazo_utc) || !string(item.fuso,200))) bad(table);
    }
    if (exists(db,`SELECT 1 FROM ${q(table)} GROUP BY comando_id HAVING COUNT(*)>1 LIMIT 1`)) bad(table);
  }
}

async function validateLabels(db,signal) {
  const text = (v,max=200) => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v;
  const bit = v => v === 0 || v === 1;
  db.exec(`CREATE TEMP TABLE _restore_labels AS SELECT * FROM whatsapp_labels WHERE 0;
    CREATE UNIQUE INDEX _restore_labels_pk ON _restore_labels(conta_id,label_id);
    CREATE TEMP TABLE _restore_assocs AS SELECT * FROM whatsapp_label_associacoes WHERE 0;
    CREATE UNIQUE INDEX _restore_assocs_pk ON _restore_assocs(conta_id,conversa_id,message_id,label_id);`);
  const oldLabel = db.prepare('SELECT * FROM _restore_labels WHERE conta_id=? AND label_id=?');
  const oldAssoc = db.prepare('SELECT * FROM _restore_assocs WHERE conta_id=? AND conversa_id=? AND message_id=? AND label_id=?');
  const insertLabel = db.prepare(`INSERT INTO _restore_labels(conta_id,label_id,nome,cor,predefined_id,removida,conflito,primeira_observacao_id,ultima_observacao_id)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(conta_id,label_id) DO UPDATE SET nome=excluded.nome,cor=excluded.cor,predefined_id=excluded.predefined_id,
    removida=excluded.removida,conflito=excluded.conflito,ultima_observacao_id=excluded.ultima_observacao_id`);
  const insertAssoc = db.prepare(`INSERT INTO _restore_assocs(conta_id,conversa_id,message_id,label_id,viu_adicao,viu_remocao,conflito,primeira_observacao_id,ultima_observacao_id)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(conta_id,conversa_id,message_id,label_id) DO UPDATE SET viu_adicao=excluded.viu_adicao,
    viu_remocao=excluded.viu_remocao,conflito=excluded.conflito,ultima_observacao_id=excluded.ultima_observacao_id`);
  for await (const r of rowsAsync(db,'SELECT * FROM whatsapp_label_observacoes ORDER BY id',signal)) {
    abort(signal);
    const common = Number.isSafeInteger(r.id) && r.id > 0 && text(r.conta_id) && ['definicao','associacao'].includes(r.tipo) &&
      typeof r.conversa_id === 'string' && r.conversa_id.length <= 200 && typeof r.message_id === 'string' && r.message_id.length <= 200 &&
      text(r.label_id) && sha(r.assinatura) && date(r.observada_em);
    if (!common) bad('whatsapp_label_observacoes');
    if (r.tipo === 'definicao') {
      if (r.conversa_id !== '' || r.message_id !== '' || typeof r.nome !== 'string' || r.nome.length > 200 ||
          !Number.isInteger(r.cor) || r.cor < 0 || r.cor > 19 || r.predefined_id !== null && !text(r.predefined_id) ||
          !bit(r.removida) || r.acao !== null) bad('whatsapp_label_observacoes');
      const normalized = { tipo:'definicao', id:r.label_id, name:r.nome, color:r.cor, deleted:Boolean(r.removida), predefinedId:r.predefined_id };
      if (hash(JSON.stringify(normalized)) !== r.assinatura) bad('whatsapp_label_observacoes');
      const prev = oldLabel.get(r.conta_id,r.label_id);
      const changed = Boolean(prev && (prev.nome !== r.nome || prev.cor !== r.cor || prev.predefined_id !== r.predefined_id || prev.removida !== r.removida));
      insertLabel.run(r.conta_id,r.label_id,r.nome,r.cor,r.predefined_id,r.removida,Number(Boolean(r.removida || changed || prev?.conflito)),prev?.primeira_observacao_id ?? r.id,r.id);
    } else {
      if (!text(r.conversa_id) || r.nome !== null || r.cor !== null || r.predefined_id !== null || r.removida !== null || !['add','remove'].includes(r.acao)) bad('whatsapp_label_observacoes');
      const normalized = { tipo:'associacao', acao:r.acao, association:{ type:r.message_id ? 'label_message':'label_jid', chatId:r.conversa_id, messageId:r.message_id, labelId:r.label_id } };
      if (hash(JSON.stringify(normalized)) !== r.assinatura) bad('whatsapp_label_observacoes');
      const prev = oldAssoc.get(r.conta_id,r.conversa_id,r.message_id,r.label_id);
      const definition = oldLabel.get(r.conta_id,r.label_id);
      const add = Number(r.acao === 'add'), remove = Number(r.acao === 'remove');
      const conflict = Number(Boolean(!definition || definition.removida === 1 || remove || prev?.conflito || prev && (prev.viu_adicao && !add || prev.viu_remocao && !remove)));
      insertAssoc.run(r.conta_id,r.conversa_id,r.message_id,r.label_id,Number(Boolean(prev?.viu_adicao || add)),Number(Boolean(prev?.viu_remocao || remove)),conflict,prev?.primeira_observacao_id ?? r.id,r.id);
    }
  }
  const colsLabel = ['conta_id','label_id','nome','cor','predefined_id','removida','conflito','primeira_observacao_id','ultima_observacao_id'].map(q).join(',');
  const colsAssoc = ['conta_id','conversa_id','message_id','label_id','viu_adicao','viu_remocao','conflito','primeira_observacao_id','ultima_observacao_id'].map(q).join(',');
  for (const [actual,expected,cols] of [['whatsapp_labels','_restore_labels',colsLabel],['whatsapp_label_associacoes','_restore_assocs',colsAssoc]]) {
    if (exists(db,`SELECT 1 FROM (SELECT ${cols} FROM ${actual} EXCEPT SELECT ${cols} FROM ${expected}) LIMIT 1`) ||
        exists(db,`SELECT 1 FROM (SELECT ${cols} FROM ${expected} EXCEPT SELECT ${cols} FROM ${actual}) LIMIT 1`)) bad(actual);
  }
  db.exec('DROP TABLE _restore_labels; DROP TABLE _restore_assocs');
}

async function validateActions(db,signal) {
  const trimmed = (v,min,max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
  const states = ['sugerido','confirmado','estacionado','resolvido','descartado'];
  for await (const a of rowsAsync(db,'SELECT * FROM lume_acoes',signal)) {
    abort(signal);
    if (!trimmed(a.id,1,200) || !exists(db,'SELECT 1 FROM eventos WHERE id=?',a.evento_id) || !sha(a.chave) || !sha(a.fonte_assinatura) ||
        !['compromisso','pendencia'].includes(a.tipo) || !trimmed(a.resumo,1,500) || !trimmed(a.trecho,8,300) ||
        !Number.isInteger(a.trecho_inicio) || a.trecho_inicio < 0 || typeof a.prazo_citado !== 'string' || a.prazo_citado.length > 200 ||
        a.autor_id !== null && typeof a.autor_id !== 'string' || a.responsavel_id !== null && typeof a.responsavel_id !== 'string' ||
        !states.includes(a.estado) || !date(a.criada_em) || !date(a.atualizada_em) ||
        a.estado === 'estacionado' && (!date(a.lembrar_em) || !trimmed(a.fuso,1,100)) ||
        a.estado !== 'estacionado' && (a.lembrar_em !== null || a.fuso !== null) ||
        a.aviso_para !== null && (!date(a.aviso_para) || !date(a.aviso_em) || !['pendente','mostrado','falhou','sem-confirmacao','cancelado'].includes(a.aviso_resultado)) ||
        a.aviso_para === null && (a.aviso_em !== null || a.aviso_resultado !== null)) bad('lume_acoes');
  }
  for await (const h of rowsAsync(db,'SELECT * FROM lume_acoes_historico',signal)) {
    abort(signal);
    if (!Number.isSafeInteger(h.id) || h.id < 1 || !exists(db,'SELECT 1 FROM lume_acoes WHERE id=?',h.acao_id) ||
        !states.includes(h.estado_anterior) || !states.includes(h.estado_novo) || !date(h.alterada_em) || typeof h.motivo !== 'string') bad('lume_acoes_historico');
    if (h.motivo.startsWith('{"tipo":"responsabilidade",')) {
      let m; try { m = JSON.parse(h.motivo); } catch { bad('lume_acoes_historico'); }
      if (h.motivo.length > 200 || Object.keys(m).sort().join('|') !== 'anterior|novo|tipo' || m.tipo !== 'responsabilidade' ||
          ![null,'local:owner'].includes(m.anterior) || ![null,'local:owner'].includes(m.novo) || m.anterior === m.novo || h.estado_anterior !== h.estado_novo) bad('lume_acoes_historico');
    } else if (h.motivo.startsWith('{"tipo":"correcao_resumo",')) {
      let m; try { m = JSON.parse(h.motivo); } catch { bad('lume_acoes_historico'); }
      if (h.motivo.length > 1200 || Object.keys(m).sort().join('|') !== 'anterior|novo|tipo' || m.tipo !== 'correcao_resumo' ||
          !trimmed(m.anterior,1,500) || !trimmed(m.novo,1,500) || h.estado_anterior !== h.estado_novo) bad('lume_acoes_historico');
    } else if (h.motivo.length > 500) bad('lume_acoes_historico');
  }
}

async function validateNotetaker(db,counts,signal) {
  for (const name of ['notetaker_partes','notetaker_trechos','notetaker_fontes']) if (counts[name]) fail('ANEXOS_SEM_LOCK','notetaker');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for await (const s of rowsAsync(db,'SELECT * FROM notetaker_sessoes',signal)) {
    abort(signal);
    let inputs; try { inputs = JSON.parse(s.entradas); } catch { bad('notetaker_sessoes'); }
    if (!uuid.test(s.id) || s.origem !== 'importacao' || !Array.isArray(inputs) || inputs.length !== 1 || inputs[0] !== 'importacao' ||
        !['preparada','gravando','pausada','encerrada','interrompida','excluida'].includes(s.estado) ||
        !['nao_iniciada','em_curso','completa','incompleta'].includes(s.importacao_estado) ||
        !['nao_solicitado','em_curso','concluida','interrompida','indisponivel','falha'].includes(s.asr_estado) ||
        !Number.isSafeInteger(s.revisao) || s.revisao < 0 || !date(s.inicio_em) ||
        [s.consentimento_em,s.direitos_revogados_em,s.fim_em,s.excluida_em].some(v => v !== null && !date(v)) ||
        s.importacao_sha256 !== null && !sha(s.importacao_sha256) ||
        s.importacao_bytes !== null && (!Number.isSafeInteger(s.importacao_bytes) || s.importacao_bytes < 0) ||
        (s.importacao_sha256 === null) !== (s.importacao_bytes === null)) bad('notetaker_sessoes');
  }
}

async function validateWhatsAppCycle(db,signal) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for await (const c of rowsAsync(db,'SELECT * FROM wa_cobertura',signal)) {
    abort(signal);
    if (c.id !== 1 || !['desconectada','conectada','conectando','aguardando_qr','auth_invalida','substituida','erro','reconectando'].includes(c.estado) ||
        !date(c.observado_em) || c.ultimo_lote_em !== null && !date(c.ultimo_lote_em) || c.ultimo_historico_em !== null && !date(c.ultimo_historico_em)) bad('wa_cobertura');
  }
  for await (const i of rowsAsync(db,'SELECT * FROM wa_interrupcoes',signal)) {
    abort(signal);
    if (!uuid.test(i.id) || !date(i.inicio) || i.fim !== null && !date(i.fim) ||
        !['aplicativo_fechado','reinicio','conexao_interrompida'].includes(i.motivo)) bad('wa_interrupcoes');
  }
  const event = db.prepare('SELECT conversa_id FROM eventos WHERE id=?');
  for await (const r of rowsAsync(db,'SELECT * FROM wa_recuperacoes',signal)) {
    abort(signal);
    if (!uuid.test(r.id) || !string(r.conversa_id,160) || !['retomar','anteriores'].includes(r.modo) ||
        !['solicitando','aguardando_historico','falhou','interrompida'].includes(r.estado) || !date(r.pedido_em) || !date(r.atualizado_em) ||
        ![0,1].includes(r.recibo) || r.erro !== null && !['APLICATIVO_REINICIADO','BACKUP_RESTAURADO','HISTORICO_INDISPONIVEL','HISTORICO_CANCELADO','HISTORICO_SEM_ANCORA','HISTORICO_FONTE_ALTERADA','HISTORICO_FALHA'].includes(r.erro) ||
        r.evento_id !== null && event.get(r.evento_id)?.conversa_id !== r.conversa_id) bad('wa_recuperacoes');
  }
  for await (const r of rowsAsync(db,'SELECT * FROM wa_retomadas',signal)) {
    abort(signal);
    if (!exists(db,'SELECT 1 FROM wa_interrupcoes WHERE id=?',r.interrupcao_id) || !string(r.conversa_id,160) ||
        !exists(db,'SELECT 1 FROM eventos WHERE conversa_id=?',r.conversa_id)) bad('wa_retomadas');
  }
  for await (const r of rowsAsync(db,'SELECT * FROM wa_fila_retomada',signal)) {
    abort(signal);
    if (!exists(db,'SELECT 1 FROM wa_interrupcoes WHERE id=?',r.interrupcao_id) ||
        !string(r.conversa_id,160) || !exists(db,'SELECT 1 FROM eventos WHERE conversa_id=?',r.conversa_id) ||
        !['pendente','solicitando','aguardando_historico','falha','cancelada'].includes(r.estado) ||
        !Number.isSafeInteger(r.tentativas) || r.tentativas<0 || r.tentativas>4 ||
        r.proxima_tentativa_em!==null&&!date(r.proxima_tentativa_em) ||
        r.ultimo_erro!==null&&!['APLICATIVO_REINICIADO','BACKUP_RESTAURADO','HISTORICO_INDISPONIVEL','HISTORICO_CANCELADO','HISTORICO_SEM_ANCORA','HISTORICO_FONTE_ALTERADA','HISTORICO_FALHA','FONTE_EXCLUIDA'].includes(r.ultimo_erro) &&
          !(r.estado==='solicitando' && r.proxima_tentativa_em!==null &&
            typeof r.ultimo_erro==='string' && r.ultimo_erro.startsWith('CLAIM:') && uuid.test(r.ultimo_erro.slice(6))) ||
        !date(r.criado_em) || !date(r.atualizado_em)) bad('wa_fila_retomada');
  }
}

async function validateDerivedBase(db,signal) {
  const origin = db.prepare('SELECT 1 FROM eventos WHERE conversa_id=? AND origem_id=?');
  for (const table of ['itens_crm','eventos_financeiros']) {
    for await (const r of rowsAsync(db,`SELECT conversa_id,origem_id FROM ${q(table)}`,signal)) {
      abort(signal);
      if (!origin.get(r.conversa_id,r.origem_id)) bad(table);
    }
  }
  for await (const r of rowsAsync(db,'SELECT item_id FROM rascunhos',signal)) {
    abort(signal);
    if (r.item_id !== null && !exists(db,'SELECT 1 FROM itens_crm WHERE id=?',r.item_id)) bad('rascunhos');
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exact(obj,required,optional=[]) {
  return obj && Object.getPrototypeOf(obj) === Object.prototype &&
    required.every(k => Object.hasOwn(obj,k)) && Object.keys(obj).every(k => required.includes(k) || optional.includes(k));
}
function parseJson(value,max,family) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) bad(family);
  try { return JSON.parse(value); } catch { bad(family); }
}
const permitted = a => exact(a,['escopo','envio','publicacao','gastos','alterar_estado_comercial'],['estado']) &&
  a.escopo === 'preparar_material' && ['envio','publicacao','gastos','alterar_estado_comercial'].every(k => a[k] === false) &&
  (a.estado === undefined || ['pendente','revogada_importada'].includes(a.estado));

async function validateExecutionCycle(db,signal) {
  const context = db.prepare('SELECT 1 FROM lume_execucao_contextos WHERE id=?');
  const clients = { claude:'claude-desktop', codex:'codex', hermes:'hermes' };
  for await (const c of rowsAsync(db,'SELECT * FROM lume_execucao_contextos',signal)) {
    abort(signal);
    const p = parseJson(c.pacote,40000,'lume_execucao_contextos');
    const i = parseJson(c.integridade,500,'lume_execucao_contextos');
    if (!uuid.test(c.id) || !exists(db,'SELECT 1 FROM lume_acoes WHERE id=?',c.acao_id) || !date(c.criado_em) || !date(c.expira_em) ||
        !exact(i,['acao','fonte']) || !sha(i.acao) || !sha(i.fonte) ||
        !exact(p,['id','acao_id','tarefa','resumo','fontes','timeline','autorizacao','instrucoes','criado_em','expira_em'],['avisos']) ||
        p.id !== c.id || p.acao_id !== c.acao_id || p.criado_em !== c.criado_em || p.expira_em !== c.expira_em ||
        !string(p.tarefa,500) || !string(p.resumo,500) || !string(p.instrucoes,1500) || !permitted(p.autorizacao) ||
        !Array.isArray(p.fontes) || p.fontes.length !== 1 || !Array.isArray(p.timeline) || p.timeline.length > 10 ||
        p.avisos !== undefined && (!Array.isArray(p.avisos) || p.avisos.length > 5 || p.avisos.some(v => !string(v,500)))) bad('lume_execucao_contextos');
    const f = p.fontes[0];
    if (!exact(f,['id','trecho','conversa','autor','em'],['parcial']) || f.id !== 'fonte_1' || !string(f.trecho,1200) ||
        !string(f.conversa,500) || !string(f.autor,100) || !date(f.em) || f.parcial !== undefined && typeof f.parcial !== 'boolean') bad('lume_execucao_contextos');
    for (const h of p.timeline) if (!exact(h,['tipo','estado','em','texto','verificacao']) || h.tipo !== 'acao' ||
        !['sugerido','confirmado','estacionado','resolvido','descartado'].includes(h.estado) || !date(h.em) ||
        typeof h.texto !== 'string' || h.texto.length > 500 || h.verificacao !== 'registro_local') bad('lume_execucao_contextos');
  }
  for await (const x of rowsAsync(db,'SELECT * FROM lume_execucoes',signal)) {
    abort(signal);
    if (!uuid.test(x.id) || !context.get(x.contexto_id) || !Object.hasOwn(clients,x.assistente) || x.cliente_id !== clients[x.assistente] ||
        !['aguardando_assistente','em_andamento','resultado_informado','verificado','revogada'].includes(x.estado) ||
        typeof x.chave_inicio !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(x.chave_inicio) ||
        x.assinatura_inicio !== hash(JSON.stringify([x.contexto_id,x.assistente])) || !date(x.autorizada_em) || !date(x.atualizada_em)) bad('lume_execucoes');
  }
  for await (const e of rowsAsync(db,'SELECT * FROM lume_execucao_eventos',signal)) {
    abort(signal);
    const d = parseJson(e.dados,15000,'lume_execucao_eventos');
    if (!Number.isSafeInteger(e.id) || e.id < 1 || !exists(db,'SELECT 1 FROM lume_execucoes WHERE id=?',e.execucao_id) ||
        typeof e.chave !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(e.chave) ||
        !['autorizacao','inicio','progresso','resultado','verificacao','revogacao'].includes(e.tipo) ||
        !['local:owner','claude-desktop','codex','hermes','backup:importacao'].includes(e.ator) || !date(e.criado_em)) bad('lume_execucao_eventos');
    const valid = e.tipo === 'autorizacao' ? exact(d,['texto','autorizacao']) && string(d.texto,1000) && permitted(d.autorizacao) :
      e.tipo === 'resultado' ? exact(d,['resumo','artefatos']) && string(d.resumo,4000) && Array.isArray(d.artefatos) && d.artefatos.length <= 10 && d.artefatos.every(v => string(v,500)) :
      e.tipo === 'verificacao' ? exact(d,['nota']) && string(d.nota,1000) : exact(d,['texto']) && string(d.texto,1000);
    if (!valid || e.assinatura !== hash(JSON.stringify([e.tipo,e.ator,d]))) bad('lume_execucao_eventos');
  }
}

async function validateSalesCycle(db,signal) {
  const source = db.prepare('SELECT conversa_id FROM eventos WHERE id=?');
  for await (const r of rowsAsync(db,'SELECT * FROM lume_vendas_avaliacoes',signal)) {
    abort(signal);
    const v = parseJson(r.resultado,20000,'lume_vendas_avaliacoes');
    if (!uuid.test(r.id) || !string(r.conversa_id,160) || !sha(r.assinatura) || !date(r.avaliado_em) ||
        !exact(v,['id','temperatura','etapa','criterio','criterio_etapa','confianca','origem','avaliado_em','fontes','desatualizada'],
          ['confianca_etapa','probabilidades','revisao','modelo','calibracao','custo_usd','criterios_versao','solicitacao_id','consentimento','importacao','recorte','aviso']) ||
        v.id !== r.id || v.avaliado_em !== r.avaliado_em || !['frio','morno','quente','insuficiente'].includes(v.temperatura) ||
        !['interesse','proposta','conversa','fechado','encerrado','insuficiente'].includes(v.etapa) ||
        !string(v.criterio,1000) || !string(v.criterio_etapa,1000) || !['manual','jev'].includes(v.origem) ||
        typeof v.desatualizada !== 'boolean' || !Array.isArray(v.fontes) || !v.fontes.length || v.fontes.length > 20 ||
        new Set(v.fontes).size !== v.fontes.length) bad('lume_vendas_avaliacoes');
    for (const id of v.fontes) if (!Number.isSafeInteger(id) || source.get(id)?.conversa_id !== r.conversa_id) bad('lume_vendas_avaliacoes');
    if (v.aviso !== undefined && !string(v.aviso,1000)) bad('lume_vendas_avaliacoes');
    if (v.recorte !== undefined) {
      const c = v.recorte;
      if (!exact(c,['escopo','total','selecionadas','inicio_em','fim_em','contexto_omitido','contexto_omitido_possivel','assinatura_janela','revisao','aviso']) ||
          c.escopo !== 'mensagens_selecionadas' || !Number.isSafeInteger(c.total) || c.total < 1 || c.total > 20 ||
          c.selecionadas !== v.fontes.length || c.selecionadas > c.total || !date(c.inicio_em) || !date(c.fim_em) ||
          Date.parse(c.inicio_em) > Date.parse(c.fim_em) || c.contexto_omitido !== (c.selecionadas < c.total) ||
          c.contexto_omitido_possivel !== true || !sha(c.assinatura_janela) || c.revisao !== null && !sha(c.revisao) ||
          !string(c.aviso,1000)) bad('lume_vendas_avaliacoes');
    }
    if (v.criterios_versao !== undefined && v.criterios_versao !== 'vendas-1' ||
        v.solicitacao_id !== undefined && v.solicitacao_id !== null && (!string(v.solicitacao_id,160) || !/^gen-dec-[A-Za-z0-9-]{1,150}$/.test(v.solicitacao_id))) bad('lume_vendas_avaliacoes');
    if (v.consentimento !== undefined && (!exact(v.consentimento,['confirmado_em','provedor','modelo','assinatura_recorte']) ||
        !date(v.consentimento.confirmado_em) || v.consentimento.provedor !== 'OpenRouter / TypeSafe' ||
        !['typesafe/jev-1.13','typesafe/jev-1.14'].includes(v.consentimento.modelo) || v.consentimento.assinatura_recorte !== r.assinatura)) bad('lume_vendas_avaliacoes');
    if (v.importacao !== undefined && (!exact(v.importacao,['em','backup_sha256','consentimento_transferido']) ||
        !date(v.importacao.em) || !sha(v.importacao.backup_sha256) || v.importacao.consentimento_transferido !== false || v.desatualizada !== true)) bad('lume_vendas_avaliacoes');
    for (const k of ['confianca','confianca_etapa']) if (v[k] !== undefined && v[k] !== null &&
      (!Number.isFinite(v[k]) || v[k] < 0 || v[k] > 1)) bad('lume_vendas_avaliacoes');
    if (v.modelo !== undefined && (!string(v.modelo,100) || !/^typesafe\/jev-1\.(?:13|14)(?:-\d{8})?$/.test(v.modelo)) ||
        v.calibracao !== undefined && v.calibracao !== 'nao_validada_no_lume' ||
        v.revisao !== undefined && !['necessaria','sugerida'].includes(v.revisao) ||
        v.custo_usd !== undefined && v.custo_usd !== null && (!Number.isFinite(v.custo_usd) || v.custo_usd < 0)) bad('lume_vendas_avaliacoes');
    if (v.probabilidades !== undefined) {
      if (!exact(v.probabilidades,['temperatura','etapa'])) bad('lume_vendas_avaliacoes');
      for (const [key,keys] of [['temperatura',['frio','morno','quente','insuficiente']],['etapa',['interesse','proposta','conversa','fechado','encerrado','insuficiente']]]) {
        if (!exact(v.probabilidades[key],keys) || keys.some(k => !Number.isFinite(v.probabilidades[key][k]) ||
            v.probabilidades[key][k] < 0 || v.probabilidades[key][k] > 1)) bad('lume_vendas_avaliacoes');
      }
    }
  }
}

async function validateProjectsCycle(db,signal) {
  const bases = db.prepare('SELECT COUNT(*) n FROM lume_projetos_fontes WHERE projeto_id=? AND base=1');
  for await (const p of rowsAsync(db,'SELECT * FROM lume_projetos_comerciais',signal)) {
    abort(signal);
    if (!uuid.test(p.id) || !string(p.nome,160) || !['acordo_citado','proposta','incerto'].includes(p.natureza) ||
        !['rascunho','confirmado','arquivado'].includes(p.estado) || !sha(p.chave) || !sha(p.assinatura_criacao) ||
        !Number.isSafeInteger(p.bases_total) || p.bases_total < 1 || p.bases_total > 32 || !date(p.criado_em) || !date(p.atualizado_em) ||
        bases.get(p.id).n !== p.bases_total) bad('lume_projetos_comerciais');
  }
  for await (const f of rowsAsync(db,'SELECT * FROM lume_projetos_fontes',signal)) {
    abort(signal);
    if (!uuid.test(f.id) || !exists(db,'SELECT 1 FROM lume_projetos_comerciais WHERE id=?',f.projeto_id) ||
        !exists(db,'SELECT 1 FROM eventos WHERE id=?',f.evento_id) || !sha(f.assinatura) ||
        !Number.isSafeInteger(f.inicio) || f.inicio < 0 || !Number.isSafeInteger(f.tamanho) || f.tamanho < 1 ||
        f.inicio + f.tamanho > 10000000 || !['evento','trecho'].includes(f.selecao) ||
        ![0,1].includes(f.base) || ![0,1].includes(f.removida) || ![0,1].includes(f.invalidada) || !date(f.criada_em)) bad('lume_projetos_fontes');
  }
  for await (const h of rowsAsync(db,'SELECT * FROM lume_projetos_historico',signal)) {
    abort(signal);
    if (!Number.isSafeInteger(h.id) || h.id < 1 || !exists(db,'SELECT 1 FROM lume_projetos_comerciais WHERE id=?',h.projeto_id) ||
        !['criado','confirmado','arquivado','restaurado','fonte_vinculada','fonte_desvinculada','importado_revisado'].includes(h.tipo) ||
        h.fonte_id !== null && !exists(db,'SELECT 1 FROM lume_projetos_fontes WHERE id=? AND projeto_id=?',h.fonte_id,h.projeto_id) ||
        !date(h.quando)) bad('lume_projetos_historico');
  }
}

async function validateCycleProvenance(db,signal) {
  const lookups = new Map(); // statements por tabela fixa, nunca linhas do acervo
  for (const table of Object.keys(CICLO_COLUNAS)) {
    if (table === 'lume_ciclo_importacoes') continue;
    lookups.set(table, db.prepare(table === 'wa_retomadas'
      ? 'SELECT 1 FROM wa_retomadas WHERE json_array(interrupcao_id,conversa_id)=?'
      : `SELECT 1 FROM ${q(table)} WHERE CAST(id AS TEXT)=?`));
  }
  for await (const r of rowsAsync(db,'SELECT * FROM lume_ciclo_importacoes',signal)) {
    abort(signal);
    const lookup = lookups.get(r.tabela);
    if (!lookup || !string(r.registro_id,1000) || !lookup.get(r.registro_id) || !sha(r.backup_sha256) ||
        !date(r.importado_em) || r.estado_original !== null && !string(r.estado_original,100)) bad('lume_ciclo_importacoes');
    if (r.tabela === 'lume_projetos_fontes' && r.estado_original !== null) {
      let original; try { original = JSON.parse(r.estado_original); } catch { bad('lume_ciclo_importacoes'); }
      if (!original || Object.getPrototypeOf(original) !== Object.prototype ||
          Object.keys(original).sort().join(',') !== 'invalidada,removida,versao' ||
          original.versao !== 1 || ![0,1].includes(original.invalidada) || ![0,1].includes(original.removida)) bad('lume_ciclo_importacoes');
    }
  }
}

async function semantic(db, counts, signal, tables = TABELAS_I_V9, fileMetas = []) {
  for (const name of ['notetaker_partes','notetaker_trechos','notetaker_fontes']) if (counts[name]) fail('ANEXOS_SEM_LOCK','notetaker');
  const mapped = ['conversas_app','grupos_app','grupo_participantes','pessoas','pessoa_identificadores','eventos',
    'priv_excluidos','priv_conversas_excluidas','priv_vinculos','f10_revogadas','desktop_ia_gastos',
    'desktop_tarefas_analises','desktop_tarefas_lotes','desktop_tarefas_sugestoes','desktop_tarefas_fontes',
    'desktop_negocios','desktop_negocios_historico','transcricoes',
    'f10_projetos','f10_conversas','f10_origens','f10_procedencias','f10_recebidos','f10_conversas_importadas',
    'lume_comandos','lume_tags','lume_tags_entidades','lume_comando_tarefas','lume_comando_lembretes',
    'whatsapp_labels','whatsapp_label_associacoes','whatsapp_label_observacoes','lume_acoes','lume_acoes_historico'];
  mapped.push('notetaker_sessoes','wa_cobertura','wa_interrupcoes','wa_recuperacoes','wa_retomadas',
    'itens_crm','eventos_financeiros','rascunhos','lume_execucao_contextos','lume_execucoes','lume_execucao_eventos',
    'lume_vendas_avaliacoes','lume_projetos_comerciais','lume_projetos_fontes','lume_projetos_historico','lume_ciclo_importacoes');
  if (tables !== TABELAS_I_V9) mapped.push('etapas');
  if (tables === TABELAS_I_V10 || tables === TABELAS_I_V10_MIDIAS) mapped.push('ciclo_midias');
  if (tables === TABELAS_I_V10) mapped.push('wa_fila_retomada');
  const unsupported = tables.filter(t => !mapped.includes(t.nome));
  for (const t of unsupported) if (counts[t.nome]) fail('SEMANTICA_NAO_MAPEADA', 'semantica', `Família ainda sem paridade v8: ${t.nome}`);
  const hasExcluded = db.prepare('SELECT 1 FROM priv_excluidos WHERE hash=?');
  const hasConversation = db.prepare('SELECT 1 FROM priv_conversas_excluidas WHERE hash=?');
  for await (const e of rowsAsync(db,'SELECT id,conversa_id,origem_id,permissao,tipo,projeto_id FROM eventos',signal)) {
    abort(signal);
    if (e.projeto_id !== null || ![null,'minha','dirigida','terceiro','compartilhado'].includes(e.permissao) || e.tipo === 'notetaker_local' ||
        hasExcluded.get(chaveExclusao(e.conversa_id,e.origem_id)) || hasConversation.get(chaveConversa(e.conversa_id))) fail('SEMANTICA_INVALIDA', 'eventos');
  }
  for await (const row of rowsAsync(db,'SELECT hash,excluido_em FROM priv_excluidos UNION ALL SELECT hash,excluido_em FROM priv_conversas_excluidas',signal)) {
    abort(signal); if (!/^[a-f0-9]{64}$/.test(row.hash) || !Number.isFinite(Date.parse(row.excluido_em))) fail('SEMANTICA_INVALIDA','tombstones');
  }
  if (tables !== TABELAS_I_V9) {
    for await (const row of rowsAsync(db,`SELECT evento_id,etapa,estado,tentativas,resultado,atualizado_em,
      proxima_tentativa_em,lease_token,lease_ate,fonte_assinatura FROM etapas`,signal)) {
      abort(signal);
      if (!['captura','midia','transcricao','interpretacao','indexacao','projecao'].includes(row.etapa) ||
          !['pendente','em_curso','concluida','falha','desistida'].includes(row.estado) ||
          !Number.isSafeInteger(row.tentativas) || row.tentativas < 0 ||
          !date(row.atualizado_em) ||
          (row.proxima_tentativa_em !== null && !date(row.proxima_tentativa_em)) ||
          (row.lease_ate !== null && !date(row.lease_ate)) ||
          (row.fonte_assinatura !== null && !sha(row.fonte_assinatura)) ||
          (row.estado === 'em_curso' && (!row.lease_token || !row.lease_ate || !row.fonte_assinatura)) ||
          (row.estado !== 'em_curso' && (row.lease_token !== null || row.lease_ate !== null)))
        fail('SEMANTICA_INVALIDA','etapas');
      if (row.resultado !== null) {
        try { JSON.parse(row.resultado); } catch { fail('SEMANTICA_INVALIDA','etapas'); }
      }
    }
  }
  for await (const row of rowsAsync(db,'SELECT fingerprint,revogado_em FROM f10_revogadas',signal)) {
    abort(signal); if (!/^[a-f0-9]{64}$/.test(row.fingerprint) || !Number.isFinite(Date.parse(row.revogado_em))) fail('SEMANTICA_INVALIDA','tombstones');
  }
  await validateSpending(db,signal);
  const transcricoes=await validateTranscriptions(db,signal,fileMetas);
  const midias=await validateCicloMidias(db,signal,fileMetas);
  if(transcricoes.size+midias.size!==fileMetas.length)fail('ANEXO_INVENTARIO_DIVERGENTE','anexos');
  await validateTasks(db,signal);
  await validateBusinesses(db,signal);
  await validateF10(db,signal);
  await validateCommands(db,signal);
  await validateLabels(db,signal);
  await validateActions(db,signal);
  await validateNotetaker(db,counts,signal);
  await validateWhatsAppCycle(db,signal);
  await validateDerivedBase(db,signal);
  await validateExecutionCycle(db,signal);
  await validateSalesCycle(db,signal);
  await validateProjectsCycle(db,signal);
  await validateCycleProvenance(db,signal);
  for await (const row of rowsAsync(db,'PRAGMA foreign_key_check',signal)) fail('RELACAO_INVALIDA', 'fk', `FK: ${row.table}`);
  const integrity = [...db.prepare('PRAGMA integrity_check').iterate()];
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') fail('INTEGRIDADE_FALHOU', 'sqlite');
}

async function recordProvenance(db,backupHash,signal) {
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT INTO lume_ciclo_importacoes(tabela,registro_id,backup_sha256,importado_em,estado_original) VALUES(?,?,?,?,?)');
  for (const table of Object.keys(CICLO_COLUNAS)) {
    if (table === 'lume_ciclo_importacoes') continue;
    for await (const row of rowsAsync(db,`SELECT * FROM ${q(table)}`,signal)) {
      abort(signal);
      const original = table === 'lume_projetos_fontes' ? JSON.stringify({versao:1,invalidada:row.invalidada,removida:row.removida}) : row.estado ?? null;
      const id = cicloRegistroId(table,row);
      if (!exists(db,'SELECT 1 FROM lume_ciclo_importacoes WHERE tabela=? AND registro_id=?',table,id))
        insert.run(table,id,backupHash,now,original);
    }
  }
}

async function deactivate(db, backupHash, signal, version = 9) {
  const now = new Date().toISOString();
  if (version === 10) {
    db.prepare(`UPDATE etapas SET estado='falha',ultimo_erro='backup_retomada',
      proxima_tentativa_em=?,lease_token=NULL,lease_ate=NULL,fonte_assinatura=NULL,
      atualizado_em=? WHERE estado='em_curso'`).run(now,now);
    const source=db.prepare(`SELECT conversa_id,origem_id,tipo,bruto,texto,permissao,autor_id,recebido_em
      FROM eventos WHERE id=?`);
    const reset=db.prepare(`UPDATE etapas SET estado='falha',ultimo_erro='backup_fonte_alterada',
      proxima_tentativa_em=?,lease_token=NULL,lease_ate=NULL,fonte_assinatura=NULL,
      atualizado_em=? WHERE evento_id=? AND etapa=?`);
    const ordem=['midia','transcricao','interpretacao','indexacao','projecao'];
    const invalidas=new Map();
    for await (const stage of rowsAsync(db,`SELECT evento_id,etapa,resultado FROM etapas
      WHERE estado='concluida' AND etapa<>'captura' ORDER BY evento_id`,signal)) {
      abort(signal);
      const row=source.get(stage.evento_id);
      let receipt;try{receipt=stage.resultado===null?null:JSON.parse(stage.resultado);}catch{receipt=null;}
      if (!row || !receipt || receipt.fonteAssinatura!==assinaturaFonteCiclo(row)) {
        const prior=invalidas.get(stage.evento_id)??ordem.length;
        invalidas.set(stage.evento_id,Math.min(prior,ordem.indexOf(stage.etapa)));
      }
    }
    for (const [eventoId,index] of invalidas) for (const etapa of ordem.slice(index))
      reset.run(now,now,eventoId,etapa);
  }
  const expire = '1970-01-01T00:00:00.000Z';
  const actionHistory = db.prepare('INSERT INTO lume_acoes_historico(acao_id,estado_anterior,estado_novo,alterada_em,motivo) VALUES(?,?,?,?,?)');
  for await (const a of rowsAsync(db,`SELECT id,estado,aviso_resultado FROM lume_acoes
    WHERE estado IN('sugerido','confirmado','estacionado') OR aviso_resultado='pendente'`,signal)) {
    const changedState = ['sugerido','confirmado','estacionado'].includes(a.estado);
    const next = changedState ? 'descartado' : a.estado;
    actionHistory.run(a.id,a.estado,next,now,changedState
      ? 'Backup v9: ação importada como histórico, sem agendamento.'
      : 'Backup v9: aviso pendente cancelado sem envio.');
  }
  for await (const c of rowsAsync(db,'SELECT id,pacote FROM lume_execucao_contextos',signal)) {
    const p = JSON.parse(c.pacote);
    p.autorizacao.estado = 'revogada_importada'; p.expira_em = expire;
    db.prepare('UPDATE lume_execucao_contextos SET pacote=?,expira_em=? WHERE id=?').run(JSON.stringify(p),expire,c.id);
  }
  db.exec("UPDATE lume_execucoes SET estado='revogada'");
  const revocation = { texto:'Histórico importado de backup; autorização não transferida.' };
  const eventKey = 'importacao-' + backupHash.slice(0,32);
  for await (const x of rowsAsync(db,'SELECT id FROM lume_execucoes',signal)) {
    if (exists(db,'SELECT 1 FROM lume_execucao_eventos WHERE execucao_id=? AND chave=?',x.id,eventKey)) bad('lume_execucao_eventos');
    db.prepare(`INSERT INTO lume_execucao_eventos(execucao_id,chave,assinatura,tipo,ator,dados,criado_em)
      VALUES(?,? ,?,'revogacao','backup:importacao',?,?)`)
      .run(x.id,eventKey,hash(JSON.stringify(['revogacao','backup:importacao',revocation])),JSON.stringify(revocation),now);
  }
  for await (const r of rowsAsync(db,'SELECT id,resultado FROM lume_vendas_avaliacoes',signal)) {
    const result = JSON.parse(r.resultado);
    result.desatualizada = true;
    result.importacao = { em:now, backup_sha256:backupHash, consentimento_transferido:false };
    db.prepare('UPDATE lume_vendas_avaliacoes SET resultado=? WHERE id=?').run(JSON.stringify(result),r.id);
  }
  db.exec("UPDATE lume_projetos_comerciais SET estado='rascunho'; UPDATE lume_projetos_fontes SET invalidada=1");
  db.prepare(`UPDATE notetaker_sessoes SET direitos_revogados_em=COALESCE(direitos_revogados_em,?),
    estado=CASE WHEN estado='excluida' THEN estado ELSE 'interrompida' END,
    importacao_estado=CASE WHEN importacao_estado IN('em_curso','completa') THEN 'incompleta' ELSE importacao_estado END,
    importacao_sha256=NULL,importacao_bytes=NULL,
    asr_estado=CASE WHEN asr_estado IN('em_curso','concluida') THEN 'interrompida' ELSE asr_estado END`).run(now);
  db.exec(`UPDATE lume_comando_lembretes SET estado='revisar' WHERE estado='agendado';
    UPDATE lume_comando_tarefas SET estado='revisar' WHERE estado='aberta';
    UPDATE lume_acoes SET
      estado=CASE WHEN estado IN('sugerido','confirmado','estacionado') THEN 'descartado' ELSE estado END,
      lembrar_em=NULL,fuso=NULL,
      aviso_resultado=CASE WHEN aviso_resultado='pendente' THEN 'cancelado' ELSE aviso_resultado END
      WHERE estado IN('sugerido','confirmado','estacionado') OR aviso_resultado='pendente';
    UPDATE desktop_tarefas_lotes SET estado='incerto' WHERE estado='iniciado';
    UPDATE wa_cobertura SET estado='desconectada';
    UPDATE wa_recuperacoes SET estado='interrompida',erro='BACKUP_RESTAURADO' WHERE estado IN('solicitando','aguardando_historico');
    UPDATE wa_fila_retomada SET estado='cancelada',proxima_tentativa_em=NULL,ultimo_erro='BACKUP_RESTAURADO'
      WHERE estado IN('pendente','solicitando');
    UPDATE desktop_ia_config SET habilitada=0;
    UPDATE desktop_tarefas_config SET ativa=0,erro=NULL,ultima_conversa_id=NULL;
    UPDATE desktop_semantica_config SET ativa=0;
    INSERT INTO desktop_config(chave,valor) VALUES('captura_pausada','1')
      ON CONFLICT(chave) DO UPDATE SET valor='1';`);
}

async function validarAcervo(opcoes = {}, version = 9) {
  const ocupadas = new Set([...pending.values()].map(state => state.area));
  for (const area of failed) ocupadas.add(area);
  const raizChave = typeof opcoes?.raizStaging === 'string' ? rootKey(opcoes.raizStaging) : null;
  const falhaDaRaiz = [...failed].some(area => rootKey(path.dirname(area.caminho)) === raizChave);
  if (ocupadas.size + inflight >= MAX_FAILED && !falhaDaRaiz) fail('LIMITE_PLANOS', 'staging');
  if (inflightRoots.has(raizChave)) fail('STAGING_EM_USO', 'staging');
  inflightRoots.add(raizChave);
  inflight++;
  try { return await validarInterno(opcoes, version); }
  finally { inflight--; inflightRoots.delete(raizChave); }
}

async function validarInterno({ pacote, senha, raizStaging, signal } = {}, version = 9) {
  let tables=version===10?TABELAS_I_V10:TABELAS_I_V9;
  const decode=version===10?decodificarAcervoV10:decodificarAcervoV9;
  abort(signal);
  await safePath(pacote, 'file'); await safePath(raizStaging, 'dir');
  await prepararRaiz(raizStaging);
  const ocupadas = new Set([...pending.values()].map(state => state.area));
  for (const area of failed) ocupadas.add(area);
  // Esta tentativa já reservou inflight; nenhuma área nova nasce acima da cota.
  if (ocupadas.size + inflight > MAX_FAILED) fail('LIMITE_PLANOS', 'staging');
  const packageBefore = await lstat(pacote, { bigint: true });
  const area = await criarAreaStagingV9({ raizStaging });
  let db; let fh; let packHandle;
  try {
    // A função só retorna após verificar TODAS as tags AEAD e o manifesto.
    const verified = await verificarPacote({ pacote, pastaStaging: area.caminho, senha, signal, areaStaging: area });
    conferirObjetoStagingV9(area, verified.pastaStaging);
    conferirObjetoStagingV9(area, verified.caminhoStaging);
    abort(signal);
    const plaintextStat = await lstat(verified.caminhoStaging, { bigint: true });
    const packageStat = await lstat(pacote, { bigint: true });
    if (!sameFile(packageBefore,packageStat)) fail('PACOTE_ALTERADO','autenticacao');
    if (!plaintextStat.isFile() || plaintextStat.isSymbolicLink()) fail('STAGING_ALTERADO', 'autenticacao');
    fh = await open(verified.caminhoStaging, constants.O_RDONLY | NOFOLLOW);
    if (!same(plaintextStat, await fh.stat({ bigint: true }))) { await fh.close(); fail('STAGING_ALTERADO', 'autenticacao'); }
    const dbPath = path.join(area.caminho, 'acervo.sqlite');
    db = await prepararEsquemaRestoreV9Gerido(area,{v10:version===10});
    conferirSqlite(area);
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
    const counts = Object.create(null);
    let current = null; let index = 0; let rows = 0; let dono;
    const fileMetas = []; let packOffset = 0; const packHash = createHash('sha256');
    let statement;
    let parserError;
    try {
      const readHash = createHash('sha256');
      async function* verifiedBytes() { for await (const chunk of fh.createReadStream({ autoClose: false })) { readHash.update(chunk); yield chunk; } }
      for await (const frame of decode(verifiedBytes(), { signal })) {
        abort(signal);
        const h = frame.cabecalho;
        switch (h.tipo) {
          case 'inicio':
            if(version===10&&h.catalogoSha256===CATALOGO_SHA256_V10_LEGADO)tables=TABELAS_I_V10_LEGADO;
            else if(version===10&&h.catalogoSha256===CATALOGO_SHA256_V10_MIDIAS)tables=TABELAS_I_V10_MIDIAS;
            else if(h.catalogoSha256!==(version===10?CATALOGO_SHA256_V10:CATALOGO_SHA256_V9))fail('CATALOGO_DIVERGENTE','inicio');
            dono=h.dono;break;
          case 'tabela':
            if (current || index >= tables.length || h.nome !== tables[index].nome || h.indice !== index) fail('TABELA_INVALIDA', 'tabela');
            current = tables[index]; counts[current.nome] = 0; statement = load(db,current); break;
          case 'row': {
            if (!current) fail('TABELA_INVALIDA', 'row');
            const cells = parseRow(frame.payload,current,counts[current.nome]+1,h.chave);
            let result; try { result = statement.get(...cells.map(c => c.value)); } catch { fail('SQL_INVALIDO', 'row'); }
            if (!result || current.colunas.some((name,i) => result[name] !== cells[i].type)) fail('TIPO_SQL_DIVERGENTE', 'row', `Storage class divergente: ${current.nome}`);
            for (let i=0; i<current.pk.length; i++) {
              const sent = cells[current.colunas.indexOf(current.pk[i])].value;
              const stored = result[`__pk${i}`];
              if (Buffer.isBuffer(sent) ? !Buffer.isBuffer(stored) || !sent.equals(stored) : stored !== sent) fail('PK_INVALIDA','row');
            }
            counts[current.nome]++; rows++; break;
          }
          case 'fimTabela': if (!current || h.linhas !== counts[current.nome]) fail('TABELA_INVALIDA', 'fimTabela'); current = null; index++; break;
          case 'arquivo':
            if (version !== 10 || current || index !== tables.length ||
              !['transcricao','ciclo_midia'].includes(h.classe) ||
              h.classe==='ciclo_midia'&&tables!==TABELAS_I_V10&&tables!==TABELAS_I_V10_MIDIAS) fail('ANEXOS_SEM_LOCK', 'anexos');
            if (!packHandle) packHandle = await registrarObjetoStagingV9(area, await area.criarArquivo('anexos.pack'));
            fileMetas.push({ id: h.id, classe: h.classe, bytes: h.bytes, sha256: h.sha256, offset: packOffset });
            break;
          case 'chunk': {
            if (version !== 10 || !packHandle) fail('ANEXOS_SEM_LOCK', 'anexos');
            let written = 0;
            while (written < frame.payload.length) {
              const result = await packHandle.write(frame.payload, written, frame.payload.length - written, packOffset + written);
              if (result.bytesWritten < 1) fail('STAGING_ALTERADO','anexos');
              written += result.bytesWritten;
            }
            packHash.update(frame.payload);
            packOffset += written;
            break;
          }
          case 'fimArquivo': break;
          case 'fim': if (current || index !== tables.length || h.tabelas !== index || h.linhas !== rows || h.arquivos !== fileMetas.length || h.bytesArquivos !== packOffset) fail('TABELA_INVALIDA','fim'); break;
        }
      }
      if (packHandle) { await packHandle.sync(); await packHandle.close(); packHandle = null; conferirObjetoStagingV9(area, path.join(area.caminho, 'anexos.pack')); }
      if (readHash.digest('hex') !== verified.sha256 || !same(plaintextStat, await fh.stat({ bigint: true }))) fail('STAGING_ALTERADO','parser');
      await semantic(db, counts, signal, tables, fileMetas);
      await recordProvenance(db, verified.sha256, signal);
      await deactivate(db, verified.sha256, signal, version);
      db.exec('COMMIT');
      conferirSqlite(area);
    } catch (error) { parserError = error; if (packHandle) { await packHandle.close().catch(() => {}); packHandle = null; } try { db.exec('ROLLBACK'); } catch {} throw error; }
    finally { try { await fh.close(); fh = null; } catch (error) { if (!parserError) throw error; } }
    // A conexão primária permanece aberta durante a conferência readOnly.
    const { DatabaseSync } = await import('node:sqlite');
    conferirSqlite(area);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    let checkError;
    try {
      conferirSqlite(area);
      auditarEsquemaRestoreV9(check,{v10:version===10});
      for (const t of ['lume_execucao_contexto_grants','lume_execucao_contexto_guardas','autorizacoes','politicas_conversa','lume_acoes_conversas','desktop_ia_conversas','desktop_tarefas_conversas']) {
        if (check.prepare(`SELECT 1 FROM ${q(t)} LIMIT 1`).get()) fail('GRANT_IMPORTADO','reabertura');
      }
      if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') fail('INTEGRIDADE_FALHOU','reabertura');
      conferirSqlite(area);
    } catch (error) { checkError = error; throw error; }
    finally { try { check.close(); } catch (error) { if (!checkError) throw error; } }
    conferirSqlite(area);
    db.close(); db = null;
    conferirSqlite(area, true);
    const dbFinal = lstatSync(dbPath, { bigint: true });
    const dbSha256 = version === 10 ? await hashArquivoV10(dbPath) : null;
    const token = randomBytes(32).toString('hex');
    const summary = Object.freeze({ versao: version, tabelas: index, linhas: rows, anexos: fileMetas.length, donoDeclarado: dono });
    const packFinal = fileMetas.length ? lstatSync(path.join(area.caminho, 'anexos.pack'), { bigint: true }) : null;
    const state = { area, verified, plaintextStat, packageStat, dbFinal, dbSha256, packFinal,
      packSha256: packFinal ? packHash.digest('hex') : null,
      fileMetas: Object.freeze(fileMetas.map(meta => Object.freeze(meta))),
      pacote, resumo: summary, versao:version, expiraEm: new Date(Date.now()+FIVE_MINUTES).toISOString(), sha256: verified.sha256, descartado: false, aplicando: false };
    pending.set(token, state);
    const timer = setTimeout(() => {
      if (state.aplicando) return;
      state.descartado = true;
      void limpar(area).then(r => { if (!r.limpezaPendente) pending.delete(token); }).catch(() => failed.add(area));
    }, FIVE_MINUTES);
    timer.unref(); state.timer = timer;
    return { plano: token, resumo: summary, expiraEm: state.expiraEm };
  } catch (error) {
    if (fh) await fh.close().catch(() => {});
    if (packHandle) await packHandle.close().catch(() => {});
    if (db) try { db.close(); } catch {}
    let recibo;
    try { recibo = await limpar(area); }
    catch (cleanupError) {
      failed.add(area);
      recibo = { limpezaPendente: true, codigos: [/^[A-Z_]+$/.test(cleanupError?.code ?? '') ? cleanupError.code : 'LIMPEZA_FALHOU'] };
    }
    const code = signal?.aborted ? 'RESTORE_CANCELADO' :
      (/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'RESTORE_FALHOU');
    const outward = error && Object.hasOwn(error, 'fase') ? error : new Error(code);
    outward.code = code;
    outward.message = code;
    outward.fase ??= signal?.aborted ? 'cancelamento' : 'staging';
    outward.limpezaPendente = recibo.limpezaPendente;
    outward.codigosLimpeza = recibo.codigos;
    throw outward;
  }
}

export function validarAcervoV9(opcoes = {}) { return validarAcervo(opcoes,9); }
export function validarAcervoV10(opcoes = {}) { return validarAcervo(opcoes,10); }

function inspecionarPlanoBase(plano) {
  const state = typeof plano === 'string' ? pending.get(plano) : null;
  if (!state || state.descartado) fail('PLANO_INVALIDO', 'plano');
  if (!state.aplicando && Date.now() >= Date.parse(state.expiraEm)) {
    state.descartado = true;
    void limpar(state.area).then(r => { if (!r.limpezaPendente) pending.delete(plano); }).catch(() => failed.add(state.area));
    fail('PLANO_INVALIDO', 'plano');
  }
  try {
    if (!sameFile(state.packageStat,lstatSync(state.pacote, { bigint: true })) ||
        !sameFile(state.plaintextStat,lstatSync(state.verified.caminhoStaging, { bigint: true })) ||
        !sameFile(state.dbFinal,lstatSync(path.join(state.area.caminho,'acervo.sqlite'), { bigint: true })) ||
        (state.packFinal && !sameFile(state.packFinal,lstatSync(path.join(state.area.caminho,'anexos.pack'), { bigint: true })))) fail('PLANO_INVALIDO','plano');
    conferirObjetoStagingV9(state.area, state.verified.caminhoStaging);
    conferirSqlite(state.area, true);
    if (state.packFinal) conferirObjetoStagingV9(state.area, path.join(state.area.caminho,'anexos.pack'));
  } catch { fail('PLANO_INVALIDO','plano'); }
  return { resumo: state.resumo, expiraEm: state.expiraEm, recusas: [] };
}

export function inspecionarPlanoV9(plano) {
  const state = typeof plano === 'string' ? pending.get(plano) : null;
  if (!state || state.versao !== 9) fail('PLANO_INVALIDO','plano');
  return inspecionarPlanoBase(plano);
}

export async function inspecionarPlanoV10(plano) {
  const state=typeof plano==='string'?pending.get(plano):null;
  if (!state || state.versao!==10) fail('PLANO_INVALIDO','plano');
  const result = inspecionarPlanoBase(plano);
  if (state.packFinal) {
    const file = path.join(state.area.caminho,'anexos.pack');
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | NOFOLLOW);
      if (!sameFile(state.packFinal, await handle.stat({ bigint: true }))) fail('PLANO_INVALIDO','plano');
      const digest = createHash('sha256');
      for await (const bytes of handle.createReadStream({ highWaterMark: 1024 * 1024, autoClose: false })) digest.update(bytes);
      if (!sameFile(state.packFinal, await handle.stat({ bigint: true })) || digest.digest('hex') !== state.packSha256)
        fail('PLANO_INVALIDO','plano');
    } catch { fail('PLANO_INVALIDO','plano'); }
    finally { await handle?.close().catch(() => {}); }
    inspecionarPlanoBase(plano);
  }
  return result;
}

export async function descartarPlanoV9(plano) {
  const state = typeof plano === 'string' ? pending.get(plano) : null;
  if (!state) return { areasVistas: 0, areasLimpas: 0, areasEmUso: 0, objetosRemovidos: 0, codigos: [], limpezaPendente: false, fsyncDiretorioSuportado: null };
  if (state.aplicando) fail('PLANO_EM_APLICACAO', 'plano');
  state.descartado = true; clearTimeout(state.timer);
  const recibo = await limpar(state.area);
  if (!recibo.limpezaPendente) pending.delete(plano);
  return recibo;
}

export function descartarPlanoV10(plano) {
  const state=typeof plano==='string'?pending.get(plano):null;
  if (state && state.versao!==10) fail('PLANO_INVALIDO','plano');
  return descartarPlanoV9(plano);
}

export async function aplicarAcervoV10({ plano, destinoNovo, confirmarMeuBackup } = {}) {
  const state = typeof plano === 'string' ? pending.get(plano) : null;
  if (!state || state.versao !== 10 || state.descartado || state.aplicando ||
      Date.now() >= Date.parse(state.expiraEm)) fail('PLANO_INVALIDO', 'publicacao');
  if (confirmarMeuBackup !== true) fail('CONFIRMACAO_OBRIGATORIA', 'publicacao');
  state.aplicando = true;
  clearTimeout(state.timer);
  try {
    await inspecionarPlanoV10(plano);
    if (await hashArquivoV10(path.join(state.area.caminho, 'acervo.sqlite')) !== state.dbSha256)
      fail('PLANO_INVALIDO', 'publicacao');
    const result = await publicarAcervoV10({ destinoNovo, state });
    const cleanup = await limpar(state.area);
    state.descartado = true;
    pending.delete(plano);
    if (cleanup.limpezaPendente) fail('LIMPEZA_PENDENTE', 'publicacao');
    return { versao: 10, resumo: state.resumo, destinoNovo, recuperacao: result.estado };
  } finally {
    state.aplicando = false;
    if (!state.descartado) {
      // Falha anterior Ã  publicação mantÃ©m o plano para inspeÃ§Ã£o e descarte explÃ­cito.
      state.timer = setTimeout(() => { void descartarPlanoV10(plano).catch(() => {}); },
        Math.max(0, Date.parse(state.expiraEm) - Date.now()));
      state.timer.unref();
    }
  }
}

export async function aplicarAcervoV9({ plano, confirmarMeuBackup } = {}) {
  const state = typeof plano === 'string' ? pending.get(plano) : null;
  if (!state || state.descartado) fail('PLANO_INVALIDO','publicacao');
  if (Date.now() >= Date.parse(state.expiraEm)) {
    await descartarPlanoV9(plano);
    fail('PLANO_INVALIDO','publicacao');
  }
  const recibo = await descartarPlanoV9(plano);
  if (recibo.limpezaPendente) fail('LIMPEZA_PENDENTE','publicacao');
  if (confirmarMeuBackup !== true) fail('CONFIRMACAO_OBRIGATORIA','publicacao');
  fail('RESTORE_LOCK_INDISPONIVEL', 'publicacao', 'Publicação de perfil ainda não implementada');
}
