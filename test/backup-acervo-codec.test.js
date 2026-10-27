import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { codificarAcervoV9, decodificarAcervoV9 } from '../src/backup-acervo-codec.js';

const H = b => createHash('sha256').update(b).digest('hex');
const empty = H(Buffer.alloc(0));
const inicio = { tipo: 'inicio', versao: 9, catalogoSha256: empty, criadoEm: '2026-09-27T00:00:00.000Z', dono: 'teste' };
const q = (cabecalho, payload = Buffer.alloc(0)) => ({ cabecalho, payload });
async function* base() {
  yield q(inicio);
  yield q({ tipo: 'tabela', indice: 0, nome: 'eventos' });
  const payload = Buffer.from('linha');
  yield q({ tipo: 'row', chave: '0001' }, payload);
  const framed = Buffer.alloc(4); framed.writeUInt32BE(payload.length);
  yield q({ tipo: 'fimTabela', linhas: 1, sha256: H(Buffer.concat([framed, payload])) });
}
async function bytes(frames) { const out = []; for await (const b of codificarAcervoV9(frames)) out.push(b); return Buffer.concat(out); }
async function* shortChunks(b, size = 3) { for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size); }

test('roundtrip com origem fragmentada, hashes e quadros únicos', async () => {
  const source = await bytes(base());
  const got = [];
  for await (const frame of decodificarAcervoV9(shortChunks(source))) got.push(frame);
  assert.deepEqual(got.map(x => x.cabecalho.tipo), ['inicio', 'tabela', 'row', 'fimTabela', 'fim']);
  assert.equal(got[2].payload.toString(), 'linha');
  assert.equal(got[4].cabecalho.sha256, H(source.subarray(0, source.length - JSON.stringify(got[4].cabecalho).length - 8)));
});

test('roundtrip v9 aceita dono vazio sem alterar o cabeçalho', async () => {
  const header = { ...inicio, dono: '' };
  const source = await bytes((async function* () { yield q(header); })());
  const got = [];
  for await (const frame of decodificarAcervoV9(shortChunks(source))) got.push(frame);
  assert.deepEqual(got.map(x => x.cabecalho.tipo), ['inicio', 'fim']);
  assert.deepEqual(got[0].cabecalho, header);
});

test('dono continua tipado e limitado; nome e chave seguem não vazios', async () => {
  const atLimit = { ...inicio, dono: '😀'.repeat(80) };
  const accepted = await bytes((async function* () { yield q(atLimit); })());
  for await (const frame of decodificarAcervoV9(shortChunks(accepted))) {
    if (frame.cabecalho.tipo === 'inicio') assert.equal(frame.cabecalho.dono, atLimit.dono);
  }
  for (const dono of [null, 'x'.repeat(81), 'x\0y']) {
    await assert.rejects(bytes((async function* () { yield q({ ...inicio, dono }); })()));
  }
  await assert.rejects(bytes((async function* () {
    yield q(inicio); yield q({ tipo: 'tabela', indice: 0, nome: '' });
  })()));
  await assert.rejects(bytes((async function* () {
    yield q(inicio); yield q({ tipo: 'tabela', indice: 0, nome: 't' });
    yield q({ tipo: 'row', chave: '' }, Buffer.from('x'));
  })()));
});

test('bytes v9 canônicos permanecem compatíveis no acervo mínimo', async () => {
  const wireFrame = header => {
    const json = Buffer.from(JSON.stringify(header));
    const size = Buffer.alloc(4); size.writeUInt32BE(json.length);
    return Buffer.concat([size, json, Buffer.alloc(4)]);
  };
  const beforeEnd = Buffer.concat([Buffer.from('LUMEAC09'), wireFrame(inicio)]);
  const end = { tipo: 'fim', tabelas: 0, linhas: 0, arquivos: 0, chunks: 0,
    bytesArquivos: 0, bytesAnteriores: beforeEnd.length, sha256: H(beforeEnd) };
  const expected = Buffer.concat([beforeEnd, wireFrame(end)]);
  const actual = await bytes((async function* () { yield q(inicio); })());
  assert.deepEqual(actual, expected);
});

test('row de 4 MiB mantém limite por Buffer e roundtrip completo', async () => {
  const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a);
  const framed = Buffer.alloc(4); framed.writeUInt32BE(payload.length);
  async function* frames() {
    yield q(inicio);
    yield q({ tipo: 'tabela', indice: 0, nome: 'eventos' });
    yield q({ tipo: 'row', chave: '0001' }, payload);
    yield q({ tipo: 'fimTabela', linhas: 1, sha256: H(Buffer.concat([framed, payload])) });
  }
  const parts = [];
  for await (const part of codificarAcervoV9(frames())) {
    assert.ok(part.length <= 4 * 1024 * 1024);
    parts.push(part);
  }
  let rows = 0;
  for await (const decoded of decodificarAcervoV9((async function* () { yield* parts; })())) {
    if (decoded.cabecalho.tipo === 'row') {
      rows++;
      assert.equal(decoded.payload.length, payload.length);
      assert.deepEqual(decoded.payload, payload);
    }
  }
  assert.equal(rows, 1);
});

