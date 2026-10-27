import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { criarOrigemV10 } from '../src/backup-acervo-v10.js';
import { gravarPacote } from '../src/backup-stream.js';
import { validarAcervoV10, aplicarAcervoV10, inspecionarPlanoV10 } from '../src/backup-acervo-restore-v9.js';
import { publicarAcervoV10, recuperarAplicacaoV10 } from '../src/backup-acervo-apply-v10.js';
import { selecionarPerfilBoot } from '../src/perfil-boot.js';

const senha = 'senha sintética para publicar perfil v10';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const f = await criarPerfilRealSintetico();
  const anexos = path.join(f.dir, 'anexos');
  const staging = path.join(f.dir, 'staging');
  const destino = path.join(f.dir, 'perfil-novo');
  await Promise.all([mkdir(anexos), mkdir(staging)]);
  const audio = path.join(anexos, 'audio-123e4567-e89b-42d3-a456-426614174000.wav');
  const bytes = Buffer.alloc(364);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(320, 40);
  await writeFile(audio, bytes);
  f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
    VALUES('conversa','audio-1','entrada','audio','{}','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run();
  f.db.prepare(`INSERT INTO transcricoes(conversa_id,origem_id,arquivo,estado,criado_em)
    VALUES('conversa','audio-1',?,'vazio','2026-09-28T10:00:00.000Z')`).run(audio);
  f.db.close();
  const origem = await criarOrigemV10({ dbPath: f.dbPath, perfil: { dono: 'Dono' },
    arquivos: [{ classe: 'transcricao', caminho: audio }] });
  const pacote = path.join(f.dir, 'backup.lumebak');
  try { await gravarPacote({ origem: origem.origem, destino: pacote, senha }); }
  finally { await origem.fechar(); }
  return { f, staging, destino, pacote, bytes };
}

test('v10 aplica banco e áudio em perfil novo; não transfere autorização', async () => {
  const x = await fixture();
  try {
    const { plano } = await validarAcervoV10({ pacote: x.pacote, senha, raizStaging: x.staging });
    await assert.rejects(aplicarAcervoV10({ plano, destinoNovo: x.destino, confirmarMeuBackup: false }),
      { code: 'CONFIRMACAO_OBRIGATORIA' });
    const applying = aplicarAcervoV10({ plano, destinoNovo: x.destino, confirmarMeuBackup: true });
    await assert.rejects(aplicarAcervoV10({ plano, destinoNovo: x.destino, confirmarMeuBackup: true }),
      { code: 'PLANO_INVALIDO' });
    const receipt = await applying;
    assert.equal(receipt.versao, 10);
    const db = new DatabaseSync(path.join(x.destino, 'data', 'assessor.db'), { readOnly: true });
    let audio;
    try {
      audio = db.prepare("SELECT arquivo FROM transcricoes WHERE origem_id='audio-1'").get().arquivo;
      assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 1);
      assert.equal(db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get().valor, '1');
    } finally { db.close(); }
    assert.equal(sha(await readFile(audio)), sha(x.bytes));
    assert.equal(path.dirname(audio), path.join(x.destino, 'data', 'anexos'));
    assert.deepEqual(await readdir(x.staging), []);
    await assert.rejects(inspecionarPlanoV10(plano), { code: 'PLANO_INVALIDO' });
    // Simula queda depois do rename e antes da remoção do journal.
    const nome = path.basename(audio);
    const recoveryId = randomUUID();
    await writeFile(x.destino + '.lume-v10-reserva', JSON.stringify({ schema: 1, id: recoveryId, destino: path.basename(x.destino) }));
    const recoveryJournal = {
      schema: 1, id: recoveryId, phase: 'ready',
      candidate: 'data-pendente-' + randomUUID().replaceAll('-', ''),
      dbSha256: sha(await readFile(path.join(x.destino, 'data', 'assessor.db'))),
      anexos: [{ id: 1, nome, sha256: sha(x.bytes) }],
    };
    await writeFile(path.join(x.destino, 'perfil-publicacao.json'), JSON.stringify(recoveryJournal));
    await assert.rejects(selecionarPerfilBoot(x.destino), { code: 'PERFIL_RECUPERACAO_PENDENTE' });
    assert.equal((await recuperarAplicacaoV10({ destinoNovo: x.destino, publicadorEncerrado: true })).estado, 'publicada');
    assert.equal((await selecionarPerfilBoot(x.destino)).tipo, 'legado');
    assert.deepEqual((await readdir(x.destino)).sort(), ['data']);
    // Simula queda entre remover a reserva e remover o journal.
    await writeFile(path.join(x.destino, 'perfil-publicacao.json'), JSON.stringify(recoveryJournal));
    await assert.rejects(selecionarPerfilBoot(x.destino), { code: 'PERFIL_RECUPERACAO_PENDENTE' });
    assert.equal((await recuperarAplicacaoV10({ destinoNovo: x.destino, publicadorEncerrado: true })).estado, 'publicada');
    assert.equal((await selecionarPerfilBoot(x.destino)).tipo, 'legado');
  } finally { await x.f.close(); }
});

