import { createHash } from 'node:crypto';
import { codificarAcervoV9 } from '../src/backup-acervo-codec.js';

// Sintético, determinístico e pequeno o suficiente para comparar revisões.
const rows = 25000;
const payload = Buffer.from('x');
const length = Buffer.from([0, 0, 0, 1]);
const rowHash = createHash('sha256');
for (let i = 0; i < rows; i++) rowHash.update(length).update(payload);
const frame = (cabecalho, bytes = Buffer.alloc(0)) => ({ cabecalho, payload: bytes });
async function* frames() {
  yield frame({ tipo: 'inicio', versao: 9, catalogoSha256: '0'.repeat(64), criadoEm: '2026-09-27T00:00:00.000Z', dono: '' });
  yield frame({ tipo: 'tabela', indice: 0, nome: 'eventos' });
  for (let i = 0; i < rows; i++) yield frame({ tipo: 'row', chave: String(i).padStart(10, '0') }, payload);
  yield frame({ tipo: 'fimTabela', linhas: rows, sha256: rowHash.digest('hex') });
}
const before = process.memoryUsage().rss;
const wall = process.hrtime.bigint();
const cpu = process.cpuUsage();
const hash = createHash('sha256');
let buffers = 0;
let bytes = 0;
for await (const part of codificarAcervoV9(frames())) {
  hash.update(part);
  buffers++;
  bytes += part.length;
}
const used = process.cpuUsage(cpu);
console.log(JSON.stringify({ rows, buffers, bytes, sha256: hash.digest('hex'),
  wallSeconds: Number(process.hrtime.bigint() - wall) / 1e9,
  cpuSeconds: (used.user + used.system) / 1e6,
  rssDeltaMiB: (process.memoryUsage().rss - before) / 1048576 }));
