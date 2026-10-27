// SPEC-F6 — Permissão na origem
//
// Resolve o problema medido em 12/09: itens de CRM e tarefas do dono nasciam a partir de
// ruído de terceiros em grupos ("Fechar 2 orçamentos", "Criar cópia do repositório").
//
// Princípio de arquitetura: controle de acesso na recuperação e na origem, não no prompt.
// A classificação acontece na ingestão e rotula cada evento como 'minha', 'dirigida' ou 'terceiro'.
//
// REGRA CRÍTICA: NENHUM EVENTO É DESCARTADO.
// O banco continua guardando absolutamente tudo que chega. Classificar nunca pode virar
// descartar — mensagem não capturada não volta. O rótulo decide o que o CRM e o painel usam.
import {LEITURA_SQL,DERIVADOS_SEM_REVOGACAO_SQL} from './leitura-sql.js';

/**
 * Normaliza e compara dois identificadores do WhatsApp (JID, LID ou número puro).
 * Trata variações de sufixo (@s.whatsapp.net, @lid, @c.us) para não falhar por formato.
 */
function mesmoIdentificador(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const limpoA = String(a).trim().replace(/@(s\.whatsapp\.net|c\.us|lid)$/, '');
  const limpoB = String(b).trim().replace(/@(s\.whatsapp\.net|c\.us|lid)$/, '');
  return limpoA.length > 0 && limpoA === limpoB;
}

/**
 * Extrai informações contextuais estruturadas (menções e citações) do objeto bruto.
 * Suporta formatos Baileys aninhados (ephemeral, viewOnce, extendedTextMessage, etc.).
 *
 * NOTA ADVERSARIAL: Menção é campo estruturado (contextInfo.mentionedJid), NUNCA
 * busca por substring no texto. Texto de terceiro contendo "@Fabricio" não é menção.
 */
