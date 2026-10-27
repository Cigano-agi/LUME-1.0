import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';
import * as crm from '../src/crm.js';
const {
  prepararEsquemaCrm, validarItens, fatiarPorTamanho, montarPrompt, gravarItens, nomeDe, mensagensDaConversa,
  fatiarPorOrcamento, deveExtrair,
  filtrarPorPermissao, procedencia
} = crm;
import { estimarTokens, interpretarSaidaAgy } from '../src/llm.js';
import { prepararEsquemaTranscricao, gravarTranscricao } from '../src/transcricao.js';
import {
  paraTodo, itemCruel, textoAdversarial, textoCruel, dataCruel, inteiro, escolher, aleatorio
} from './gerador.js';

const msgs = [
  { id: 1, origem_id: 'A1', autor_id: 'karen@lid', autor_e_dono: 0, permissao: 'dirigida', texto: 'me manda a proposta', recebido_em: '2026-08-01T10:00:00.000Z' },
  { id: 2, origem_id: 'A2', autor_id: null, autor_e_dono: 1, permissao: 'minha', texto: 'mando amanha', recebido_em: '2026-08-01T10:05:00.000Z' }
];

test('item que cita mensagem inexistente e recusado antes de tocar o banco', () => {
  const { aceitos, recusados } = validarItens([
    { tipo: 'compromisso', resumo: 'Enviar proposta', origem_id: 'A2' },
    { tipo: 'lead', resumo: 'Cliente quer fechar por R$ 90 mil', origem_id: 'INVENTADO' },
    { tipo: 'pendencia', resumo: 'Responder a Karen', origem_id: 'A1' }
  ], msgs);

  assert.equal(aceitos.length, 2);
  assert.equal(recusados.length, 1);
  assert.equal(recusados[0].motivo, 'origem_id inexistente');
  assert.equal(recusados[0].item.resumo, 'Cliente quer fechar por R$ 90 mil',
    'justamente o item mais convincente e o que nao tem lastro');
});

test('item aceito herda a data da mensagem que o sustenta, nao a data de hoje', () => {
  const { aceitos } = validarItens([{ tipo: 'compromisso', resumo: 'Enviar', origem_id: 'A2' }], msgs);
  assert.equal(aceitos[0].quando, '2026-08-01T10:05:00.000Z');
});

test('item sem resumo ou sem tipo nao passa', () => {
  const { aceitos, recusados } = validarItens([
    { tipo: 'compromisso', origem_id: 'A1' },
    { resumo: 'sem tipo', origem_id: 'A1' },
    null
  ], msgs);
  assert.equal(aceitos.length, 0);
  assert.equal(recusados.length, 3);
});

test('entrada que nao e lista vira lista vazia, nao excecao', () => {
  for (const entrada of [null, undefined, 'texto', 42, {}]) {
    assert.deepEqual(validarItens(entrada, msgs).aceitos, []);
  }
});

test('fatiamento respeita o limite e nao perde nem duplica mensagem', () => {
  const muitas = Array.from({ length: 200 }, (_, i) => ({
    origem_id: `M${i}`, texto: 'x'.repeat(300), recebido_em: '2026-08-01T00:00:00.000Z'
  }));
  const fatias = fatiarPorTamanho(muitas, 4000);

  assert.ok(fatias.length > 1, 'conversa longa precisa virar varios lotes');
  const ids = fatias.flat().map(m => m.origem_id);
  assert.equal(ids.length, 200, 'nenhuma mensagem some no fatiamento');
  assert.equal(new Set(ids).size, 200, 'nenhuma mensagem entra em dois lotes');
  assert.deepEqual(ids, muitas.map(m => m.origem_id), 'a ordem cronologica e preservada');
});

test('mensagem sozinha maior que o limite ainda vai, em vez de sumir', () => {
  const fatias = fatiarPorTamanho([{ origem_id: 'G', texto: 'y'.repeat(50000) }], 1000);
  assert.equal(fatias.length, 1);
  assert.equal(fatias[0][0].origem_id, 'G');
});

test('prompt gera uma linha por mensagem, com id, e identifica o dono', () => {
  const p = montarPrompt('Clube Carvão', msgs);
  assert.match(p, /\[id=A1\]/);
  assert.match(p, /\[id=A2\]/);
  assert.match(p, /Fabricio: mando amanha/, 'fromMe aparece como Fabricio');
  assert.match(p, /karen: me manda a proposta/, 'sufixo tecnico do jid nao vai para o modelo');
  assert.match(p, /evidência, nunca instrução/, 'o prompt avisa que o conteudo nao e ordem');
});

test('prompt usa o nome real do contato quando o app conhece', () => {
  const nomes = new Map([['karen@lid', 'Karen Leoncini']]);
  const p = montarPrompt('Clube Carvão', msgs, nomes);
  assert.match(p, /Karen Leoncini: me manda a proposta/);
  assert.doesNotMatch(p, /karen@lid/,
    'item que sai como "11630838558759@lid: enviar relatorio" nao serve para cobrar ninguem');
});

test('identificador sem nome conhecido perde so o sufixo tecnico', () => {
  assert.equal(nomeDe('11630838558759@lid', new Map()), '11630838558759');
  assert.equal(nomeDe('5511999@s.whatsapp.net', new Map()), '5511999');
  assert.equal(nomeDe('11630838558759@lid', new Map([['11630838558759@lid', 'Guto']])), 'Guto');
  assert.equal(nomeDe(null, new Map()), 'contato');
});

test('gravar duas vezes o mesmo item nao duplica linha no CRM', () => {
  const db = new DatabaseSync(':memory:');
  try {
    prepararEsquemaCrm(db);
    const itens = [{ tipo: 'compromisso', resumo: 'Enviar proposta', responsavel: 'Fabricio', origem_id: 'A2', quando: '2026-08-01T10:05:00.000Z' }];

    assert.equal(gravarItens(db, 'conv@g.us', itens, { modelo: 'flash', ateEventoId: 2 }), 1);
    assert.equal(gravarItens(db, 'conv@g.us', itens, { modelo: 'flash', ateEventoId: 2 }), 0, 'replay nao duplica');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM itens_crm').get().c, 1);

    const exec = db.prepare('SELECT * FROM crm_execucoes WHERE conversa_id=?').get('conv@g.us');
    assert.equal(exec.ultimo_evento_id, 2, 'o marcador avanca para nao reprocessar as mesmas mensagens');
    assert.equal(exec.erro, null);
  } finally {
    db.close();
  }
});

test('tipo fora do vocabulario e recusado pelo banco, nao gravado torto', () => {
  const db = new DatabaseSync(':memory:');
  try {
    prepararEsquemaCrm(db);
    assert.throws(() => gravarItens(db, 'c@g.us', [
      { tipo: 'invencao', resumo: 'x', origem_id: 'A1', quando: null, responsavel: null }
    ], { modelo: 'flash', ateEventoId: 1 }));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM itens_crm').get().c, 0);
  } finally {
    db.close();
  }
});

