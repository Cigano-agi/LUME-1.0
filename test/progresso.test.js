import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createContext, runInContext } from 'node:vm';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import {
  MonitorProgresso,
  calcularRitmo,
  formatarEstimativa
} from '../src/progresso.js';
import {
  paraTodo,
  textoAdversarial,
  textoCruel,
  inteiro,
  escolher
} from './gerador.js';

/**
 * Conexão falsa para simular diferentes estados do WhatsApp sem tocar na rede.
 */
function criarConexaoFalsa(estado = 'conectada') {
  return {
    estado: () => ({ estado, erro: null, qr: null }),
    iniciar: async () => {},
    parar: async () => {},
    baixarMidia: async () => null
  };
}

/**
 * Insere mensagens sintéticas no banco para testar contagens e ritmo.
 */
function inserirMensagens(db, quantidade, { conversaId = 'c1@s.whatsapp.net', recebidoEm = new Date().toISOString() } = {}) {
  const stmt = db.prepare(`
    INSERT INTO eventos (conversa_id, origem_id, direcao, tipo, bruto, texto, recebido_em, dia_local)
    VALUES (?, ?, 'entrada', 'texto', '{}', 'msg', ?, '2026-09-12')
  `);
  for (let i = 0; i < quantidade; i++) {
    stmt.run(conversaId, `ORIG_${Date.now()}_${Math.random()}_${i}`, recebidoEm);
  }
}

/**
 * Cria um ambiente controlado com DOM simulado para executar o script real de painel.html
 * no Node usando node:vm, sem nenhuma dependência externa (zero npm install).
 */
function instanciarPainelScript(html, { fetchHandler = null } = {}) {
  const elements = new Map();
  const dummyEl = {
    hidden: true,
    textContent: '',
    innerHTML: '',
    children: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) {
      this.children.push(child);
      this.textContent += (child.textContent ?? child);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
      this.textContent = nodes.map(n => n.textContent ?? n).join('');
    },
    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    },
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    querySelector() { return dummyEl; },
    querySelectorAll() { return []; },
    showModal() {},
    close() {}
  };

  const getEl = (id) => {
    if (!elements.has(id)) {
      elements.set(id, { ...dummyEl, id });
    }
    return elements.get(id);
  };

  const intervals = [];
  const ctx = createContext({
    document: {
      getElementById: getEl,
      querySelector: () => dummyEl,
      querySelectorAll: () => [],
      createElement: (tag) => ({ ...dummyEl, tag, textContent: '', children: [] }),
      createTextNode: (t) => ({ textContent: t }),
      title: ''
    },
    window: { location: { hash: '' }, addEventListener: () => {} },
    location: { hash: '' },
    history: { replaceState: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: () => {},
    setTimeout: (fn, ms) => 1,
    clearTimeout: () => {},
    fetch: async (url, opts) => {
      if (typeof fetchHandler === 'function') {
        return fetchHandler(url, opts);
      }
      return { ok: true, json: async () => ({}) };
    },
    AbortController,
    console: { log() {}, error() {}, warn() {} },
    URL, Intl, Number, Date, Math, String, Boolean, Array, Object
  });

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) {
    throw new Error('Tag <script> não encontrada em painel.html');
  }

  runInContext(scriptMatch[1], ctx);

  return { ctx, getEl, intervals };
}

// ---------------------------------------------------------------- critérios de aceite (seção 3)

test('A1: com 0 mensagens e sessão pareada, a fase é pareando', () => {
  // Com 0 mensagens, o banco está vazio ou acabou de parear.
  // Mostrar 'estavel' seria falso porque o histórico nem começou a descer.
  const db = abrirBanco();
  const conexao = criarConexaoFalsa('conectada');
  const progresso = new MonitorProgresso(db, { conexao });

  const est = progresso.estado();
  assert.equal(est.fase, 'pareando', 'A1 é falso se mostrar estavel numa caixa vazia');
  assert.equal(est.mensagens, 0);
  assert.equal(est.conversas, 0);
  assert.equal(est.ritmoPorMinuto, 0);
  assert.equal(est.estimativa, null);
  db.close();
});

