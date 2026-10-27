// Testes do modulo de rascunho (SPEC-F4).
//
// Regras obrigatórias da spec:
// 1. A trava de seguranca (SPEC-F4-S1, S2, S3): rascunho e texto parado na tela do dono. Nada sai.
// 2. Criterios de aceite A1 a A5: no maximo 1 por dia, sem duplicacao, sem envio, estado preservado, lastro em origem_id.
// 3. Quatro classes de teste dinamico: propriedade, adversarial, fronteira e temporal.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../src/banco.js';
import { Politica } from '../src/autorizacao.js';
import { diaLocal, agoraIso } from '../src/relogio.js';
import {
  paraTodo,
  itemCruel,
  textoAdversarial,
  textoCruel,
  dataCruel,
  identificadorCruel
} from './gerador.js';
import {
  escolherAlvo,
  montarPedido,
  gravarRascunho,
  rascunhoDoDia,
  descartarRascunho,
  usarRascunho,
  prepararEsquemaRascunho
} from '../src/rascunho.js';

const AGORA_FIXO = '2026-09-12T15:00:00.000Z';

function bancoMemoria() {
  const db = abrirBanco(':memory:');
  prepararEsquemaRascunho(db);
  return db;
}

describe('SPEC-F4 — Trava de seguranca obrigatoria (S1, S2, S3)', () => {
  test('S1: src/rascunho.js nao importa saidas.js, transporte nem socket', () => {
    // A trava que permite o rascunho conviver com a regra dura do dono:
    // o arquivo nao pode sequer referenciar os modulos de envio.
    const caminho = new URL('../src/rascunho.js', import.meta.url);
    const conteudo = readFileSync(caminho, 'utf-8');

    assert.doesNotMatch(conteudo, /from\s+['"].*saidas(\.js)?['"]/, 'proibido importar src/saidas.js');
    assert.doesNotMatch(conteudo, /from\s+['"].*transporte.*['"]/, 'proibido importar transporte');
    assert.doesNotMatch(conteudo, /from\s+['"].*socket.*['"]/, 'proibido importar socket');
    assert.doesNotMatch(conteudo, /import\s*\(\s*['"].*saidas.*['"]\s*\)/, 'proibido import dinamico de saidas');
    assert.doesNotMatch(conteudo, /import\s*\(\s*['"].*transporte.*['"]\s*\)/, 'proibido import dinamico de transporte');
    assert.doesNotMatch(conteudo, /node:(net|dgram)/, 'proibido abrir sockets de rede');
    assert.doesNotMatch(conteudo, /['"]baileys['"]/, 'proibido conectar ao WhatsApp direto');
  });

  test('S2: nenhuma linha entra na tabela saidas ao gravar rascunho', () => {
    const db = bancoMemoria();
    const countAntes = db.prepare('SELECT COUNT(*) c FROM saidas').get().c;

    gravarRascunho(db, {
      itemId: 42,
      texto: 'Olá, segue a proposta conforme combinamos.',
      modelo: 'flash',
      agora: AGORA_FIXO
    });

    const countDepois = db.prepare('SELECT COUNT(*) c FROM saidas').get().c;
    assert.equal(countAntes, 0, 'tabela saidas deve comecar vazia');
    assert.equal(countDepois, 0, 'gravar rascunho nunca pode inserir linha em saidas');
  });

  test('S3: podeEnviar() continua devolvendo "sem regra cadastrada" depois de tudo', () => {
    const db = bancoMemoria();
    const politica = new Politica(db);
    const dm = '551199999999@s.whatsapp.net';
    const grupo = '120363001234@g.us';

    // Estado inicial
    assert.deepEqual(politica.podeEnviar(dm), { permitido: false, motivo: 'sem regra cadastrada' });
    assert.deepEqual(politica.podeEnviar(grupo), { permitido: false, motivo: 'sem regra cadastrada' });

    // Executa o fluxo completo de rascunho
    const itens = [
      { id: 1, tipo: 'lead', resumo: 'Interesse em consultoria', origem_id: 'MSG1', estado: 'aberto', conversa_id: dm }
    ];
    const alvo = escolherAlvo(itens, { agora: AGORA_FIXO });
    assert.ok(alvo);
    const prompt = montarPedido(alvo, [{ origem_id: 'MSG1', texto: 'quanto custa?' }]);
    assert.ok(prompt);
    gravarRascunho(db, { itemId: alvo.id, texto: 'Proposta inicial', modelo: 'flash', agora: AGORA_FIXO });
    const r = rascunhoDoDia(db, { agora: AGORA_FIXO });
    assert.ok(r);

    // Veredito apos toda a operacao de rascunho
    assert.deepEqual(politica.podeEnviar(dm), { permitido: false, motivo: 'sem regra cadastrada' },
      'nenhuma conversa vira autorizada por geracao de rascunho');
    assert.deepEqual(politica.podeEnviar(grupo), { permitido: false, motivo: 'sem regra cadastrada' },
      'nenhum grupo vira autorizado por geracao de rascunho');
  });
});

describe('SPEC-F4 — Criterios de aceite (A1 a A5)', () => {
  test('A1: no maximo 1 rascunho por dia', () => {
    const db = bancoMemoria();
    const dia = '2026-09-12';

    gravarRascunho(db, { itemId: 1, texto: 'Primeiro rascunho', modelo: 'flash', dia });
    // Tenta forcar um segundo no mesmo dia
    gravarRascunho(db, { itemId: 2, texto: 'Segundo rascunho', modelo: 'flash', dia });

    const total = db.prepare('SELECT COUNT(*) c FROM rascunhos WHERE dia = ?').get(dia).c;
    assert.equal(total, 1, 'e falso se existir 2 no mesmo dia');

    const res = rascunhoDoDia(db, { dia });
    assert.ok(res);
    assert.equal(res.dia, dia);
  });

  test('A2: rodar duas vezes no mesmo dia nao cria o segundo (contagem nao sobe)', () => {
    const db = bancoMemoria();
    const dia = '2026-09-12';

    const r1 = gravarRascunho(db, { itemId: 10, texto: 'Texto A', modelo: 'flash', dia });
    const count1 = db.prepare('SELECT COUNT(*) c FROM rascunhos').get().c;
    assert.equal(count1, 1);

    const r2 = gravarRascunho(db, { itemId: 20, texto: 'Texto B', modelo: 'flash', dia });
    const count2 = db.prepare('SELECT COUNT(*) c FROM rascunhos').get().c;
    assert.equal(count2, 1, 'a contagem nao pode subir ao rodar novamente no mesmo dia');
    assert.equal(r1.id, r2.id, 'deve preservar o rascunho ja existente do dia');
  });

  test('A3: sem item aberto, devolve null sem gravar nada', () => {
    const dbAberto = bancoMemoria();
    const dbFechado = bancoMemoria();

    const itemBase = {
      id: 77,
      tipo: 'lead',
      resumo: 'Interesse em projeto',
      quando: AGORA_FIXO,
      origem_id: 'MSG77'
    };

    // Mudando UMA variavel so: mantendo todo o resto exatamente igual
    const itemAberto = { ...itemBase, estado: 'aberto' };
    const itemFechado = { ...itemBase, estado: 'resolvido' };

    // Caso 1: com item aberto, escolherAlvo acha o item e gravarRascunho grava com sucesso
    const alvoAberto = escolherAlvo([itemAberto], { agora: AGORA_FIXO });
    assert.equal(alvoAberto?.id, 77);
    const gravadoAberto = alvoAberto
      ? gravarRascunho(dbAberto, { itemId: alvoAberto.id, texto: 'Proposta comercial', dia: '2026-09-12' })
      : null;
    assert.ok(gravadoAberto);
    assert.equal(gravadoAberto.item_id, 77);
    assert.equal(dbAberto.prepare('SELECT COUNT(*) c FROM rascunhos').get().c, 1);

    // Caso 2: com item fechado (apenas estado alterado), escolherAlvo devolve null
    const itensFechados = [
      itemFechado,
      { ...itemBase, id: 78, estado: 'descartado' },
      { ...itemBase, id: 79, estado: 'expirado' }
    ];
    const alvoFechado = escolherAlvo(itensFechados, { agora: AGORA_FIXO });
    assert.equal(alvoFechado, null, 'sem item aberto, escolherAlvo deve devolver null');

    // Tenta gravar usando o resultado do alvoFechado no fluxo completo
    const gravadoFechado = alvoFechado
      ? gravarRascunho(dbFechado, { itemId: alvoFechado.id, texto: 'Proposta comercial', dia: '2026-09-12' })
      : null;
    assert.equal(gravadoFechado, null, 'fluxo completo com itens fechados devolve null');

    // Tambem tenta passar diretamente alvoFechado?.id para gravarRascunho
    const gravadoDireto = gravarRascunho(dbFechado, {
      itemId: alvoFechado?.id,
      texto: 'Proposta comercial',
      dia: '2026-09-12'
    });
    assert.equal(gravadoDireto, null, 'gravarRascunho devolve null sem id de item');

    const countFechado = dbFechado.prepare('SELECT COUNT(*) c FROM rascunhos').get().c;
    assert.equal(countFechado, 0, 'sem item aberto, nenhuma linha e gravada no banco');
  });

  test('A4: descartar o rascunho nao apaga a linha (e estado)', () => {
    const db = bancoMemoria();
    const r = gravarRascunho(db, { itemId: 15, texto: 'Rascunho inicial', modelo: 'flash', dia: '2026-09-12' });
    assert.equal(r.estado, 'rascunho');

    const desc = descartarRascunho(db, r.id);
    assert.equal(desc.estado, 'descartado');

    const linhas = db.prepare('SELECT * FROM rascunhos WHERE id = ?').all(r.id);
    assert.equal(linhas.length, 1, 'a linha nao pode sumir ao descartar rascunho');
    assert.equal(linhas[0].estado, 'descartado');

    const total = db.prepare('SELECT COUNT(*) c FROM rascunhos').get().c;
    assert.equal(total, 1, 'descartar e mudanca de estado, nao DELETE');
  });

  test('A4b: usarRascunho transiciona rascunho -> usado sem apagar linha e fecha ciclo de estados', () => {
    const db = bancoMemoria();

    // 1. Cria rascunho inicial (estado: 'rascunho')
    const r = gravarRascunho(db, { itemId: 55, texto: 'Rascunho para envio', modelo: 'flash', dia: '2026-09-12' });
    assert.equal(r.estado, 'rascunho');

    // 2. Transicao direta rascunho -> usado
    const usado = usarRascunho(db, r.id, { agora: '2026-09-12T16:00:00.000Z' });
    assert.equal(usado.id, r.id);
    assert.equal(usado.estado, 'usado');
    assert.equal(usado.atualizado_em, '2026-09-12T16:00:00.000Z');

    // A linha continua existindo no banco (nao e DELETE)
    const total = db.prepare('SELECT COUNT(*) c FROM rascunhos').get().c;
    assert.equal(total, 1, 'usarRascunho e mudanca de estado, nao DELETE');

    // 3. Transicao rascunho -> descartado -> usado (recuperar rascunho descartado)
    const db2 = bancoMemoria();
    const r2 = gravarRascunho(db2, { itemId: 56, texto: 'Segundo rascunho', dia: '2026-09-12' });
    const descartado = descartarRascunho(db2, r2);
    assert.equal(descartado.estado, 'descartado');

    const recuperadoUsado = usarRascunho(db2, r2);
    assert.equal(recuperadoUsado.estado, 'usado');
    assert.equal(db2.prepare('SELECT COUNT(*) c FROM rascunhos').get().c, 1);

    // 4. Chamada com id inexistente ou nulo devolve null
    assert.equal(usarRascunho(db2, 99999), null);
    assert.equal(usarRascunho(db2, null), null);
  });

  test('A5: o pedido cita o origem_id da mensagem real', () => {
    const item = {
      id: 7,
      origem_id: 'MSG_REAL_98765',
      tipo: 'lead',
      resumo: 'Interesse em fechar projeto',
      responsavel: 'Fabricio'
    };
    const mensagens = [
      { origem_id: 'MSG_REAL_98765', texto: 'Fabricio, quanto fica o projeto?', autor_e_dono: 0 }
    ];

    const prompt = montarPedido(item, mensagens);

    assert.match(prompt, /MSG_REAL_98765/, 'o pedido precisa citar o origem_id real para ter lastro');
    assert.match(prompt, /voz do dono|Fabrício|Fabricio/i, 'deve pedir na voz do dono');
    assert.match(prompt, /não inventar|nao inventar/i, 'deve conter proibicao explicita de invencao');
    assert.match(prompt, /preço|prazo|compromisso/i, 'deve proibir inventar preco, prazo ou compromisso');
    assert.match(prompt, /curto/i, 'deve pedir um rascunho curto');
    assert.match(prompt, /português|portugues/i, 'deve explicitar idioma portugues');
  });
});

describe('SPEC-F4 — Dynamic testing (4 classes)', () => {
  test('Propriedade: para qualquer lista, escolherAlvo devolve item da propria lista ou null', () => {
    paraTodo(
      'escolherAlvo devolve item da propria lista ou null',
      (rnd, i) => {
        const n = i % 20;
        const lista = [];
        for (let k = 0; k < n; k++) {
          lista.push(itemCruel(rnd, k));
        }
        return lista;
      },
      (lista) => {
        const alvo = escolherAlvo(lista, { agora: AGORA_FIXO });
        if (alvo === null) {
          // Se devolveu null, deve ser porque nao havia item aberto ou a lista era vazia
          const temAberto = lista.some((item) => item.estado === 'aberto' || item.estado === undefined);
          assert.ok(!temAberto || lista.length === 0, 'so pode devolver null se nao houver item aberto');
        } else {
          // Objeto devolvido deve pertencer exatamente a lista passada por referencia
          assert.ok(lista.includes(alvo), 'item devolvido deve ser da propria lista, nunca inventado');
          assert.ok(alvo.estado === 'aberto' || alvo.estado === undefined, 'item escolhido deve ser aberto ou sem estado');
        }
      },
      { casos: 150 }
    );
  });

  test('Adversarial: item com textoAdversarial nao contamina politicas nem toca em envio', () => {
    paraTodo(
      'textoAdversarial nao consegue burlar envio nem alterar autorizacao',
      (rnd) => {
        const textoMalicioso = textoAdversarial(rnd);
        const dm = identificadorCruel(rnd) || '551188888888@s.whatsapp.net';
        return { textoMalicioso, dm };
      },
      ({ textoMalicioso, dm }) => {
        const db = bancoMemoria();
        const politica = new Politica(db);

        const item = {
          id: 999,
          tipo: 'compromisso',
          resumo: textoMalicioso,
          origem_id: 'MSG_ADV_1',
          conversa_id: dm,
          estado: 'aberto',
          quando: AGORA_FIXO,
        };

        const alvo = escolherAlvo([item], { agora: AGORA_FIXO });
        assert.equal(alvo, item);

        const prompt = montarPedido(item, [{ origem_id: 'MSG_ADV_1', texto: textoMalicioso }]);
        // O prompt deve sinalizar que conteudo e evidencia, nao instrucao
        assert.match(prompt, /evidência|evidencia/i, 'prompt deve instruir que conteudo e evidencia, nunca instrucao');

        gravarRascunho(db, {
          itemId: item.id,
          texto: 'Rascunho gerado',
          modelo: 'flash',
          dia: '2026-09-12',
        });

        // Checa se tabela saidas continua zerada
        const totalSaidas = db.prepare('SELECT COUNT(*) c FROM saidas').get().c;
        assert.equal(totalSaidas, 0, 'injecao adversarial nao pode criar linha em saidas');

        // Checa se politica de envio continua bloqueada
        assert.deepEqual(politica.podeEnviar(dm), { permitido: false, motivo: 'sem regra cadastrada' });
      },
      { casos: 50 }
    );
  });

  test('Fronteira: lista vazia, 1 item, empate de valor, item sem origem_id', () => {
    // 1. Lista vazia
    assert.equal(escolherAlvo([], { agora: AGORA_FIXO }), null);

    // 2. 1 item aberto
    const unico = { id: 1, tipo: 'lead', resumo: 'Lead unico', estado: 'aberto', quando: AGORA_FIXO };
    assert.equal(escolherAlvo([unico], { agora: AGORA_FIXO }), unico);

    // 3. Todos do mesmo valor (empate) -> deterministico e estavel
    const iguais = [
      { id: 10, tipo: 'compromisso', resumo: 'Mesmo peso A', estado: 'aberto', quando: AGORA_FIXO },
      { id: 20, tipo: 'compromisso', resumo: 'Mesmo peso B', estado: 'aberto', quando: AGORA_FIXO },
      { id: 30, tipo: 'compromisso', resumo: 'Mesmo peso C', estado: 'aberto', quando: AGORA_FIXO },
    ];
    const escolhido = escolherAlvo(iguais, { agora: AGORA_FIXO });
    assert.equal(escolhido, iguais[0], 'empate deve ser estavel mantendo o primeiro da lista');

    // 3b. Empate estavel com datas invalidas e ausentes
    const iguaisComDataInvalida = [
      { id: 100, tipo: 'lead', resumo: 'Sem data', estado: 'aberto' },
      { id: 200, tipo: 'lead', resumo: 'Data lixo', estado: 'aberto', quando: 'lixo' },
      { id: 300, tipo: 'lead', resumo: 'Data vazia', estado: 'aberto', quando: '' },
    ];
    assert.equal(escolherAlvo(iguaisComDataInvalida, { agora: AGORA_FIXO }), iguaisComDataInvalida[0],
      'empate com datas invalidas/ausentes deve manter o primeiro da lista');

    const invertidosInvalida = [
      { id: 200, tipo: 'lead', resumo: 'Data lixo', estado: 'aberto', quando: 'lixo' },
      { id: 100, tipo: 'lead', resumo: 'Sem data', estado: 'aberto' },
    ];
    assert.equal(escolherAlvo(invertidosInvalida, { agora: AGORA_FIXO }), invertidosInvalida[0]);

    // Mas sinal adicional desempata corretamente mesmo com data invalida
    const desempatePorDM = [
      { id: 401, tipo: 'lead', resumo: 'No grupo', conversa_id: '123@g.us', estado: 'aberto', quando: 'lixo' },
      { id: 402, tipo: 'lead', resumo: 'Na DM', conversa_id: '123@s.whatsapp.net', estado: 'aberto' },
    ];
    assert.equal(escolherAlvo(desempatePorDM, { agora: AGORA_FIXO })?.id, 402, 'DM desempata sobre grupo mesmo com datas invalidas/ausentes');

    // 4. Item sem origem_id nao derruba o modulo
    const semOrigem = { id: 40, tipo: 'decisao', resumo: 'Sem origem id', estado: 'aberto' };
    const alvoSemOrigem = escolherAlvo([semOrigem], { agora: AGORA_FIXO });
    assert.equal(alvoSemOrigem, semOrigem);
    const promptSemOrigem = montarPedido(semOrigem, []);
    assert.ok(typeof promptSemOrigem === 'string');
    assert.ok(promptSemOrigem.length > 0);

    // 5. Fronteira de estado: 'aberto' vs undefined vs '' vs null
    const itemSemEstado = { id: 50, tipo: 'lead', resumo: 'Sem prop estado' }; // undefined
    assert.equal(escolherAlvo([itemSemEstado], { agora: AGORA_FIXO }), itemSemEstado, 'item sem estado (undefined) deve ser tratado como aberto');

    const itemEstadoVazio = { id: 51, tipo: 'lead', resumo: 'Estado vazio', estado: '' };
    assert.equal(escolherAlvo([itemEstadoVazio], { agora: AGORA_FIXO }), null, 'item com estado: "" nao pode ser tratado como aberto');

    const itemEstadoNull = { id: 52, tipo: 'lead', resumo: 'Estado null', estado: null };
    assert.equal(escolherAlvo([itemEstadoNull], { agora: AGORA_FIXO }), null, 'item com estado: null nao pode ser tratado como aberto');

    const listaMista = [
      { id: 53, tipo: 'lead', resumo: 'String vazia', estado: '' },
      { id: 54, tipo: 'lead', resumo: 'Valido aberto', estado: 'aberto' }
    ];
    assert.equal(escolherAlvo(listaMista, { agora: AGORA_FIXO })?.id, 54, 'deve ignorar estado: "" e selecionar o aberto');
  });

  test('Temporal: fuso America/Sao_Paulo e virada de dia garantem 1 por dia local', () => {
    const db = bancoMemoria();

    // 23:45 em Sao Paulo no dia 2026-09-12 (UTC: 2026-09-13T02:45:00Z)
    const noiteSp = new Date('2026-09-13T02:45:00.000Z');
    assert.equal(diaLocal(noiteSp), '2026-09-12');

    // 00:15 em Sao Paulo no dia 2026-09-13 (UTC: 2026-09-13T03:15:00Z)
    const madrugadaSp = new Date('2026-09-13T03:15:00.000Z');
    assert.equal(diaLocal(madrugadaSp), '2026-09-13');

    // Grava rascunho na noite do dia 12
    const r1 = gravarRascunho(db, { itemId: 1, texto: 'Rascunho noite', agora: noiteSp });
    assert.equal(r1.dia, '2026-09-12');

    // Tentativa as 23:55 (mesmo dia local) nao cria segundo rascunho
    const noite2Sp = new Date('2026-09-13T02:55:00.000Z');
    const r1Repetido = gravarRascunho(db, { itemId: 2, texto: 'Tentativa mesma noite', agora: noite2Sp });
    assert.equal(r1Repetido.id, r1.id);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM rascunhos').get().c, 1);

    // Na virada (dia 13 local), um novo rascunho passa a ser permitido
    const r2 = gravarRascunho(db, { itemId: 3, texto: 'Rascunho novo dia', agora: madrugadaSp });
    assert.equal(r2.dia, '2026-09-13');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM rascunhos').get().c, 2);

    // Consulta de cada dia devolve seu respectivo rascunho
    const buscaDia12 = rascunhoDoDia(db, { dia: '2026-09-12' });
    const buscaDia13 = rascunhoDoDia(db, { dia: '2026-09-13' });
    assert.equal(buscaDia12.id, r1.id);
    assert.equal(buscaDia13.id, r2.id);

    // Com dataCruel: afeta gravarRascunho, diaLocal e a restricao de 1-por-dia sem quebrar
    paraTodo(
      'datas crueis afetam diaLocal, gravarRascunho e restricao 1-por-dia sem quebrar',
      (rnd) => dataCruel(rnd),
      (data) => {
        const dbLocal = bancoMemoria();

        // 1. gravarRascunho com agora: data grava com sucesso e dia possui formato YYYY-MM-DD
        const r1Cruel = gravarRascunho(dbLocal, { itemId: 10, texto: 'Rascunho temporal', agora: data });
        assert.ok(r1Cruel, 'gravarRascunho deve gravar mesmo com dataCruel');
        assert.match(r1Cruel.dia, /^\d{4}-\d{2}-\d{2}$/, 'dia gravado deve ter formato YYYY-MM-DD');
        assert.equal(r1Cruel.item_id, 10);

        // 2. Restricao de 1-por-dia local resiste a dataCruel
        const r2Cruel = gravarRascunho(dbLocal, { itemId: 20, texto: 'Tentativa mesmo dia', agora: data });
        assert.equal(r2Cruel.id, r1Cruel.id, 'segunda tentativa no mesmo dia local deve devolver o existente');
        assert.equal(dbLocal.prepare('SELECT COUNT(*) c FROM rascunhos WHERE dia = ?').get(r1Cruel.dia).c, 1);

        // 3. rascunhoDoDia acha o mesmo rascunho passando a dataCruel
        const doDia = rascunhoDoDia(dbLocal, { agora: data });
        assert.ok(doDia);
        assert.equal(doDia.id, r1Cruel.id);

        // 4. escolherAlvo com item de dataCruel e item com data fixa escolhe deterministica e estavelmente
        const itemCruel = { id: 101, tipo: 'lead', resumo: 'Data cruel', estado: 'aberto', quando: data };
        const itemFixo = { id: 102, tipo: 'lead', resumo: 'Data fixa', estado: 'aberto', quando: AGORA_FIXO };
        const escolhido = escolherAlvo([itemCruel, itemFixo], { agora: AGORA_FIXO });
        assert.ok(escolhido === itemCruel || escolhido === itemFixo, 'escolherAlvo deve selecionar um dos dois itens');
      },
      { casos: 40 }
    );
  });
});
