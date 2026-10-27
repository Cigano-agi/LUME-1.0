// Backlog diário: os itens abertos organizados por QUEM DEVE.
//
// Por que este módulo existe:
// O painel já ordena por valor (`src/valor.js`) e já fecha o que morreu
// (`src/frescor.js`). Faltava o corte que o dono pede todo dia: "o que EU devo" contra
// "o que DEVEM a mim". Sem esse corte, uma lista de 72 itens é um monte, não um plano —
// cobrar terceiro e executar tarefa própria são dois modos de trabalho diferentes e não
// se misturam na mesma fila.
//
// O que este módulo NÃO faz, de propósito:
//  - Não pontua. Ordenação é de `src/valor.js` (`ordenarPorValor`).
//  - Não decide o que morreu. Isso é de `src/frescor.js` (`classificar`).
//  - Não resolve nome. Isso é de `src/crm.js` (`nomeDe`, `mapaDeNomes`).
//  - Não lê banco nem escreve arquivo. Funções puras; o I/O mora em `bin/backlog.js`.
//
// Identidade do item: o NÚMERO do ID é o `itens_crm.id` e nunca muda. A LETRA é o balde
// de hoje e pode mudar (um item meu que eu delego vira de terceiro). Quem quiser rastrear
// uma linha entre dois dias olha o número, não a letra.

import { nomeDe } from './crm.js';
import { ordenarPorValor } from './valor.js';

/** Letra de cada balde. O número que a acompanha é sempre o id do item no banco. */
export const BALDES = {
  caixa: '$',
  meu: 'F',
  terceiro: 'T',
  lead: 'L',
  decisao: 'D',
  indefinido: '?',
};

// Sinal de que a linha é sobre dinheiro entrando ou saindo. Espelha deliberadamente o
// `SINAL_COMERCIAL` de `src/valor.js`: lá ele soma pontos, aqui ele escolhe a seção. Se
// um dos dois mudar, o outro tem que mudar junto — o teste cobre isso.
const SINAL_CAIXA =
  /or[çc]amento|proposta|pix|pagamento|repasse|cobran[çc]a|cobrar|faturar?|fatura|nota fiscal|contrato|assinar|fechar neg|or[çc]ar|honor[áa]rio|mensalidade|parcel|reembolso|R\$/i;

/**
 * O item é meu, de terceiro, ou não dá para saber?
 *
 * Regra dura: sem responsável declarado o item é `indefinido`, nunca "meu por padrão".
 * Assumir dono infla a lista do dono com trabalho que talvez nem seja dele — que é
 * exatamente o que faz alguém parar de abrir o backlog.
 */
export function donoDoItem(item, { dono, mapa } = {}) {
  const cru = item?.responsavel;
  if (!cru || !String(cru).trim()) return 'indefinido';

  const nome = nomeDe(cru, mapa);
  const alvos = [dono, 'fabricio', 'fabrício']
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  const normal = String(nome)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  for (const alvo of alvos) {
    const a = alvo.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (normal === a || normal.startsWith(a + ' ') || normal.includes(a)) return 'meu';
  }
  return 'terceiro';
}

/** A seção onde a linha entra. Caixa ganha de todas as outras. */
export function baldeDoItem(item, { dono, mapa } = {}) {
  if (item?.tipo === 'decisao') return 'decisao';

  const deQuem = donoDoItem(item, { dono, mapa });
  if (SINAL_CAIXA.test(String(item?.resumo ?? ''))) return 'caixa';
  if (item?.tipo === 'lead') return 'lead';

  if (deQuem === 'meu') return 'meu';
  if (deQuem === 'terceiro') return 'terceiro';
  return 'indefinido';
}

/** ID estável de exibição. O número é o id do banco e sobrevive a qualquer reordenação. */
export function idDeExibicao(item, balde) {
  return `${BALDES[balde] ?? '?'}-${item.id}`;
}

/** Idade em dias inteiros, a partir de `quando` (ou `extraido_em` se não houver). */
export function idadeEmDias(item, agora = new Date()) {
  const base = Date.parse(item?.quando || item?.extraido_em || '');
  if (Number.isNaN(base)) return null;
  const dias = Math.floor((agora.getTime() - base) / 86400000);
  return dias >= 0 ? dias : 0;
}

