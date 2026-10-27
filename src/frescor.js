// Fase 1 do `docs/PLAN-frescor-itens.md`: fechar o que ja morreu. Sem modelo, sem custo.
//
// O achado que originou: 152 itens abertos, zero tocados, e o painel ordenando por
// antiguidade -- empurrando o mais podre para o topo.
//
// A medicao de 11/09/2026 corrigiu a premissa do plano. O plano culpava "3.661
// mensagens chegaram depois de cada item". Nao e sinal:
//
//   - 126 dos 152 itens vem de grupo, e 95 de UM grupo so (WAVES, ~130 msg/dia).
//   - Um item de 1 dia ja tem 261-362 mensagens depois; um de 30 dias tem 3.600.
//     Ou seja: msgs_depois ~= ritmo da conversa x tempo. Ele mede o barulho do
//     grupo, nao a idade do item.
//   - O tempo ja e essa medida, normalizada. Por isso a regra olha dias, e
//     `msgs_depois` fica no painel so como contexto para quem for conferir.
//
// Mesma disciplina na segunda regra: "a pergunta teve resposta do outro lado" so
// distingue alguma coisa em DM. Em grupo "o outro lado" e todo mundo, e alguem
// sempre fala depois -- a regra aplicada a grupo fecharia 93 dos 152 itens sem
// que nenhum deles tivesse sido realmente respondido.

export const DIAS_PADRAO = 30;
export const HORAS_RESPOSTA = 6;

const DIA_MS = 86400000;

/** Itens abertos com os dois sinais deterministicos anexados. */
export function itensAbertos(db) {
  return db.prepare(`
    SELECT i.id, i.tipo, i.quando, i.resumo, i.conversa_id,
           COALESCE(g.nome, c.nome, i.conversa_id) AS conversa_nome,
           (i.conversa_id LIKE '%@g.us') AS grupo,
           (SELECT COUNT(*) FROM eventos e
             WHERE e.conversa_id = i.conversa_id AND e.recebido_em > i.quando) AS depois,
           CASE WHEN i.conversa_id LIKE '%@g.us' THEN NULL ELSE (
             SELECT MIN(r.recebido_em) FROM eventos r
              WHERE r.conversa_id = i.conversa_id
                AND r.recebido_em > i.quando
                AND r.texto IS NOT NULL AND r.texto <> ''
                AND r.autor_e_dono <> (SELECT o.autor_e_dono FROM eventos o
                                        WHERE o.conversa_id = i.conversa_id
                                          AND o.origem_id = i.origem_id LIMIT 1)
           ) END AS resposta_em
    FROM itens_crm i
    LEFT JOIN grupos_app g ON g.id = i.conversa_id
    LEFT JOIN conversas_app c ON c.id = i.conversa_id
    WHERE i.estado = 'aberto'
  `).all();
}

/**
 * Veredito de um item, ou `null` para "continua aberto".
 *
 * Ordem importa: respondido e mais especifico que velho. Um item respondido ha 60
 * dias foi resolvido, nao expirou -- e so `resolvido` conta para a metrica que o
 * produto precisa medir.
 */
export function classificar(item, { dias = DIAS_PADRAO, horas = HORAS_RESPOSTA, agora = Date.now() } = {}) {
  const nasceu = Date.parse(item.quando);
  if (Number.isNaN(nasceu)) return null; // sem data resolvivel nao se decide nada

  if (item.tipo === 'pendencia' && !item.grupo && item.resposta_em) {
    const espera = (Date.parse(item.resposta_em) - nasceu) / 3600000;
    if (espera >= 0 && espera <= horas) {
      return { estado: 'resolvido', motivo: `o outro lado respondeu em ${espera.toFixed(1)}h` };
    }
  }

  const idade = Math.floor((agora - nasceu) / DIA_MS);
  if (idade > dias) {
    return { estado: 'expirado', motivo: `${idade} dias sem reconferencia` };
  }
  return null;
}

export function avaliar(db, opcoes = {}) {
  const abertos = itensAbertos(db);
  const decisoes = [];
  for (const item of abertos) {
    const veredito = classificar(item, opcoes);
    if (veredito) decisoes.push({ ...item, ...veredito });
  }
  return { abertos, decisoes, restantes: abertos.length - decisoes.length };
}

export function aplicar(db, decisoes) {
  const agora = new Date().toISOString();
  const mudar = db.prepare(
    'UPDATE itens_crm SET estado=?, estado_em=?, estado_motivo=? WHERE id=? AND estado=\'aberto\''
  );
  let mudados = 0;
  db.exec('BEGIN');
  try {
    for (const d of decisoes) mudados += mudar.run(d.estado, agora, d.motivo, d.id).changes;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return mudados;
}