test('audio transcrito entra na conversa como texto, marcado como audio', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT,
      autor_id TEXT, autor_e_dono INTEGER, texto TEXT, recebido_em TEXT)`);
    prepararEsquemaTranscricao(db);

    const ins = db.prepare('INSERT INTO eventos (conversa_id,origem_id,autor_id,autor_e_dono,texto,recebido_em) VALUES (?,?,?,?,?,?)');
    ins.run('c1', 'M1', 'ana@lid', 0, 'me manda o orcamento', '2026-08-01T10:00:00.000Z');
    ins.run('c1', 'M2', 'ana@lid', 0, null, '2026-08-01T10:05:00.000Z');   // audio
    ins.run('c1', 'M3', 'ana@lid', 0, '', '2026-08-01T10:09:00.000Z');     // audio sem transcricao

    gravarTranscricao(db, {
      conversaId: 'c1', origemId: 'M2', arquivo: 'a.opus',
      quando: '2026-08-01T10:05:00.000Z', texto: 'pode fechar por tres mil, mando amanha', modelo: 'flash'
    });

    const msgs = mensagensDaConversa(db, 'c1');
    assert.equal(msgs.length, 2, 'audio sem transcricao continua fora; nao se inventa texto para ele');
    assert.equal(msgs[1].texto, 'pode fechar por tres mil, mando amanha');
    assert.equal(msgs[1].de_audio, 1);
    assert.equal(msgs[0].de_audio, 0);

    const p = montarPrompt('Conversa', msgs, null, { politica: 'tudo' });
    assert.match(p, /\(áudio\): pode fechar por tres mil/,
      'o modelo precisa saber que o compromisso foi combinado falando');
  } finally {
    db.close();
  }
});

test('conversa continua legivel quando a tabela de transcricoes nem existe', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT,
      autor_id TEXT, autor_e_dono INTEGER, texto TEXT, recebido_em TEXT)`);
    db.prepare('INSERT INTO eventos (conversa_id,origem_id,autor_id,autor_e_dono,texto,recebido_em) VALUES (?,?,?,?,?,?)')
      .run('c1', 'M1', 'ana@lid', 0, 'texto puro', '2026-08-01T10:00:00.000Z');
    const msgs = mensagensDaConversa(db, 'c1');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].texto, 'texto puro');
  } finally {
    db.close();
  }
});

test('mensagem de audio exportada traz a referencia do arquivo, e a transcricao substitui', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT,
      autor_id TEXT, autor_e_dono INTEGER, texto TEXT, recebido_em TEXT)`);
    prepararEsquemaTranscricao(db);
    db.prepare('INSERT INTO eventos (conversa_id,origem_id,autor_id,autor_e_dono,texto,recebido_em) VALUES (?,?,?,?,?,?)')
      .run('c1', 'M1', 'ana@lid', 0, 'audio.opus <anexado: 00000019-AUDIO-2025-12-05.opus>', '2026-08-01T10:00:00.000Z');
    gravarTranscricao(db, {
      conversaId: 'c1', origemId: 'M1', arquivo: '00000019-AUDIO-2025-12-05.opus',
      texto: 'fecha por tres mil e me manda amanha', modelo: 'flash'
    });

    const msgs = mensagensDaConversa(db, 'c1');
    assert.equal(msgs[0].texto, 'fecha por tres mil e me manda amanha',
      'a fala vale mais que o nome do arquivo que a continha');
    assert.equal(msgs[0].de_audio, 1);
  } finally {
    db.close();
  }
});

test('referencia de anexo sem transcricao continua como esta, sem virar nulo', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT,
      autor_id TEXT, autor_e_dono INTEGER, texto TEXT, recebido_em TEXT)`);
    prepararEsquemaTranscricao(db);
    db.prepare('INSERT INTO eventos (conversa_id,origem_id,autor_id,autor_e_dono,texto,recebido_em) VALUES (?,?,?,?,?,?)')
      .run('c1', 'M1', 'ana@lid', 0, 'contrato.pdf <anexado: contrato.pdf>', '2026-08-01T10:00:00.000Z');
    const msgs = mensagensDaConversa(db, 'c1');
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].texto, /contrato\.pdf/, 'documento sem transcricao mantem a referencia');
    assert.equal(msgs[0].de_audio, 0);
  } finally {
    db.close();
  }
});

test('corte pelo timeout interno do agy vira falha explicita, nao "resposta nao e JSON"', async () => {
  // O agy sai com codigo 0 e devolve texto em vez de JSON quando desiste sozinho.
  // Sem reconhecer esse texto, a causa real (lote grande demais) fica invisivel.
  const saidaReal = '[agy] print timeout after 5m0s with turn in progress; returning partial output';
  const saidaGenerica = '[agy] fatal internal error on worker thread; returning partial output';

  assert.throws(
    () => interpretarSaidaAgy(saidaGenerica),
    /resposta do agy nao e JSON:/
  );
  assert.throws(
    () => interpretarSaidaAgy(saidaReal),
    /Gemini cortado pelo timeout interno do agy com o turno em andamento: lote grande demais/
  );
});

test('A1 - nenhuma fatia passa do teto de tokens', () => {
  const mensagens = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    origem_id: `M${i + 1}`,
    texto: 'Mensagem de tamanho moderado para teste de orcamento '.repeat(3)
  }));
  const teto = 100;
  const fatias = fatiarPorOrcamento(mensagens, { tetoTokens: teto });

  assert.ok(fatias.length > 1, 'deve gerar multiplas fatias');
  for (const fatia of fatias) {
    const custoFatia = fatia.reduce((acc, m) => acc + estimarTokens(m.texto), 0);
    assert.ok(custoFatia <= teto, `fatia com ${custoFatia} tokens excedeu o teto de ${teto}`);
  }
});

test('A2 - concatenar as fatias devolve exatamente a entrada sem perder, duplicar ou reordenar', () => {
  const mensagens = Array.from({ length: 35 }, (_, i) => ({
    id: i + 1,
    origem_id: `MSG_${i + 1}`,
    texto: `Mensagem de conteudo unico ${i + 1} com dados adicionais`,
    quando: `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`
  }));
  const fatias = fatiarPorOrcamento(mensagens, { tetoTokens: 50 });
  const concatenadas = fatias.flat();

  assert.equal(concatenadas.length, mensagens.length, 'quantidade total de mensagens deve ser identica');
  assert.deepEqual(concatenadas, mensagens, 'concatenar fatias deve reproduzir o array original');
});