test('recusa corrupção, truncagem e bytes depois do fim', async () => {
  const source = await bytes(base());
  for (const bad of [source.subarray(0, source.length - 1), Buffer.concat([source, Buffer.from([1])]),
    Buffer.from(source.map((v, i) => i === 9 ? 0xff : v))]) {
    await assert.rejects(async () => { for await (const _ of decodificarAcervoV9(shortChunks(bad))) {} });
  }
});

test('recusa length overflow, UTF-8 inválido, row alterada e buffer de origem acima do teto', async () => {
  const source = await bytes(base());
  const overflow = Buffer.from(source); overflow.writeUInt32BE(0xffffffff, 8);
  const invalidUtf8 = Buffer.from(source); invalidUtf8[12] = 0xff;
  const changedRow = Buffer.from(source); const at = changedRow.indexOf(Buffer.from('linha')); assert.ok(at > 0); changedRow[at] ^= 1;
  for (const bad of [overflow, invalidUtf8, changedRow]) {
    await assert.rejects(async () => { for await (const _ of decodificarAcervoV9(shortChunks(bad))) {} });
  }
  await assert.rejects(async () => { for await (const _ of decodificarAcervoV9((async function*(){ yield Buffer.alloc(4*1024*1024+1); })())) {} });
  await assert.rejects(async () => { for await (const _ of decodificarAcervoV9((async function*(){ yield Buffer.alloc(0); })())) {} });
});

test('recusa duplicação de chave, offset e hash de chunk', async () => {
  const digest = H(Buffer.from('ab'));
  async function* audio(offset = 0, endHash = digest) {
    yield q(inicio); yield q({tipo:'tabela',indice:0,nome:'t'});
    yield q({tipo:'row',chave:'a'},Buffer.from('x'));
    yield q({tipo:'row',chave:'a'},Buffer.from('y'));
    yield q({tipo:'fimTabela',linhas:2,sha256:empty});
    yield q({tipo:'arquivo',id:1,classe:'notetaker',bytes:2,sha256:digest,nome:'audio'});
    yield q({tipo:'chunk',id:1,indice:0,offset},Buffer.from('ab'));
    yield q({tipo:'fimArquivo',id:1,bytes:2,sha256:endHash});
  }
  await assert.rejects(async () => { for await (const _ of codificarAcervoV9(audio())) {} }, /chave/);
  async function* validAudio(offset = 0, endHash = digest) {
    yield q(inicio); yield q({tipo:'arquivo',id:1,classe:'notetaker',bytes:2,sha256:digest,nome:'audio'});
    yield q({tipo:'chunk',id:1,indice:0,offset},Buffer.from('ab'));
    yield q({tipo:'fimArquivo',id:1,bytes:2,sha256:endHash});
  }
  await assert.rejects(async () => { for await (const _ of codificarAcervoV9(validAudio(1))) {} }, /offset/);
  await assert.rejects(async () => { for await (const _ of codificarAcervoV9(validAudio(0,empty))) {} }, /hash/);
});

test('recusa campos extras, protótipo e ordem inválida', async () => {
  for (const header of [
    { ...inicio, extra: 1 },
    JSON.parse('{"tipo":"inicio","versao":9,"catalogoSha256":"' + empty + '","criadoEm":"2026-09-27T00:00:00.000Z","dono":"x","__proto__":{}}'),
  ]) await assert.rejects(async () => { for await (const _ of codificarAcervoV9((async function*(){ yield q(header); })())) {} });
  await assert.rejects(async () => { for await (const _ of codificarAcervoV9((async function*(){ yield q(inicio); yield q({tipo:'row',chave:'a'},Buffer.from('x')); })())) {} });
});

test('recusa accessors em quadro e cabeçalho sem executar getters', async () => {
  let reads = 0;
  const header = { tipo: 'row' };
  Object.defineProperty(header, 'chave', { enumerable: true, get() { reads++; return 'a'; } });
  async function* withHeaderGetter() {
    yield q(inicio);
    yield q({ tipo: 'tabela', indice: 0, nome: 't' });
    yield q(header, Buffer.from('x'));
  }
  await assert.rejects(async () => {
    for await (const _ of codificarAcervoV9(withHeaderGetter())) {}
  }, /acessor/);
  assert.equal(reads, 0);

  const frame = q(inicio);
  Object.defineProperty(frame, 'cabecalho', { enumerable: true, get() { reads++; return inicio; } });
  await assert.rejects(async () => {
    for await (const _ of codificarAcervoV9((async function* () { yield frame; })())) {}
  }, /acessor/);
  assert.equal(reads, 0);
});

