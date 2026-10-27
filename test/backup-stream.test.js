import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gravarPacote, verificarPacote } from '../src/backup-stream.js';

const SENHA = 'senha sintética só para teste';

async function comPasta(fn) {
  const pasta = await mkdtemp(path.join(tmpdir(), 'lume-stream-test-'));
  try { await fn(pasta); } finally { await rm(pasta, { recursive: true, force: true }); }
}

async function* blocos(...itens) { for (const item of itens) yield Buffer.from(item); }

test('ida e volta vazia e múltiplas partes autenticadas', async () => comPasta(async pasta => {
  const pacote = path.join(pasta, 'dados.lume');
  await gravarPacote({ origem: blocos('abc', 'def'), destino: pacote, senha: SENHA });
  const resultado = await verificarPacote({ pacote, pastaStaging: pasta, senha: SENHA });
  assert.equal((await readFile(resultado.caminhoStaging)).toString(), 'abcdef');
  assert.equal(resultado.partes, 1);
  assert.equal(resultado.bytes, 6);
  assert.equal(resultado.sha256, createHash('sha256').update('abcdef').digest('hex'));
  const vazio = path.join(pasta, 'vazio.lume');
  await gravarPacote({ origem: blocos(), destino: vazio, senha: SENHA });
  const v = await verificarPacote({ pacote: vazio, pastaStaging: pasta, senha: SENHA });
  assert.equal((await stat(v.caminhoStaging)).size, 0);
}));

test('senha errada e adulterações nunca devolvem staging', async () => comPasta(async pasta => {
  const original = path.join(pasta, 'original.lume');
  await gravarPacote({ origem: blocos('primeiro', 'segundo'), destino: original, senha: SENHA });
  await assert.rejects(verificarPacote({ pacote: original, pastaStaging: pasta, senha: 'incorreta' }));
  const bytes = await readFile(original);
  const variantes = [
    ['header', 40], ['parte', 82], ['tag', 90], ['final', bytes.length - 1]
  ];
  for (const [nome, indice] of variantes) {
    const alterado = Buffer.from(bytes); alterado[indice] ^= 1;
    const arquivo = path.join(pasta, `${nome}.lume`);
    await writeFile(arquivo, alterado);
    await assert.rejects(verificarPacote({ pacote: arquivo, pastaStaging: pasta, senha: SENHA }), nome);
  }
  for (const corte of [0, 1, 72, bytes.length - 1]) {
    const arquivo = path.join(pasta, `corte-${corte}.lume`);
    await writeFile(arquivo, bytes.subarray(0, corte));
    await assert.rejects(verificarPacote({ pacote: arquivo, pastaStaging: pasta, senha: SENHA }));
  }
  assert.deepEqual((await readdir(pasta)).filter(n => n.startsWith('.lume-stream-')), []);
}));

test('reorder, duplicação, troca entre pacotes e bytes extras são rejeitados', async () => comPasta(async pasta => {
  const a = path.join(pasta, 'a.lume'); const b = path.join(pasta, 'b.lume');
  await gravarPacote({ origem: blocos(Buffer.alloc(1024 * 1024, 1), Buffer.from('bbbb')), destino: a, senha: SENHA });
  await gravarPacote({ origem: blocos(Buffer.alloc(1024 * 1024, 2), Buffer.from('dddd')), destino: b, senha: SENHA });
  const ba = await readFile(a); const bb = await readFile(b);
  const p1 = ba.subarray(72, 72 + 9 + 1024 * 1024 + 16);
  const p2 = ba.subarray(72 + p1.length, 72 + p1.length + 9 + 4 + 16);
  const final = ba.subarray(72 + p1.length + p2.length);
  const casos = [
    Buffer.concat([ba.subarray(0, 72), p2, p1, final]),
    Buffer.concat([ba.subarray(0, 72), p1, p1, final]),
    Buffer.concat([ba.subarray(0, 72), bb.subarray(72, 72 + p1.length), p2, final]),
    Buffer.concat([ba, Buffer.from('extra')])
  ];
  for (let i = 0; i < casos.length; i++) {
    const arquivo = path.join(pasta, `replay-${i}.lume`);
    await writeFile(arquivo, casos[i]);
    await assert.rejects(verificarPacote({ pacote: arquivo, pastaStaging: pasta, senha: SENHA }));
  }
}));

test('destino ocupado, link e cancelamento preservam objetos alheios', async () => comPasta(async pasta => {
  const ocupado = path.join(pasta, 'ocupado');
  await writeFile(ocupado, 'intacto');
  await assert.rejects(gravarPacote({ origem: blocos('x'), destino: ocupado, senha: SENHA }));
  assert.equal((await readFile(ocupado)).toString(), 'intacto');
  const link = path.join(pasta, 'link');
  try {
    await symlink(ocupado, link);
    await assert.rejects(gravarPacote({ origem: blocos('x'), destino: link, senha: SENHA }));
    await assert.rejects(verificarPacote({ pacote: link, pastaStaging: pasta, senha: SENHA }));
  } catch (erro) { if (erro.code !== 'EPERM') throw erro; }
  const ac = new AbortController(); ac.abort();
  const cancelado = path.join(pasta, 'cancelado');
  await assert.rejects(gravarPacote({ origem: blocos('x'), destino: cancelado, senha: SENHA, signal: ac.signal }));
  await assert.rejects(stat(cancelado));
  const falha = path.join(pasta, 'falha');
  async function* origemComErro() { yield Buffer.from('parcial'); throw new Error('falha sintética'); }
  await assert.rejects(gravarPacote({ origem: origemComErro(), destino: falha, senha: SENHA }), /falha sintética/);
  await assert.rejects(stat(falha));
  const grande = path.join(pasta, 'entrada-grande');
  await assert.rejects(gravarPacote({ origem: blocos(Buffer.alloc(4 * 1024 * 1024 + 1)), destino: grande, senha: SENHA }), /4 MiB/);
  await assert.rejects(stat(grande));
  const senhaCurta = path.join(pasta, 'senha-curta');
  await assert.rejects(gravarPacote({ origem: blocos('x'), destino: senhaCurta, senha: 'curta' }), /12 a 256/);
  await assert.rejects(stat(senhaCurta));
}));

