import test from 'node:test';
import assert from 'node:assert/strict';

import { pontuar, ordenarPorValor } from '../src/valor.js';
import {
  paraTodo,
  itemCruel,
  textoAdversarial,
  textoCruel,
  dataCruel,
  identificadorCruel,
  inteiro
} from './gerador.js';

// Base temporal fixa para testes determinísticos
const AGORA = Date.parse('2026-09-12T12:00:00.000Z');
const haDias = d => new Date(AGORA - d * 86400000).toISOString();

// ============================================================================
// CRITÉRIOS DE ACEITE (SPEC-F2)
// ============================================================================

test('A1: Lead com valor citado e 2 dias fica acima de pendência de grupo com 200 dias', () => {
  const lead = {
    id: 1,
    tipo: 'lead',
    resumo: 'Proposta de consultoria R$ 20k',
    quando: haDias(2),
    conversa_id: '5511999999999@s.whatsapp.net'
  };
  const pendencia = {
    id: 2,
    tipo: 'pendencia',
    resumo: 'Aguardando retorno do relatório',
    quando: haDias(200),
    conversa_id: '12036302@g.us'
  };

  const ordenados = ordenarPorValor([pendencia, lead], { agora: AGORA });
  assert.equal(ordenados[0].id, lead.id, 'o lead deveria estar no topo');
  assert.equal(ordenados[1].id, pendencia.id, 'a pendência de 200 dias deveria estar abaixo');
});

test('A2: Toda pontuação vem com ≥1 porquê', () => {
  const casos = [
    { tipo: 'lead', resumo: 'R$ 20k', quando: haDias(2), conversa_id: '551199@s.whatsapp.net' },
    { tipo: 'compromisso', resumo: '', quando: haDias(10), conversa_id: '123@g.us' },
    { tipo: 'decisao', resumo: 'algo', quando: null },
    {},
    { tipo: 'desconhecido', quando: 'ontem' }
  ];

  for (const item of casos) {
    const res = pontuar(item, { agora: AGORA });
    assert.ok(typeof res.pontos === 'number', 'pontos deve ser numérico');
    assert.ok(Array.isArray(res.porques), 'porques deve ser array');
    assert.ok(res.porques.length >= 1, `item sem porquês: ${JSON.stringify(item)}`);
    for (const pq of res.porques) {
      assert.ok(typeof pq === 'string' && pq.trim().length > 0, 'cada porquê deve ser texto não vazio');
    }
  }
});

test('A3: ordenarPorValor não muta a entrada', () => {
  const item1 = { id: 1, tipo: 'pendencia', quando: haDias(50) };
  const item2 = { id: 2, tipo: 'lead', quando: haDias(1) };
  const item3 = { id: 3, tipo: 'compromisso', quando: haDias(5) };

  const entrada = [item1, item2, item3];
  const copiaOriginal = [...entrada];
  const saida = ordenarPorValor(entrada, { agora: AGORA });

  assert.deepEqual(entrada, copiaOriginal, 'o array de entrada não pode ter sua ordem alterada');
  assert.notEqual(saida, entrada, 'deve retornar um novo array');
  assert.equal(item1.id, 1, 'propriedades dos itens não devem ser corrompidas');
});

test('A4: Ordenação é estável no empate', () => {
  // Dois itens com pontuação exatamente idêntica devem manter a ordem original
  const itemA = { id: 'A', tipo: 'compromisso', quando: haDias(5), conversa_id: '123@g.us', resumo: 'mesmo' };
  const itemB = { id: 'B', tipo: 'compromisso', quando: haDias(5), conversa_id: '123@g.us', resumo: 'mesmo' };

  const res1 = ordenarPorValor([itemA, itemB], { agora: AGORA });
  assert.equal(res1[0].id, 'A');
  assert.equal(res1[1].id, 'B');

  const res2 = ordenarPorValor([itemB, itemA], { agora: AGORA });
  assert.equal(res2[0].id, 'B');
  assert.equal(res2[1].id, 'A');
});