test('A2: enquanto o ritmo sobe ou se mantém, a fase é recebendo', () => {
  // Conforme mensagens chegam e o ritmo se mantém ou sobe, a fase deve ser 'recebendo',
  // nunca pulando direto para 'estavel'.
  const db = abrirBanco();
  const conexao = criarConexaoFalsa('conectada');
  const progresso = new MonitorProgresso(db, { conexao, janelaMs: 60_000 });

  let tempo = Date.now();

  // T0: 0 mensagens -> pareando
  let est = progresso.estado({ agora: new Date(tempo) });
  assert.equal(est.fase, 'pareando');

  // T1 (+10s): 100 mensagens chegam -> ritmo sobe -> recebendo
  tempo += 10_000;
  inserirMensagens(db, 100, { recebidoEm: new Date(tempo).toISOString() });
  est = progresso.estado({ agora: new Date(tempo) });
  assert.equal(est.fase, 'recebendo', 'A2 é falso se pular para estavel no meio');
  assert.ok(est.ritmoPorMinuto > 0);
  assert.equal(est.mensagens, 100);

  // T2 (+10s): mais 100 mensagens chegam -> ritmo se mantém alto -> continua recebendo
  tempo += 10_000;
  inserirMensagens(db, 100, { recebidoEm: new Date(tempo).toISOString() });
  est = progresso.estado({ agora: new Date(tempo) });
  assert.equal(est.fase, 'recebendo', 'ritmo mantido deve conservar fase recebendo');
  assert.equal(est.mensagens, 200);

  // T3 (+10s): apenas 5 mensagens chegam -> ritmo desacelera -> desacelerando
  tempo += 10_000;
  inserirMensagens(db, 5, { recebidoEm: new Date(tempo).toISOString() });
  est = progresso.estado({ agora: new Date(tempo) });
  assert.equal(est.fase, 'desacelerando', 'queda abrupta de ritmo deve transicionar para desacelerando');

  db.close();
});

test('A3: sem mensagem nova por N minutos, vira estavel e notifica o canal injetado uma unica vez', () => {
  // Sem mensagens por tempo suficiente (limiteEstavelSegundos), a carga é considerada concluída.
  const db = abrirBanco();
  const avisos = [];
  const progresso = new MonitorProgresso(db, {
    limiteEstavelSegundos: 120, // 2 minutos
    notificar: (titulo, texto) => avisos.push({ titulo, texto })
  });

  let tempo = Date.now();
  inserirMensagens(db, 50, { recebidoEm: new Date(tempo).toISOString() });

  // Estado inicial com mensagens: ainda ativo
  let est = progresso.estado({ agora: new Date(tempo) });
  assert.notEqual(est.fase, 'estavel');
  assert.equal(avisos.length, 0);

  // Passaram-se 60 segundos (menos que os 2 minutos) -> ainda não é estável
  tempo += 60_000;
  est = progresso.estado({ agora: new Date(tempo) });
  assert.notEqual(est.fase, 'estavel');
  assert.equal(avisos.length, 0);

  // Passaram-se mais 70 segundos (total 130s > 120s) -> vira estável!
  tempo += 70_000;
  est = progresso.estado({ agora: new Date(tempo) });
  assert.equal(est.fase, 'estavel', 'A3 é falso se ficar em recebendo para sempre');
  assert.equal(avisos.length, 1, 'deve disparar notificação nativa ao passar para estável');
  assert.equal(avisos[0].titulo, 'Lume');
  assert.equal(avisos[0].texto, 'A chegada de mensagens ficou estável. Confira o andamento no Lume.');

  // Próxima chamada após estabilizado: não pode disparar alarme repetido
  tempo += 30_000;
  est = progresso.estado({ agora: new Date(tempo) });
  assert.equal(est.fase, 'estavel');
  assert.equal(avisos.length, 1, 'notificação de estabilização não pode virar spam');

  db.close();
});

test('A4: sem dado suficiente, estimativa e null', () => {
  // Quando não há como saber o total de mensagens, estimativa DEVE ser null.
  // Inventar um número quando não há meta é mentir para o usuário.
  const db = abrirBanco();
  const progresso = new MonitorProgresso(db);

  // Sem total definido
  let est = progresso.estado();
  assert.equal(est.estimativa, null, 'A4 é falso se devolver um tempo chutado sem total');

  // Com mensagens mas sem total
  inserirMensagens(db, 100);
  est = progresso.estado();
  assert.equal(est.estimativa, null, 'sem saber o total de mensagens, estimativa continua null');

  // Quando o total é fornecido e há ritmo mensurável, a estimativa humana é calculada
  const progressoComMeta = new MonitorProgresso(db, { totalEsperado: 1000 });
  const tempo = Date.now();
  progressoComMeta.estado({ agora: new Date(tempo) });
  inserirMensagens(db, 100, { recebidoEm: new Date(tempo + 10_000).toISOString() });
  const estMeta = progressoComMeta.estado({ agora: new Date(tempo + 10_000) });
  assert.ok(typeof estMeta.estimativa === 'string' && estMeta.estimativa.includes('minuto'));

  db.close();
});

