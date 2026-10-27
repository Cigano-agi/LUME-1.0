/**
 * Comandos locais do Lume 3.2.
 *
 * Este modulo e deliberadamente puro na borda: nao importa transporte, socket ou
 * provedor de IA. A mensagem ja capturada entra, uma acao deterministica sai e
 * todos os efeitos ficam no SQLite local com a origem que os sustenta.
 */

export const VERSAO_CONTRATO_COMANDOS = '3.2.0-v1';
export const COMANDOS_LUME = Object.freeze([
  '#lume_tarefa',
  '#lume_lembrete',
  '#lume_cliente',
  '#lume_tag',
  '#lume_ajuda'
]);
export const TABELAS_COMANDOS = Object.freeze([
  'lume_comandos',
  'lume_tags',
  'lume_tags_entidades',
  'lume_comando_tarefas',
  'lume_comando_lembretes'
]);

const COMANDOS = new Set(COMANDOS_LUME);
const ESTADOS_FINAIS = new Set(['feito', 'revisar', 'nao_reconhecido', 'nao_executado']);
const TIPOS_ENTIDADE = new Set(['mensagem', 'conversa', 'contato', 'tarefa', 'lembrete', 'negocio']);
const segmentador = new Intl.Segmenter('pt-BR', {granularity: 'grapheme'});