test('A5: Item com data ausente/inválida não some — vai para o fim com porquê declarado', () => {
  const itemValido = { id: 1, tipo: 'decisao', quando: haDias(100), conversa_id: '123@g.us' };
  const itemSemData = { id: 2, tipo: 'lead', quando: null, resumo: 'sem data' };
  const itemDataInvalida = { id: 3, tipo: 'lead', quando: 'ontem', resumo: 'data errada' };
  const itemDataVazia = { id: 4, tipo: 'compromisso', quando: '', resumo: 'string vazia' };

  const entrada = [itemSemData, itemValido, itemDataInvalida, itemDataVazia];
  const saida = ordenarPorValor(entrada, { agora: AGORA });

  assert.equal(saida.length, 4, 'nenhum item pode desaparecer');
  // O item com data válida deve vir antes de todos os itens com data inválida/ausente
  assert.equal(saida[0].id, itemValido.id, 'item válido deve vir antes de itens sem data');

  for (const item of [itemSemData, itemDataInvalida, itemDataVazia]) {
    const pontuacao = pontuar(item, { agora: AGORA });
    assert.ok(
      pontuacao.porques.some(p => /data/i.test(p)),
      `item com data inválida deve declarar porquê sobre a data: ${pontuacao.porques.join(', ')}`
    );
  }
});

test('A6: Reordenar duas vezes dá o mesmo resultado (idempotência e estabilidade em empate)', () => {
  const quandoPadrao = haDias(5);
  // Itens com pontuações variadas, incluindo múltiplos itens com notas idênticas (empate-A, empate-B, empate-C)
  const itens = [
    { id: 1, tipo: 'pendencia', quando: haDias(20), conversa_id: '123@g.us' },
    { id: 'empate-A', tipo: 'compromisso', quando: quandoPadrao, conversa_id: '123@g.us', resumo: 'mesma nota' },
    { id: 2, tipo: 'lead', quando: haDias(3), resumo: 'R$ 5k', conversa_id: '5511@s.whatsapp.net' },
    { id: 'empate-B', tipo: 'compromisso', quando: quandoPadrao, conversa_id: '123@g.us', resumo: 'mesma nota' },
    { id: 3, tipo: 'decisao', quando: haDias(5), conversa_id: '123@g.us' },
    { id: 'empate-C', tipo: 'compromisso', quando: quandoPadrao, conversa_id: '123@g.us', resumo: 'mesma nota' },
    { id: 4, tipo: 'lead', quando: null }
  ];

  // Comprova que os itens empatados possuem de fato a mesma pontuação
  const pA = pontuar(itens[1], { agora: AGORA }).pontos;
  const pB = pontuar(itens[3], { agora: AGORA }).pontos;
  const pC = pontuar(itens[5], { agora: AGORA }).pontos;
  assert.equal(pA, pB, 'empate-A e empate-B devem ter mesma pontuação');
  assert.equal(pB, pC, 'empate-B e empate-C devem ter mesma pontuação');

  const primeira = ordenarPorValor(itens, { agora: AGORA });
  const segunda = ordenarPorValor(primeira, { agora: AGORA });

  assert.deepEqual(
    segunda.map(i => i.id),
    primeira.map(i => i.id),
    'reordenar uma lista já ordenada não deve alterar a ordem'
  );

  // A spec diz: "dois itens de mesma nota trocarem de posição" — verifica que a ordem estável entre si é preservada
  const posA1 = primeira.findIndex(i => i.id === 'empate-A');
  const posB1 = primeira.findIndex(i => i.id === 'empate-B');
  const posC1 = primeira.findIndex(i => i.id === 'empate-C');
  assert.ok(posA1 < posB1 && posB1 < posC1, 'primeira ordenação deve preservar ordem de entrada dos empatados');

  const posA2 = segunda.findIndex(i => i.id === 'empate-A');
  const posB2 = segunda.findIndex(i => i.id === 'empate-B');
  const posC2 = segunda.findIndex(i => i.id === 'empate-C');
  assert.ok(posA2 < posB2 && posB2 < posC2, 'segunda ordenação deve preservar a ordem estável entre si dos empatados');
  assert.equal(posA1, posA2, 'posição de empate-A deve ser idêntica na 1ª e 2ª chamada');
  assert.equal(posB1, posB2, 'posição de empate-B deve ser idêntica na 1ª e 2ª chamada');
  assert.equal(posC1, posC2, 'posição de empate-C deve ser idêntica na 1ª e 2ª chamada');
});