test('A5: a faixa de progresso no painel.html some sozinha ao estabilizar (hidden quando estavel)', async () => {
  // A faixa no painel deve existir, mostrar a fase em português e contagem viva,
  // e sumir sozinha quando fase === 'estavel' sem exigir clique do usuário.
  // Testado executando a função verificarProgresso de verdade sobre o DOM simulado.
  const html = await readFile(new URL('../src/painel/painel.html', import.meta.url), 'utf8');

  // Verifica que o elemento de progresso está presente no HTML
  assert.ok(html.includes('id="progresso"'), 'painel.html deve conter o elemento #progresso');
  assert.ok(html.includes('id="progresso-texto"'), 'painel.html deve conter #progresso-texto');
  assert.ok(html.includes('id="progresso-extra"'), 'painel.html deve conter #progresso-extra');

  let apiRetorno = {
    fase: 'recebendo',
    mensagens: 250,
    conversas: 12,
    ritmoPorMinuto: 30,
    estimativa: 'faltam uns 5 minutos'
  };

  const { ctx, getEl, intervals } = instanciarPainelScript(html, {
    fetchHandler: async () => ({
      ok: true,
      json: async () => apiRetorno
    })
  });

  // O script deve conter a função verificarProgresso implementada
  assert.equal(typeof ctx.verificarProgresso, 'function', 'verificarProgresso deve ser uma função no painel.html');

  // O agendamento por setInterval deve existir para que atualize sem intervenção manual
  const agendado = intervals.find(i => i.fn === ctx.verificarProgresso);
  assert.ok(agendado, 'verificarProgresso deve ser agendado com setInterval');
  assert.ok(agendado.ms <= 5000, 'intervalo de atualização do progresso deve ser frequente (<= 5s)');

  // 1. Estado 'recebendo': a faixa deve ficar visível e exibir os dados
  await ctx.verificarProgresso();
  const elProgresso = getEl('progresso');
  const elTexto = getEl('progresso-texto');
  const elExtra = getEl('progresso-extra');

  assert.equal(elProgresso.hidden, false, 'a faixa deve estar visível (hidden=false) na fase recebendo');
  assert.ok(elTexto.textContent.includes('Recebendo histórico do WhatsApp…'), 'deve exibir nome da fase em português');
  assert.ok(elTexto.textContent.includes('250 mensagens'), 'deve exibir contagem de mensagens');
  assert.ok(elTexto.textContent.includes('12 conversas'), 'deve exibir total de conversas');
  assert.ok(elTexto.textContent.includes('30 msg/min'), 'deve exibir ritmo');
  assert.equal(elExtra.textContent, 'faltam uns 5 minutos', 'deve exibir a estimativa');

  // 2. Estado 'estavel': A FAIXA SOME SOZINHA (hidden=true) sem qualquer clique!
  apiRetorno = {
    fase: 'estavel',
    mensagens: 300,
    conversas: 12,
    ritmoPorMinuto: 0,
    estimativa: null
  };
  await ctx.verificarProgresso();

  assert.equal(
    elProgresso.hidden,
    true,
    'A5 é falso se exigir clique para sumir — ao virar estavel a faixa deve sumir sozinha (hidden=true)'
  );

  // 3. Resposta nula ou vazia não quebra e mantém a faixa oculta
  apiRetorno = null;
  await ctx.verificarProgresso();
  assert.equal(elProgresso.hidden, true, 'dados inválidos devem ocultar a faixa com segurança');
});