test('A3 - mensagem sozinha maior que o teto vira fatia propria, nao e descartada', () => {
  const msgPequena1 = { id: 1, origem_id: 'P1', texto: 'pequena 1' };
  const msgGigante = { id: 2, origem_id: 'G1', texto: 'texto enorme que excede qualquer orcamento '.repeat(50) };
  const msgPequena2 = { id: 3, origem_id: 'P2', texto: 'pequena 2' };

  const teto = 50;
  const fatias = fatiarPorOrcamento([msgPequena1, msgGigante, msgPequena2], { tetoTokens: teto });

  assert.equal(fatias.length, 3, 'deve produzir 3 fatias');
  assert.deepEqual(fatias[0], [msgPequena1]);
  assert.deepEqual(fatias[1], [msgGigante], 'mensagem gigante virou fatia propria');
  assert.deepEqual(fatias[2], [msgPequena2]);
  assert.deepEqual(fatias.flat().map(m => m.origem_id), ['P1', 'G1', 'P2'], 'nenhuma mensagem foi descartada');
});

test('A5 - comunidade e recusada com motivo antes de gastar token', () => {
  // Grupo onde o dono nunca fala (0% de autoria)
  const grupoSemDono = {
    id: '120363001@g.us',
    mensagens: [
      { id: '1', autor_e_dono: 0, fromMe: false, texto: 'bom dia grupo' },
      { id: '2', autor_e_dono: 0, fromMe: false, texto: 'alguem viu a noticia?' }
    ]
  };
  assert.deepEqual(deveExtrair(grupoSemDono), { extrair: false, motivo: 'comunidade' });

  // Grupo com autoria passiva (<= 5% das mensagens)
  const grupoPassivo = {
    id: '120363002@g.us',
    total: 100,
    proprias: 3
  };
  assert.deepEqual(deveExtrair(grupoPassivo), { extrair: false, motivo: 'comunidade' });

  // A5 fronteira exata: grupo com exatamente 5% (5/100 = 0.05 <= 0.05) e comunidade
  assert.deepEqual(
    deveExtrair({ id: '120363004@g.us', total: 100, proprias: 5 }),
    { extrair: false, motivo: 'comunidade' },
    'exatamente 5% deve ser classificado como comunidade'
  );

  // A5 fronteira exata: grupo com 6% (6/100 = 0.06 > 0.05) e grupo de trabalho ativo
  assert.deepEqual(
    deveExtrair({ id: '120363005@g.us', total: 100, proprias: 6 }),
    { extrair: true, motivo: null },
    'acima de 5% deve ser extraido'
  );

  // A5 fronteira com array de mensagens: exatamente 5 em 100 vs 6 em 100
  const msgs100_5 = Array.from({ length: 100 }, (_, i) => ({ id: String(i), autor_e_dono: i < 5 ? 1 : 0, texto: `msg ${i}` }));
  assert.deepEqual(deveExtrair({ id: '120363006@g.us', mensagens: msgs100_5 }), { extrair: false, motivo: 'comunidade' });

  const msgs100_6 = Array.from({ length: 100 }, (_, i) => ({ id: String(i), autor_e_dono: i < 6 ? 1 : 0, texto: `msg ${i}` }));
  assert.deepEqual(deveExtrair({ id: '120363007@g.us', mensagens: msgs100_6 }), { extrair: true, motivo: null });

  // Grupo ativo de trabalho onde o dono participa (> 5% de autoria)
  const grupoTrabalho = {
    id: '120363003@g.us',
    total: 100,
    proprias: 20
  };
  assert.deepEqual(deveExtrair(grupoTrabalho), { extrair: true, motivo: null });

  // DM onde o dono ainda nao respondeu (lead/pendencia em aberto nao pode ser descartado!)
  const dmCliente = {
    id: '5511999999999@s.whatsapp.net',
    mensagens: [
      { id: '1', autor_e_dono: 0, fromMe: false, texto: 'Fabricio, quanto fica o projeto?' }
    ]
  };
  assert.deepEqual(deveExtrair(dmCliente), { extrair: true, motivo: null });

  // Fronteira de identificador: id vazio e invalido, nao cai em comunidade
  assert.deepEqual(deveExtrair({ id: '' }), { extrair: false, motivo: 'invalido' });
  assert.deepEqual(deveExtrair({ id: '   ' }), { extrair: false, motivo: 'invalido' });

  // Conversa individual com id vazio mas com mensagens autoriza extracao e nao vira comunidade por ter autor_e_dono <= 5%
  const dmSemId = {
    id: '',
    mensagens: Array.from({ length: 50 }, (_, i) => ({ id: String(i), autor_e_dono: i === 0 ? 1 : 0, texto: `msg ${i}` }))
  };
  assert.deepEqual(deveExtrair(dmSemId), { extrair: true, motivo: null });
});

test('Classe Dinamica 1 (Propriedade) - fatiar preserva concatenacao (A2) e teto (A1) em 1000 casos de itemCruel', () => {
  paraTodo('fatiarPorOrcamento propriedade itemCruel', (rnd) => {
    const qtd = inteiro(rnd, 0, 30);
    const lista = Array.from({ length: qtd }, (_, j) => itemCruel(rnd, j));
    // Teto entre 40 e 150 tokens (itemCruel tem resumo de ate 90 chars => ~23 tokens, logo nenhum excede isolado)
    const tetoTokens = inteiro(rnd, 40, 150);
    return { lista, tetoTokens };
  }, ({ lista, tetoTokens }) => {
    const fatias = fatiarPorOrcamento(lista, { tetoTokens });

    // A2: Concatenar as fatias devolve exatamente a entrada
    assert.deepEqual(fatias.flat(), lista, 'concatenacao deve ser identica a lista original');

    // A1: Nenhuma fatia passa do teto (usando m.texto ?? m.resumo ?? '' identico a crm.js)
    for (const fatia of fatias) {
      const custoFatia = fatia.reduce((acc, m) => acc + estimarTokens(typeof m === 'string' ? m : (m?.texto ?? m?.resumo ?? '')), 0);
      assert.ok(custoFatia <= tetoTokens, `fatia com ${custoFatia} tokens excedeu teto ${tetoTokens}`);
    }
  }, { casos: 1000 });
});