// ============================================================================
// HIERARQUIA DE SINAIS DE VALOR
// ============================================================================

test('Sinais: peso de tipo (lead > compromisso > pendencia > decisao)', () => {
  const quando = haDias(5);
  const lead = { tipo: 'lead', quando, conversa_id: '123@g.us' };
  const comp = { tipo: 'compromisso', quando, conversa_id: '123@g.us' };
  const pend = { tipo: 'pendencia', quando, conversa_id: '123@g.us' };
  const deci = { tipo: 'decisao', quando, conversa_id: '123@g.us' };

  const pLead = pontuar(lead, { agora: AGORA }).pontos;
  const pComp = pontuar(comp, { agora: AGORA }).pontos;
  const pPend = pontuar(pend, { agora: AGORA }).pontos;
  const pDeci = pontuar(deci, { agora: AGORA }).pontos;

  assert.ok(pLead > pComp, 'lead deve pontuar mais que compromisso');
  assert.ok(pComp > pPend, 'compromisso deve pontuar mais que pendência');
  assert.ok(pPend > pDeci, 'pendência deve pontuar mais que decisão');
});

test('Sinais: frescor (item de 2 dias vale mais que o de 200 dias)', () => {
  const novo = { tipo: 'compromisso', quando: haDias(2), conversa_id: '123@g.us' };
  const velho = { tipo: 'compromisso', quando: haDias(200), conversa_id: '123@g.us' };

  const pNovo = pontuar(novo, { agora: AGORA }).pontos;
  const pVelho = pontuar(velho, { agora: AGORA }).pontos;

  assert.ok(pNovo > pVelho, 'item recente de 2 dias deve pontuar mais que de 200 dias');
});

test('Sinais: valor monetário citado no resumo (R$ 20k, 20 mil, R$1.500)', () => {
  const semValor = { tipo: 'lead', quando: haDias(3), resumo: 'Conversa geral' };
  const com20k = { tipo: 'lead', quando: haDias(3), resumo: 'Contrato de R$ 20k fechando' };
  const com20mil = { tipo: 'lead', quando: haDias(3), resumo: 'Contrato de 20 mil fechando' };
  const com1500 = { tipo: 'lead', quando: haDias(3), resumo: 'Serviço pontual R$1.500' };

  const pSem = pontuar(semValor, { agora: AGORA }).pontos;
  const p20k = pontuar(com20k, { agora: AGORA }).pontos;
  const p20mil = pontuar(com20mil, { agora: AGORA }).pontos;
  const p1500 = pontuar(com1500, { agora: AGORA }).pontos;

  assert.ok(p20k > pSem, 'R$ 20k deve pontuar mais que sem valor');
  assert.ok(p20mil > pSem, '20 mil deve pontuar mais que sem valor');
  assert.ok(p1500 > pSem, 'R$1.500 deve pontuar mais que sem valor');
});

test('Sinais: DM vale mais que grupo e ausência de canal não ganha bônus', () => {
  const dm = { tipo: 'pendencia', quando: haDias(2), conversa_id: '5511999999999@s.whatsapp.net' };
  const grupo = { tipo: 'pendencia', quando: haDias(2), conversa_id: '12036302@g.us' };
  const semCanal = { tipo: 'pendencia', quando: haDias(2) };

  const pDm = pontuar(dm, { agora: AGORA }).pontos;
  const pGrupo = pontuar(grupo, { agora: AGORA }).pontos;
  const pSemCanal = pontuar(semCanal, { agora: AGORA }).pontos;

  assert.ok(pDm > pGrupo, 'DM deve pontuar mais que grupo');
  assert.ok(pDm > pSemCanal, 'DM deve pontuar mais que item sem canal identificado');
  assert.equal(pGrupo, pSemCanal, 'grupo e sem canal não recebem bônus de DM');

  const resDm = pontuar(dm, { agora: AGORA });
  const resGrupo = pontuar(grupo, { agora: AGORA });
  const resSemCanal = pontuar(semCanal, { agora: AGORA });
  assert.ok(resDm.porques.includes('conversa direta (DM)'), 'DM deve declarar porquê de conversa direta');
  assert.ok(resGrupo.porques.includes('mensagem em grupo'), 'grupo deve declarar porquê de mensagem em grupo');
  assert.ok(!resSemCanal.porques.includes('conversa direta (DM)'), 'item sem canal não deve ganhar porquê de DM');
  assert.ok(!resSemCanal.porques.includes('mensagem em grupo'), 'item sem canal não deve ganhar porquê de grupo');
});

