// Módulo puro de cálculo de valor e ordenação de itens do CRM.
//
// Por que este módulo existe:
// O painel antigo ordenava por antiguidade simples, empurrando o item mais velho e
// podre para o topo. Em 9 meses, zero ações foram tomadas porque a fila começava
// pelo que já havia morrido.
//
// Por que funções puras:
// Nenhuma dependência de banco de dados, relógio global do sistema ou I/O de rede.
// O relógio entra por injeção de dependência (`agora`) para que os testes temporais
// (fuso de SP, virada de ano, futuro) sejam 100% determinísticos e reproduzíveis.

// Pesos base de cada tipo de item.
// Lead é oportunidade direta de receita e confiança comercial (peso máximo).
// Compromisso é palavra dada pelo dono ou a ele (ação necessária).
// Pendência é espera de resposta ou documento.
// Decisão é resolução interna ou encerramento.
const PONTOS_POR_TIPO = {
  lead: 100,
  compromisso: 70,
  pendencia: 40,
  decisao: 20
};

// Sinal comercial por CONTEÚDO, não por tipo.
//
// Medido em 12/09 no banco real: 14 dos 45 itens abertos carregam dinheiro, cliente ou
// proposta — mas só 6 estão tipados como `lead`, e desses só 3 têm sinal comercial de
// verdade. O tipo erra nos dois sentidos: "Fazer os repasses após confirmação do Pix do
// Dr. Gui" é dinheiro puro e está tipado `compromisso`.
//
// Por isso o eixo comercial do painel ("em quem eu ligo hoje") não pode ser um filtro de
// tipo. Filtrar por `lead` perderia 8 itens comerciais para preservar 6. Aqui o sinal é
// aditivo e vale para qualquer tipo: o item sobe porque fala de dinheiro, não porque o
// modelo escolheu bem o rótulo.
const SINAL_COMERCIAL = /or[çc]amento|proposta|pix|pagamento|repasse|cobran[çc]a|cobrar|faturar?|fatura|nota fiscal|contrato|assinar|fechar neg|or[çc]ar|honor[áa]rio|mensalidade|parcel|reembolso/i;
const PONTOS_SINAL_COMERCIAL = 35;

// Limites monetários razoáveis para a operação de assessoria/consultoria.
// Valores iguais ou menores que zero não representam oportunidade financeira.
// Valores acima de 100 milhões são tratados como absurdos ou alucinação/ataque.
const VALOR_MINIMO_RELEVANTE = 0;
const VALOR_MAXIMO_PLAUSIVEL = 100_000_000;

/**
 * Converte qualquer representação temporal para carimbo numérico em milissegundos.
 * Retorna `NaN` se a data for nula, vazia ou textual sem resolução (ex: 'ontem').
 * Não fabrica data fictícia: o dado ausente precisa ser identificado como tal.
 */
function extrairTimestamp(quando) {
  if (quando == null || quando === '') return NaN;
  if (typeof quando === 'number' && Number.isFinite(quando)) return quando;
  if (quando instanceof Date && !Number.isNaN(quando.getTime())) return quando.getTime();
  if (typeof quando === 'string') {
    const limpo = quando.trim();
    if (!limpo) return NaN;
    // Se for string numérica (ex: timestamp ms em string '1789234567890')
    if (/^\d{10,13}$/.test(limpo)) {
      const num = Number(limpo);
      if (Number.isFinite(num)) return num;
    }
    const t = Date.parse(limpo);
    if (!Number.isNaN(t)) return t;
  }
  return NaN;
}

/**
 * Detecta tentativas de injeção de instrução ou termos adversariais no resumo.
 * O conteúdo recebido do WhatsApp é evidência, nunca instrução de controle.
 */