test('Classe Dinamica 2 (Adversarial) - mensagem com textoAdversarial e fatiada como texto sem escapar nem alterar orcamento', () => {
  paraTodo('fatiarPorOrcamento adversarial', (rnd) => {
    // Lista de mensagens combinando mensagens normais e adversariais
    const qtd = inteiro(rnd, 2, 15);
    const msgsAdv = [];
    const msgsNormal = [];

    for (let i = 0; i < qtd; i++) {
      const adv = rnd() < 0.5 ? textoAdversarial(rnd) : textoCruel(rnd, { min: 10, max: 80 });
      // Texto normal com exatamente o mesmo comprimento em caracteres
      const normal = 'a'.repeat(adv.length);
      const origem_id = `ADV_${i}`;
      msgsAdv.push({ id: i + 1, origem_id, texto: adv, autor_id: 'contato@s.whatsapp.net', recebido_em: '2026-09-12T10:00:00.000Z' });
      msgsNormal.push({ id: i + 1, origem_id, texto: normal, autor_id: 'contato@s.whatsapp.net', recebido_em: '2026-09-12T10:00:00.000Z' });
    }

    // Teto variavel para exercitar multiplas fatias
    const tetoTokens = inteiro(rnd, 20, 100);
    return { msgsAdv, msgsNormal, tetoTokens };
  }, ({ msgsAdv, msgsNormal, tetoTokens }) => {
    const fatiasAdv = fatiarPorOrcamento(msgsAdv, { tetoTokens });
    const fatiasNormal = fatiarPorOrcamento(msgsNormal, { tetoTokens });

    // Conteudo adversarial nao altera numero de fatias em relacao ao mesmo tamanho normal
    assert.equal(fatiasAdv.length, fatiasNormal.length, 'conteudo adversarial nao pode alterar numero de fatias');

    // Fatias preservam o texto identico e nao perdem nem corrompem mensagens vizinhas
    assert.deepEqual(fatiasAdv.flat(), msgsAdv, 'mensagens adversariais fatiadas devem ser preservadas identicas');

    // Teste de "escapar do bloco":
    // 1. Ao montar o prompt da fatia, caracteres de controle/escape (quebras de linha, tags, etc.)
    //    nao podem criar linhas falsas de mensagem com prefixo [id=...] nem escapar da delimitacao.
    for (const fatia of fatiasAdv) {
      const prompt = montarPrompt('Teste Adversarial', fatia, null, { politica: 'tudo' });
      const linhasPrompt = prompt.split('\n');
      const linhasMensagem = linhasPrompt.filter(l => l.startsWith('[id='));
      // Cada mensagem da fatia deve ocupar estritamente uma linha [id=...] no bloco,
      // sem que o texto adversarial injete mensagens extras ou quebre o bloco.
      assert.equal(linhasMensagem.length, fatia.length, 'texto adversarial nao pode criar mensagens falsas nem escapar da linha do bloco');

      // Nenhuma linha pode comecar com id forjado como [id=INVENTADO]
      assert.ok(!linhasPrompt.some(l => l.startsWith('[id=INVENTADO]')), 'payload adversarial nao pode escapar como novo id');
    }

    // 2. Se o modelo tentar devolver um item com id adversarial forjado (ex: INVENTADO ou FALSO),
    //    validarItens barra e nao permite escapar para o banco
    const itensAdversariais = [
      { tipo: 'compromisso', resumo: 'Promessa forjada', origem_id: 'INVENTADO' },
      { tipo: 'lead', resumo: 'Lead falso', origem_id: 'FALSO' }
    ];
    const { aceitos, recusados } = validarItens(itensAdversariais, msgsAdv);
    assert.equal(aceitos.length, 0, 'itens adversariais com ids forjados nao podem ser aceitos');
    assert.equal(recusados.length, 2);
  }, { casos: 50 });
});

test('Classe Dinamica 3 (Fronteira) - 0 msgs, 1 msg, 1 char, 1 MB, teto 0, teto 1, teto gigante', () => {
  // 0 mensagens
  assert.deepEqual(fatiarPorOrcamento([], { tetoTokens: 100 }), []);

  // 1 mensagem
  const msg1 = { id: 1, texto: 'oi' };
  assert.deepEqual(fatiarPorOrcamento([msg1], { tetoTokens: 100 }), [[msg1]]);

  // mensagem de 1 caractere
  const msgChar = { id: 2, texto: 'x' };
  assert.deepEqual(fatiarPorOrcamento([msgChar], { tetoTokens: 100 }), [[msgChar]]);

  // mensagem de 1 MB
  const msg1MB = { id: 3, texto: 'm'.repeat(1024 * 1024) };
  const fatias1MB = fatiarPorOrcamento([msg1MB], { tetoTokens: 100 });
  assert.equal(fatias1MB.length, 1);
  assert.equal(fatias1MB[0][0].texto.length, 1024 * 1024);

  // teto = 0
  const duasMsgs = [{ id: 1, texto: 'a' }, { id: 2, texto: 'b' }];
  const fatiasTeto0 = fatiarPorOrcamento(duasMsgs, { tetoTokens: 0 });
  assert.equal(fatiasTeto0.length, 2, 'teto 0 separa cada mensagem em sua propria fatia');
  assert.deepEqual(fatiasTeto0.flat(), duasMsgs);

  // teto = 1
  const fatiasTeto1 = fatiarPorOrcamento(duasMsgs, { tetoTokens: 1 });
  assert.equal(fatiasTeto1.length, 2);
  assert.deepEqual(fatiasTeto1.flat(), duasMsgs);

  // teto gigante
  const muitas = Array.from({ length: 50 }, (_, i) => ({ id: i, texto: `msg ${i}` }));
  const fatiasGigante = fatiarPorOrcamento(muitas, { tetoTokens: 10000000 });
  assert.equal(fatiasGigante.length, 1, 'todas as mensagens cabem numa unica fatia');
  assert.deepEqual(fatiasGigante[0], muitas);
});

test('Classe Dinamica 4 (Temporal) - ordem cronologica original preservada mesmo com dataCruel fora de ordem', () => {
  paraTodo('fatiarPorOrcamento temporal dataCruel', (rnd) => {
    const msgs = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      origem_id: `M_${i}`,
      texto: `Msg teste ${i}`,
      quando: dataCruel(rnd)
    }));
    return msgs;
  }, (msgs) => {
    const fatias = fatiarPorOrcamento(msgs, { tetoTokens: 20 });
    const recuperadas = fatias.flat();
    assert.deepEqual(recuperadas, msgs, 'ordem original das mensagens deve ser estritamente preservada');
  }, { casos: 100 });
});

// ============================================================================
// SPEC-F7 — Procedência: de onde veio e por que entrou
// ============================================================================