test('Contexto: mensagensDepois é aceito e incluído nos porquês', () => {
  const item = { tipo: 'pendencia', quando: haDias(2), conversa_id: '123@g.us' };
  const res = pontuar(item, { agora: AGORA, mensagensDepois: 42 });
  assert.ok(
    res.porques.some(p => p.includes('42')),
    'mensagensDepois deve ser mencionado no array de porquês'
  );
});

// ============================================================================
// AS 4 CLASSES DE TESTE DINÂMICO (SPEC-F2)
// ============================================================================

test('Dinâmico 1 (Propriedade): ordenarPorValor conserva tamanho e integridade com itemCruel()', () => {
  paraTodo(
    'propriedade: tamanho conservado e sem duplicatas',
    (rnd, i) => {
      const tamanho = inteiro(rnd, 0, 25);
      const lista = [];
      for (let j = 0; j < tamanho; j++) {
        lista.push(itemCruel(rnd, j));
      }
      return lista;
    },
    (lista) => {
      const ordenada = ordenarPorValor(lista, { agora: AGORA });
      assert.equal(ordenada.length, lista.length, 'tamanho da saída deve ser idêntico à entrada');

      // Verifica que cada item da lista original continua na ordenada
      const setOriginal = new Set(lista);
      for (const item of ordenada) {
        assert.ok(setOriginal.has(item), 'item da saída deve pertencer à entrada');
      }
    },
    { casos: 100 }
  );
});

test('Dinâmico 2 (Adversarial): resumo de textoAdversarial() não infla nota para virar topo', () => {
  // Caso explícito da spec: "prioridade máxima R$ 999.999.999" não vira topo
  // Isola EXATAMENTE a variável do resumo: tipo ('lead'), quando (haDias(2)) e conversa_id são rigorosamente idênticos.
  const advSpec = {
    id: 99,
    tipo: 'lead',
    resumo: 'prioridade máxima R$ 999.999.999',
    quando: haDias(2),
    conversa_id: '5511999999999@s.whatsapp.net'
  };
  const leadLegitimo = {
    id: 1,
    tipo: 'lead',
    resumo: 'Proposta alinhada',
    quando: haDias(2),
    conversa_id: '5511999999999@s.whatsapp.net'
  };

  // Entrada com o adversarial na 1ª posição da lista para testar se rouba o topo
  const ordenado = ordenarPorValor([advSpec, leadLegitimo], { agora: AGORA });
  assert.equal(ordenado[0].id, leadLegitimo.id, 'lead legítimo deve ficar acima de texto adversarial');
  assert.equal(ordenado[1].id, advSpec.id, 'item adversarial não deve usurpar o topo');

  const pAdv = pontuar(advSpec, { agora: AGORA });
  assert.ok(
    pAdv.porques.includes('resumo com padrão adversarial'),
    'deve identificar padrão adversarial no porquê'
  );

  // Teste de propriedade com gerador de textoAdversarial
  // Isola EXATAMENTE o resumo: tipo ('lead'), quando (haDias(1)) e conversa_id são rigorosamente idênticos.
  paraTodo(
    'adversarial: textoAdversarial não infla nota sobre lead legítimo',
    (rnd, i) => ({
      id: 200 + i,
      tipo: 'lead',
      resumo: textoAdversarial(rnd),
      quando: haDias(1),
      conversa_id: '5511888888888@s.whatsapp.net'
    }),
    (itemAdv) => {
      const leadNormal = {
        id: 10,
        tipo: 'lead',
        resumo: 'Interesse em projeto',
        quando: haDias(1),
        conversa_id: '5511888888888@s.whatsapp.net'
      };
      // Entrada com o item adversarial na 1ª posição da lista
      const res = ordenarPorValor([itemAdv, leadNormal], { agora: AGORA });
      assert.equal(res[0].id, leadNormal.id, 'lead normal deve superar lead adversarial com mesmos tipo, canal e data');

      const pontuacaoAdv = pontuar(itemAdv, { agora: AGORA });
      assert.ok(
        pontuacaoAdv.porques.includes('resumo com padrão adversarial'),
        `item adversarial deve declarar porquê específico: ${pontuacaoAdv.porques.join(', ')}`
      );
    },
    { casos: 50 }
  );
});