test('v10 reverte publicação interrompida durante a cópia e libera boot vazio', async () => {
  const f = await criarPerfilRealSintetico();
  try {
    const root = path.join(f.dir, 'perfil-interrompido');
    const candidate = 'data-pendente-' + randomUUID().replaceAll('-', '');
    const id = randomUUID();
    await mkdir(path.join(root, candidate, 'anexos'), { recursive: true });
    await writeFile(path.join(root, candidate, 'assessor.db'), 'cópia parcial');
    await writeFile(root + '.lume-v10-reserva', JSON.stringify({ schema: 1, id, destino: path.basename(root) }));
    await writeFile(path.join(root, 'perfil-publicacao.json'), JSON.stringify({
      schema: 1, id, phase: 'building', candidate,
    }));
    await writeFile(path.join(root, 'perfil-publicacao.next'), 'parcial');
    await assert.rejects(recuperarAplicacaoV10({ destinoNovo: root }), { code: 'PERFIL_RECUPERACAO_PENDENTE' });
    assert.equal((await recuperarAplicacaoV10({ destinoNovo: root, publicadorEncerrado: true })).estado, 'revertida');
    assert.equal((await recuperarAplicacaoV10({ destinoNovo: root })).estado, 'sem-pendencia');
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    await assert.rejects(lstat(root + '.lume-v10-reserva'), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('v10 reverte queda antes do journal e rejeita mais anexos que cabem no manifesto', async () => {
  const f = await criarPerfilRealSintetico();
  try {
    const root = path.join(f.dir, 'perfil-sem-journal');
    const id = randomUUID();
    await writeFile(root + '.lume-v10-reserva', JSON.stringify({ schema: 1, id, destino: path.basename(root) }));
    await mkdir(root);
    await assert.rejects(selecionarPerfilBoot(root), { code: 'PERFIL_RECUPERACAO_PENDENTE' });
    assert.equal((await recuperarAplicacaoV10({ destinoNovo: root, publicadorEncerrado: true })).estado, 'revertida');
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    await assert.rejects(lstat(root + '.lume-v10-reserva'), { code: 'ENOENT' });
    const excessive = { fileMetas: Array(100001).fill(null) };
    await assert.rejects(publicarAcervoV10({ destinoNovo: root, state: excessive }), { code: 'ANEXO_LIMITE' });
    await assert.rejects(lstat(root), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('v10 recusa publicar em perfil ocupado e preserva seus dados', async () => {
  const x = await fixture();
  try {
    await mkdir(path.join(x.destino, 'data'), { recursive: true });
    await writeFile(path.join(x.destino, 'data', 'marcador.txt'), 'preservar');
    const { plano } = await validarAcervoV10({ pacote: x.pacote, senha, raizStaging: x.staging });
    await assert.rejects(aplicarAcervoV10({ plano, destinoNovo: x.destino, confirmarMeuBackup: true }),
      { code: 'PERFIL_OCUPADO' });
    assert.equal((await readFile(path.join(x.destino, 'data', 'marcador.txt'), 'utf8')), 'preservar');
  } finally { await x.f.close(); }
});