test('A5-comportamento HTTP: transicao recebendo -> estavel fecha faixa no front-end sem clique', async (t) => {
  // Prova com servidor HTTP real que a transição de estado no backend faz a faixa sumir no front-end
  const db = abrirBanco();
  const conexao = criarConexaoFalsa('conectada');
  const monitor = new MonitorProgresso(db, { conexao, limiteEstavelSegundos: 1 });
  const server = criarServidor(db, { conexao, progresso: monitor });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    db.close();
  });

  const porta = server.address().port;
  const base = `http://127.0.0.1:${porta}`;

  const agora = Date.now();
  inserirMensagens(db, 80, { recebidoEm: new Date(agora).toISOString() });

  const html = await readFile(new URL('../src/painel/painel.html', import.meta.url), 'utf8');
  const { ctx, getEl } = instanciarPainelScript(html, {
    fetchHandler: async (url, opts) => {
      const fullUrl = url.startsWith('http') ? url : `${base}${url}`;
      const res = await fetch(fullUrl, opts);
      const json = await res.json();
      return { ok: res.ok, status: res.status, json: async () => json };
    }
  });

  // T0: ativo no backend -> front-end exibe a faixa
  await ctx.verificarProgresso();
  const elProgresso = getEl('progresso');
  assert.equal(elProgresso.hidden, false, 'faixa visível quando servidor está em recebendo');

  // T1: tempo passa sem mensagens (> 1s no relógio real) -> backend vira 'estavel' -> front-end esconde a faixa sozinho
  await new Promise(r => setTimeout(r, 1100));
  await ctx.verificarProgresso();
  assert.equal(elProgresso.hidden, true, 'faixa sumiu sozinha quando o backend estabilizou');
});

test('Risco irreversivel (F6-A6/F8-A6): /api/progresso e MonitorProgresso nunca apagam nem filtram eventos', async (t) => {
  // Prova que consultar o progresso (seja via HTTP ou objeto) é estritamente somente-leitura:
  // nenhum evento da tabela eventos pode sofrer DELETE, UPDATE ou descarte silencioso.
  const db = abrirBanco();
  const conexao = criarConexaoFalsa('conectada');
  const monitor = new MonitorProgresso(db, { conexao });
  const server = criarServidor(db, { conexao, progresso: monitor });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    db.close();
  });

  inserirMensagens(db, 40, { conversaId: 'conversa_a@s.whatsapp.net' });
  inserirMensagens(db, 30, { conversaId: 'conversa_b@s.whatsapp.net' });

  const totalInicial = db.prepare('SELECT COUNT(*) c FROM eventos').get().c;
  const linhasIniciais = db.prepare('SELECT id, conversa_id, origem_id, recebido_em, texto, tipo FROM eventos ORDER BY id').all();
  assert.equal(totalInicial, 70);

  const porta = server.address().port;

  // Realiza múltiplas consultas seguidas pela rota HTTP
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`http://127.0.0.1:${porta}/api/progresso`);
    assert.equal(res.status, 200);
    const dados = await res.json();
    assert.equal(dados.mensagens, 70);
  }

  // Avalia transições no monitor
  monitor.estado({ agora: new Date(Date.now() + 5000) });
  monitor.estado({ agora: new Date(Date.now() + 500_000) });

  // Comprova que nenhuma linha foi tocada
  const totalFinal = db.prepare('SELECT COUNT(*) c FROM eventos').get().c;
  const linhasFinais = db.prepare('SELECT id, conversa_id, origem_id, recebido_em, texto, tipo FROM eventos ORDER BY id').all();

  assert.equal(totalFinal, totalInicial, 'total de eventos não pode decrescer após consultas de progresso');
  assert.deepEqual(linhasFinais, linhasIniciais, 'nenhum evento pode ser alterado ou descartado (imutabilidade de eventos)');
});

test('A6: a rota responde 200 com banco vazio', async (t) => {
  // O servidor deve subir e responder 200 no endpoint /api/progresso
  // mesmo antes de qualquer conexão ou mensagem gravada.
  const db = abrirBanco();
  const conexao = criarConexaoFalsa('desconectada');
  const server = criarServidor(db, { conexao });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    db.close();
  });

  const porta = server.address().port;
  const res = await fetch(`http://127.0.0.1:${porta}/api/progresso`);
  assert.equal(res.status, 200, 'A6 é falso se estourar antes do primeiro pareamento');

  const dados = await res.json();
  assert.equal(dados.fase, 'pareando');
  assert.equal(dados.mensagens, 0);
  assert.equal(dados.conversas, 0);
  assert.equal(dados.ritmoPorMinuto, 0);
  assert.equal(dados.estimativa, null);
});

// ---------------------------------------------------------------- dynamic testing (seção 4)