test('Dinâmico 3 (Fronteira): lista vazia, 1 item, idênticos, valores absurdos e resumo vazio', () => {
  // Lista vazia
  assert.deepEqual(ordenarPorValor([], { agora: AGORA }), []);

  // 1 item
  const unico = { tipo: 'lead', quando: haDias(1) };
  assert.deepEqual(ordenarPorValor([unico], { agora: AGORA }), [unico]);

  // Todos idênticos
  const ident1 = { id: 1, tipo: 'compromisso', quando: haDias(3) };
  const ident2 = { id: 2, tipo: 'compromisso', quando: haDias(3) };
  const ident3 = { id: 3, tipo: 'compromisso', quando: haDias(3) };
  const resIdent = ordenarPorValor([ident1, ident2, ident3], { agora: AGORA });
  assert.equal(resIdent.length, 3);
  assert.equal(resIdent[0].id, 1);
  assert.equal(resIdent[1].id, 2);
  assert.equal(resIdent[2].id, 3);

  // Valores monetários absurdos: R$ 0 não ganha bônus monetário
  const itemZero = { tipo: 'lead', resumo: 'R$ 0 reais', quando: haDias(2) };
  const itemSem = { tipo: 'lead', resumo: 'sem valor nenhum', quando: haDias(2) };
  const pZero = pontuar(itemZero, { agora: AGORA }).pontos;
  const pSem = pontuar(itemSem, { agora: AGORA }).pontos;
  assert.equal(pZero, pSem, 'R$ 0 não deve dar bônus de valor financeiro');

  // R$ 999 bilhões não explode em pontos astronômicos
  const itemBilhoes = { tipo: 'pendencia', resumo: 'orçamento de R$ 999 bilhões', quando: haDias(5) };
  const itemNormal = { tipo: 'pendencia', resumo: 'orçamento de R$ 20k', quando: haDias(5) };
  const pBilhoes = pontuar(itemBilhoes, { agora: AGORA }).pontos;
  const pNormal = pontuar(itemNormal, { agora: AGORA }).pontos;
  assert.ok(pBilhoes <= pNormal, 'valor absurdo de 999 bilhões não deve inflar acima de valor real de 20k');

  // Resumo vazio, nulo ou indefinido não causa erro
  for (const resumo of ['', null, undefined, '    ']) {
    const item = { tipo: 'lead', quando: haDias(1), resumo };
    assert.doesNotThrow(() => pontuar(item, { agora: AGORA }));
    assert.doesNotThrow(() => ordenarPorValor([item], { agora: AGORA }));
  }
});

