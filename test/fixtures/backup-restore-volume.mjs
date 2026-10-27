import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { criarPerfilRealSintetico } from './backup-schema-real.js';
import { criarOrigemV9 } from '../../src/backup-acervo-v9.js';
import { gravarPacote } from '../../src/backup-stream.js';
import { validarAcervoV9, descartarPlanoV9 } from '../../src/backup-acervo-restore-v9.js';

const senha = 'senha sintética do teste';
const phases = {};
let step = performance.now();
function mark(name) { phases[name] = Math.round(performance.now() - step); step = performance.now(); }

const f = await criarPerfilRealSintetico();
const raizStaging = path.join(f.dir, 'staging');
const pacote = path.join(f.dir, 'volume.lumebak');
let plano;
try {
  const insert = f.db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,'c',?,'entrada','texto',?,?,'2026-09-27T12:00:00.000Z','2026-09-27','minha')`);
  f.db.exec('BEGIN');
  for (let i = 1; i <= 250001; i++) insert.run(BigInt(i), `origem-${i}`, `bruto ${i}`, `texto ${i}`);
  f.db.exec('COMMIT'); f.db.close();
  await mkdir(raizStaging);
  mark('construcao');
  const baseline = process.memoryUsage().rss; let peak = baseline;
  const source = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Volume sintético' } });
  async function* measured() { for await (const block of source.origem) { peak = Math.max(peak, process.memoryUsage().rss); yield block; } }
  await gravarPacote({ origem: measured(), destino: pacote, senha });
  mark('origem_mais_aead');
  const monitor = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  let result;
  try { result = await validarAcervoV9({ pacote, senha, raizStaging }); plano = result.plano; }
  finally { clearInterval(monitor); peak = Math.max(peak, process.memoryUsage().rss); }
  mark('restore_staging');
  assert.equal(result.resumo.linhas, 250001);
  const work = (await readdir(raizStaging))[0];
  const db = new DatabaseSync(path.join(raizStaging, work, 'acervo.sqlite'), { readOnly: true });
  const original = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 250001);
    const sql = 'SELECT id,conversa_id,origem_id,bruto,texto,permissao FROM eventos ORDER BY id';
    const digest = handle => {
      const h = createHash('sha256');
      for (const r of handle.prepare(sql).iterate()) h.update(JSON.stringify([r.id, r.conversa_id, r.origem_id, r.bruto, r.texto, r.permissao]));
      return h.digest('hex');
    };
    assert.equal(digest(db), digest(original));
    assert.deepEqual({ ...db.prepare('SELECT typeof(id) id,typeof(bruto) bruto,typeof(texto) texto FROM eventos WHERE id=250001').get() },
      { id: 'integer', bruto: 'text', texto: 'text' });
  } finally { db.close(); original.close(); }
  peak = Math.max(peak, process.memoryUsage().rss);
  assert.ok(peak - baseline <= 512 * 1024 * 1024, `RSS adicional ${Math.round((peak - baseline) / 1048576)} MiB`);
  mark('asserts_paridade');
  console.log(JSON.stringify({ status: 'ok', rows: result.resumo.linhas, rssAdditionalMiB: Math.round((peak - baseline) / 1048576), phases }));
} finally {
  if (plano) await descartarPlanoV9(plano);
  await f.close();
}