const agoraIso = agora => (agora instanceof Date ? agora : new Date(agora ?? Date.now())).toISOString();
const grafemas = valor => [...segmentador.segment(String(valor ?? ''))].length;
const limparEspacos = valor => String(valor ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
const tokenInicial = texto => limparEspacos(texto).split(' ')[0].toLocaleLowerCase('pt-BR');
const ehGrupo = conversaId => String(conversaId ?? '').endsWith('@g.us');
const chaveIdempotente = ({conversaId, origemId, versao = VERSAO_CONTRATO_COMANDOS}) =>
  `${versao}:${String(conversaId)}:${String(origemId)}`;

/**
 * Adapta uma mensagem Baileys sem acessar o socket. A citacao continua sendo
 * somente alvo/prova; seu texto nunca e interpretado como comando.
 */
export function entradaDeMensagemWhatsapp(mensagem, {timeZone, doProprioBot = false, origemRemovida = () => false} = {}) {
  const chave = mensagem?.key ?? {};
  let conteudo = mensagem?.message ?? {};
  for (let nivel = 0; nivel < 8; nivel++) {
    const interno = conteudo?.ephemeralMessage?.message
      ?? conteudo?.viewOnceMessage?.message
      ?? conteudo?.viewOnceMessageV2?.message
      ?? conteudo?.documentWithCaptionMessage?.message;
    if (!interno) break;
    conteudo = interno;
  }
  const portador = conteudo.extendedTextMessage ?? conteudo.imageMessage ?? conteudo.videoMessage ?? conteudo.documentMessage ?? null;
  const texto = conteudo.conversation ?? portador?.text ?? portador?.caption ?? null;
  const contexto = portador?.contextInfo ?? null;
  const origemRespondida = contexto?.stanzaId ?? null;
  const autorRespondido = contexto?.participant ?? contexto?.remoteJid ?? null;
  const resposta = origemRespondida ? {
    origemId: origemRespondida,
    autorId: autorRespondido,
    removida: Boolean(origemRemovida(String(chave.remoteJid ?? ''), String(origemRespondida)))
  } : null;
  return {
    conversaId: String(chave.remoteJid ?? ''),
    origemId: String(chave.id ?? ''),
    fromMe: Boolean(chave.fromMe),
    doProprioBot: Boolean(doProprioBot),
    texto,
    timeZone,
    ...(resposta ? {resposta} : {})
  };
}

function resposta(estado, motivo, extra = {}) {
  return {estado, motivo, acao: null, tags: [], ...extra};
}

export function normalizarTag(valor) {
  const exibicao = limparEspacos(valor).replace(/^#+/u, '');
  if (!exibicao) return {valida: false, motivo: 'tag_vazia'};
  if (grafemas(exibicao) > 40) return {valida: false, motivo: 'tag_acima_do_limite'};
  // ZWJ/ZWNJ (categoria Cf) fazem parte de emojis e escritas legitimas. Recusamos
  // controles e surrogates soltos sem quebrar um grafema como "pessoa no notebook".
  if (/[\p{Cc}\p{Cs}]/u.test(exibicao)) return {valida: false, motivo: 'tag_com_controle'};
  return {
    valida: true,
    exibicao,
    chave: exibicao.normalize('NFKC').toLocaleLowerCase('pt-BR')
  };
}

function extrairHashtags(corpo) {
  const tokens = corpo.match(/(?:^|\s)#([^\s#]+)/gu) ?? [];
  const brutas = tokens.map(token => token.trim().slice(1));
  if (brutas.length > 5) return resposta('revisar', 'tags_acima_do_limite');
  const tags = [];
  const chaves = new Set();
  for (const bruta of brutas) {
    const tag = normalizarTag(bruta);
    if (!tag.valida) return resposta('revisar', tag.motivo);
    if (!chaves.has(tag.chave)) {
      chaves.add(tag.chave);
      tags.push(tag);
    }
  }
  return {estado: 'ok', tags};
}

function removerHashtags(corpo) {
  return limparEspacos(corpo.replace(/(?:^|\s)#[^\s#]+/gu, ' '));
}

function partesData(data, timeZone) {
  const formato = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  return Object.fromEntries(formato.formatToParts(data).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function utcDeHorarioLocal({ano, mes, dia, hora, minuto}, timeZone) {
  // Intl nao oferece conversao local->UTC direta. Duas iteracoes convergem para
  // o deslocamento correto inclusive nas zonas com horario de verao.
  let instante = Date.UTC(ano, mes - 1, dia, hora, minuto, 0);
  for (let i = 0; i < 3; i++) {
    const p = partesData(new Date(instante), timeZone);
    const observado = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    instante += Date.UTC(ano, mes - 1, dia, hora, minuto, 0) - observado;
  }
  const corresponde = candidato => {
    const p = partesData(new Date(candidato), timeZone);
    return +p.year === ano && +p.month === mes && +p.day === dia && +p.hour === hora && +p.minute === minuto;
  };
  if (!corresponde(instante)) return {erro: 'prazo_inexistente_no_fuso'};
  // Na volta do horario de verao, o mesmo relogio local ocorre duas vezes. Nao
  // escolhemos uma delas silenciosamente.
  for (const minutos of [-180, -150, -120, -90, -60, -30, 30, 60, 90, 120, 150, 180]) {
    if (corresponde(instante + minutos * 60_000)) return {erro: 'prazo_ambiguo_no_fuso'};
  }
  return {utc: new Date(instante).toISOString()};
}

function dataLocalBase(agora, timeZone) {
  const p = partesData(agora instanceof Date ? agora : new Date(agora), timeZone);
  return {ano: +p.year, mes: +p.month, dia: +p.day};
}

function somarDias({ano, mes, dia}, quantidade) {
  const d = new Date(Date.UTC(ano, mes - 1, dia + quantidade, 12));
  return {ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate()};
}

export function interpretarDataHora(valor, {timeZone, agora = new Date()} = {}) {
  const texto = limparEspacos(valor).toLocaleLowerCase('pt-BR');
  if (!texto) return {valida: false, motivo: 'prazo_ausente'};

  // Instante com offset explicito nao depende do fuso da instalacao.
  const offset = texto.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(z|[+-]\d{2}:\d{2})$/u);
  if (offset) {
    const iso = `${offset[1]}-${offset[2]}-${offset[3]}T${offset[4]}:${offset[5]}:00${offset[6].toUpperCase()}`;
    const data = new Date(iso);
    if (Number.isNaN(data.getTime())) return {valida: false, motivo: 'prazo_impossivel'};
    const [ano, mes, dia, hora, minuto] = offset.slice(1, 6).map(Number);
    const calendario = new Date(Date.UTC(ano, mes - 1, dia));
    if (mes < 1 || mes > 12 || dia < 1 || calendario.getUTCFullYear() !== ano || calendario.getUTCMonth() + 1 !== mes || calendario.getUTCDate() !== dia || hora > 23 || minuto > 59) return {valida: false, motivo: 'prazo_impossivel'};
    return {valida: true, local: texto, utc: data.toISOString(), timeZone: 'offset_explicito'};
  }

  if (!timeZone) return {valida: false, motivo: 'fuso_ausente'};
  try { partesData(new Date(agora), timeZone); } catch { return {valida: false, motivo: 'fuso_invalido'}; }

  let componentes;
  const relativa = texto.match(/^(hoje|amanh[aã])\s+(\d{1,2}):(\d{2})$/u);
  if (relativa) {
    const base = somarDias(dataLocalBase(agora, timeZone), relativa[1] === 'hoje' ? 0 : 1);
    componentes = {...base, hora: +relativa[2], minuto: +relativa[3]};
  } else {
    const local = texto.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})$/u);
    if (!local) return {valida: false, motivo: 'prazo_ambiguo'};
    componentes = {ano: +local[1], mes: +local[2], dia: +local[3], hora: +local[4], minuto: +local[5]};
  }
  const {ano, mes, dia, hora, minuto} = componentes;
  const calendario = new Date(Date.UTC(ano, mes - 1, dia, hora, minuto));
  if (calendario.getUTCFullYear() !== ano || calendario.getUTCMonth() + 1 !== mes || calendario.getUTCDate() !== dia || hora > 23 || minuto > 59) {
    return {valida: false, motivo: 'prazo_impossivel'};
  }
  const convertido = utcDeHorarioLocal(componentes, timeZone);
  if (convertido.erro) return {valida: false, motivo: convertido.erro};
  return {valida: true, local: texto, utc: convertido.utc, timeZone};
}

/** Interpreta sem persistir ou realizar qualquer I/O. */
export function interpretarComando(entrada, opcoes = {}) {
  const textoBruto = String(entrada?.texto ?? '').normalize('NFKC');
  const texto = limparEspacos(entrada?.texto);
  const primeiro = tokenInicial(texto);

  if (!primeiro.startsWith('#lume_')) return resposta('nao_executado', 'nao_e_comando');
  if (!entrada?.fromMe) return resposta('nao_executado', 'autor_nao_autorizado', {comando: primeiro});
  if (entrada?.doProprioBot) return resposta('nao_executado', 'eco_do_aplicativo', {comando: primeiro});
  if (grafemas(textoBruto) > 500) return resposta('revisar', 'mensagem_acima_do_limite', {comando: primeiro});
  if (!COMANDOS.has(primeiro)) return resposta('nao_reconhecido', 'comando_desconhecido', {comando: primeiro});

  const comandosNoTexto = texto.match(/(?:^|\s)(#lume_[\p{L}\p{N}_-]+)/giu) ?? [];
  if (comandosNoTexto.length !== 1) return resposta('revisar', 'mais_de_um_comando', {comando: primeiro});

  const corpo = limparEspacos(texto.slice(texto.split(' ')[0].length));
  if (primeiro === '#lume_ajuda') {
    if (corpo) return resposta('revisar', 'ajuda_com_conteudo', {comando: primeiro});
    return resposta('feito', 'ajuda_disponivel_no_lume', {comando: primeiro, acao: {tipo: 'ajuda'}, tags: []});
  }
  if (!corpo) return resposta('revisar', 'corpo_vazio', {comando: primeiro});

  if (primeiro === '#lume_tarefa') {
    const extraidas = extrairHashtags(corpo);
    if (extraidas.estado !== 'ok') return {...extraidas, comando: primeiro};
    const descricao = removerHashtags(corpo);
    if (!descricao) return resposta('revisar', 'tarefa_vazia', {comando: primeiro});
    return resposta('feito', 'tarefa_criada', {comando: primeiro, acao: {tipo: 'tarefa', texto: descricao}, tags: extraidas.tags});
  }

  if (primeiro === '#lume_lembrete') {
    if ((corpo.match(/\|/gu) ?? []).length !== 1) return resposta('revisar', 'lembrete_ambiguo', {comando: primeiro});
    const [prazoTexto, conteudo] = corpo.split('|').map(limparEspacos);
    const extraidas = extrairHashtags(conteudo);
    if (extraidas.estado !== 'ok') return {...extraidas, comando: primeiro};
    const descricao = removerHashtags(conteudo);
    if (!descricao) return resposta('revisar', 'lembrete_vazio', {comando: primeiro});
    const prazo = interpretarDataHora(prazoTexto, {timeZone: entrada.timeZone ?? opcoes.timeZone, agora: opcoes.agora});
    if (!prazo.valida) return resposta('revisar', prazo.motivo, {comando: primeiro});
    return resposta('feito', 'lembrete_criado', {comando: primeiro, acao: {tipo: 'lembrete', texto: descricao, prazo}, tags: extraidas.tags});
  }

  if (primeiro === '#lume_cliente') {
    const extraidas = extrairHashtags(corpo);
    if (extraidas.estado !== 'ok') return {...extraidas, comando: primeiro};
    if (!extraidas.tags.length || removerHashtags(corpo)) return resposta('revisar', 'cliente_exige_tags', {comando: primeiro});
    if (ehGrupo(entrada.conversaId)) {
      if (!entrada.resposta?.origemId || !entrada.resposta?.autorId) return resposta('revisar', 'alvo_de_grupo_ausente', {comando: primeiro});
      if (entrada.resposta.removida) return resposta('revisar', 'alvo_removido', {comando: primeiro});
      return resposta('feito', 'cliente_classificado', {comando: primeiro, acao: {tipo: 'marcar_cliente', contatoId: entrada.resposta.autorId}, tags: extraidas.tags});
    }
    return resposta('feito', 'cliente_classificado', {comando: primeiro, acao: {tipo: 'marcar_cliente', contatoId: entrada.conversaId}, tags: extraidas.tags});
  }

  const tag = normalizarTag(corpo);
  if (!tag.valida) return resposta('revisar', tag.motivo, {comando: primeiro});
  if (entrada.resposta?.origemId) {
    if (entrada.resposta.removida) return resposta('revisar', 'alvo_removido', {comando: primeiro});
    return resposta('feito', 'mensagem_classificada', {comando: primeiro, acao: {tipo: 'marcar', entidadeTipo: 'mensagem', entidadeId: entrada.resposta.origemId}, tags: [tag]});
  }
  return resposta('feito', 'conversa_classificada', {comando: primeiro, acao: {tipo: 'marcar', entidadeTipo: 'conversa', entidadeId: entrada.conversaId}, tags: [tag]});
}

export function prepararComandosWhatsapp(db) {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS lume_comandos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotencia TEXT NOT NULL UNIQUE,
      contrato TEXT NOT NULL,
      evento_id INTEGER REFERENCES eventos(id) ON DELETE CASCADE,
      conversa_id TEXT NOT NULL,
      origem_id TEXT NOT NULL,
      comando TEXT,
      estado TEXT NOT NULL CHECK(estado IN('feito','revisar','nao_reconhecido','nao_executado','origem_removida')),
      motivo TEXT NOT NULL,
      resultado_json TEXT,
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL,
      UNIQUE(conversa_id, origem_id, contrato)
    );
    CREATE TABLE IF NOT EXISTS lume_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL UNIQUE,
      nome_exibido TEXT NOT NULL,
      criada_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lume_tags_entidades (
      tag_id INTEGER NOT NULL REFERENCES lume_tags(id) ON DELETE CASCADE,
      entidade_tipo TEXT NOT NULL CHECK(entidade_tipo IN('mensagem','conversa','contato','tarefa','lembrete','negocio')),
      entidade_id TEXT NOT NULL,
      comando_id INTEGER NOT NULL REFERENCES lume_comandos(id) ON DELETE CASCADE,
      conversa_id TEXT NOT NULL,
      origem_id TEXT NOT NULL,
      procedencia TEXT NOT NULL DEFAULT 'comando_local' CHECK(procedencia IN('comando_local','interface','externa')),
      estado TEXT NOT NULL DEFAULT 'ativa' CHECK(estado IN('ativa','revisar','origem_removida')),
      criada_em TEXT NOT NULL,
      PRIMARY KEY(tag_id, entidade_tipo, entidade_id, comando_id)
    );
    CREATE TABLE IF NOT EXISTS lume_comando_tarefas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comando_id INTEGER NOT NULL UNIQUE REFERENCES lume_comandos(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      conversa_id TEXT NOT NULL,
      origem_id TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'aberta' CHECK(estado IN('aberta','concluida','revisar','origem_removida')),
      criada_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lume_comando_lembretes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comando_id INTEGER NOT NULL UNIQUE REFERENCES lume_comandos(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      prazo_local TEXT NOT NULL,
      prazo_utc TEXT NOT NULL,
      fuso TEXT NOT NULL,
      conversa_id TEXT NOT NULL,
      origem_id TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'agendado' CHECK(estado IN('agendado','concluido','revisar','origem_removida')),
      criada_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lume_comandos_origem ON lume_comandos(conversa_id, origem_id);
    CREATE INDEX IF NOT EXISTS idx_lume_tags_entidade ON lume_tags_entidades(entidade_tipo, entidade_id, estado);
  `);
  const colunas = db.prepare('PRAGMA table_info(lume_comandos)').all().map(c => c.name);
  if (!colunas.includes('evento_id')) db.exec('ALTER TABLE lume_comandos ADD COLUMN evento_id INTEGER REFERENCES eventos(id) ON DELETE CASCADE');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='eventos'").get()) db.exec(`UPDATE lume_comandos SET evento_id=(SELECT e.id FROM eventos e
      WHERE e.conversa_id=lume_comandos.conversa_id AND e.origem_id=lume_comandos.origem_id)
      WHERE evento_id IS NULL AND EXISTS(SELECT 1 FROM eventos e
        WHERE e.conversa_id=lume_comandos.conversa_id AND e.origem_id=lume_comandos.origem_id)`);
}

function obterOuCriarTag(db, tag, criadoEm) {
  db.prepare('INSERT OR IGNORE INTO lume_tags(chave,nome_exibido,criada_em) VALUES(?,?,?)').run(tag.chave, tag.exibicao, criadoEm);
  return db.prepare('SELECT id,chave,nome_exibido FROM lume_tags WHERE chave=?').get(tag.chave);
}

function associarTags(db, {tags, entidadeTipo, entidadeId, comandoId, conversaId, origemId, criadoEm}) {
  if (!TIPOS_ENTIDADE.has(entidadeTipo)) throw new Error(`tipo de entidade invalido: ${entidadeTipo}`);
  for (const tag of tags) {
    const canonica = obterOuCriarTag(db, tag, criadoEm);
    db.prepare(`INSERT OR IGNORE INTO lume_tags_entidades
      (tag_id,entidade_tipo,entidade_id,comando_id,conversa_id,origem_id,procedencia,estado,criada_em)
      VALUES(?,?,?,?,?,?,'comando_local','ativa',?)`)
      .run(canonica.id, entidadeTipo, String(entidadeId), comandoId, conversaId, origemId, criadoEm);
  }
}

/**
 * Persiste o livro de comandos e seu unico efeito local em uma transacao.
 * A chave (conversa, origem, contrato) torna replay e reinicio idempotentes.
 */
export function processarComando(db, entrada, opcoes = {}) {
  const interpretado = interpretarComando(entrada, opcoes);
  // O fluxo de captura entrega todas as mensagens. Texto comum nao pertence ao
  // livro de comandos e sai antes de preparar schema, validar ids ou abrir uma
  // transacao. Apenas o namespace explicito #lume_ e auditavel aqui.
  if (interpretado.motivo === 'nao_e_comando') {
    return {
      id: null,
      estado: interpretado.estado,
      motivo: interpretado.motivo,
      resultado: interpretado,
      ignorado: true,
      repetido: false
    };
  }
  if (!opcoes.esquemaPreparado) prepararComandosWhatsapp(db);
  const conversaId = String(entrada?.conversaId ?? '');
  const origemId = String(entrada?.origemId ?? '');
  if (!conversaId || !origemId) throw new Error('comando sem conversaId ou origemId');
  const versao = opcoes.versao ?? VERSAO_CONTRATO_COMANDOS;
  const idempotencia = chaveIdempotente({conversaId, origemId, versao});
  const existente = db.prepare('SELECT * FROM lume_comandos WHERE idempotencia=?').get(idempotencia);
  if (existente) return {...linhaComando(existente), repetido: true};

  if (!ESTADOS_FINAIS.has(interpretado.estado)) throw new Error('estado de comando invalido');
  const criadoEm = agoraIso(opcoes.agora);

  const transacaoPropria = !opcoes.transacaoExistente;
  db.exec(transacaoPropria ? 'BEGIN IMMEDIATE' : 'SAVEPOINT lume_processar_comando');
  try {
    const corrida = db.prepare('SELECT * FROM lume_comandos WHERE idempotencia=?').get(idempotencia);
    if (corrida) {
      db.exec(transacaoPropria ? 'COMMIT' : 'RELEASE lume_processar_comando');
      return {...linhaComando(corrida), repetido: true};
    }
    const info = db.prepare(`INSERT INTO lume_comandos
      (idempotencia,contrato,evento_id,conversa_id,origem_id,comando,estado,motivo,resultado_json,criado_em,atualizado_em)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        idempotencia, versao, entrada.eventoId ?? null, conversaId, origemId, interpretado.comando ?? null,
        interpretado.estado, interpretado.motivo, JSON.stringify(interpretado), criadoEm, criadoEm
      );
    const comandoId = Number(info.lastInsertRowid);
    const acao = interpretado.acao;
    if (interpretado.estado === 'feito' && acao?.tipo === 'tarefa') {
      const tarefa = db.prepare(`INSERT INTO lume_comando_tarefas(comando_id,texto,conversa_id,origem_id,criada_em)
        VALUES(?,?,?,?,?)`).run(comandoId, acao.texto, conversaId, origemId, criadoEm);
      associarTags(db, {tags: interpretado.tags, entidadeTipo: 'tarefa', entidadeId: tarefa.lastInsertRowid, comandoId, conversaId, origemId, criadoEm});
    } else if (interpretado.estado === 'feito' && acao?.tipo === 'lembrete') {
      const lembrete = db.prepare(`INSERT INTO lume_comando_lembretes
        (comando_id,texto,prazo_local,prazo_utc,fuso,conversa_id,origem_id,criada_em) VALUES(?,?,?,?,?,?,?,?)`)
        .run(comandoId, acao.texto, acao.prazo.local, acao.prazo.utc, acao.prazo.timeZone, conversaId, origemId, criadoEm);
      associarTags(db, {tags: interpretado.tags, entidadeTipo: 'lembrete', entidadeId: lembrete.lastInsertRowid, comandoId, conversaId, origemId, criadoEm});
    } else if (interpretado.estado === 'feito' && acao?.tipo === 'marcar_cliente') {
      associarTags(db, {tags: interpretado.tags, entidadeTipo: 'contato', entidadeId: acao.contatoId, comandoId, conversaId, origemId, criadoEm});
    } else if (interpretado.estado === 'feito' && acao?.tipo === 'marcar') {
      associarTags(db, {tags: interpretado.tags, entidadeTipo: acao.entidadeTipo, entidadeId: acao.entidadeId, comandoId, conversaId, origemId, criadoEm});
    }
    db.exec(transacaoPropria ? 'COMMIT' : 'RELEASE lume_processar_comando');
    return {...linhaComando(db.prepare('SELECT * FROM lume_comandos WHERE id=?').get(comandoId)), repetido: false};
  } catch (erro) {
    db.exec(transacaoPropria ? 'ROLLBACK' : 'ROLLBACK TO lume_processar_comando; RELEASE lume_processar_comando');
    throw erro;
  }
}

function linhaComando(linha) {
  return {
    id: Number(linha.id),
    idempotencia: linha.idempotencia,
    contrato: linha.contrato,
    eventoId: linha.evento_id == null ? null : Number(linha.evento_id),
    conversaId: linha.conversa_id,
    origemId: linha.origem_id,
    comando: linha.comando,
    estado: linha.estado,
    motivo: linha.motivo,
    resultado: linha.resultado_json ? JSON.parse(linha.resultado_json) : null
  };
}

export function validarBackupComandos(tabelas) {
  const falhar = () => { throw new Error('Comandos ou tags incompatíveis no backup.'); };
  if (!tabelas || TABELAS_COMANDOS.some(nome => !Array.isArray(tabelas[nome]))) falhar();
  const eventos = new Map((tabelas.eventos ?? []).map(e => [Number(e.id), e]));
  const comandos = new Map();
  const idempotencias = new Set();
  for (const c of tabelas.lume_comandos) {
    if (!Number.isSafeInteger(c.id) || c.id < 1 || comandos.has(c.id) || typeof c.idempotencia !== 'string' || !c.idempotencia || idempotencias.has(c.idempotencia)
      || typeof c.contrato !== 'string' || !c.contrato || typeof c.conversa_id !== 'string' || !c.conversa_id || typeof c.origem_id !== 'string' || !c.origem_id
      || !['feito', 'revisar', 'nao_reconhecido', 'nao_executado', 'origem_removida'].includes(c.estado)
      || typeof c.motivo !== 'string' || !c.motivo || !Number.isFinite(Date.parse(c.criado_em)) || !Number.isFinite(Date.parse(c.atualizado_em))) falhar();
    if (!Number.isSafeInteger(c.evento_id) || c.evento_id < 1) falhar();
    const evento = eventos.get(Number(c.evento_id));
    if (!evento || evento.conversa_id !== c.conversa_id || evento.origem_id !== c.origem_id || !evento.autor_e_dono || evento.permissao !== 'minha') falhar();
    try { if (c.resultado_json !== null) JSON.parse(c.resultado_json); } catch { falhar(); }
    comandos.set(c.id, c); idempotencias.add(c.idempotencia);
  }
  const tags = new Map();
  for (const tag of tabelas.lume_tags) {
    if (!Number.isSafeInteger(tag.id) || tag.id < 1 || tags.has(tag.id) || typeof tag.chave !== 'string' || !normalizarTag(tag.nome_exibido).valida
      || normalizarTag(tag.nome_exibido).chave !== tag.chave || !Number.isFinite(Date.parse(tag.criada_em))) falhar();
    tags.set(tag.id, tag);
  }
  const efeitos = new Set();
  for (const a of tabelas.lume_tags_entidades) {
    const comando = comandos.get(Number(a.comando_id));
    const chave = `${a.tag_id}|${a.entidade_tipo}|${a.entidade_id}|${a.comando_id}`;
    if (!tags.has(Number(a.tag_id)) || !comando || efeitos.has(chave) || !TIPOS_ENTIDADE.has(a.entidade_tipo) || typeof a.entidade_id !== 'string' || !a.entidade_id
      || a.conversa_id !== comando.conversa_id || a.origem_id !== comando.origem_id || !['comando_local', 'interface', 'externa'].includes(a.procedencia)
      || !['ativa', 'revisar', 'origem_removida'].includes(a.estado) || !Number.isFinite(Date.parse(a.criada_em))) falhar();
    efeitos.add(chave);
  }
  const unicos = new Set();
  for (const [nome, estados] of [['lume_comando_tarefas', ['aberta', 'concluida', 'revisar', 'origem_removida']], ['lume_comando_lembretes', ['agendado', 'concluido', 'revisar', 'origem_removida']]]) {
    for (const item of tabelas[nome]) {
      const comando = comandos.get(Number(item.comando_id));
      const chave = `${nome}|${item.comando_id}`;
      if (!Number.isSafeInteger(item.id) || item.id < 1 || !comando || unicos.has(chave) || typeof item.texto !== 'string' || !item.texto
        || item.conversa_id !== comando.conversa_id || item.origem_id !== comando.origem_id || !estados.includes(item.estado) || !Number.isFinite(Date.parse(item.criada_em))) falhar();
      if (nome === 'lume_comando_lembretes' && (typeof item.prazo_local !== 'string' || !Number.isFinite(Date.parse(item.prazo_utc)) || typeof item.fuso !== 'string' || !item.fuso)) falhar();
      unicos.add(chave);
    }
  }
}

/** Invalida derivados sem apagar auditoria ou uma decisao humana posterior. */
export function invalidarOrigemComando(db, {conversaId, origemId, removida = false, agora = new Date(), transacaoExistente = false, esquemaPreparado = false} = {}) {
  if (!esquemaPreparado) prepararComandosWhatsapp(db);
  const novoEstado = removida ? 'origem_removida' : 'revisar';
  const quando = agoraIso(agora);
  db.exec(transacaoExistente ? 'SAVEPOINT lume_invalidar_origem' : 'BEGIN IMMEDIATE');
  try {
    const comandos = db.prepare('SELECT id,estado,motivo FROM lume_comandos WHERE conversa_id=? AND origem_id=?').all(conversaId, origemId);
    let afetados = 0;
    for (const {id,estado,motivo} of comandos) {
      // Remocao e terminal para o ciclo automatico: uma edicao atrasada nao
      // pode ressuscitar nem rebaixar uma origem que ja foi apagada.
      if (estado === 'origem_removida' || (!removida && estado === 'revisar' && motivo === 'origem_editada')) continue;
      db.prepare('UPDATE lume_comandos SET estado=?,motivo=?,atualizado_em=? WHERE id=?').run(novoEstado, removida ? 'origem_removida' : 'origem_editada', quando, id);
      db.prepare(`UPDATE lume_tags_entidades SET estado=? WHERE comando_id=? AND estado IN(${removida ? "'ativa','revisar'" : "'ativa'"})`).run(novoEstado, id);
      db.prepare(`UPDATE lume_comando_tarefas SET estado=? WHERE comando_id=? AND estado IN(${removida ? "'aberta','revisar'" : "'aberta'"})`).run(novoEstado, id);
      db.prepare(`UPDATE lume_comando_lembretes SET estado=? WHERE comando_id=? AND estado IN(${removida ? "'agendado','revisar'" : "'agendado'"})`).run(novoEstado, id);
      afetados++;
    }
    db.exec(transacaoExistente ? 'RELEASE lume_invalidar_origem' : 'COMMIT');
    return {afetados, estado: novoEstado};
  } catch (erro) {
    db.exec(transacaoExistente ? 'ROLLBACK TO lume_invalidar_origem; RELEASE lume_invalidar_origem' : 'ROLLBACK');
    throw erro;
  }
}

export function listarEntidadesPorTag(db, tag) {
  prepararComandosWhatsapp(db);
  const normalizada = normalizarTag(tag);
  if (!normalizada.valida) return [];
  return db.prepare(`SELECT te.entidade_tipo,te.entidade_id,te.conversa_id,te.origem_id,
      te.procedencia,te.estado,t.nome_exibido,t.chave
    FROM lume_tags t JOIN lume_tags_entidades te ON te.tag_id=t.id
    WHERE t.chave=? AND te.estado='ativa' ORDER BY te.criada_em,te.entidade_tipo,te.entidade_id`).all(normalizada.chave);
}