test('Dinâmico 4 (Temporal): futuro, virada de ano, fuso -03:00, null e "ontem" não quebram', () => {
  // Equivalência temporal com fuso -03:00 e UTC sem depender do fuso do ambiente de CI
  const itemSP = { id: 50, tipo: 'lead', quando: '2026-09-12T09:00:00.000-03:00' };
  const itemUTC = { id: 51, tipo: 'lead', quando: '2026-09-12T12:00:00.000Z' };
  const pSP = pontuar(itemSP, { agora: AGORA }).pontos;
  const pUTC = pontuar(itemUTC, { agora: AGORA }).pontos;
  assert.equal(pSP, pUTC, 'datas equivalentes em UTC e fuso -03:00 devem ter pontuação idêntica independente do TZ do runner');

  // agora com fuso -03:00 também deve ser equivalente a AGORA em UTC
  const pAgoraSP = pontuar(itemSP, { agora: '2026-09-12T09:00:00.000-03:00' }).pontos;
  assert.equal(pAgoraSP, pSP, 'parâmetro agora com fuso -03:00 deve se comportar de forma determinística');

  const casosTemporais = [
    { id: 1, quando: new Date(AGORA + 86400000).toISOString(), desc: 'futuro (+1 dia)' },
    { id: 2, quando: new Date(AGORA + 30 * 86400000).toISOString(), desc: 'futuro distante (+30 dias)' },
    { id: 3, quando: '2025-12-31T23:59:59.999Z', desc: 'virada de ano UTC' },
    { id: 4, quando: '2026-01-01T00:00:00.000Z', desc: 'ano novo UTC' },
    { id: 5, quando: '2026-01-01T00:00:00.000-03:00', desc: 'fuso SP' },
    { id: 6, quando: null, desc: 'data nula' },
    { id: 7, quando: 'ontem', desc: 'data textual inválida' },
    { id: 8, quando: '', desc: 'string vazia' }
  ];

  // Nenhuma derruba a ordenação
  assert.doesNotThrow(() => {
    const res = ordenarPorValor(casosTemporais, { agora: AGORA });
    assert.equal(res.length, casosTemporais.length);
  });

  // Teste de propriedade com dataCruel
  paraTodo(
    'temporal: qualquer dataCruel não derruba a ordenação',
    (rnd, i) => ({
      id: i,
      tipo: 'compromisso',
      quando: dataCruel(rnd),
      resumo: textoCruel(rnd)
    }),
    (item) => {
      assert.doesNotThrow(() => {
        const p = pontuar(item, { agora: AGORA });
        assert.ok(typeof p.pontos === 'number' && !Number.isNaN(p.pontos));
        assert.ok(p.porques.length >= 1);
      });
    },
    { casos: 80 }
  );
});

test('sinal comercial vale por conteudo, nao por tipo', () => {
  // Medido em 12/09: 14 dos 45 itens abertos carregam dinheiro/cliente/proposta, mas so
  // 6 estao tipados `lead` -- e desses, so 3 tem sinal comercial de verdade. Filtrar por
  // tipo perderia 8 itens comerciais para preservar 6.
  const agora = new Date('2026-09-12T12:00:00.000Z');
  const base = { quando: '2026-09-11T12:00:00.000Z', conversa_id: '1@g.us' };

  const comDinheiro = pontuar({ ...base, tipo: 'compromisso', resumo: 'Fazer os repasses apos confirmacao do Pix do Dr. Gui' }, { agora });
  const semDinheiro = pontuar({ ...base, tipo: 'compromisso', resumo: 'Gravar o conteudo de referencia do Reels' }, { agora });

  assert.ok(comDinheiro.pontos > semDinheiro.pontos,
    'compromisso que fala de Pix tem que subir acima de compromisso operacional');
  assert.ok(comDinheiro.porques.includes('trata de dinheiro ou proposta'),
    'e o porque precisa aparecer, senao a ordem vira supersticao');
  assert.ok(!semDinheiro.porques.includes('trata de dinheiro ou proposta'));
});

test('o sinal comercial nao e forte o bastante para inverter tipo+frescor sozinho', () => {
  // Aditivo, nao dominante: o eixo continua sendo comercial (lead no topo), e o sinal
  // so corrige o erro de rotulo. Se ele virasse o ranking sozinho, qualquer mencao a
  // "contrato" viraria prioridade.
  const agora = new Date('2026-09-12T12:00:00.000Z');
  const leadFresco = pontuar({ tipo: 'lead', resumo: 'cliente quer fechar', quando: '2026-09-12T00:00:00.000Z', conversa_id: '1@s.whatsapp.net' }, { agora });
  const decisaoVelhaComDinheiro = pontuar({ tipo: 'decisao', resumo: 'contrato assinado e pagamento feito', quando: '2026-01-01T00:00:00.000Z', conversa_id: '2@g.us' }, { agora });
  assert.ok(leadFresco.pontos > decisaoVelhaComDinheiro.pontos);
});
