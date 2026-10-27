import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { abrirOraculoStagingV9 } from './fixtures/backup-restore-oraculo.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { criarOrigemV10 } from '../src/backup-acervo-v10.js';
import { gravarPacote } from '../src/backup-stream.js';
import { validarAcervoV10, inspecionarPlanoV9, inspecionarPlanoV10, descartarPlanoV10 } from '../src/backup-acervo-restore-v9.js';

function wavSintetico(amostra = 0) {
  const pcm = Buffer.alloc(320, 0);
  pcm[0] = amostra;
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

async function fixtureAnexo({ dois = false } = {}) {
  const f = await criarPerfilRealSintetico();
  const anexos = path.join(f.dir, 'anexos');
  await mkdir(anexos);
  const caminho = path.join(anexos, 'audio-123e4567-e89b-42d3-a456-426614174000.wav');
  const bytes = wavSintetico();
  await writeFile(caminho, bytes);
  f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
    VALUES('conversa-sintetica','audio-sintetico','entrada','audio','{}','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run();
  f.db.prepare(`INSERT INTO transcricoes(conversa_id,origem_id,arquivo,estado,criado_em)
    VALUES('conversa-sintetica','audio-sintetico',?,'vazio','2026-09-28T10:00:00.000Z')`).run(caminho);
  let segundo;
  if (dois) {
    const caminho2 = path.join(anexos, 'audio-223e4567-e89b-42d3-a456-426614174000.wav');
    const bytes2 = wavSintetico(17);
    await writeFile(caminho2, bytes2);
    f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('conversa-sintetica','audio-sintetico-2','entrada','audio','{}','2026-09-28T10:00:01.000Z','2026-09-28','minha')`).run();
    f.db.prepare(`INSERT INTO transcricoes(conversa_id,origem_id,arquivo,estado,criado_em)
      VALUES('conversa-sintetica','audio-sintetico-2',?,'vazio','2026-09-28T10:00:01.000Z')`).run(caminho2);
    segundo = { caminho: caminho2, bytes: bytes2 };
  }
  f.db.close();
  return { f, caminho, bytes, anexos, segundo };
}

test('v10 leva WAV referenciado, confere hash e restaura a referência em staging; v9 permanece sem anexos', async () => {
  const { f, caminho, bytes } = await fixtureAnexo();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'com-audio.lumebak');
  const senha = 'senha sintética para anexo';
  let origem, plano;
  try {
    await mkdir(raizStaging);
    await assert.rejects(criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } }), { code: 'ANEXOS_SEM_LOCK' });
    origem = await criarOrigemV10({
      dbPath: f.dbPath, perfil: { dono: 'Teste' },
      arquivos: [{ classe: 'transcricao', caminho }],
    });
    assert.equal(origem.resumo.anexos, 1);
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    plano = await validarAcervoV10({ pacote, senha, raizStaging });
    assert.equal(plano.resumo.anexos, 1);
    assert.throws(() => inspecionarPlanoV9(plano.plano), { code: 'PLANO_INVALIDO' });
    assert.equal((await inspecionarPlanoV10(plano.plano)).resumo.anexos, 1);
    const db = await abrirOraculoStagingV9({ raizStaging, raizFixture: f.dir });
    let referencia;
    try { referencia = db.prepare('SELECT arquivo FROM transcricoes WHERE origem_id=?').get('audio-sintetico')?.arquivo; }
    finally { db.close(); }
    assert.equal(typeof referencia, 'string');
    const area = path.join(raizStaging, (await readdir(raizStaging))[0]);
    assert.equal(referencia, 'anexo:1', 'caminho privado não entra no backup');
    const lido = await readFile(path.join(area, 'anexos.pack'));
    assert.equal(createHash('sha256').update(lido).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  } finally {
    if (plano) await descartarPlanoV10(plano.plano);
    await origem?.fechar();
    await f.close();
  }
});

test('v10 recusa anexo ausente, junção ancestral e hardlink dentro da raiz gerida', async t => {
  const { f, caminho, anexos } = await fixtureAnexo();
  const faltando = path.join(anexos, 'nao-existe.wav');
  const externo = path.join(f.dir, 'externo');
  const linkDir = path.join(anexos, 'atalho-externo');
  const linkPath = path.join(linkDir, 'audio.wav');
  const hardlink = path.join(anexos, 'audio-hardlink.wav');
  const db = new DatabaseSync(f.dbPath);
  const referenciar = valor => db.prepare('UPDATE transcricoes SET arquivo=? WHERE origem_id=?').run(valor, 'audio-sintetico');
  try {
    referenciar(faltando);
    await assert.rejects(criarOrigemV10({
      dbPath: f.dbPath, perfil: { dono: 'Teste' },
      arquivos: [{ classe: 'transcricao', caminho: faltando }],
    }), { code: 'ANEXO_AUSENTE' });
    await mkdir(externo);
    await writeFile(path.join(externo, 'audio.wav'), wavSintetico());
    let junctionCriada = false;
    try { await symlink(externo, linkDir, process.platform === 'win32' ? 'junction' : 'dir'); junctionCriada = true; }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) t.diagnostic('Sistema sem permissão de junção; caso de link omitido');
      else throw error;
    }
    if (junctionCriada) {
      assert.equal((await lstat(linkDir)).isSymbolicLink(), true);
      referenciar(linkPath);
      await assert.rejects(criarOrigemV10({
        dbPath: f.dbPath, perfil: { dono: 'Teste' },
        arquivos: [{ classe: 'transcricao', caminho: linkPath }],
      }), { code: 'ANEXO_CAMINHO_INVALIDO' });
    }
    try { await link(caminho, hardlink); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Sistema sem permissão de hardlink; caso omitido'); return; }
      throw error;
    }
    assert.ok((await stat(hardlink)).nlink > 1, 'hardlink realmente compartilha inode');
    referenciar(hardlink);
    await assert.rejects(criarOrigemV10({
      dbPath: f.dbPath, perfil: { dono: 'Teste' },
      arquivos: [{ classe: 'transcricao', caminho: hardlink }],
    }), { code: 'ANEXO_LINK_MULTIPLO' });
  } finally { db.close(); await f.close(); }
});

test('v10 recusa arquivo listado sem referência em transcrições', async () => {
  const { f, anexos } = await fixtureAnexo();
  const semReferencia = path.join(anexos, 'outro.wav');
  try {
    await writeFile(semReferencia, wavSintetico());
    await assert.rejects(criarOrigemV10({
      dbPath: f.dbPath, perfil: { dono: 'Teste' },
      arquivos: [{ classe: 'transcricao', caminho: semReferencia }],
    }));
  } finally { await f.close(); }
});

test('v10 restaura dois WAV em um único arquivo de staging de tamanho limitado aos anexos', async () => {
  const { f, caminho, bytes, segundo } = await fixtureAnexo({ dois: true });
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'dois-audios.lumebak');
  let origem, plano;
  try {
    await mkdir(raizStaging);
    origem = await criarOrigemV10({ dbPath: f.dbPath, perfil: { dono: 'Teste' }, arquivos: [
      { classe: 'transcricao', caminho }, { classe: 'transcricao', caminho: segundo.caminho },
    ] });
    assert.equal(origem.resumo.anexos, 2);
    await gravarPacote({ origem: origem.origem, destino: pacote, senha: 'senha sintética de dois anexos' });
    plano = await validarAcervoV10({ pacote, senha: 'senha sintética de dois anexos', raizStaging });
    assert.equal(plano.resumo.anexos, 2);
    const area = path.join(raizStaging, (await readdir(raizStaging))[0]);
    const pack = path.join(area, 'anexos.pack');
    assert.equal((await stat(pack)).size, bytes.length + segundo.bytes.length, 'staging contém só bytes de anexos, sem cópias extras');
    assert.deepEqual(await readFile(pack), Buffer.concat([bytes, segundo.bytes]));
    assert.equal((await readdir(area)).filter(name => /^anexo-\d+\.bin$/.test(name)).length, 0, 'não cria um arquivo temporário por anexo');
    const db = await abrirOraculoStagingV9({ raizStaging, raizFixture: f.dir });
    try {
      assert.deepEqual(db.prepare('SELECT arquivo FROM transcricoes ORDER BY origem_id').all().map(row => row.arquivo), ['anexo:1', 'anexo:2']);
    } finally { db.close(); }
  } finally {
    if (plano) await descartarPlanoV10(plano.plano);
    await origem?.fechar();
    await f.close();
  }
});

test('v10 recusa arquivo trocado após inventário e remove pacote incompleto', async () => {
  const { f, caminho } = await fixtureAnexo();
  const destino = path.join(f.dir, 'trocado.lumebak');
  let origem;
  try {
    origem = await criarOrigemV10({ dbPath: f.dbPath, perfil: { dono: 'Teste' }, arquivos: [{ classe: 'transcricao', caminho }] });
    await rename(caminho, `${caminho}.original`);
    await writeFile(caminho, wavSintetico(29));
    await assert.rejects(gravarPacote({ origem: origem.origem, destino, senha: 'senha sintética após troca' }), { code: 'ANEXO_ALTERADO' });
    await assert.rejects(stat(destino), { code: 'ENOENT' });
  } finally { await origem?.fechar(); await f.close(); }
});

test('v10 invalida plano se anexos.pack muda em lugar com inode, tamanho e mtime preservados', async () => {
  const { f, caminho } = await fixtureAnexo();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'plano-mutado.lumebak');
  let origem, plano;
  try {
    await mkdir(raizStaging);
    origem = await criarOrigemV10({ dbPath: f.dbPath, perfil: { dono: 'Teste' }, arquivos: [{ classe: 'transcricao', caminho }] });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha: 'senha sintética plano mutado' });
    plano = await validarAcervoV10({ pacote, senha: 'senha sintética plano mutado', raizStaging });
    assert.equal((await inspecionarPlanoV10(plano.plano)).resumo.anexos, 1);
    const area = path.join(raizStaging, (await readdir(raizStaging))[0]);
    const pack = path.join(area, 'anexos.pack');
    const antes = await stat(pack, { bigint: true });
    const handle = await open(pack, 'r+');
    try {
      const primeiro = Buffer.alloc(1);
      assert.equal((await handle.read(primeiro, 0, 1, 0)).bytesRead, 1);
      primeiro[0] ^= 1;
      assert.equal((await handle.write(primeiro, 0, 1, 0)).bytesWritten, 1);
      await handle.sync();
    } finally { await handle.close(); }
    await utimes(pack, antes.atime, antes.mtime);
    const depois = await stat(pack, { bigint: true });
    assert.equal(depois.ino, antes.ino);
    assert.equal(depois.size, antes.size);
    assert.equal(depois.mtimeMs, antes.mtimeMs);
    await assert.rejects(async () => inspecionarPlanoV10(plano.plano), { code: 'PLANO_INVALIDO' });
  } finally {
    if (plano) await descartarPlanoV10(plano.plano);
    await origem?.fechar();
    await f.close();
  }
});
