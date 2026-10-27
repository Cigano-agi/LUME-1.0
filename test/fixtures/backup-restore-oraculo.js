import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function assinaturaArquivo(caminho) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const bloco of createReadStream(caminho)) { hash.update(bloco); bytes += bloco.length; }
  return { bytes, sha256: hash.digest('hex') };
}

async function identidadeCheckpoint(caminho) {
  const db = await lstat(caminho, { bigint: true });
  assert.ok(db.isFile() && !db.isSymbolicLink(), 'DB de staging regular');
  const wal = await lstat(`${caminho}-wal`, { bigint: true }).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (wal) {
    assert.ok(wal.isFile() && !wal.isSymbolicLink(), 'WAL regular');
    assert.equal(wal.size, 0n, 'cópia apenas do DB exige WAL ausente ou vazio');
  }
  return { dev: db.dev, ino: db.ino, size: db.size, mtimeNs: db.mtimeNs, ctimeNs: db.ctimeNs };
}

/** Oráculo de teste: nunca abre o DB gerido, para não recriar WAL/SHM no staging. */
export async function abrirOraculoStagingV9({ raizStaging, raizFixture }) {
  assert.notEqual(path.resolve(raizFixture), path.resolve(raizStaging), 'oráculo fora do staging');
  const nomes = await readdir(raizStaging);
  assert.equal(nomes.length, 1, 'um único plano de staging');
  const original = path.join(raizStaging, nomes[0], 'acervo.sqlite');
  const copia = path.join(raizFixture, `oraculo-${randomUUID()}.sqlite`);
  const antes = await identidadeCheckpoint(original);
  await copyFile(original, copia, constants.COPYFILE_EXCL);
  assert.deepEqual(await assinaturaArquivo(copia), await assinaturaArquivo(original), 'cópia byte-idêntica do DB checkpointado');
  assert.deepEqual(await identidadeCheckpoint(original), antes, 'DB e WAL estáveis durante a cópia');
  return new DatabaseSync(copia, { readOnly: true });
}
