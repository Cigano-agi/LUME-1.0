// Medição de precisão do CRM: saber se a lista de tarefas e compromissos mente.
//
// Oportunidade 0,90: o usuário perde a confiança se a lista tiver falso positivo.
// Sem medição, não há como saber se a extração está melhorando ou degradando.
//
// Regras de precisão:
// 1. Nada é apagado: descartar é mudança de estado ('descartado'), nunca remoção.
// 2. Reversível: marcar falso positivo e desmarcar devolve o item para 'aberto'.
// 3. Taxa não inventa certeza: sem julgamentos (julgados === 0), a taxa é null,
//    nunca 0 nem 1 nem NaN.
// 4. Expirado por frescor não conta como falso positivo nem como aceite.

import { agoraIso } from './relogio.js';

/**
 * Garante que a tabela itens_crm e as colunas necessárias para precisão existam.
 * É idempotente: pode ser chamada múltiplas vezes sem erro.
 */
export function prepararEsquemaPrecisao(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS itens_crm (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      conversa_id   TEXT NOT NULL,
      origem_id     TEXT NOT NULL,
      tipo          TEXT NOT NULL CHECK (tipo IN ('compromisso','pendencia','lead','decisao')),
      resumo        TEXT NOT NULL,
      responsavel   TEXT,
      quando        TEXT,
      estado        TEXT NOT NULL DEFAULT 'aberto' CHECK (estado IN ('aberto','resolvido','descartado','expirado')),
      extraido_em   TEXT NOT NULL,
      modelo        TEXT,
      estado_em     TEXT,
      estado_motivo TEXT,
      UNIQUE(conversa_id, origem_id, tipo)
    );
  `);

  const colunas = new Set(
    db.prepare('PRAGMA table_info(itens_crm)').all().map(c => c.name)
  );

  if (!colunas.has('estado')) {
    db.exec("ALTER TABLE itens_crm ADD COLUMN estado TEXT NOT NULL DEFAULT 'aberto'");
  }
  if (!colunas.has('estado_em')) {
    db.exec('ALTER TABLE itens_crm ADD COLUMN estado_em TEXT');
  }
  if (!colunas.has('estado_motivo')) {
    db.exec('ALTER TABLE itens_crm ADD COLUMN estado_motivo TEXT');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_itens_crm_estado ON itens_crm(estado, tipo);
    CREATE INDEX IF NOT EXISTS idx_itens_crm_estado_em ON itens_crm(estado_em);
  `);
}

/**
 * Normaliza o itemId para um identificador seguro.
 * Evita exceções de bind no SQLite com valores como undefined, booleanos ou objetos.
 */
function normalizarId(itemId) {
  if (typeof itemId === 'number') {
    return Number.isSafeInteger(itemId) && itemId > 0 ? itemId : null;
  }
  if (typeof itemId === 'bigint') {
    return itemId > 0n ? itemId : null;
  }
  if (typeof itemId === 'string' && itemId.trim() !== '') {
    const n = Number(itemId);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Normaliza o parâmetro `desde` para comparação temporal.
 * Valores nulos ou vazios desativam o filtro temporal.
 */
function normalizarDesde(desde) {
  if (desde == null || desde === '') return null;
  if (desde instanceof Date) return desde.toISOString();
  if (typeof desde === 'number' && Number.isFinite(desde)) {
    return new Date(desde).toISOString();
  }
  if (typeof desde === 'string') {
    const s = desde.trim();
    if (!s) return null;
    const t = Date.parse(s);
    if (!Number.isNaN(t)) {
      try {
        return new Date(t).toISOString();
      } catch {
        return s;
      }
    }
    return s;
  }
  return String(desde);
}

/**
 * Marca um item do CRM como falso positivo.
 * Move para estado='descartado', carimba a data ISO atual e prefixa o motivo.
 */
export function marcarFalsoPositivo(db, { itemId, motivo } = {}) {
  const id = normalizarId(itemId);
  if (id === null) return false;

  const agora = agoraIso();
  const motivoTexto = motivo != null ? String(motivo) : '';
  const estadoMotivo = `falso positivo: ${motivoTexto}`;

  const info = db.prepare(`
    UPDATE itens_crm
    SET estado = 'descartado',
        estado_em = ?,
        estado_motivo = ?
    WHERE id = ?
  `).run(agora, estadoMotivo, id);

  return info.changes > 0;
}

/**
 * Desmarca um item do CRM, devolvendo para estado='aberto' e limpando motivo e data.
 * Reversão segura: nada é apagado.
 */
export function desmarcar(db, { itemId } = {}) {
  const id = normalizarId(itemId);
  if (id === null) return false;

  const info = db.prepare(`
    UPDATE itens_crm
    SET estado = 'aberto',
        estado_em = NULL,
        estado_motivo = NULL
    WHERE id = ?
  `).run(id);

  return info.changes > 0;
}

/**
 * Calcula a precisão dos itens julgados no CRM.
 * Julgados = aceitos (resolvido) + falsos (descartado).
 * Itens em 'aberto' e 'expirado' (frescor) não contam como julgamento.
 *
 * Taxa = aceitos / julgados.
 * Se julgados === 0, taxa é estritamente null.
 */
export function precisao(db, { desde } = {}) {
  const filtroDesde = normalizarDesde(desde);

  // Só conta JULGAMENTO HUMANO. Regra automática não é evidência sobre a qualidade do
  // item, e contá-la corrompe justamente a métrica que existe para detectar mentira.
  //
  // Medido em 12/09 contra o banco real: os 5 itens `resolvido` do banco foram fechados
  // pelo frescor com motivo "o outro lado respondeu em 0.1h" — a outra pessoa já tinha
  // respondido antes do item nascer. Contando-os como aceitos, a taxa dava **1,00**, ou
  // seja, "100% de precisão" num sistema onde ninguém julgou nada. Falso conforto é pior
  // que métrica ausente: `null` faz perguntar, `1,00` faz relaxar.
  //
  // O que separa os dois é o `estado_motivo`: o frescor escreve "N dias sem reconferencia"
  // e "o outro lado respondeu em Xh"; o julgamento humano escreve "falso positivo: ..."
  // ou não escreve motivo nenhum (o dono clicou em Resolver).
  // COALESCE obrigatório: em SQL, `NULL LIKE 'x'` é NULL e `NOT NULL` também é NULL, então
  // a linha sairia do resultado. Item sem motivo é justamente o dono clicando "Resolver" —
  // o julgamento humano mais puro que existe — e ele sumiria da conta sem nenhum erro.
  const AUTOMATICO = "(COALESCE(estado_motivo,'') LIKE 'o outro lado respondeu%' OR COALESCE(estado_motivo,'') LIKE '%sem reconferencia%')";
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN estado = 'descartado' THEN 1 ELSE 0 END) AS falsos,
      SUM(CASE WHEN estado = 'resolvido' THEN 1 ELSE 0 END) AS aceitos
    FROM itens_crm
    WHERE estado IN ('resolvido', 'descartado')
      AND NOT ${AUTOMATICO}
      AND (? IS NULL OR estado_em >= ?)
  `).get(filtroDesde, filtroDesde);

  const falsos = Number(row?.falsos ?? 0);
  const aceitos = Number(row?.aceitos ?? 0);
  const julgados = Number(row?.total ?? 0);

  const taxa = julgados === 0 ? null : aceitos / julgados;

  return {
    julgados,
    falsos,
    aceitos,
    taxa
  };
}
