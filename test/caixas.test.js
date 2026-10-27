import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ColetorCaixas,
  resolverGrupo2026,
  higienizarNomeArquivo,
  resolverNomeNaoColidente,
  extrairAnexoInfo
} from '../src/caixas.js';

function criarBancoMemoria() {
  return new DatabaseSync(':memory:');
}

function criarDirTemp() {
  return mkdtempSync(join(tmpdir(), 'assessor-caixas-test-'));
}

test('higienizacao de nomes: bloqueia traversal, caracteres perigosos e nomes reservados', () => {
  // Path traversal
  assert.equal(higienizarNomeArquivo('../../../../etc/passwd'), 'passwd');
  assert.equal(higienizarNomeArquivo('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe');

  // Caracteres proibidos e bytes nulos
  assert.equal(higienizarNomeArquivo('relatorio\0final:v1<teste>*.pdf'), 'relatoriofinal_v1_teste__.pdf');

  // Dispositivos reservados do Windows
  assert.equal(higienizarNomeArquivo('CON.txt'), '_CON.txt');
  assert.equal(higienizarNomeArquivo('aux.zip'), '_aux.zip');
  assert.equal(higienizarNomeArquivo('NUL'), '_NUL');
  assert.equal(higienizarNomeArquivo('COM1.dat'), '_COM1.dat');

  // Nomes vazios ou com apenas pontos
  assert.equal(higienizarNomeArquivo('...'), 'anexo.bin');
  assert.equal(higienizarNomeArquivo(''), 'anexo.bin');
  assert.equal(higienizarNomeArquivo(null), 'anexo.bin');
});

test('resolucao de nomes nao colidentes evita sobrescrita de arquivos existentes', () => {
  const dir = criarDirTemp();
  try {
    writeFileSync(join(dir, 'documento.pdf'), 'original');
    const nome2 = resolverNomeNaoColidente(dir, 'documento.pdf');
    assert.equal(nome2, 'documento_1.pdf');

    writeFileSync(join(dir, 'documento_1.pdf'), 'segundo');
    const nome3 = resolverNomeNaoColidente(dir, 'documento.pdf');
    assert.equal(nome3, 'documento_2.pdf');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('whitelist exata do grupo 2026: 0 candidatos, ambiguidades e correspondencia exata', () => {
  // Zero candidatos
  const resZero = resolverGrupo2026([]);
  assert.equal(resZero.resolvido, false);
  assert.equal(resZero.motivo, 'nenhum_candidato');

  // Nomes parecidos nao sao aceitos (apenas correspondência exata '2026')
  const resParecidos = resolverGrupo2026([
    { id: '1@g.us', subject: 'Grupo 2026' },
    { id: '2@g.us', subject: '2026 Projetos' },
    { id: '3@g.us', subject: 'Ano 2026' }
  ]);
  assert.equal(resParecidos.resolvido, false);
  assert.equal(resParecidos.motivo, 'nenhum_candidato');

  // Multiplos candidatos com nome '2026' (ambiguidade aguarda decisao humana)
  const resAmbiguo = resolverGrupo2026([
    { id: '120363001@g.us', subject: '2026' },
    { id: '120363002@g.us', subject: '2026' }
  ]);
  assert.equal(resAmbiguo.resolvido, false);
  assert.equal(resAmbiguo.motivo, 'ambiguo_multiplos_candidatos');
  assert.equal(resAmbiguo.total, 2);

  // Exatamente um grupo '2026'
  const resExato = resolverGrupo2026([
    { id: '120363001@g.us', subject: 'Outro Grupo' },
    { id: '120363999@g.us', subject: '2026' }
  ]);
  assert.equal(resExato.resolvido, true);
  assert.equal(resExato.jid, '120363999@g.us');
});

test('coletor filtra rigorosamente por whitelist e ignora mensagens de fora do grupo 2026', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();

  try {
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: '120363999@g.us',
      baixarMidia: async () => Buffer.from('conteudo teste')
    });

    // Mensagem de outro grupo
    const msgOutroGrupo = {
      key: { remoteJid: 'outro-grupo@g.us', id: 'MSG-001' },
      message: { documentMessage: { fileName: 'export.zip', mimetype: 'application/zip' } }
    };
    const resOutro = await coletor.processarMensagem(msgOutroGrupo);
    assert.equal(resOutro.aceito, false);
    assert.equal(resOutro.motivo, 'fora_do_grupo_2026');

    // Mensagem de DM
    const msgDM = {
      key: { remoteJid: '5511999999999@s.whatsapp.net', id: 'MSG-002' },
      message: { documentMessage: { fileName: 'export.zip', mimetype: 'application/zip' } }
    };
    const resDM = await coletor.processarMensagem(msgDM);
    assert.equal(resDM.aceito, false);
    assert.equal(resDM.motivo, 'fora_do_grupo_2026');

    // Mensagem do grupo 2026
    const msg2026 = {
      key: { remoteJid: '120363999@g.us', id: 'MSG-003', participant: '551188888888@s.whatsapp.net' },
      messageTimestamp: 1773000000,
      message: { documentMessage: { fileName: 'exportacao_gutuziani.zip', mimetype: 'application/zip' } }
    };
    const res2026 = await coletor.processarMensagem(msg2026);
    assert.equal(res2026.aceito, true);
    assert.equal(res2026.status, 'recebido');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('deduplicacao e replay: mensagens repetidas nao duplicam caixas nem sobrescrevem', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  let chamadasDownload = 0;

  try {
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: '120363999@g.us',
      baixarMidia: async () => {
        chamadasDownload++;
        return Buffer.from('conteudo zip gutuziani');
      }
    });

    const msg = {
      key: { remoteJid: '120363999@g.us', id: 'MSG-REPLAY-1', participant: '551188888888@s.whatsapp.net' },
      messageTimestamp: 1773000000,
      message: { documentMessage: { fileName: 'exportacao.zip', mimetype: 'application/zip' } }
    };

    const primeira = await coletor.processarMensagem(msg);
    assert.equal(primeira.aceito, true);
    assert.equal(primeira.status, 'recebido');
    assert.equal(chamadasDownload, 1);

    // Replay da mesma mensagem (idempotencia)
    const segunda = await coletor.processarMensagem(msg);
    assert.equal(segunda.aceito, true);
    assert.equal(segunda.repetido, true);
    assert.equal(chamadasDownload, 1); // Nao baixou de novo!

    // Verifica que so ha 1 registro no banco SQLite
    const jobs = db.prepare('SELECT * FROM caixas_jobs').all();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].estado, 'recebido');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('falhas transientes, retentativas e transicao explicita para erro ao atingir limite', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  let falhar = true;

  try {
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: '120363999@g.us',
      maxTentativas: 2,
      baixarMidia: async () => {
        if (falhar) throw new Error('Falha de conexao de rede simulada');
        return Buffer.from('conteudo ok');
      }
    });

    const msg = {
      key: { remoteJid: '120363999@g.us', id: 'MSG-FALHA-1' },
      message: { documentMessage: { fileName: 'teste.pdf', mimetype: 'application/pdf' } }
    };

    // Tentativa 1 -> Falha -> Estado pendente
    const r1 = await coletor.processarMensagem(msg);
    assert.equal(r1.aceito, false);
    assert.equal(r1.estado, 'pendente');
    assert.equal(r1.tentativas, 1);

    let job = coletor.obterJob('120363999@g.us', 'MSG-FALHA-1');
    assert.equal(job.estado, 'pendente');
    assert.equal(job.tentativas, 1);

    // Tentativa 2 -> Falha -> Atingiu maxTentativas (2) -> Transicao para erro definitivo
    const r2 = await coletor.processarMensagem(msg);
    assert.equal(r2.aceito, false);
    assert.equal(r2.estado, 'erro');
    assert.equal(r2.tentativas, 2);

    job = coletor.obterJob('120363999@g.us', 'MSG-FALHA-1');
    assert.equal(job.estado, 'erro');
    assert.equal(job.tentativas, 2);
    assert.match(job.ultimo_erro, /Falha de conexao/);

    // Manifesto foi gerado refletindo o erro duravel
    const caixaDir = join(dir, job.id);
    const manifesto = JSON.parse(readFileSync(join(caixaDir, 'manifesto.json'), 'utf-8'));
    assert.equal(manifesto.status, 'erro');
    assert.match(manifesto.erroResumido, /Falha de conexao/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('recuperacao de reinicio: leases abandonados em "baixando" sao recuperados', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();

  try {
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: '120363999@g.us',
      maxTentativas: 3,
      baixarMidia: async () => Buffer.from('arquivo recuperado')
    });

    // Simula um job que foi interrompido por crash enquanto estava baixando
    db.prepare(`
      INSERT INTO caixas_jobs (
        id, conversa_id, origem_id, remetente_id, tipo, nome_original,
        nome_higienizado, mime_tipo, tamanho_bytes, estado, motivo_ignorado,
        tentativas, max_tentativas, ultimo_erro, arquivo_caminho, sha256,
        recebido_em, atualizado_em
      ) VALUES (
        'cx_CRASH_1', '120363999@g.us', 'CRASH_1', 'remetente', 'documento', 'anexo.zip',
        NULL, 'application/zip', 100, 'baixando', NULL,
        1, 3, NULL, NULL, NULL,
        '2026-09-08T20:00:00.000Z', '2026-09-08T20:00:00.000Z'
      )
    `).run();

    const resRecuperacao = coletor.recuperarReinicio();
    assert.equal(resRecuperacao.recuperados, 1);

    const jobRecuperado = coletor.obterCaixaPorId('cx_CRASH_1');
    assert.equal(jobRecuperado.estado, 'pendente');
    assert.match(jobRecuperado.ultimo_erro, /reinicio/i);

    // Agora o coletor consegue processar a mensagem com sucesso
    const msg = {
      key: { remoteJid: '120363999@g.us', id: 'CRASH_1' },
      message: { documentMessage: { fileName: 'anexo.zip', mimetype: 'application/zip' } }
    };
    const resFinal = await coletor.processarMensagem(msg);
    assert.equal(resFinal.aceito, true);
    assert.equal(resFinal.status, 'recebido');

    const jobFinal = coletor.obterCaixaPorId('cx_CRASH_1');
    assert.equal(jobFinal.estado, 'recebido');
    assert.equal(jobFinal.tentativas, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('protecao contra nomes maliciosos e contencao estrita dentro de original/', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();

  try {
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: '120363999@g.us',
      baixarMidia: async () => Buffer.from('conteudo seguro')
    });

    const msgMaliciosa = {
      key: { remoteJid: '120363999@g.us', id: 'MSG-MALICIOUS' },
      message: {
        documentMessage: {
          fileName: '../../../../../../Windows/System32/calc.exe',
          mimetype: 'application/octet-stream'
        }
      }
    };

    const res = await coletor.processarMensagem(msgMaliciosa);
    assert.equal(res.aceito, true);
    assert.equal(res.status, 'recebido');

    const caixaDir = join(dir, res.caixaId);
    const dirOriginal = join(caixaDir, 'original');

    // O arquivo DEVE estar confinado estritamente dentro de original/
    assert.ok(existsSync(join(dirOriginal, 'calc.exe')));
    // E nao pode ter escapado para a raiz do disco
    assert.ok(!existsSync(resolve(dir, '../../calc.exe')));

    // O manifesto mantem o nome original para registro histórico
    const manifesto = JSON.parse(readFileSync(join(caixaDir, 'manifesto.json'), 'utf-8'));
    assert.equal(manifesto.arquivo.nomeOriginal, '../../../../../../Windows/System32/calc.exe');
    assert.equal(manifesto.arquivo.nomeHigienizado, 'calc.exe');
    assert.equal(manifesto.arquivo.caminhoRelativo, 'original/calc.exe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('manifesto sanitizado: contem SHA-256 e bytes, e NUNCA vaza chaves de midia ou credenciais', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();

  try {
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: '120363999@g.us',
      baixarMidia: async () => Buffer.from('dados binarios da exportacao')
    });

    // Mensagem contendo chaves privadas de mídia do Baileys
    const msgComSegredos = {
      key: { remoteJid: '120363999@g.us', id: 'MSG-SECRETS', participant: '551199999999@s.whatsapp.net' },
      messageTimestamp: 1773000000,
      message: {
        documentMessage: {
          fileName: 'exportacao_gutuziani.zip',
          mimetype: 'application/zip',
          fileLength: 28,
          mediaKey: Buffer.from('super-secret-media-key-12345'),
          directPath: '/v/t62.7118-24/12345678_token.enc',
          encFileHash: 'encrypted-hash-abcd',
          fileEncSha256: Buffer.from('wa-enc-sha256')
        }
      }
    };

    const res = await coletor.processarMensagem(msgComSegredos);
    assert.equal(res.aceito, true);
    assert.equal(res.status, 'recebido');

    const caixaDir = join(dir, res.caixaId);
    const manifestoRaw = readFileSync(join(caixaDir, 'manifesto.json'), 'utf-8');
    const manifesto = JSON.parse(manifestoRaw);

    // Campos obrigatorios de integridade e proveniencia estao presentes
    assert.equal(manifesto.versao, '1.0.0');
    assert.equal(manifesto.caixaId, res.caixaId);
    assert.equal(manifesto.status, 'recebido');
    assert.equal(manifesto.transporte.grupoId, '120363999@g.us');
    assert.equal(manifesto.transporte.mensagemId, 'MSG-SECRETS');
    assert.equal(manifesto.arquivo.bytes, 28);
    assert.ok(manifesto.arquivo.sha256);
    assert.equal(manifesto.arquivo.caminhoRelativo, 'original/exportacao_gutuziani.zip');

    // Verificacao explicita de privacidade e segredos
    assert.doesNotMatch(manifestoRaw, /super-secret-media-key/);
    assert.doesNotMatch(manifestoRaw, /mediaKey/);
    assert.doesNotMatch(manifestoRaw, /directPath/);
    assert.doesNotMatch(manifestoRaw, /encFileHash/);
    assert.doesNotMatch(manifestoRaw, /fileEncSha256/);
    assert.doesNotMatch(manifestoRaw, /token/i);
    assert.doesNotMatch(manifestoRaw, /cookie/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('videos sao ignorados com motivo explícito sem baixar o payload', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  let downloadChamado = false;

  try {
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: '120363999@g.us',
      baixarMidia: async () => {
        downloadChamado = true;
        return Buffer.from('video pesado');
      }
    });

    const msgVideo = {
      key: { remoteJid: '120363999@g.us', id: 'MSG-VIDEO-1' },
      messageTimestamp: 1773000000,
      message: {
        videoMessage: {
          mimetype: 'video/mp4',
          fileLength: 50000000,
          caption: 'video explicativo'
        }
      }
    };

    const res = await coletor.processarMensagem(msgVideo);
    assert.equal(res.aceito, true);
    assert.equal(res.ignorado, true);
    assert.equal(res.motivo, 'video_ignorado');
    assert.equal(downloadChamado, false); // Nao baixou o payload de video!

    const job = coletor.obterCaixaPorId(res.caixaId);
    assert.equal(job.estado, 'ignorado');
    assert.equal(job.motivo_ignorado, 'video_ignorado');

    // Manifesto gerado registra o video como excluido por politica
    const caixaDir = join(dir, res.caixaId);
    const manifesto = JSON.parse(readFileSync(join(caixaDir, 'manifesto.json'), 'utf-8'));
    assert.equal(manifesto.status, 'ignorado');
    assert.equal(manifesto.motivoStatus, 'video_ignorado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('backfill do banco recupera anexos ja persistidos em eventos, sem duplicar', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    // Reproduz o formato real da tabela `eventos`: a mensagem crua fica
    // aninhada em bruto.mensagem, com mediaKey preservada.
    db.exec(`CREATE TABLE eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversa_id TEXT NOT NULL,
      origem_id TEXT,
      bruto TEXT
    )`);

    const JID = '120363999@g.us';
    const inserir = (origemId, conversaId, mensagem) =>
      db.prepare('INSERT INTO eventos (conversa_id, origem_id, bruto) VALUES (?, ?, ?)')
        .run(conversaId, origemId, JSON.stringify({ tipoLote: 'append', mensagem }));

    inserir('MSG-A', JID, {
      key: { remoteJid: JID, id: 'MSG-A', participant: '55119@s.whatsapp.net' },
      messageTimestamp: 1757000000,
      message: { documentMessage: { fileName: 'gutuziani.zip', mimetype: 'application/zip', mediaKey: 'k', directPath: '/d' } }
    });
    inserir('MSG-B', JID, {
      key: { remoteJid: JID, id: 'MSG-B' },
      messageTimestamp: 1757000100,
      message: { conversation: 'so texto, sem anexo' }
    });
    // Mensagem de outro grupo NAO pode ser tocada pelo backfill.
    inserir('MSG-C', 'outro@g.us', {
      key: { remoteJid: 'outro@g.us', id: 'MSG-C' },
      message: { documentMessage: { fileName: 'sigiloso.pdf', mimetype: 'application/pdf' } }
    });
    // Bruto corrompido nao pode derrubar a varredura.
    db.prepare('INSERT INTO eventos (conversa_id, origem_id, bruto) VALUES (?, ?, ?)')
      .run(JID, 'MSG-D', '{json quebrado');

    let downloads = 0;
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: JID,
      baixarMidia: async () => { downloads++; return Buffer.from('conteudo exportado'); }
    });

    const r1 = await coletor.backfillDoBanco({ limite: 100 });
    assert.equal(r1.ok, true);
    assert.equal(r1.examinados, 3, 'so varre eventos do JID fixado');
    assert.equal(r1.recebidos, 1);
    assert.equal(r1.semAnexo, 1);
    assert.equal(r1.erros, 1, 'bruto corrompido vira erro contabilizado, nao excecao');
    assert.equal(downloads, 1);

    const caixa = coletor.obterJob(JID, 'MSG-A');
    assert.equal(caixa.estado, 'recebido');
    assert.ok(caixa.sha256);
    assert.ok(existsSync(resolve(dir, caixa.id, 'original', caixa.nome_higienizado)));
    assert.equal(readFileSync(resolve(dir, caixa.id, 'manifesto.json'), 'utf-8').includes('mediaKey'), false,
      'manifesto nunca carrega chave de midia');

    // Segunda passada e idempotente: nenhum download novo, nenhuma caixa nova.
    const r2 = await coletor.backfillDoBanco({ limite: 100 });
    assert.equal(r2.recebidos, 0);
    assert.equal(r2.repetidos, 1);
    assert.equal(downloads, 1, 'replay nao rebaixa a mesma midia');

    // O anexo do outro grupo nunca virou caixa.
    assert.equal(coletor.obterJob('outro@g.us', 'MSG-C'), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill recusa varrer enquanto o grupo 2026 nao estiver resolvido', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    db.exec('CREATE TABLE eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT, bruto TEXT)');
    const coletor = new ColetorCaixas(db, { diretorioBase: dir, baixarMidia: async () => Buffer.from('x') });
    const r = await coletor.backfillDoBanco({ limite: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'grupo_nao_resolvido');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache do JID nao serve valor velho depois de fixar outro grupo', () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const coletor = new ColetorCaixas(db, { diretorioBase: dir });
    assert.equal(coletor.obterJidGrupo2026(), null);
    coletor.fixarJidGrupo2026('120363111@g.us');
    assert.equal(coletor.obterJidGrupo2026(), '120363111@g.us');
    assert.equal(coletor.ehGrupo2026('120363111@g.us'), true);
    coletor.atualizarGrupos([{ id: '120363222@g.us', subject: '2026' }]);
    assert.equal(coletor.obterJidGrupo2026(), '120363222@g.us', 'resolucao nova invalida o cache');
    assert.equal(coletor.ehGrupo2026('120363111@g.us'), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('download por fluxo grava arquivo, confere sha256 e nao carrega tudo em memoria', async () => {
  const { Readable } = await import('node:stream');
  const { createHash } = await import('node:crypto');
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const JID = '120363999@g.us';
    // Tres pedacos separados provam que o hash e incremental, nao de um Buffer unico.
    const pedacos = [Buffer.from('parte-um-'), Buffer.from('parte-dois-'), Buffer.from('parte-tres')];
    const inteiro = Buffer.concat(pedacos);
    const shaEsperado = createHash('sha256').update(inteiro).digest('hex');

    let formatoPedido = null;
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: JID,
      baixarMidia: async (_msg, formato) => { formatoPedido = formato; return Readable.from(pedacos); }
    });

    const res = await coletor.processarMensagem({
      key: { remoteJid: JID, id: 'MSG-STREAM' },
      messageTimestamp: 1757000000,
      message: { documentMessage: { fileName: 'export.zip', mimetype: 'application/zip', fileLength: inteiro.length } }
    });

    assert.equal(formatoPedido, 'stream', 'o Baileys recebe o formato, nunca o tipo do anexo');
    assert.equal(res.status, 'recebido');
    assert.equal(res.bytes, inteiro.length);
    assert.equal(res.sha256, shaEsperado);

    const job = coletor.obterJob(JID, 'MSG-STREAM');
    assert.equal(readFileSync(resolve(dir, job.id, 'original', job.nome_higienizado), 'utf-8'), inteiro.toString());
    assert.equal(existsSync(resolve(dir, job.id, 'original', job.nome_higienizado + '.part')), false, 'sem residuo .part');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fluxo maior que o limite e cortado no meio, sem deixar arquivo parcial publicado', async () => {
  const { Readable } = await import('node:stream');
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const JID = '120363999@g.us';
    let entregues = 0;
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir,
      jidGrupo2026: JID,
      limiteBytes: 10,
      baixarMidia: async () => Readable.from((function* () {
        for (let i = 0; i < 100; i++) { entregues++; yield Buffer.alloc(8, 1); }
      })())
    });

    const res = await coletor.processarMensagem({
      key: { remoteJid: JID, id: 'MSG-GRANDE' },
      message: { documentMessage: { fileName: 'gigante.zip', mimetype: 'application/zip' } }
    });

    assert.equal(res.aceito, false);
    assert.match(res.erro, /excede o limite/);
    assert.ok(entregues < 100, 'o fluxo para no limite em vez de consumir tudo');
    const job = coletor.obterJob(JID, 'MSG-GRANDE');
    assert.equal(job.arquivo_caminho, null);
    assert.equal(existsSync(resolve(dir, job.id, 'original', 'gigante.zip')), false);
    assert.equal(existsSync(resolve(dir, job.id, 'original', 'gigante.zip.part')), false, 'residuo .part e removido');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tamanho declarado acima do limite recusa antes de abrir o download', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const JID = '120363999@g.us';
    let tentouBaixar = false;
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir, jidGrupo2026: JID, limiteBytes: 1024,
      baixarMidia: async () => { tentouBaixar = true; return Buffer.alloc(10); }
    });
    const res = await coletor.processarMensagem({
      key: { remoteJid: JID, id: 'MSG-DECLARADO' },
      message: { documentMessage: { fileName: 'enorme.zip', mimetype: 'application/zip', fileLength: 5 * 1024 } }
    });
    assert.equal(res.aceito, false);
    assert.match(res.erro, /Tamanho declarado/);
    assert.equal(tentouBaixar, false, 'nao gasta rede quando o proprio WhatsApp ja declarou o tamanho');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('midia expirada no WhatsApp vira erro terminal, sem queimar as tres tentativas', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const JID = '120363999@g.us';
    let chamadas = 0;
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir, jidGrupo2026: JID,
      baixarMidia: async () => { chamadas++; throw new Error('Failed to fetch stream from https://mmg.whatsapp.net/x'); }
    });
    const msg = {
      key: { remoteJid: JID, id: 'MSG-EXPIRADA' },
      message: { documentMessage: { fileName: 'antigo.pdf', mimetype: 'application/pdf' } }
    };
    const res = await coletor.processarMensagem(msg);
    assert.equal(res.aceito, false);
    assert.equal(res.estado, 'erro', 'nao fica pendente esperando retentativa inutil');

    const job = coletor.obterJob(JID, 'MSG-EXPIRADA');
    assert.equal(job.estado, 'erro');
    assert.equal(job.motivo_ignorado, 'midia_indisponivel_no_whatsapp');
    assert.equal(job.tentativas, 1);

    // Reprocessar nao tenta baixar de novo.
    await coletor.processarMensagem(msg);
    assert.equal(chamadas, 1, 'erro terminal nao volta para a fila');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloads correm em serie, nunca em rajada paralela', async () => {
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const JID = '120363999@g.us';
    let emVoo = 0, pico = 0;
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir, jidGrupo2026: JID,
      baixarMidia: async () => {
        emVoo++; pico = Math.max(pico, emVoo);
        await new Promise(r => setTimeout(r, 5));
        emVoo--;
        return Buffer.from('conteudo');
      }
    });

    const mensagens = ['A', 'B', 'C', 'D'].map(s => ({
      key: { remoteJid: JID, id: 'MSG-' + s },
      message: { documentMessage: { fileName: 'arq-' + s + '.pdf', mimetype: 'application/pdf' } }
    }));
    await Promise.all(mensagens.map(m => coletor.processarMensagem(m)));

    assert.equal(pico, 1, 'no maximo um download por vez');
    for (const s of ['A', 'B', 'C', 'D']) {
      assert.equal(coletor.obterJob(JID, 'MSG-' + s).estado, 'recebido');
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('erro no fluxo de midia nao escapa como excecao nao tratada do processo', async () => {
  const { Readable } = await import('node:stream');
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  const capturadas = [];
  const capturar = err => capturadas.push(err);
  process.on('uncaughtException', capturar);
  try {
    const JID = '120363999@g.us';
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir, jidGrupo2026: JID,
      baixarMidia: async () => {
        const fluxo = new Readable({ read() {} });
        fluxo.push(Buffer.from('inicio-do-arquivo'));
        // Reproduz o ECONNRESET do WhatsApp no meio de um anexo grande.
        setTimeout(() => fluxo.destroy(Object.assign(new Error('terminated'), { code: 'ECONNRESET' })), 5);
        return fluxo;
      }
    });

    const res = await coletor.processarMensagem({
      key: { remoteJid: JID, id: 'MSG-RESET' },
      message: { documentMessage: { fileName: 'grande.zip', mimetype: 'application/zip' } }
    });

    await new Promise(r => setTimeout(r, 40));
    assert.equal(res.aceito, false, 'a falha vira estado do job');
    assert.deepEqual(capturadas, [], 'nenhuma excecao escapou para o processo');
    assert.equal(coletor.obterJob(JID, 'MSG-RESET').estado, 'pendente', 'volta para a fila');
    // O parcial fica: queda de conexao e o caso comum, e a proxima tentativa retoma dele.
    assert.equal(existsSync(resolve(dir, 'cx_MSG-RESET', 'original', 'grande.zip.part')), true);
  } finally {
    process.off('uncaughtException', capturar);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fluxo pendurado sem bytes novos e abortado pelo vigia de inatividade', async () => {
  const { Readable } = await import('node:stream');
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const JID = '120363999@g.us';
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir, jidGrupo2026: JID,
      timeoutInatividadeMs: 1,
      baixarMidia: async () => {
        const fluxo = new Readable({ read() {} });
        fluxo.push(Buffer.from('primeiro-pedaco'));
        // e nunca mais entrega nada, nem fecha.
        return fluxo;
      }
    });

    const res = await coletor.processarMensagem({
      key: { remoteJid: JID, id: 'MSG-PENDURADA' },
      message: { documentMessage: { fileName: 'travado.zip', mimetype: 'application/zip' } }
    });

    assert.equal(res.aceito, false);
    assert.match(res.erro, /Download parado/);
    assert.equal(coletor.obterJob(JID, 'MSG-PENDURADA').estado, 'pendente');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('download retoma do .part em vez de recomecar os 650 MB do zero', async () => {
  const { Readable } = await import('node:stream');
  const { createHash } = await import('node:crypto');
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const JID = '120363999@g.us';
    const parte1 = Buffer.from('AAAAAAAAAA');   // 10 bytes que sobrevivem a queda
    const parte2 = Buffer.from('BBBBBBBBBB');   // 10 bytes da retomada
    const inteiro = Buffer.concat([parte1, parte2]);

    const pedidos = [];
    let chamada = 0;
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir, jidGrupo2026: JID,
      baixarMidia: async (_msg, _formato, opcoes) => {
        pedidos.push(opcoes?.startByte ?? null);
        chamada++;
        if (chamada === 1) {
          // Entrega metade e a conexao cai, como o WhatsApp faz de verdade.
          const fluxo = new Readable({ read() {} });
          fluxo.push(parte1);
          // Simular a queda DEPOIS do progresso durável que este caso exercita.
          // Um prazo fixo de 5 ms podia cair antes de o arquivo sequer abrir.
          const parcialEmCurso=resolve(dir,'cx_MSG-RETOMA','original','export.zip.part');
          const limiteEspera=Date.now()+2000;
          const cairAposProgresso=()=>{
            if(existsSync(parcialEmCurso)&&statSync(parcialEmCurso).size===parte1.length)fluxo.destroy(Object.assign(new Error('terminated'),{code:'ECONNRESET'}));
            else if(Date.now()>limiteEspera)fluxo.destroy(new Error('Fixture não observou progresso em disco antes da queda'));
            else setTimeout(cairAposProgresso,5);
          };
          setTimeout(cairAposProgresso,5);
          return fluxo;
        }
        return Readable.from([parte2]);
      }
    });

    const msg = {
      key: { remoteJid: JID, id: 'MSG-RETOMA' },
      message: { documentMessage: { fileName: 'export.zip', mimetype: 'application/zip' } }
    };

    const primeira = await coletor.processarMensagem(msg);
    assert.equal(primeira.aceito, false, 'a queda nao conclui a caixa');
    const parcial = resolve(dir, 'cx_MSG-RETOMA', 'original', 'export.zip.part');
    assert.equal(existsSync(parcial), true, 'o parcial e preservado para retomar');
    assert.equal(readFileSync(parcial).length, 10);
    assert.equal(coletor.obterJob(JID, 'MSG-RETOMA').tentativas, 0, 'progresso nao gasta tentativa');

    const segunda = await coletor.processarMensagem(msg);
    assert.equal(segunda.status, 'recebido');
    assert.equal(segunda.bytes, 20, 'soma o que ja estava em disco');
    assert.deepEqual(pedidos, [null, 10], 'a retomada pede a partir do byte 10');

    const job = coletor.obterJob(JID, 'MSG-RETOMA');
    const finalNoDisco = readFileSync(resolve(dir, job.id, 'original', job.nome_higienizado));
    assert.equal(finalNoDisco.toString(), inteiro.toString(), 'arquivo remontado na ordem certa');
    assert.equal(job.sha256, createHash('sha256').update(inteiro).digest('hex'),
      'sha256 e do arquivo inteiro em disco, nao so do pedaco baixado agora');
    assert.equal(existsSync(parcial), false, 'sem residuo .part depois de fechar');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('processarPendentes empurra a fila usando a mensagem crua guardada em eventos', async () => {
  const { Readable } = await import('node:stream');
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    db.exec('CREATE TABLE eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT, bruto TEXT)');
    const JID = '120363999@g.us';
    const msg = {
      key: { remoteJid: JID, id: 'MSG-FILA' },
      message: { documentMessage: { fileName: 'pendente.zip', mimetype: 'application/zip' } }
    };
    db.prepare('INSERT INTO eventos (conversa_id, origem_id, bruto) VALUES (?, ?, ?)')
      .run(JID, 'MSG-FILA', JSON.stringify({ tipoLote: 'append', mensagem: msg }));

    let falharPrimeira = true;
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir, jidGrupo2026: JID,
      baixarMidia: async () => {
        if (falharPrimeira) {
          falharPrimeira = false;
          throw new Error('Connection Terminated');
        }
        return Readable.from([Buffer.from('conteudo final')]);
      }
    });

    await coletor.processarMensagem(msg);
    assert.equal(coletor.obterJob(JID, 'MSG-FILA').estado, 'pendente');

    const r = await coletor.processarPendentes({ limite: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.tentados, 1);
    assert.equal(r.recebidos, 1, 'a fila conclui sozinha o que a queda deixou pendente');
    assert.equal(coletor.obterJob(JID, 'MSG-FILA').estado, 'recebido');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arquivo truncado nao vira recibo: volta para a fila e retoma do que falta', async () => {
  const { Readable } = await import('node:stream');
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const JID = '120363999@g.us';
    let chamada = 0;
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir, jidGrupo2026: JID,
      baixarMidia: async () => {
        chamada++;
        // Fecha limpo entregando menos do que o WhatsApp declarou (o caso do WAVES).
        return Readable.from([Buffer.from(chamada === 1 ? 'AAAAA' : 'BBBBB')]);
      }
    });

    const msg = {
      key: { remoteJid: JID, id: 'MSG-TRUNCADA' },
      message: { documentMessage: { fileName: 'export.zip', mimetype: 'application/zip', fileLength: 10 } }
    };

    const primeira = await coletor.processarMensagem(msg);
    assert.equal(primeira.aceito, false, 'fluxo que fecha limpo mas incompleto nao e recibo');
    assert.match(primeira.erro, /Download incompleto: 5 de 10 bytes/);
    const job = coletor.obterJob(JID, 'MSG-TRUNCADA');
    assert.equal(job.estado, 'pendente');
    assert.equal(job.sha256, null, 'nada de hash de arquivo pela metade');
    assert.equal(existsSync(resolve(dir, job.id, 'original', 'export.zip.part')), true,
      'o parcial fica para a retomada completar');

    const segunda = await coletor.processarMensagem(msg);
    assert.equal(segunda.status, 'recebido');
    assert.equal(segunda.bytes, 10);
    assert.equal(readFileSync(resolve(dir, job.id, 'original', 'export.zip'), 'utf-8'), 'AAAAABBBBB');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sha256 diferente do declarado pelo WhatsApp descarta o parcial corrompido', async () => {
  const { Readable } = await import('node:stream');
  const db = criarBancoMemoria();
  const dir = criarDirTemp();
  try {
    const JID = '120363999@g.us';
    const coletor = new ColetorCaixas(db, {
      diretorioBase: dir, jidGrupo2026: JID,
      baixarMidia: async () => Readable.from([Buffer.from('conteudo trocado')])
    });

    const res = await coletor.processarMensagem({
      key: { remoteJid: JID, id: 'MSG-CORROMPIDA' },
      message: { documentMessage: {
        fileName: 'export.zip', mimetype: 'application/zip',
        fileLength: 16,
        // base64 de 32 bytes que nao correspondem ao conteudo entregue
        fileSha256: Buffer.alloc(32, 7).toString('base64')
      } }
    });

    assert.equal(res.aceito, false);
    assert.match(res.erro, /Integridade falhou/);
    const job = coletor.obterJob(JID, 'MSG-CORROMPIDA');
    assert.equal(job.arquivo_caminho, null);
    assert.equal(existsSync(resolve(dir, job.id, 'original', 'export.zip')), false);
    assert.equal(existsSync(resolve(dir, job.id, 'original', 'export.zip.part')), false,
      'bytes corrompidos nao servem para retomar: o parcial e descartado');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sha declarado e aceito nos formatos em que o Baileys entrega', async () => {
  const { normalizarSha } = await import('../src/caixas.js');
  const bytes = Buffer.alloc(32, 3);
  const hex = bytes.toString('hex');
  assert.equal(normalizarSha(bytes.toString('base64')), hex);
  assert.equal(normalizarSha(bytes), hex);
  assert.equal(normalizarSha({ type: 'Buffer', data: [...bytes] }), hex, 'formato do JSON.parse');
  assert.equal(normalizarSha([...bytes]), hex);
  assert.equal(normalizarSha(null), null);
  assert.equal(normalizarSha(undefined), null);
});
