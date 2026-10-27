// Medição e acompanhamento da carga do histórico do WhatsApp (SPEC-F9).
//
// O WhatsApp entrega conversas ao longo de horas. O painel anterior mostrava apenas
// um número estático, deixando o usuário sem saber se o app travou ou se ainda está
// baixando mensagens — o que causava abandono no primeiro dia (T8).
//
// Regras essenciais:
// 1. Fase honesta: com 0 mensagens é sempre 'pareando'; enquanto mensagens entram
//    e o ritmo sobe ou se mantém é 'recebendo'; se o ritmo cai é 'desacelerando';
//    sem mensagens por N minutos vira 'estavel'.
// 2. Estimativa honesta: sem saber o total de mensagens a estimativa é estritamente null.
//    Chutar tempo inventado é mentir para o usuário.
// 3. Notificação nativa: quando passa para 'estavel', usa o canal injetado pelo app
//    uma única vez (sem spam a cada consulta).
// 4. Sem dependências extras: pura aritmética, SQLite embutido e janela móvel.

/**
 * Calcula o ritmo de mensagens por minuto usando as amostras contidas na janela móvel.
 * Protegido contra divisão por zero e deltas negativos decorrentes de skew do relógio.
 */
export function calcularRitmo(amostras, janelaMs = 60_000) {
  if (!Array.isArray(amostras) || amostras.length < 2) return 0;

  const primeira = amostras[0];
  const ultima = amostras[amostras.length - 1];

  const deltaMs = ultima.tempoMs - primeira.tempoMs;
  const deltaMensagens = ultima.mensagens - primeira.mensagens;

  // Se o relógio do sistema recuou ou duas amostras chegaram no mesmo milissegundo,
  // nunca divide por zero nem gera Infinity/NaN.
  if (deltaMs <= 0 || deltaMensagens <= 0) return 0;

  const ritmo = Math.round((deltaMensagens / deltaMs) * 60_000);
  return Number.isFinite(ritmo) && ritmo > 0 ? ritmo : 0;
}

/**
 * Converte minutos restantes em texto amigável em português.
 * Devolve null se minutos for inválido, zero ou negativo.
 */
export function formatarEstimativa(minutos) {
  if (minutos == null || !Number.isFinite(minutos) || minutos <= 0) return null;

  if (minutos === 1) return 'falta cerca de 1 minuto';
  if (minutos < 60) return `faltam uns ${minutos} minutos`;

  const horas = Math.floor(minutos / 60);
  const restoMinutos = minutos % 60;
  return restoMinutos > 0
    ? `faltam cerca de ${horas}h e ${restoMinutos} min`
    : `faltam cerca de ${horas}h`;
}

/**
 * Busca a data da última atividade gravada no banco para inicialização
 * após reinício da aplicação durante ou após a carga.
 */
function obterUltimaAtividade(db) {
  try {
    const etapa = db.prepare('SELECT MAX(atualizado_em) AS u FROM etapas').get();
    if (etapa?.u) {
      const t = Date.parse(etapa.u);
      if (!Number.isNaN(t)) return t;
    }
  } catch {}
  try {
    const ev = db.prepare("SELECT MAX(recebido_em) AS u FROM eventos WHERE tipo<>'notetaker_trecho'").get();
    if (ev?.u) {
      const t = Date.parse(ev.u);
      if (!Number.isNaN(t)) return t;
    }
  } catch {}
  return null;
}

/**
 * Monitor do progresso da ingestão de mensagens.
 * Mantém histórico em memória para janela móvel e faz transições de estado conservadoras.
 */
export class MonitorProgresso {
  #db;
  #conexao;
  #limiteEstavelSegundos;
  #janelaMs;
  #totalEsperado;
  #notificar;
  #amostras = [];
  #maiorMensagens = 0;
  #ultimaMensagens = 0;
  #ultimoAvancoMs = null;
  #ritmoAnterior = 0;
  #faseAnterior = null;
  #notificadoEstavel = false;