/**
 * Agrupa os itens abertos nos baldes, cada balde já ordenado por valor.
 *
 * `itens` são linhas de `itens_crm` com estado 'aberto'. Nada é filtrado aqui: o que
 * está morto já foi fechado por `frescor.aplicar()` antes de chegar.
 */
export function montarBacklog(itens, { agora = new Date(), dono = null, mapa = null } = {}) {
  const baldes = { caixa: [], meu: [], terceiro: [], lead: [], decisao: [], indefinido: [] };

  for (const item of itens ?? []) {
    const balde = baldeDoItem(item, { dono, mapa });
    baldes[balde].push({
      ...item,
      id_exibicao: idDeExibicao(item, balde),
      balde,
      dono: donoDoItem(item, { dono, mapa }),
      idade_dias: idadeEmDias(item, agora),
      conversa: nomeDe(item.conversa_id, mapa),
      responsavel_nome: item.responsavel ? nomeDe(item.responsavel, mapa) : null,
    });
  }

  for (const chave of Object.keys(baldes)) {
    baldes[chave] = ordenarPorValor(baldes[chave], { agora });
  }

  return { baldes, total: (itens ?? []).length, gerado_em: agora.toISOString() };
}

function escapar(texto) {
  return String(texto ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function tabela(linhas, colunaDono) {
  if (!linhas.length) return '_Nada aqui hoje._\n';
  const cab = colunaDono
    ? '| ID | Quem | Demanda | Idade |\n|----|------|---------|-------|\n'
    : '| ID | Conversa | Demanda | Idade |\n|----|----------|---------|-------|\n';
  return (
    cab +
    linhas
      .map((i) => {
        const quem = colunaDono ? i.responsavel_nome || i.conversa : i.conversa;
        const idade = i.idade_dias === null ? '?' : `${i.idade_dias}d`;
        return `| \`${i.id_exibicao}\` | ${escapar(quem)} | ${escapar(i.resumo)} | ${idade} |`;
      })
      .join('\n') + '\n'
  );
}

/** O arquivo que o dono abre todo dia. Layout fixo — a graça é ser o mesmo sempre. */
export function renderizarMarkdown(backlog, { dia, ultimaExtracao = null } = {}) {
  const b = backlog.baldes;
  const n = (k) => b[k].length;

  return `# Backlog — ${dia}

Gerado por \`node bin/backlog.js\`. **Não editar à mão** — a próxima execução sobrescreve.
Fonte: \`itens_crm\` com estado aberto. Datas e horas em America/Sao_Paulo.

O **número** do ID é o id do item no banco e nunca muda; a **letra** é o balde de hoje.
Para rastrear uma linha entre dois dias, siga o número.

| Balde | Itens |
|---|---|
| 💰 Caixa | ${n('caixa')} |
| 🔴 Devo eu | ${n('meu')} |
| ⏳ Devem a mim | ${n('terceiro')} |
| 🌱 Leads | ${n('lead')} |
| ⚖️ Decisões | ${n('decisao')} |
| ❓ Sem dono | ${n('indefinido')} |
| **Total** | **${backlog.total}** |

${ultimaExtracao ? `> Última extração de CRM: **${ultimaExtracao}**. A extração não é agendada — se esta data estiver velha, rode \`npm run crm\` antes de confiar na lista.\n` : ''}
---

## 💰 Caixa — dinheiro entrando ou saindo

Tudo que cita valor, orçamento, proposta, cobrança, contrato ou mensalidade. Ordenado por
valor calculado, não por data.

${tabela(b.caixa, true)}
---

## 🔴 Devo eu

${tabela(b.meu, false)}
---

## ⏳ Devem a mim — cobrar

${tabela(b.terceiro, true)}
---

## 🌱 Leads a orçar

${tabela(b.lead, true)}
---

## ⚖️ Decisões registradas — contexto, não tarefa

${tabela(b.decisao, true)}
---

## ❓ Sem dono — triar

Itens sem responsável declarado. Não entram na sua fila até alguém assumir.

${tabela(b.indefinido, false)}`;
}