test('snapshot do payload preserva hash se produtor muda Buffer entre yields', async () => {
  const payload = Buffer.from('x');
  async function* frames() {
    yield q(inicio);
    yield q({ tipo: 'tabela', indice: 0, nome: 't' });
    yield q({ tipo: 'row', chave: 'a' }, payload);
    yield q({ tipo: 'fimTabela', linhas: 1, sha256: H(Buffer.from([0, 0, 0, 1, 120])) });
  }
  const parts = []; let mutated = false;
  for await (const part of codificarAcervoV9(frames())) {
    parts.push(part);
    if (part.includes(Buffer.from('{"tipo":"row","chave":"a"}'))) { payload[0] = 121; mutated = true; }
  }
  assert.equal(mutated, true);
  const got = [];
  for await (const frame of decodificarAcervoV9(shortChunks(Buffer.concat(parts)))) got.push(frame);
  assert.equal(got.find(x => x.cabecalho.tipo === 'row').payload.toString(), 'x');
});

test('250001 rows e áudio equivalente a 2h por chunks, sem reter acervo', { timeout: 120000 }, async () => {
  const rows = 250001;
  const audioBytes = 2 * 60 * 60 * 16000 * 2; // PCM mono 16 kHz, 16-bit, 2h
  const chunkSize = 1024 * 1024;
  const audioChunk = Buffer.alloc(chunkSize, 0x5a);
  const audioHash = createHash('sha256');
  for (let at = 0; at < audioBytes; at += chunkSize) audioHash.update(audioChunk.subarray(0, Math.min(chunkSize, audioBytes - at)));
  const expectedAudio = audioHash.digest('hex');
  const row = Buffer.from('x'); const len = Buffer.from([0,0,0,1]);
  const rowHash = createHash('sha256'); for (let i=0;i<rows;i++) rowHash.update(len).update(row);
  async function* frames() {
    yield q(inicio); yield q({tipo:'tabela',indice:0,nome:'eventos'});
    for (let i=0;i<rows;i++) yield q({tipo:'row',chave:String(i).padStart(8,'0')},row);
    yield q({tipo:'fimTabela',linhas:rows,sha256:rowHash.digest('hex')});
    yield q({tipo:'arquivo',id:1,classe:'notetaker',bytes:audioBytes,sha256:expectedAudio,nome:'audio'});
    for (let at=0,idx=0;at<audioBytes;at+=chunkSize,idx++) yield q({tipo:'chunk',id:1,indice:idx,offset:at},audioChunk.subarray(0,Math.min(chunkSize,audioBytes-at)));
    yield q({tipo:'fimArquivo',id:1,bytes:audioBytes,sha256:expectedAudio});
  }
  const before = process.memoryUsage().rss; let peak=before, count=0, audio=0;
  async function* origin() { for await (const b of codificarAcervoV9(frames())) { peak=Math.max(peak,process.memoryUsage().rss); yield b; } }
  for await (const f of decodificarAcervoV9(origin())) {
    peak=Math.max(peak,process.memoryUsage().rss);
    if(f.cabecalho.tipo==='row') { count++; assert.equal(f.payload[0],120); }
    if(f.cabecalho.tipo==='chunk') { audio+=f.payload.length; assert.equal(f.payload[0],0x5a); }
  }
  assert.equal(count, rows); assert.equal(audio,audioBytes);
  console.log(`RSS local: inicial ${(before/1048576).toFixed(1)} MiB; pico ${(peak/1048576).toFixed(1)} MiB; adicional ${((peak-before)/1048576).toFixed(1)} MiB`);
  assert.ok(peak-before < 512*1024*1024, `RSS adicional ${(peak-before)/1048576} MiB`);
});

test('cancelamento fecha origem', async () => {
  const source = await bytes(base()); const controller = new AbortController(); let closed=false;
  async function* origin() { try { for await (const b of shortChunks(source,1)) yield b; } finally { closed=true; } }
  await assert.rejects(async () => { for await (const _ of decodificarAcervoV9(origin(),{signal:controller.signal})) controller.abort(); }, /abort|cancel/i);
  assert.equal(closed,true);
  await assert.rejects(async () => { for await (const _ of codificarAcervoV9(base(), {signal:controller.signal})) {} }, /abort|cancel/i);
});