  constructor(db, {
    conexao = null,
    limiteEstavelSegundos = 120, // 2 minutos sem novas mensagens = estável
    janelaMs = 60_000,          // 1 minuto de janela móvel para ritmo
    totalEsperado = null,
    notificar = null
  } = {}) {
    this.#db = db;
    this.#conexao = conexao;
    this.#limiteEstavelSegundos = Math.max(1, limiteEstavelSegundos);
    this.#janelaMs = Math.max(1000, janelaMs);
    this.#totalEsperado = typeof totalEsperado === 'number' && totalEsperado > 0 ? totalEsperado : null;
    this.#notificar = notificar;

    // Inicializa a contagem acumulada já existente no banco para suportar reinício
    try {
      const r = this.#db.prepare("SELECT COUNT(*) c FROM eventos WHERE tipo<>'notetaker_trecho'").get();
      const contagem = Number(r?.c || 0);
      this.#maiorMensagens = contagem;
      this.#ultimaMensagens = contagem;
    } catch {}

    const ultimaAtividade = obterUltimaAtividade(this.#db);
    if (ultimaAtividade !== null) {
      this.#ultimoAvancoMs = ultimaAtividade;
    }
  }

  /**
   * Avalia o estado atual do progresso, registrando nova amostra e
   * acionando a notificação nativa se a fase passar para 'estavel'.
   */
  estado({ agora = new Date() } = {}) {
    const agoraMs = agora instanceof Date
      ? agora.getTime()
      : typeof agora === 'number'
        ? agora
        : Date.now();

    let totalMsg = 0;
    try {
      const r = this.#db.prepare("SELECT COUNT(*) c FROM eventos WHERE tipo<>'notetaker_trecho'").get();
      totalMsg = Number(r?.c || 0);
    } catch {}

    // Invariante de monotonicidade: mensagens nunca decresce na visão externa
    if (totalMsg < this.#maiorMensagens) {
      totalMsg = this.#maiorMensagens;
    } else {
      this.#maiorMensagens = totalMsg;
    }

    let totalConv = 0;
    try {
      const r = this.#db.prepare('SELECT COUNT(*) c FROM conversas_app').get();
      totalConv = Number(r?.c || 0);
    } catch {}
    if (totalConv === 0 && totalMsg > 0) {
      try {
        const r = this.#db.prepare("SELECT COUNT(DISTINCT conversa_id) c FROM eventos WHERE tipo<>'notetaker_trecho'").get();
        totalConv = Number(r?.c || 0);
      } catch {}
    }

    // Inicializa tempo de avanço se ainda não determinado
    if (this.#ultimoAvancoMs === null) {
      this.#ultimoAvancoMs = agoraMs;
    }

    // Se houve avanço de mensagens, carimba o momento da chegada
    if (totalMsg > this.#ultimaMensagens) {
      this.#ultimoAvancoMs = agoraMs;
      this.#ultimaMensagens = totalMsg;
    }

    // Proteção se o relógio do sistema retrocedeu
    if (agoraMs < this.#ultimoAvancoMs) {
      this.#ultimoAvancoMs = agoraMs;
    }

    const paradoHaSegundos = Math.max(0, Math.floor((agoraMs - this.#ultimoAvancoMs) / 1000));

    // Atualiza a janela móvel de amostras
    this.#amostras = this.#amostras.filter(
      a => a.tempoMs >= agoraMs - this.#janelaMs && a.tempoMs <= agoraMs
    );
    this.#amostras.push({ tempoMs: agoraMs, mensagens: totalMsg });

    const ritmoPorMinuto = calcularRitmo(this.#amostras, this.#janelaMs);

    // Decisão conservadora de fase
    let fase;
    if (totalMsg === 0) {
      // Critério A1: com 0 mensagens é sempre 'pareando'
      fase = 'pareando';
    } else if (paradoHaSegundos >= this.#limiteEstavelSegundos) {
      // Critério A3: sem nova mensagem por N minutos, vira 'estavel'
      fase = 'estavel';
    } else {
      // Critério A2: enquanto o ritmo sobe ou se mantém é 'recebendo';
      // se caiu de ritmo vira 'desacelerando'
      if (
        ritmoPorMinuto >= this.#ritmoAnterior ||
        this.#faseAnterior === 'pareando' ||
        this.#ritmoAnterior === 0
      ) {
        fase = 'recebendo';
      } else {
        fase = 'desacelerando';
      }
    }

    this.#ritmoAnterior = ritmoPorMinuto;

    // Dispara notificação nativa ao passar para estável
    if (fase === 'estavel') {
      if (this.#faseAnterior !== null && this.#faseAnterior !== 'estavel' && !this.#notificadoEstavel) {
        this.#notificadoEstavel = true;
        if (typeof this.#notificar === 'function') {
          try {
            this.#notificar(
              'Lume',
              'A chegada de mensagens ficou estável. Confira o andamento no Lume.'
            );
          } catch {
            // Notificação de SO não pode derrubar a rota
          }
        }
      }
    } else {
      // Rearma para nova notificação caso novo lote reabra a ingestão
      this.#notificadoEstavel = false;
    }

    this.#faseAnterior = fase;

    // Critério A4: estimativa honesta ou null
    let estimativa = null;
    if (
      this.#totalEsperado != null &&
      this.#totalEsperado > totalMsg &&
      ritmoPorMinuto > 0
    ) {
      const minutosRestantes = Math.ceil((this.#totalEsperado - totalMsg) / ritmoPorMinuto);
      estimativa = formatarEstimativa(minutosRestantes);
    }

    return {
      fase,
      mensagens: totalMsg,
      conversas: totalConv,
      ritmoPorMinuto,
      paradoHaSegundos,
      estimativa
    };
  }
}