test('cancelamento durante leitura remove apenas staging criado', async () => comPasta(async pasta => {
  const pacote = path.join(pasta, 'cancelar-leitura.lume');
  const guardado = path.join(pasta, 'guardado');
  await writeFile(guardado, 'intacto');
  const bloco = Buffer.alloc(1024 * 1024, 5);
  async function* origem() { for (let i = 0; i < 24; i++) yield bloco; }
  await gravarPacote({ origem: origem(), destino: pacote, senha: SENHA });
  const ac = new AbortController();
  const timer = setInterval(async () => {
    if ((await readdir(pasta)).some(n => n.startsWith('.lume-stream-'))) ac.abort();
  }, 2);
  try {
    await assert.rejects(verificarPacote({ pacote, pastaStaging: pasta, senha: SENHA, signal: ac.signal }));
  } finally { clearInterval(timer); }
  assert.deepEqual((await readdir(pasta)).filter(n => n.startsWith('.lume-stream-')), []);
  assert.equal((await readFile(guardado)).toString(), 'intacto');
}));

test('limites de parte e formato são aplicados', async () => comPasta(async pasta => {
  const pacote = path.join(pasta, 'limites.lume');
  await gravarPacote({ origem: blocos(Buffer.alloc(1024 * 1024 + 1, 7)), destino: pacote, senha: SENHA });
  const ok = await verificarPacote({ pacote, pastaStaging: pasta, senha: SENHA });
  assert.equal(ok.partes, 2);
  const bytes = await readFile(pacote);
  for (const [nome, pos, valor] of [['versao', 8, 99], ['tamanho', 13, 0], ['kdf', 58, 0], ['nonce', 48, bytes[48] ^ 1], ['salt', 16, bytes[16] ^ 1], ['parte-grande', 77, 0xff]]) {
    const mudado = Buffer.from(bytes); mudado[pos] = valor;
    const arquivo = path.join(pasta, `${nome}.lume`);
    await writeFile(arquivo, mudado);
    await assert.rejects(verificarPacote({ pacote: arquivo, pastaStaging: pasta, senha: SENHA }), nome);
  }
}));

test('senha conta pontos Unicode e respeita limites sem normalização', async () => comPasta(async pasta => {
  for (const [id, senha] of [['ascii11', 'a'.repeat(11)], ['ascii257', 'a'.repeat(257)], ['astral6', '🔒'.repeat(6)], ['astral11', '🔒'.repeat(11)], ['astral257', '🔒'.repeat(257)], ['surrogate', '\uD800'.repeat(12)]]) {
    const destino = path.join(pasta, id);
    await assert.rejects(gravarPacote({ origem: blocos('x'), destino, senha }), /12 a 256/);
    await assert.rejects(stat(destino), { code: 'ENOENT' });
  }
  for (const [id, senha] of [['ascii12', 'a'.repeat(12)], ['ascii256', 'a'.repeat(256)], ['astral12', '🔒'.repeat(12)], ['astral256', '🔒'.repeat(256)]]) {
    const pacote = path.join(pasta, id);
    await gravarPacote({ origem: blocos('x'), destino: pacote, senha });
    const resultado = await verificarPacote({ pacote, pastaStaging: pasta, senha });
    assert.equal((await readFile(resultado.caminhoStaging)).toString(), 'x');
  }
}));

test('fluxo sintético acima de 64 MiB permanece incremental', async t => comPasta(async pasta => {
  const pacote = path.join(pasta, 'grande.lume');
  const bloco = Buffer.alloc(1024 * 1024, 0x5a);
  const antes = process.memoryUsage().rss;
  let pico = antes;
  const monitor = setInterval(() => { pico = Math.max(pico, process.memoryUsage().rss); }, 5);
  async function* origem() { for (let i = 0; i < 65; i++) yield bloco; }
  try {
    await gravarPacote({ origem: origem(), destino: pacote, senha: SENHA });
    const r = await verificarPacote({ pacote, pastaStaging: pasta, senha: SENHA });
    assert.equal(r.bytes, 65 * 1024 * 1024);
    assert.equal(r.partes, 65);
  } finally { clearInterval(monitor); }
  t.diagnostic(`RSS pico incremental: ${Math.round((pico - antes) / 1048576)} MiB`);
  assert.ok(pico - antes < 160 * 1024 * 1024);
}));