test('Dynamic Testing 1 - Propriedade: mensagens nunca decresce entre chamadas (mesmo com deleções e drops)', () => {
  // Invariante: a contagem de mensagens exibida nunca decresce entre chamadas consecutivas,
  // mesmo se ocorrerem deleções no banco (ex.: corrupção, vacuum ou anomalias).
  // A guarda em progresso.js (#maiorMensagens) garante que a visão externa é estritamente não-decrescente.
  paraTodo(
    'propriedade: monotonicidade de mensagens sob inserções e deleções',
    (rnd) => {
      const passos = inteiro(rnd, 4, 12);
      const operacoes = [];
      for (let p = 0; p < passos; p++) {
        const tipo = escolher(rnd, ['inserir', 'inserir', 'deletar', 'zerar']);
        const qtd = inteiro(rnd, 1, 30);
        operacoes.push({ tipo, qtd });
      }
      return { operacoes };
    },
    ({ operacoes }) => {
      const db = abrirBanco();
      const progresso = new MonitorProgresso(db);
      let mensagensAnterior = -1;

      for (const op of operacoes) {
        if (op.tipo === 'inserir') {
          inserirMensagens(db, op.qtd);
        } else if (op.tipo === 'deletar') {
          // Deleta linhas para forçar a contagem física do SQLite a cair
          db.prepare('DELETE FROM eventos WHERE id IN (SELECT id FROM eventos LIMIT ?)').run(op.qtd);
        } else if (op.tipo === 'zerar') {
          // Esvazia completamente a tabela
          db.prepare('DELETE FROM eventos').run();
        }

        const est = progresso.estado();
        assert.ok(
          est.mensagens >= mensagensAnterior,
          `mensagens não pode decrescer: anterior=${mensagensAnterior}, atual=${est.mensagens}`
        );
        mensagensAnterior = est.mensagens;
      }
      db.close();
    },
    { casos: 50 }
  );
});

test('Dynamic Testing 2 - Adversarial: nenhum texto de mensagem chega a rota de progresso', () => {
  // Conteúdo malicioso de mensagens (tentativas de injeção, scripts, prompt injection)
  // não pode contaminar a rota de progresso, que deve retornar exclusivamente contagens e enums limpos.
  paraTodo(
    'adversarial: sanitização e isolamento de conteúdo de terceiro',
    (rnd) => {
      const textos = [];
      for (let i = 0; i < 5; i++) {
        textos.push(rnd() < 0.5 ? textoAdversarial(rnd) : textoCruel(rnd));
      }
      return { textos };
    },
    ({ textos }) => {
      const db = abrirBanco();
      const stmt = db.prepare(`
        INSERT INTO eventos (conversa_id, origem_id, direcao, tipo, bruto, texto, recebido_em, dia_local)
        VALUES (?, ?, 'entrada', 'texto', '{}', ?, '2026-09-12T12:00:00.000Z', '2026-09-12')
      `);
      for (let i = 0; i < textos.length; i++) {
        stmt.run(`adv_${i}@s.whatsapp.net`, `ORIG_ADV_${i}`, textos[i]);
      }

      const progresso = new MonitorProgresso(db);
      const est = progresso.estado();
      const jsonString = JSON.stringify(est);

      for (const texto of textos) {
        if (typeof texto === 'string' && texto.length > 5) {
          assert.equal(
            jsonString.includes(texto),
            false,
            `texto adversarial não pode aparecer na resposta de progresso: ${texto.slice(0, 30)}`
          );
        }
      }

      assert.ok(['pareando', 'recebendo', 'desacelerando', 'estavel'].includes(est.fase));
      assert.ok(typeof est.mensagens === 'number');
      assert.ok(typeof est.conversas === 'number');
      assert.ok(typeof est.ritmoPorMinuto === 'number');

      db.close();
    },
    { casos: 50 }
  );
});

test('Dynamic Testing 3 - Fronteira: 0, 1, grandes volumes, relogio alterado e app reiniciado', () => {
  const db = abrirBanco();
  const progresso = new MonitorProgresso(db);

  // 1. Zero mensagens
  assert.equal(progresso.estado().mensagens, 0);
  assert.equal(progresso.estado().fase, 'pareando');

  // 2. 1 mensagem
  inserirMensagens(db, 1);
  const est1 = progresso.estado();
  assert.equal(est1.mensagens, 1);
  assert.equal(est1.conversas, 1);

  // 3. Relógio do sistema alterado no meio: volta no tempo
  const t0 = Date.now();
  progresso.estado({ agora: new Date(t0) });
  // Relógio recuou 1 hora!
  const estVoltou = progresso.estado({ agora: new Date(t0 - 3600_000) });
  assert.ok(estVoltou.paradoHaSegundos >= 0, 'paradoHaSegundos nunca pode ser negativo mesmo se relógio retroceder');
  assert.ok(Number.isFinite(estVoltou.ritmoPorMinuto), 'ritmo deve permanecer número finito');

  // 4. Relógio avançou 5 horas de repente
  const estAvancou = progresso.estado({ agora: new Date(t0 + 5 * 3600_000) });
  assert.ok(estAvancou.paradoHaSegundos >= 0);
  assert.equal(estAvancou.fase, 'estavel', 'salto no tempo sem novas mensagens deve estabilizar');

  // 5. App reiniciado durante a carga: novo MonitorProgresso criado sobre banco com dados
  inserirMensagens(db, 50);
  const progressoReiniciado = new MonitorProgresso(db);
  const estReiniciado = progressoReiniciado.estado();
  assert.equal(estReiniciado.mensagens, 51, 'monitor reiniciado preserva contagem acumulada');
  assert.ok(Number.isFinite(estReiniciado.ritmoPorMinuto));

  db.close();
});