describe('SPEC-F7 — Critérios de aceite (A1 a A6)', () => {
  test('SPEC-F7 / A1: Item novo nasce com permissao_origem preenchida (falso se coluna for nula)', () => {
    const db = new DatabaseSync(':memory:');
    try {
      prepararEsquemaCrm(db);
      db.exec(`CREATE TABLE IF NOT EXISTS eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversa_id TEXT,
        origem_id TEXT,
        autor_id TEXT,
        autor_e_dono INTEGER,
        texto TEXT,
        recebido_em TEXT,
        permissao TEXT
      )`);
      db.prepare(`INSERT INTO eventos (conversa_id, origem_id, autor_id, autor_e_dono, texto, recebido_em, permissao)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'grupo1@g.us', 'MSG_A1', '551188888888@s.whatsapp.net', 1, 'fecho amanha', '2026-09-12T10:00:00.000Z', 'minha'
      );

      const msgsEntrada = [{ origem_id: 'MSG_A1', permissao: 'minha', recebido_em: '2026-09-12T10:00:00.000Z' }];
      const { aceitos } = validarItens([
        { tipo: 'compromisso', resumo: 'Fecho amanha', origem_id: 'MSG_A1' }
      ], msgsEntrada);

      assert.equal(aceitos.length, 1);
      assert.equal(aceitos[0].permissao_origem, 'minha', 'validarItens preenche permissao_origem');

      const gravados = gravarItens(db, 'grupo1@g.us', aceitos, { modelo: 'flash', ateEventoId: 1, politica: 'so-minhas' });
      assert.equal(gravados, 1);

      const row = db.prepare('SELECT * FROM itens_crm WHERE conversa_id = ?').get('grupo1@g.us');
      assert.ok(row, 'item deve estar persistido no banco');
      assert.equal(row.permissao_origem, 'minha', 'A1: permissao_origem deve estar gravada no item');
      assert.notEqual(row.permissao_origem, null, 'A1: e falso se existir item novo com permissao_origem nula');
    } finally {
      db.close();
    }
  });

  test('SPEC-F7 / A2: Com politica so-minhas, mensagem de terceiro NAO chega ao prompt', () => {
    const mensagens = [
      { id: 1, origem_id: 'M1', autor_id: 'dono', autor_e_dono: 1, texto: 'minha mensagem do dono', permissao: 'minha', recebido_em: '2026-09-12T10:00:00.000Z' },
      { id: 2, origem_id: 'M2', autor_id: 'lead@s.whatsapp.net', autor_e_dono: 0, texto: 'mensagem dirigida ao dono', permissao: 'dirigida', recebido_em: '2026-09-12T10:01:00.000Z' },
      { id: 3, origem_id: 'M3', autor_id: 'terceiro@s.whatsapp.net', autor_e_dono: 0, texto: 'conversa secreta de terceiro proibida', permissao: 'terceiro', recebido_em: '2026-09-12T10:02:00.000Z' },
      { id: 4, origem_id: 'M4', autor_id: 'pre_f6@s.whatsapp.net', autor_e_dono: 0, texto: 'mensagem antiga com permissao nula', permissao: null, recebido_em: '2026-09-12T10:03:00.000Z' }
    ];

    // Filtra antes de montar o prompt (politica so-minhas)
    const filtradas = filtrarPorPermissao(mensagens, { politica: 'so-minhas' });
    assert.equal(filtradas.length, 2, 'sob so-minhas, apenas minha e dirigida passam');
    assert.deepEqual(filtradas.map(m => m.origem_id), ['M1', 'M2']);

    const prompt = montarPrompt('Grupo Confidencial', filtradas);
    assert.doesNotMatch(prompt, /conversa secreta de terceiro proibida/, 'mensagem de terceiro NAO pode chegar ao prompt');
    assert.doesNotMatch(prompt, /\[id=M3\]/, 'id da mensagem de terceiro nao pode aparecer no prompt');
    assert.doesNotMatch(prompt, /mensagem antiga com permissao nula/, 'mensagem com permissao nula nao pode passar sob so-minhas');
    assert.doesNotMatch(prompt, /\[id=M4\]/);
    assert.match(prompt, /minha mensagem do dono/);
    assert.match(prompt, /mensagem dirigida ao dono/);

    // Sob 'tudo', terceiro chega ao prompt
    const filtradasTudo = filtrarPorPermissao(mensagens, { politica: 'tudo' });
    assert.deepEqual(filtradasTudo.map(m=>m.origem_id),['M1','M2','M3'],'NULL não entra no prompt mesmo sob tudo');
    const promptTudo = montarPrompt('DM Aberta', filtradasTudo, null, { politica: 'tudo' });
    assert.match(promptTudo, /conversa secreta de terceiro proibida/);
  });

  test('SPEC-F7 / A3: procedencia() devolve a mensagem exata que originou o item (falso se apontar para outra)', () => {
    const db = new DatabaseSync(':memory:');
    try {
      prepararEsquemaCrm(db);
      db.exec(`CREATE TABLE IF NOT EXISTS eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversa_id TEXT,
        origem_id TEXT,
        autor_id TEXT,
        autor_e_dono INTEGER,
        texto TEXT,
        recebido_em TEXT,
        permissao TEXT
      )`);

      db.prepare(`INSERT INTO eventos (conversa_id, origem_id, autor_id, autor_e_dono, texto, recebido_em, permissao) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'c1', 'MSG_CERTA', 'lead@s.whatsapp.net', 0, 'Fabrício, quero fechar por 15 mil', '2026-09-10T14:00:00.000Z', 'dirigida'
      );
      db.prepare(`INSERT INTO eventos (conversa_id, origem_id, autor_id, autor_e_dono, texto, recebido_em, permissao) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'c1', 'MSG_OUTRA', 'outro@s.whatsapp.net', 0, 'outra mensagem aleatoria', '2026-09-10T14:05:00.000Z', 'minha'
      );

      gravarItens(db, 'c1', [{
        tipo: 'lead',
        resumo: 'Lead de 15 mil',
        origem_id: 'MSG_CERTA',
        quando: '2026-09-10T14:00:00.000Z',
        permissao_origem: 'dirigida'
      }], { modelo: 'flash', ateEventoId: 1, politica: 'tudo' });

      const proc = procedencia(db, { itemId: 1 });
      assert.ok(proc, 'procedencia() deve retornar resultado');
      assert.equal(proc.item.id, 1);
      assert.equal(proc.item.origem_id, 'MSG_CERTA');
      assert.ok(proc.evento, 'deve retornar o evento de origem');
      assert.equal(proc.evento.origem_id, 'MSG_CERTA', 'A3: evento de origem deve ser exatamente MSG_CERTA');
      assert.notEqual(proc.evento.origem_id, 'MSG_OUTRA', 'A3: e falso se apontar para outra mensagem');
      assert.equal(proc.evento.texto, 'Fabrício, quero fechar por 15 mil');
      assert.equal(proc.conversa, 'c1');
      assert.equal(proc.permissao, 'dirigida');
      assert.equal(proc.quando, '2026-09-10T14:00:00.000Z');
    } finally {
      db.close();
    }
  });

  test('SPEC-F7 / A4: Item antigo (sem as colunas / pre-migracao) nao quebra procedencia()', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE itens_crm (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          conversa_id   TEXT NOT NULL,
          origem_id     TEXT NOT NULL,
          tipo          TEXT NOT NULL,
          resumo        TEXT NOT NULL,
          responsavel   TEXT,
          quando        TEXT,
          estado        TEXT NOT NULL DEFAULT 'aberto',
          extraido_em   TEXT NOT NULL,
          modelo        TEXT
        );
        CREATE TABLE eventos (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          conversa_id   TEXT NOT NULL,
          origem_id     TEXT NOT NULL,
          texto         TEXT,
          recebido_em   TEXT
        );
      `);

      db.prepare(`INSERT INTO itens_crm (id, conversa_id, origem_id, tipo, resumo, responsavel, quando, estado, extraido_em, modelo)
        VALUES (1, 'c_antiga', 'MSG_PRE_F7', 'compromisso', 'Item legado de agosto', 'Fabricio', '2026-08-01T10:00:00Z', 'aberto', '2026-08-01T10:00:00Z', 'flash')`).run();
      db.prepare(`INSERT INTO eventos (conversa_id, origem_id, texto, recebido_em)
        VALUES ('c_antiga', 'MSG_PRE_F7', 'texto anterior a F6/F7', '2026-08-01T10:00:00Z')`).run();

      let proc = null;
      assert.doesNotThrow(() => {
        proc = procedencia(db, { itemId: 1 });
      }, 'procedencia() nunca deve estourar com item pre-migracao');

      assert.ok(proc);
      assert.equal(proc.item.id, 1);
      assert.equal(proc.item.origem_id, 'MSG_PRE_F7');
      assert.equal(proc.evento.origem_id, 'MSG_PRE_F7');
      assert.equal(proc.conversa, 'c_antiga');
      assert.equal(proc.permissao, null);
      assert.equal(proc.regra, null);
    } finally {
      db.close();
    }
  });

  test('SPEC-F7 / A5: A regra que deixou entrar e legivel por humano (falso se gravar codigo sem traducao)', () => {
    const db = new DatabaseSync(':memory:');
    try {
      prepararEsquemaCrm(db);
      db.exec(`CREATE TABLE IF NOT EXISTS eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT, autor_id TEXT, autor_e_dono INTEGER, texto TEXT, recebido_em TEXT, permissao TEXT
      )`);

      db.prepare(`INSERT INTO eventos (conversa_id, origem_id, autor_id, autor_e_dono, texto, recebido_em, permissao) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'grupo_trabalho@g.us', 'M_GRP', '55118888@s.whatsapp.net', 1, 'minha mensagem', '2026-09-12T10:00:00Z', 'minha'
      );
      db.prepare(`INSERT INTO eventos (conversa_id, origem_id, autor_id, autor_e_dono, texto, recebido_em, permissao) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'dm_cliente@s.whatsapp.net', 'M_DM', '55119999@s.whatsapp.net', 0, 'mensagem dm', '2026-09-12T10:00:00Z', 'dirigida'
      );

      // Grava sob 'so-minhas'
      gravarItens(db, 'grupo_trabalho@g.us', [{
        tipo: 'compromisso', resumo: 'Envio amanhã', origem_id: 'M_GRP', permissao_origem: 'minha'
      }], { modelo: 'flash', ateEventoId: 1, politica: 'so-minhas' });

      // Grava sob 'tudo'
      gravarItens(db, 'dm_cliente@s.whatsapp.net', [{
        tipo: 'lead', resumo: 'Cliente interessado', origem_id: 'M_DM', permissao_origem: 'dirigida'
      }], { modelo: 'flash', ateEventoId: 2, politica: 'tudo' });

      const row1 = db.prepare("SELECT regra FROM itens_crm WHERE origem_id = 'M_GRP'").get();
      assert.ok(row1.regra, 'regra deve estar preenchida');
      assert.notEqual(row1.regra, 'so-minhas', 'A5: e falso se gravar "so-minhas" sem traducao humana');
      assert.match(row1.regra, /minhas|dirigidas|dono/i, 'deve ser texto legivel em portugues explicando a regra');

      const row2 = db.prepare("SELECT regra FROM itens_crm WHERE origem_id = 'M_DM'").get();
      assert.ok(row2.regra, 'regra deve estar preenchida');
      assert.notEqual(row2.regra, 'tudo', 'A5: e falso se gravar "tudo" sem traducao humana');
      assert.match(row2.regra, /todas|permitidas|autorizadas/i, 'deve ser texto legivel em portugues explicando a regra');
    } finally {
      db.close();
    }
  });

  test('SPEC-F7 / A6: validarItens continua descartando item sem lastro (falso se entrar sem origem_id)', () => {
    const mensagens = [{ origem_id: 'MSG_EXISTENTE', permissao: 'minha' }];
    const { aceitos, recusados } = validarItens([
      { tipo: 'lead', resumo: 'Sem origem id' },
      { tipo: 'lead', resumo: 'Origem id vazia', origem_id: '' },
      { tipo: 'compromisso', resumo: 'Origem id nula', origem_id: null },
      { tipo: 'compromisso', resumo: 'Origem id inventada', origem_id: 'INVENTADO' },
      { tipo: 'compromisso', resumo: 'Com lastro real', origem_id: 'MSG_EXISTENTE' }
    ], mensagens);

    assert.equal(aceitos.length, 1);
    assert.equal(aceitos[0].origem_id, 'MSG_EXISTENTE');
    assert.equal(recusados.length, 4, 'os 4 itens sem lastro devem ser recusados');
    assert.ok(recusados.every(r => r.motivo === 'origem_id inexistente' || r.motivo === 'campo obrigatorio ausente'));
  });
});

