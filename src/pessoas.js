// Identidade de pessoa: uma pessoa, muitos identificadores.
//
// O problema medido em 11/09 e reconfirmado em 12/09: o banco tem 3.394 autores distintos
// e o app exibe nome para 193. O resto aparece como `267220265488501` ou
// `11630838558759@lid` — inclusive dentro dos itens de CRM, onde "quem" é metade da
// informação. Um lead cujo responsável é um número não é acionável.
//
// O nome nunca esteve perdido. Ele chega em toda mensagem ao vivo, no `pushName`, e
// `src/contexto-app.js` descartava quando a conversa era grupo — que é onde está quase
// todo mundo. Medido: **766 pessoas** têm nome recuperável do `bruto` já gravado, sem
// chamar a API do WhatsApp uma única vez.
//
// Por que não é `Map<id, nome>` numa coluna de conversa: a mesma pessoa aparece com
// identificadores diferentes (`235166790353081@lid` e outro id, ambos Victor Mendes
// Ribeiro). Sem entidade canônica, o RAG conta a pessoa duas vezes e responde errado a
// "o que o Victor falou sobre X".
//
// Três regras que sustentam o resto:
//  - `nome_cru` nunca é sobrescrito por derivação. O limpo é coluna à parte: se a regra de
//    limpeza errar, o original está lá para refazer. Mesmo princípio do `origem_id` do CRM.
//  - Fusão é reversível: unir grava `fundida_em`, nunca apaga linha.
//  - Toda identidade tem origem e data. `manual` > `usync` > `grupo` > `pushName`.

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS pessoas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_cru       TEXT NOT NULL,
  nome_exibicao  TEXT,
  telefone       TEXT,
  fundida_em     INTEGER REFERENCES pessoas(id),
  atualizado_em  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pessoa_identificadores (
  identificador  TEXT PRIMARY KEY,
  pessoa_id      INTEGER NOT NULL REFERENCES pessoas(id),
  origem         TEXT NOT NULL CHECK (origem IN ('pushName','usync','grupo','manual','zip')),
  visto_em       TEXT NOT NULL,
  ativo          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pessoa_ident_pessoa ON pessoa_identificadores(pessoa_id);
CREATE INDEX IF NOT EXISTS idx_pessoas_fundida ON pessoas(fundida_em);
`;

// Quanto vale cada fonte. Um nome digitado à mão nunca é derrubado por um pushName que
// a pessoa mudou para "🔥 PROMOÇÃO 🔥" na semana seguinte.
const PESO_ORIGEM = { manual: 4, usync: 3, grupo: 2, zip: 1, pushName: 1 };

export function prepararEsquemaPessoas(db) {
  db.exec(ESQUEMA);
}

// ------------------------------------------------------------------- nome de exibição

// Emoji, símbolos decorativos e caixas de desenho que as pessoas usam para enfeitar o
// nome no WhatsApp. Removidos só do nome de exibição; `nome_cru` guarda o original.
const DECORACAO = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2000}-\u{206F}\u{E000}-\u{F8FF}≈¥•·|~*_=+^<>]/gu;

// Sufixo comercial que a pessoa pendura no nome: "| Cigano.agi", "- Equipe X",
// "( Webi )". O nome da pessoa é o que vem antes.
const SUFIXO_COMERCIAL = /\s*[|\-–—(\[]\s*[^|\-–—()\[\]]{2,40}\s*[)\]]?\s*$/;

/**
 * Deriva o nome que aparece na tela a partir do `pushName` cru.
 *
 * A regra que mais importa é a última: **quando não sobra nome de gente, devolve o
 * apelido como ele é.** Inventar nome é pior que mostrar apelido — `Sr.Primus` é
 * `Sr.Primus`, e transformar isso em "Sr" seria perder a única forma de reconhecê-lo.
 */
export function nomeExibicao(bruto) {
  const original = String(bruto ?? '').trim();
  if (!original) return null;

  // `@handle` é identificador de rede social, não nome. Sai antes de tudo.
  let t = original.replace(/@[A-Za-z0-9._]{2,}/g, ' ');
  t = t.replace(SUFIXO_COMERCIAL, '');
  t = t.replace(DECORACAO, ' ').replace(/\s+/g, ' ').trim();

  // Sobrou pontuação solta ou nada: o apelido original serve melhor que um resto.
  if (!t || !/\p{L}/u.test(t)) return original;

  const palavras = t.split(' ').filter(p => /\p{L}/u.test(p));
  if (!palavras.length) return original;

  // Sobrou só um fragmento. `≈≈K¥0≈≈ @hype_vilarinho` derivava para "K", que não
  // identifica ninguém — é pior que o apelido inteiro, porque parece nome e não é.
  // Menos de duas letras no total, ou uma palavra só com menos de três letras, significa
  // que a limpeza comeu o nome em vez de limpá-lo: devolve o original.
  const letras = (t.match(/\p{L}/gu) ?? []).length;
  if (letras < 2 || (palavras.length === 1 && palavras[0].length < 3)) return original;

  // Nome e sobrenome quando existirem. Mais que isso vira linha que não cabe na tabela.
  return palavras.slice(0, 2).join(' ');
}

// ------------------------------------------------------------------------ gravação

/**
 * Registra (ou atualiza) a pessoa dona de um identificador.
 * Devolve `{ pessoaId, criada, atualizada }`.
 *
 * Idempotente: chamar de novo com o mesmo nome não muda nada. Nome novo de origem mais
 * fraca não derruba nome de origem mais forte — é o que impede o pushName da semana
 * ("🔥 PROMOÇÃO 🔥") de apagar um nome que alguém digitou à mão.
 */
export function registrarPessoa(db, { identificador, nomeCru, origem = 'pushName', telefone = null, quando = null }) {
  const id = String(identificador ?? '').trim();
  const nome = String(nomeCru ?? '').trim();
  if (!id || !nome) return { pessoaId: null, criada: false, atualizada: false };
  if (!(origem in PESO_ORIGEM)) throw new TypeError(`origem desconhecida: ${origem}`);

  const agora = quando ?? new Date().toISOString();
  const existente = db.prepare(
    'SELECT pi.pessoa_id, pi.origem, p.nome_cru FROM pessoa_identificadores pi ' +
    'JOIN pessoas p ON p.id = pi.pessoa_id WHERE pi.identificador = ?'
  ).get(id);

  if (!existente) {
    const r = db.prepare(
      'INSERT INTO pessoas (nome_cru, nome_exibicao, telefone, atualizado_em) VALUES (?, ?, ?, ?)'
    ).run(nome, nomeExibicao(nome), telefone, agora);
    const pessoaId = Number(r.lastInsertRowid);
    db.prepare(
      'INSERT INTO pessoa_identificadores (identificador, pessoa_id, origem, visto_em) VALUES (?, ?, ?, ?)'
    ).run(id, pessoaId, origem, agora);
    return { pessoaId, criada: true, atualizada: false };
  }

  db.prepare('UPDATE pessoa_identificadores SET visto_em = ? WHERE identificador = ?').run(agora, id);

  const mandaMais = PESO_ORIGEM[origem] >= PESO_ORIGEM[existente.origem];
  if(PESO_ORIGEM[origem]>PESO_ORIGEM[existente.origem]&&existente.nome_cru===nome)
    db.prepare('UPDATE pessoa_identificadores SET origem = ? WHERE identificador = ?').run(origem,id);
  if (!mandaMais || existente.nome_cru === nome) {
    return { pessoaId: existente.pessoa_id, criada: false, atualizada: false };
  }

  db.prepare('UPDATE pessoas SET nome_cru = ?, nome_exibicao = ?, telefone = COALESCE(?, telefone), atualizado_em = ? WHERE id = ?')
    .run(nome, nomeExibicao(nome), telefone, agora, existente.pessoa_id);
  db.prepare('UPDATE pessoa_identificadores SET origem = ? WHERE identificador = ?').run(origem, id);
  return { pessoaId: existente.pessoa_id, criada: false, atualizada: true };
}

// ------------------------------------------------------------------------ consulta

/**
 * `Map<identificador, nomeExibicao>` de todas as pessoas conhecidas.
 * Segue `fundida_em` para que identificador fundido devolva o nome do canônico.
 */
export function mapaDePessoas(db) {
  const mapa = new Map();
  const linhas = db.prepare(`
    SELECT pi.identificador,
           COALESCE(c.nome_exibicao, c.nome_cru, p.nome_exibicao, p.nome_cru) AS nome
    FROM pessoa_identificadores pi
    JOIN pessoas p ON p.id = pi.pessoa_id
    LEFT JOIN pessoas c ON c.id = p.fundida_em
    WHERE pi.ativo = 1
  `).all();
  for (const l of linhas) if (l.nome) mapa.set(l.identificador, l.nome);
  return mapa;
}

/**
 * Une dois registros que são a mesma pessoa. Reversível de propósito: grava o ponteiro,
 * não apaga a linha — desfazer é limpar `fundida_em`.
 */
export function fundirPessoas(db, { deId, paraId }) {
  if (deId === paraId) throw new TypeError('nao da para fundir uma pessoa nela mesma');
  const alvo = db.prepare('SELECT id, fundida_em FROM pessoas WHERE id = ?').get(paraId);
  if (!alvo) throw new Error(`pessoa ${paraId} nao existe`);
  if (alvo.fundida_em) throw new Error(`pessoa ${paraId} ja foi fundida em ${alvo.fundida_em}; funda no canonico`);
  db.prepare('UPDATE pessoas SET fundida_em = ?, atualizado_em = ? WHERE id = ?')
    .run(paraId, new Date().toISOString(), deId);
  return { deId, paraId };
}

// ------------------------------------------------------------------------ backfill

/**
 * Varre o `bruto` já gravado e recupera o nome que foi descartado na ingestão.
 *
 * Não chama a API do WhatsApp — é leitura do que já está no disco, então não corre o
 * risco de limitação de conta que a varredura em massa correria.
 */
export function backfillDoBruto(db, { limite = null, aoProgresso = null } = {}) {
  prepararEsquemaPessoas(db);
  // `MAX(recebido_em)` faz o nome mais recente de cada pessoa ganhar: quem trocou o
  // pushName deve aparecer com o nome de agora, não com o de dois anos atrás.
  const linhas = db.prepare(`
    SELECT autor_id AS identificador,
           json_extract(bruto, '$.mensagem.pushName') AS nome,
           MAX(recebido_em) AS visto
    FROM eventos
    WHERE autor_id IS NOT NULL
      AND autor_e_dono = 0
      AND json_extract(bruto, '$.mensagem.pushName') IS NOT NULL
      AND TRIM(json_extract(bruto, '$.mensagem.pushName')) <> ''
    GROUP BY autor_id
    ${limite ? `LIMIT ${Number(limite)}` : ''}
  `).all();

  let criadas = 0, atualizadas = 0, n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const l of linhas) {
      const r = registrarPessoa(db, {
        identificador: l.identificador, nomeCru: l.nome, origem: 'pushName', quando: l.visto
      });
      if (r.criada) criadas++;
      if (r.atualizada) atualizadas++;
      if (aoProgresso && ++n % 100 === 0) aoProgresso(n, linhas.length);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { examinadas: linhas.length, criadas, atualizadas };
}