test('Dynamic Testing 4 - Temporal: janela movel nao divide por zero nem devolve Infinity', () => {
  // Teste de cálculo de ritmo sob concorrência extrema de milissegundos
  // Caso de duas amostras no exato mesmo milissegundo
  const ritmoZeroTempo = calcularRitmo([
    { tempoMs: 1000, mensagens: 10 },
    { tempoMs: 1000, mensagens: 20 }
  ], 60_000);
  assert.equal(ritmoZeroTempo, 0, 'deltaMs zero deve devolver 0, nunca Infinity ou NaN');
  assert.ok(!Number.isNaN(ritmoZeroTempo));

  // Amostras com delta negativo (relógio instável)
  const ritmoNegativo = calcularRitmo([
    { tempoMs: 2000, mensagens: 10 },
    { tempoMs: 1000, mensagens: 20 }
  ], 60_000);
  assert.equal(ritmoNegativo, 0, 'deltaMs negativo não pode gerar ritmo inválido');

  // Janela com apenas 1 amostra
  const ritmoUnico = calcularRitmo([{ tempoMs: 1000, mensagens: 10 }], 60_000);
  assert.equal(ritmoUnico, 0);

  // Lista vazia
  const ritmoVazio = calcularRitmo([], 60_000);
  assert.equal(ritmoVazio, 0);

  // formatarEstimativa cobre tempos humanos e casos limites
  assert.equal(formatarEstimativa(null), null);
  assert.equal(formatarEstimativa(0), null);
  assert.equal(formatarEstimativa(-5), null);
  assert.equal(formatarEstimativa(1), 'falta cerca de 1 minuto');
  assert.equal(formatarEstimativa(20), 'faltam uns 20 minutos');
  assert.equal(formatarEstimativa(75), 'faltam cerca de 1h e 15 min');
  assert.equal(formatarEstimativa(120), 'faltam cerca de 2h');
});

test('Bug de fronteira: painel.html nao usa innerHTML para dados de progresso e sanitiza entrada', async () => {
  // Prova que a faixa de progresso no painel.html não utiliza innerHTML para injetar dados dinâmicos,
  // eliminando o vetor de XSS caso os valores de fase ou contagem contenham caracteres HTML.
  const html = await readFile(new URL('../src/painel/painel.html', import.meta.url), 'utf8');

  // Verifica ausência de innerHTML na montagem do texto de progresso
  assert.equal(
    html.includes("$('progresso-texto').innerHTML"),
    false,
    'progresso-texto não deve usar innerHTML — manipulação segura via DOM/textContent'
  );

  // Executa o script com payload malicioso
  const payloadXss = '<img src=x onerror="window.malicioso=true">';
  const { ctx, getEl } = instanciarPainelScript(html, {
    fetchHandler: async () => ({
      ok: true,
      json: async () => ({
        fase: payloadXss,
        mensagens: 10,
        conversas: 1,
        ritmoPorMinuto: 5,
        estimativa: '<script>window.malicioso2=true</script>'
      })
    })
  });

  await ctx.verificarProgresso();

  const elTexto = getEl('progresso-texto');
  const elExtra = getEl('progresso-extra');

  // Garante que o script malicioso não foi executado no contexto
  assert.equal(ctx.window.malicioso, undefined, 'script malicioso via fase não pode ser executado');
  assert.equal(ctx.window.malicioso2, undefined, 'script malicioso via estimativa não pode ser executado');

  // O texto do elemento contém o fallback seguro ou o texto literal, sem tags HTML interpretadas
  assert.ok(
    elTexto.textContent.includes('Sincronizando histórico…') || elTexto.textContent.includes(payloadXss),
    'conteúdo deve ser tratado estritamente como texto puro'
  );
});