describe('SPEC-F7 — Dynamic testing (4 classes)', () => {
  test('Classe Dinamica 1 (Propriedade) - todo item produzido aponta para mensagem no prompt, nunca filtrada', () => {
    paraTodo('propriedade procedencia lastro no prompt', (rnd) => {
      const qtd = inteiro(rnd, 5, 20);
      const msgs = [];
      for (let i = 0; i < qtd; i++) {
        const perm = escolher(rnd, ['minha', 'dirigida', 'terceiro', null]);
        msgs.push({
          origem_id: `MSG_${i}`,
          permissao: perm,
          texto: `Mensagem ${i} ${textoCruel(rnd, { min: 5, max: 30 })}`,
          recebido_em: dataCruel(rnd)
        });
      }
      const politica = escolher(rnd, ['so-minhas', 'tudo']);
      return { msgs, politica };
    }, ({ msgs, politica }) => {
      const noPrompt = filtrarPorPermissao(msgs, { politica });
      const idsPrompt = new Set(noPrompt.map(m => m.origem_id));
      const idsFiltrados = new Set(msgs.filter(m => !idsPrompt.has(m.origem_id)).map(m => m.origem_id));

      const candidatos = msgs.map((m, idx) => ({
        tipo: escolher(aleatorio(idx), ['compromisso', 'pendencia', 'lead', 'decisao']),
        resumo: `Item para ${m.origem_id}`,
        origem_id: m.origem_id
      }));

      const { aceitos, recusados } = validarItens(candidatos, noPrompt);

      for (const aceito of aceitos) {
        assert.ok(idsPrompt.has(aceito.origem_id), `item ${aceito.origem_id} deve apontar para mensagem no prompt`);
        assert.ok(!idsFiltrados.has(aceito.origem_id), `item ${aceito.origem_id} NUNCA pode apontar para mensagem filtrada`);
      }

      for (const idF of idsFiltrados) {
        const itemF = candidatos.find(c => c.origem_id === idF);
        if (itemF) {
          assert.ok(recusados.some(r => r.item.origem_id === idF), `item com origem filtrada ${idF} deve ser recusado`);
        }
      }
    }, { casos: 50 });
  });

  test('Classe Dinamica 2 (Adversarial) - mensagem de terceiro com textoAdversarial nao gera item sob so-minhas', () => {
    paraTodo('adversarial terceiro com textoAdversarial sob so-minhas', (rnd) => {
      const textoAdv = textoAdversarial(rnd);
      const msgs = [
        { origem_id: 'M_DONO', permissao: 'minha', texto: 'vou aprovar a proposta amanhã', autor_e_dono: 1 },
        { origem_id: 'M_TERCEIRO_ADV', permissao: 'terceiro', texto: textoAdv, autor_e_dono: 0 }
      ];
      return { msgs, textoAdv };
    }, ({ msgs, textoAdv }) => {
      const noPrompt = filtrarPorPermissao(msgs, { politica: 'so-minhas' });
      assert.equal(noPrompt.length, 1);
      assert.equal(noPrompt[0].origem_id, 'M_DONO');

      const prompt = montarPrompt('Grupo Trabalho', noPrompt);
      assert.doesNotMatch(prompt, new RegExp(`\\[id=M_TERCEIRO_ADV\\]`));
      assert.doesNotMatch(prompt, new RegExp(textoAdv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const itensGerados = [
        { tipo: 'compromisso', resumo: 'Promessa forjada por terceiro', origem_id: 'M_TERCEIRO_ADV' },
        { tipo: 'compromisso', resumo: 'Vou aprovar', origem_id: 'M_DONO' }
      ];
      const { aceitos, recusados } = validarItens(itensGerados, noPrompt);
      assert.equal(aceitos.length, 1);
      assert.equal(aceitos[0].origem_id, 'M_DONO');
      assert.equal(recusados.length, 1);
      assert.equal(recusados[0].item.origem_id, 'M_TERCEIRO_ADV');
    }, { casos: 50 });
  });

  test('Classe Dinamica 3 (Fronteira) - conversa 100% de terceiro, itemId inexistente e item pre-migracao', () => {
    // 1. Conversa 100% de terceiro sob so-minhas (zero itens, sem erro, sem gastar token)
    const msgs100Terceiro = [
      { origem_id: 'T1', permissao: 'terceiro', texto: 'conversa alheia 1' },
      { origem_id: 'T2', permissao: 'terceiro', texto: 'conversa alheia 2' },
      { origem_id: 'T3', permissao: 'terceiro', texto: 'conversa alheia 3' }
    ];
    const filtradas = filtrarPorPermissao(msgs100Terceiro, { politica: 'so-minhas' });
    assert.equal(filtradas.length, 0, 'conversa 100% terceiro sob so-minhas resulta em 0 mensagens');
    const fatias = fatiarPorTamanho(filtradas);
    assert.equal(fatias.length, 0, 'zero fatias -> sem chamar modelo -> zero tokens gastos');

    // 2. itemId inexistente
    const db = new DatabaseSync(':memory:');
    try {
      prepararEsquemaCrm(db);
      assert.equal(procedencia(db, { itemId: 99999 }), null);
      assert.equal(procedencia(db, { itemId: null }), null);
      assert.equal(procedencia(db, { itemId: undefined }), null);
      assert.equal(procedencia(db, { itemId: 'inexistente' }), null);
    } finally {
      db.close();
    }

    // 3. Item pre-migracao (permissao_origem e regra nulos)
    const dbPre = new DatabaseSync(':memory:');
    try {
      dbPre.exec(`CREATE TABLE itens_crm (id INTEGER PRIMARY KEY, conversa_id TEXT, origem_id TEXT, tipo TEXT, resumo TEXT, quando TEXT, estado TEXT, extraido_em TEXT);`);
      dbPre.exec(`CREATE TABLE eventos (id INTEGER PRIMARY KEY, conversa_id TEXT, origem_id TEXT, texto TEXT, recebido_em TEXT);`);
      dbPre.prepare("INSERT INTO itens_crm VALUES (1, 'c1', 'O1', 'lead', 'resumo pre-migracao', '2026-01-01', 'aberto', '2026-01-01')").run();
      dbPre.prepare("INSERT INTO eventos VALUES (1, 'c1', 'O1', 'texto da mensagem', '2026-01-01')").run();
      const proc = procedencia(dbPre, { itemId: 1 });
      assert.ok(proc);
      assert.equal(proc.item.id, 1);
      assert.equal(proc.evento.origem_id, 'O1');
      assert.equal(proc.permissao, null);
      assert.equal(proc.regra, null);
    } finally {
      dbPre.close();
    }
  });

  test('Classe Dinamica 4 (Temporal) - item com mensagem reclassificada continua apontando para a verdade do momento em que nasceu', () => {
    paraTodo('temporal procedencia imutavel na reclassificacao', (rnd) => {
      return {
        permInicial: escolher(rnd, ['minha', 'dirigida']),
        permNova: escolher(rnd, ['terceiro', 'dirigida', 'minha']),
        dataOrigem: dataCruel(rnd)
      };
    }, ({ permInicial, permNova, dataOrigem }) => {
      const db = new DatabaseSync(':memory:');
      try {
        prepararEsquemaCrm(db);
        db.exec(`CREATE TABLE IF NOT EXISTS eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT, autor_id TEXT, autor_e_dono INTEGER, texto TEXT, recebido_em TEXT, permissao TEXT)`);
        db.prepare(`INSERT INTO eventos (conversa_id, origem_id, autor_id, autor_e_dono, texto, recebido_em, permissao) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          'conv_temp@g.us', 'MSG_TEMP', 'autor@lid', 0, 'texto mensagem', String(dataOrigem ?? ''), permInicial
        );

        gravarItens(db, 'conv_temp@g.us', [
          { tipo: 'compromisso', resumo: 'Compromisso temporal', origem_id: 'MSG_TEMP', permissao_origem: permInicial, quando: String(dataOrigem ?? '') }
        ], { modelo: 'flash', ateEventoId: 1, politica: 'so-minhas' });

        // Evento no banco e reclassificado para permNova
        db.prepare("UPDATE eventos SET permissao = ? WHERE origem_id = ?").run(permNova, 'MSG_TEMP');

        const proc = procedencia(db, { itemId: 1 });
        assert.ok(proc);
        assert.equal(proc.permissao, permInicial, 'permissao do item deve refletir o momento do nascimento');
        assert.equal(proc.item.permissao_origem, permInicial);
        assert.equal(proc.evento.permissao, permNova);
      } finally {
        db.close();
      }
    }, { casos: 30 });
  });
});

describe('SPEC-F7 — Contrato observavel CLI (bin/procedencia.js)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const RAIZ = resolve(__dirname, '..');
  const CAMINHO_CLI = resolve(RAIZ, 'bin', 'procedencia.js');

  test('CLI: bin/procedencia.js sem --item sai com codigo 1', () => {
    const res = spawnSync(process.execPath, [CAMINHO_CLI], {
      encoding: 'utf-8',
      env: { ...process.env, ASSESSOR_DATA_DIR: ':memory:' }
    });
    assert.equal(res.status, 1, `CLI sem --item deve sair com 1. stderr: ${res.stderr}`);
    assert.match(res.stderr + res.stdout, /--item/i);
  });

  test('CLI: bin/procedencia.js com item inexistente sai com codigo 1 e mensagem explicativa', () => {
    const res = spawnSync(process.execPath, [CAMINHO_CLI, '--item', '999999'], {
      encoding: 'utf-8',
      env: { ...process.env, ASSESSOR_DATA_DIR: ':memory:' }
    });
    assert.equal(res.status, 1, `CLI com item inexistente deve sair com 1`);
    assert.match(res.stderr + res.stdout, /não encontrado|inexistente/i);
  });

  test('CLI: bin/procedencia.js --item <id> imprime a cadeia legivel e sai com 0', () => {
    // Cria um banco real temporario com item e evento
    const dirTmp = resolve(RAIZ, 'data', 'test_proc_' + Date.now());
    const dbPath = resolve(dirTmp, 'assessor.db');
    mkdirSync(dirTmp, { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      prepararEsquemaCrm(db);
      db.exec(`CREATE TABLE IF NOT EXISTS eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT, autor_id TEXT, autor_e_dono INTEGER, texto TEXT, recebido_em TEXT, permissao TEXT
      )`);
      db.prepare(`INSERT INTO eventos (conversa_id, origem_id, autor_id, autor_e_dono, texto, recebido_em, permissao) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'c_cli@s.whatsapp.net', 'ORIGEM_CLI', '55119999@s.whatsapp.net', 0, 'Quero fechar a consultoria por 20 mil', '2026-09-12T12:00:00Z', 'dirigida'
      );
      gravarItens(db, 'c_cli@s.whatsapp.net', [{
        tipo: 'lead',
        resumo: 'Lead de 20 mil consultoria',
        origem_id: 'ORIGEM_CLI',
        permissao_origem: 'dirigida',
        quando: '2026-09-12T12:00:00Z'
      }], { modelo: 'flash', ateEventoId: 1, politica: 'tudo' });
    } finally {
      db.close();
    }

    try {
      const res = spawnSync(process.execPath, [CAMINHO_CLI, '--item', '1'], {
        encoding: 'utf-8',
        env: { ...process.env, ASSESSOR_DATA_DIR: dirTmp }
      });
      assert.equal(res.status, 0, `CLI deve sair com 0 para item existente. Erro: ${res.stderr}`);
      const saida = res.stdout;
      assert.match(saida, /ORIGEM_CLI/);
      assert.match(saida, /Lead de 20 mil consultoria/);
      assert.match(saida, /dirigida/);
      assert.match(saida, /Quero fechar a consultoria por 20 mil/);
    } finally {
      try {
        rmSync(dirTmp, { recursive: true, force: true });
      } catch {}
    }
  });
});



// ------------------------------------------------- F7: falha fechada, nao aberta

test('F7: permissao desconhecida NAO e chutada como do dono', () => {
  // A versao anterior fazia: se a permissao for nula, chuta 'minha' em grupo.
  // Isso etiquetaria os 290 mil eventos anteriores a F6 -- todos com permissao nula --
  // como conteudo do proprio dono, em massa e em silencio. E o contrario do que esta
  // frente existe para fazer.
  const db = new DatabaseSync(':memory:');
  prepararEsquemaCrm(db);
  db.exec(`CREATE TABLE IF NOT EXISTS eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT, direcao TEXT, autor_id TEXT, autor_e_dono INTEGER, do_proprio_bot INTEGER, projeto_id TEXT, tipo TEXT, bruto TEXT, texto TEXT, recebido_em TEXT, dia_local TEXT, permissao TEXT)`);
  db.prepare(`INSERT INTO eventos (conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,texto,recebido_em,dia_local)
              VALUES ('g1@g.us','SEM-PERM','entrada','x@lid',0,'texto','oi','2026-09-12T10:00:00.000Z','2026-09-12')`).run();

  gravarItens(db, 'g1@g.us', [
    { tipo: 'lead', resumo: 'item de origem desconhecida', origem_id: 'SEM-PERM' }
  ], { modelo: 'teste' });

  const item = db.prepare("SELECT permissao_origem FROM itens_crm WHERE origem_id='SEM-PERM'").get();
  assert.ok(item, 'o item precisa ter sido gravado');
  assert.notEqual(item.permissao_origem, 'minha',
    'permissao desconhecida NUNCA pode virar "minha" — seria transformar terceiro em dono');
  assert.notEqual(item.permissao_origem, 'dirigida');
  assert.equal(item.permissao_origem, 'desconhecida',
    'desconhecida e a resposta honesta, e ela nao passa sob so-minhas');
  db.close();
});

test('F7/A2: montarPrompt falha FECHADO quando ninguem passa a politica', () => {
  // A versao anterior so filtrava se `opcoes.politica` existisse. Um chamador que
  // esquecesse o parametro mandava a conversa inteira ao modelo -- e esquecimento nao
  // pode ser a diferenca entre filtrar e nao filtrar conteudo de terceiro.
  const msgs = [
    { origem_id: 'A1', autor_e_dono: 1, texto: 'combinei de mandar a proposta', recebido_em: '2026-09-12T10:00:00.000Z', permissao: 'minha' },
    { origem_id: 'A2', autor_e_dono: 0, texto: 'SEGREDO DE TERCEIRO NAO PODE VAZAR', recebido_em: '2026-09-12T10:01:00.000Z', permissao: 'terceiro' }
  ];

  const semOpcoes = montarPrompt('WAVES', msgs);
  assert.doesNotMatch(semOpcoes, /SEGREDO DE TERCEIRO/,
    'sem politica declarada, o padrao tem que ser o restritivo');
  assert.match(semOpcoes, /combinei de mandar/, 'o que e do dono continua entrando');

  const comTudo = montarPrompt('WAVES', msgs, null, { politica: 'tudo' });
  assert.match(comTudo, /SEGREDO DE TERCEIRO/,
    'com "tudo" declarado de proposito, entra — a escolha e da pessoa');
});

test('F7/A2: mensagem com permissao NULA tambem nao chega ao modelo', () => {
  // Os 290 mil eventos antigos. Nulo e desconhecido, nao e autorizacao.
  const msgs = [
    { origem_id: 'A1', autor_e_dono: 1, texto: 'minha mensagem', recebido_em: '2026-09-12T10:00:00.000Z', permissao: 'minha' },
    { origem_id: 'A2', autor_e_dono: 0, texto: 'ANTIGA SEM ROTULO', recebido_em: '2026-09-12T10:01:00.000Z', permissao: null }
  ];
  assert.doesNotMatch(montarPrompt('WAVES', msgs), /ANTIGA SEM ROTULO/);
});