function extrairContextInfo(bruto) {
  if (!bruto) return null;
  let obj = bruto;
  if (typeof bruto === 'string') {
    try {
      obj = JSON.parse(bruto);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const msg = obj.mensagem?.message ?? obj.message ?? obj.mensagem ?? obj;

  let inner = msg;
  for (let i = 0; i < 8; i++) {
    if (!inner || typeof inner !== 'object') break;
    const desempacotado =
      inner.ephemeralMessage?.message ??
      inner.viewOnceMessage?.message ??
      inner.viewOnceMessageV2?.message ??
      inner.documentWithCaptionMessage?.message;
    if (!desempacotado) break;
    inner = desempacotado;
  }

  if (inner?.contextInfo) return inner.contextInfo;

  if (typeof inner === 'object') {
    for (const chave of Object.keys(inner)) {
      const sub = inner[chave];
      if (sub && typeof sub === 'object' && sub.contextInfo) {
        return sub.contextInfo;
      }
    }
  }

  if (obj.contextInfo) return obj.contextInfo;
  return null;
}

/**
 * Prepara o esquema de permissões e políticas no banco de dados.
 * Idempotente: garante tabela de políticas e coluna `permissao` em `eventos`.
 */
export function garantirEsquema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS politicas_conversa (
      conversa_id   TEXT PRIMARY KEY,
      politica      TEXT NOT NULL CHECK (politica IN ('so-minhas', 'tudo')),
      atualizado_em TEXT NOT NULL
    );
  `);

  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='eventos'").all();
  if (tabelas.length > 0) {
    const colunas = db.prepare('PRAGMA table_info(eventos)').all().map((c) => c.name);
    if (!colunas.includes('permissao')) {
      db.exec('ALTER TABLE eventos ADD COLUMN permissao TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_eventos_permissao ON eventos(conversa_id, permissao)');
  }
}

/**
 * Classifica um evento recebido quanto à sua permissão/procedência:
 * - 'minha': mensagem enviada pelo dono (autor_e_dono = 1 ou autorId === donoId)
 * - 'dirigida': DM de outra pessoa, menção estruturada ao dono em grupo, ou resposta a mensagem dele
 * - 'terceiro': o resto das mensagens em grupo
 *
 * Função pura: não muta a entrada nem acessa banco de dados.
 */
export function classificar(evento, { donoId = null, politica = null } = {}) {
  // Protege contra entradas nulas ou inválidas sem lançar exceção
  if (!evento || typeof evento !== 'object') return 'terceiro';

  const donoEfetivo = donoId || process.env.ASSESSOR_DONO || null;

  // 1. Mensagem do dono é sempre 'minha' (Critério A1)
  const autorEDono = Boolean(evento.autorEDono ?? evento.autor_e_dono);
  if (autorEDono) return 'minha';

  const autorId = evento.autorId ?? evento.autor_id ?? null;
  if (donoEfetivo && autorId && mesmoIdentificador(autorId, donoEfetivo)) {
    return 'minha';
  }

  // 2. Distinção grupo x DM
  const conversaId = String(evento.conversaId ?? evento.conversa_id ?? '');
  const ehGrupo = conversaId.endsWith('@g.us');

  // DM de outra pessoa é sempre 'dirigida' (Critério A2)
  if (!ehGrupo) {
    return 'dirigida';
  }

  // 3. Em grupo: verificar se é dirigida ao dono (Critério A4)
  // Menção direta no objeto do evento
  const mencoesDiretas = evento.mencoes ?? evento.mencao ?? evento.mentionedJids ?? evento.mentionedJid ?? [];
  const listaMencoes = Array.isArray(mencoesDiretas) ? mencoesDiretas : [mencoesDiretas];

  let mencionouDono = false;
  if (donoEfetivo) {
    mencionouDono = listaMencoes.some((m) => mesmoIdentificador(m, donoEfetivo));
  }

  // Resposta/citação direta no objeto do evento
  const autorCitadoDireto =
    evento.respostaPara ??
    evento.respostaA ??
    evento.citacaoAutor ??
    evento.quotedParticipant ??
    null;

  let respondeuAoDono = false;
  if (donoEfetivo && autorCitadoDireto) {
    respondeuAoDono = mesmoIdentificador(autorCitadoDireto, donoEfetivo);
  }
  if (evento.respostaAoDono || evento.citacaoDono) {
    respondeuAoDono = true;
  }

  // Se ainda não achou nem menção nem resposta ao dono, inspeciona campos estruturados no bruto (Achado 5).
  // Se qualquer um dos dois já é verdadeiro, a mensagem já é garantidamente 'dirigida',
  // dispensando processamento adicional do bruto (evita desperdício e risco de efeitos colaterais).
  if (!mencionouDono && !respondeuAoDono) {
    const contextInfo = extrairContextInfo(evento.bruto);
    if (contextInfo) {
      if (donoEfetivo && Array.isArray(contextInfo.mentionedJid)) {
        mencionouDono = contextInfo.mentionedJid.some((m) => mesmoIdentificador(m, donoEfetivo));
      }

      if (!mencionouDono) {
        if (donoEfetivo && contextInfo.participant && mesmoIdentificador(contextInfo.participant, donoEfetivo)) {
          respondeuAoDono = true;
        } else if (contextInfo.fromMe || contextInfo.isQuotedMessageFromMe || contextInfo.quotedMessage?.key?.fromMe) {
          respondeuAoDono = true;
        }
      }
    }
  }

  if (mencionouDono || respondeuAoDono) {
    return 'dirigida';
  }

  // 4. O restante em grupo é terceiro (Critério A3)
  return 'terceiro';
}

/**
 * Consulta a política vigente para uma conversa.
 * Padrão (Critério A5):
 * - grupo (@g.us): 'so-minhas'
 * - DM: 'tudo'
 */
export function politicaDaConversa(db, conversaId) {
  garantirEsquema(db);
  const id = String(conversaId ?? '');
  const config = db.prepare('SELECT politica FROM politicas_conversa WHERE conversa_id = ?').get(id);
  if (config?.politica) {
    return config.politica;
  }

  // Padrão sem configuração: grupo restrito, DM aberta
  return id.endsWith('@g.us') ? 'so-minhas' : 'tudo';
}

/**
 * Grava a política definida para uma conversa ('so-minhas' ou 'tudo').
 */
export function definirPolitica(db, { conversaId, politica }) {
  if (!conversaId || typeof conversaId !== 'string') {
    throw new TypeError('conversaId deve ser uma string valida');
  }
  if (politica !== 'so-minhas' && politica !== 'tudo') {
    throw new TypeError(`Politica desconhecida: "${politica}". Use "so-minhas" ou "tudo".`);
  }

  garantirEsquema(db);
  const agora = new Date().toISOString();
  db.prepare(`
    INSERT INTO politicas_conversa (conversa_id, politica, atualizado_em)
    VALUES (?, ?, ?)
    ON CONFLICT(conversa_id) DO UPDATE SET
      politica = excluded.politica,
      atualizado_em = excluded.atualizado_em
  `).run(conversaId, politica, agora);

  return { conversaId, politica };
}

/**
 * Retorna os eventos visíveis de uma conversa conforme a política configurada (Critério A7).
 * 'tudo': retorna as mensagens ainda permitidas, inclusive de terceiros.
 * 'so-minhas': retorna apenas mensagens com permissao IN ('minha', 'dirigida').
 */
export function eventosVisiveis(db, conversaId) {
  garantirEsquema(db);
  const politica = politicaDaConversa(db, conversaId);
  if (politica === 'tudo') {
    return db
      .prepare(`SELECT e.* FROM eventos e WHERE e.conversa_id = ? AND ${LEITURA_SQL} ORDER BY e.recebido_em ASC, e.id ASC`)
      .all(conversaId);
  }
  return db
    .prepare(
      `SELECT e.* FROM eventos e WHERE e.conversa_id = ? AND e.permissao IN ('minha', 'dirigida') AND ${DERIVADOS_SEM_REVOGACAO_SQL} ORDER BY e.recebido_em ASC, e.id ASC`
    )
    .all(conversaId);
}

/**
 * Filtra uma lista de eventos em memória conforme a política.
 * Alinhado estritamente com a semântica SQL de eventosVisiveis:
 * - 'tudo': preserva apenas eventos com permissão ainda definida.
 * - 'so-minhas': apenas eventos com permissao IN ('minha', 'dirigida').
 * Mensagens sem permissão definida (null, undefined ou valores desconhecidos) NUNCA
 * passam como visíveis sob 'so-minhas' (Achados 3 e 4 — evita entrada silenciosa de lixo).
 */
export function filtrarPorPolitica(eventos, politica = 'so-minhas') {
  if (!Array.isArray(eventos)) return [];
  if (politica === 'tudo') return eventos.filter(e=>{
    if(!e||typeof e!=='object')return false;
    if(Object.hasOwn(e,'permissao'))return e.permissao!=null;
    return !Object.hasOwn(e,'permissao_origem')||e.permissao_origem!=null;
  });
  return eventos.filter((e) => {
    if (!e || typeof e !== 'object') return false;
    const perm = Object.hasOwn(e,'permissao')?e.permissao:e.permissao_origem;
    return perm === 'minha' || perm === 'dirigida';
  });
}

/**
 * Reclassifica um evento já existente no banco de dados com base nas regras da F6.
 * Lê o evento e seu payload bruto, reavalia a classificação via classificar() e
 * atualiza a coluna `permissao` no banco.
 * Garante que colunas temporais (recebido_em, dia_local) nunca sejam alteradas (Achado 1 / Caso Temporal).
 */
export function reclassificarEvento(db, idOuOrigemId, { donoId = null } = {}) {
  garantirEsquema(db);
  const eventoLinha = db.prepare(
    'SELECT * FROM eventos WHERE id = ? OR origem_id = ?'
  ).get(idOuOrigemId, String(idOuOrigemId));

  if (!eventoLinha) {
    throw new Error(`Evento não encontrado para reclassificação: ${idOuOrigemId}`);
  }

  let bruto = null;
  if (eventoLinha.bruto) {
    try {
      bruto = JSON.parse(eventoLinha.bruto);
    } catch {
      bruto = eventoLinha.bruto;
    }
  }

  const eventoParaClassificar = {
    ...eventoLinha,
    conversaId: eventoLinha.conversa_id,
    origemId: eventoLinha.origem_id,
    autorId: eventoLinha.autor_id,
    autorEDono: Boolean(eventoLinha.autor_e_dono),
    recebidoEm: eventoLinha.recebido_em,
    bruto
  };

  const novaPermissao = classificar(eventoParaClassificar, { donoId });
  db.prepare('UPDATE eventos SET permissao = ? WHERE id = ?').run(novaPermissao, eventoLinha.id);

  return {
    id: eventoLinha.id,
    origemId: eventoLinha.origem_id,
    permissao: novaPermissao,
    anterior: eventoLinha.permissao
  };
}