function ehTextoAdversarial(texto) {
  if (!texto || typeof texto !== 'string') return false;
  const padroes = [
    /ignore\s+(?:as\s+)?instru/i,
    /system\s*:/i,
    /<\/?mensagem>/i,
    /<script>/i,
    /drop\s+table/i,
    /\[id\s*=\s*inventado\]/i,
    /responda\s+em\s+json/i,
    /assistant\s*:/i,
    /prioridade\s+m[aá]xima/i,
    /esque[çc]a\s+o\s+origem_id/i,
    /\{"itens"\s*:/i
  ];
  return padroes.some(p => p.test(texto));
}

/**
 * Converte sequência numérica com pontuação brasileira (1.500 ou 1.500,00) em Number.
 */
function converterNumeroPt(str) {
  if (!str) return 0;
  let s = str.trim();
  if (/\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extrai valor monetário citado no texto do resumo (ex: R$ 20k, 20 mil, R$1.500).
 * Retorna `{ valor, absurdo, citado }`.
 */
function extrairValorMonetario(texto) {
  if (!texto || typeof texto !== 'string') {
    return { valor: 0, absurdo: false, citado: false };
  }

  if (ehTextoAdversarial(texto)) {
    // Resumos adversariais são desarmados: nenhum valor financeiro é concedido
    return { valor: 0, absurdo: false, citado: false, adversarial: true };
  }

  // Padrão 1: Notação com prefixo R$ explícito
  const regexReais = /R\$\s*([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?|[0-9]+(?:,[0-9]{1,2})?|[0-9]+(?:\.[0-9]+)?)\s*(k|mil|milh(?:ão|ao|ões|oes)|bi|bilh(?:ão|ao|ões|oes))?\b/i;
  // Padrão 2: Notação abreviada sem R$ (ex: "20 mil", "20k")
  const regexAbreviado = /\b([0-9]+(?:,[0-9]+|\.[0-9]+)?)\s*(k|mil)\b/i;

  let match = texto.match(regexReais);
  if (!match) {
    match = texto.match(regexAbreviado);
  }

  if (!match) {
    return { valor: 0, absurdo: false, citado: false };
  }

  const baseNum = converterNumeroPt(match[1]);
  const sufixo = (match[2] || '').toLowerCase();

  let multiplicador = 1;
  if (sufixo === 'k' || sufixo === 'mil') {
    multiplicador = 1_000;
  } else if (sufixo.startsWith('milh')) {
    multiplicador = 1_000_000;
  } else if (sufixo.startsWith('bi')) {
    multiplicador = 1_000_000_000;
  }

  const total = baseNum * multiplicador;

  if (total <= VALOR_MINIMO_RELEVANTE) {
    return { valor: 0, absurdo: false, citado: false };
  }

  if (total >= VALOR_MAXIMO_PLAUSIVEL || sufixo.startsWith('bi')) {
    return { valor: total, absurdo: true, citado: true };
  }

  return { valor: total, absurdo: false, citado: true };
}

/**
 * Determina o canal de comunicação do item:
 * - 'grupo': item em grupo do WhatsApp (termina em @g.us ou item.grupo === true/1)
 * - 'dm': conversa direta individual (termina em @s.whatsapp.net, @lid, etc., ou item.grupo === false/0)
 * - null: sem canal identificado (não ganha bônus de DM nem rótulo de grupo)
 */
function determinarCanal(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.grupo === 'boolean') {
    return item.grupo ? 'grupo' : 'dm';
  }
  if (typeof item.grupo === 'number') {
    return item.grupo === 1 ? 'grupo' : 'dm';
  }
  if (typeof item.conversa_id === 'string') {
    const id = item.conversa_id.trim();
    if (!id) return null;
    return id.endsWith('@g.us') ? 'grupo' : 'dm';
  }
  return null;
}

/**
 * Pontua um único item do CRM e gera justificativas legíveis.
 *
 * Contrato:
 * Toda nota TEM que ter pelo menos um porquê declarado (`porques.length >= 1`).
 * Ordem dos pesos: tipo > frescor > valor monetário > DM vs grupo.
 *
 * @param {Object} item - Item a ser avaliado
 * @param {Object} [opcoes] - Opções de contexto temporal
 * @param {Date|number|string} [opcoes.agora] - Carimbo de referência para frescor
 * @param {number} [opcoes.mensagensDepois] - Quantidade de mensagens posteriores
 * @returns {{ pontos: number, porques: string[] }}
 */
export function pontuar(item, { agora = new Date(), mensagensDepois } = {}) {
  if (!item || typeof item !== 'object') {
    return { pontos: -Infinity, porques: ['item inválido'] };
  }

  const porques = [];
  let pontos = 0;

  // 1. Tipo do item (peso dominante)
  const tipo = item.tipo;
  if (tipo && PONTOS_POR_TIPO[tipo] !== undefined) {
    pontos += PONTOS_POR_TIPO[tipo];
    porques.push(`tipo: ${tipo}`);
  } else {
    porques.push(tipo ? `tipo desconhecido (${tipo})` : 'sem tipo definido');
  }

  // 1b. Sinal comercial, aditivo e independente do tipo.
  // É o que salva "Fazer os repasses após confirmação do Pix do Dr. Gui" — dinheiro
  // puro que o modelo tipou como `compromisso` e que um filtro por `lead` jogaria fora.
  if (SINAL_COMERCIAL.test(String(item.resumo ?? ''))) {
    pontos += PONTOS_SINAL_COMERCIAL;
    porques.push('trata de dinheiro ou proposta');
  }

  // 2. Frescor temporal (2 dias vale mais que 200)
  const agoraMs = extrairTimestamp(agora);
  const referenciaMs = Number.isNaN(agoraMs) ? Date.now() : agoraMs;
  const quandoMs = extrairTimestamp(item.quando);

  const semDataValida = Number.isNaN(quandoMs);
  if (semDataValida) {
    // Critério A5: vai para o fim da fila com porquê declarado
    pontos -= 1000;
    if (item.quando === null || item.quando === undefined || item.quando === '') {
      porques.push('data ausente');
    } else {
      porques.push(`data inválida (${String(item.quando).slice(0, 30)})`);
    }
  } else {
    const deltaMs = referenciaMs - quandoMs;
    const dias = deltaMs / 86400000;

    if (dias < 0) {
      // Evento no futuro: mantém frescor alto sem fabricar carimbo falso
      pontos += 25;
      porques.push('agendado para o futuro');
    } else {
      const diasInteiros = Math.floor(dias);
      if (diasInteiros <= 2) {
        pontos += 22;
        porques.push(diasInteiros === 0 ? 'criado hoje' : `recente (${diasInteiros}d)`);
      } else if (diasInteiros <= 7) {
        pontos += 18;
        porques.push(`frescor semanal (${diasInteiros}d)`);
      } else if (diasInteiros <= 14) {
        pontos += 14;
        porques.push(`frescor quinzenal (${diasInteiros}d)`);
      } else if (diasInteiros <= 30) {
        pontos += 8;
        porques.push(`frescor mensal (${diasInteiros}d)`);
      } else if (diasInteiros <= 60) {
        pontos += 4;
        porques.push(`antigo (${diasInteiros}d)`);
      } else {
        pontos += 0;
        porques.push(`muito antigo (${diasInteiros}d)`);
      }
    }
  }

  // 3. Valor monetário citado no resumo (R$ 20k, 20 mil, R$1.500)
  const resumo = item.resumo;
  const infoValor = extrairValorMonetario(resumo);

  if (infoValor.adversarial) {
    // Defesa adversarial: padrões maliciosos não inflam nota e são penalizados
    pontos -= 50;
    porques.push('resumo com padrão adversarial');
  } else if (infoValor.absurdo) {
    porques.push('valor monetário absurdo ignorado');
  } else if (infoValor.citado && infoValor.valor > 0) {
    let ptsValor = 10;
    if (infoValor.valor >= 50_000) {
      ptsValor = 16;
    } else if (infoValor.valor >= 10_000) {
      ptsValor = 14;
    } else if (infoValor.valor >= 1_000) {
      ptsValor = 12;
    }
    pontos += ptsValor;

    if (infoValor.valor >= 1_000 && infoValor.valor % 1_000 === 0) {
      porques.push(`valor citado: R$ ${infoValor.valor / 1_000}k`);
    } else {
      porques.push(`valor citado: R$ ${infoValor.valor.toLocaleString('pt-BR')}`);
    }
  }

  // 4. Canal de comunicação: DM vale mais que grupo
  const canal = determinarCanal(item);
  if (canal === 'grupo') {
    porques.push('mensagem em grupo');
  } else if (canal === 'dm') {
    pontos += 10;
    porques.push('conversa direta (DM)');
  }

  // 5. Contexto opcional: mensagens que chegaram depois
  const depois = mensagensDepois !== undefined ? mensagensDepois : item.depois;
  if (typeof depois === 'number' && depois > 0) {
    porques.push(`${depois} mensagens depois`);
  }

  // Garantia estrutural de A2: nenhum item sai com porquês vazio
  if (porques.length === 0) {
    porques.push('avaliação padrão');
  }

  return { pontos, porques };
}

/**
 * Ordena uma lista de itens pelo valor de ação imediata.
 *
 * Contrato:
 * - Puro: não muta a lista recebida nem altera propriedades dos objetos.
 * - Estável: itens com a mesma nota preservam a ordem relativa original.
 * - Confiável: itens com data ausente ou inválida vão para o final sem sumir.
 *
 * @param {Array<Object>} itens - Lista de itens do CRM
 * @param {Object} [opcoes] - Opções repassadas para o cálculo de pontuação
 * @returns {Array<Object>} Nova lista ordenada de itens
 */
export function ordenarPorValor(itens, { agora } = {}) {
  if (!Array.isArray(itens)) return [];
  if (itens.length <= 1) return [...itens];

  // Mapeia preservando índice para garantia estrita de estabilidade em desempate
  const pontuados = itens.map((item, indice) => ({
    item,
    indice,
    resultado: pontuar(item, { agora })
  }));

  pontuados.sort((a, b) => {
    const diff = b.resultado.pontos - a.resultado.pontos;
    if (diff !== 0) return diff;
    return a.indice - b.indice; // desempate estável
  });

  return pontuados.map(p => p.item);
}
