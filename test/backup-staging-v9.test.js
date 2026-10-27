import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { criarAreaStagingV9, registrarObjetoStagingV9, limparAreaStagingV9, recuperarAreasStagingV9 } from '../src/backup-staging-v9.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'lume-stage-test-'));
  assert.equal(path.isAbsolute(base), true);
  assert.equal(path.dirname(base), path.resolve(tmpdir()));
  assert.match(path.basename(base), /^lume-stage-test-/);
  t.after(async () => {
    // Exclusivamente o diretório temporário criado neste teste.
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    await rm(base, { recursive: true, force: true });
  });
  return base;
}

test('cria e registra antes de escrita, limpa e repete sem perder inventário', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const caminho = await area.criarArquivo('acervo.sqlite');
  const handle = await registrarObjetoStagingV9(area, caminho);
  await handle.writeFile('somente fixture sintética');
  await handle.close();
  const primeiro = await limparAreaStagingV9(area);
  assert.equal(primeiro.limpezaPendente, false);
  assert.equal(primeiro.objetosRemovidos, 1);
  const segundo = await recuperarAreasStagingV9({ raizStaging: raiz });
  assert.equal(segundo.limpezaPendente, false);
  assert.deepEqual(await readdir(raiz), []);
});

test('filho encerra sem finally; pai recupera inventário e plaintext sintético', async t => {
  const raiz = await fixture(t);
  const modulo = new URL('../src/backup-staging-v9.js', import.meta.url).href;
  const script = `import { criarAreaStagingV9, registrarObjetoStagingV9 } from ${JSON.stringify(modulo)};
const area = await criarAreaStagingV9({ raizStaging: process.argv[1] });
const caminho = await area.criarArquivo('acervo.sqlite');
const handle = await registrarObjetoStagingV9(area, caminho);
await handle.writeFile('fixture sintética de processo encerrado');
await handle.sync();
process.exit(0);`;
  const filho = spawnSync(process.execPath, ['--input-type=module', '-e', script, raiz], { windowsHide: true, timeout: 15000 });
  assert.equal(filho.status, 0, `filho falhou: ${filho.status}`);
  const recibo = await recuperarAreasStagingV9({ raizStaging: raiz });
  assert.equal(recibo.areasLimpas, 1);
  assert.equal(recibo.limpezaPendente, false);
  assert.deepEqual(await readdir(raiz), []);
});

test('substituição e arquivo extra são preservados e geram pendência', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const caminho = await area.criarArquivo('acervo.sqlite');
  const handle = await registrarObjetoStagingV9(area, caminho);
  await handle.close();
  await rename(caminho, `${caminho}.antigo`);
  await writeFile(caminho, 'objeto substituído');
  const recibo = await limparAreaStagingV9(area);
  assert.equal(recibo.limpezaPendente, true);
  assert.equal(await readFile(caminho, 'utf8'), 'objeto substituído');
  assert.equal(await readFile(`${caminho}.antigo`, 'utf8'), '');
});

test('manifestos truncado, falso e grande não autorizam remoção', async t => {
  for (const texto of ['{', '{}', 'x'.repeat(65537)]) {
    const raiz = await fixture(t);
    const area = await criarAreaStagingV9({ raizStaging: raiz });
    await writeFile(path.join(area.caminho, 'manifesto.json'), texto);
    const recibo = await recuperarAreasStagingV9({ raizStaging: raiz });
    assert.equal(recibo.limpezaPendente, true);
    assert.equal(await readFile(path.join(area.caminho, 'manifesto.json'), 'utf8'), texto);
  }
});

test('allowlist, fora da área e links são recusados', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  await assert.rejects(area.criarArquivo('qualquer.txt'));
  await assert.rejects(area.criarArquivo('../acervo.sqlite'));
  await assert.rejects(registrarObjetoStagingV9(area, path.join(raiz, 'acervo.sqlite')));
  const destino = path.join(raiz, 'destino');
  await mkdir(destino);
  const link = path.join(raiz, 'link');
  try { await symlink(destino, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (erro) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(erro.code)) return; throw erro; }
  await assert.rejects(criarAreaStagingV9({ raizStaging: link }));
});

test('falha de limpeza conserva manifesto e permite retry', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const caminho = await area.criarArquivo('acervo.sqlite');
  const handle = await registrarObjetoStagingV9(area, caminho);
  await handle.close();
  const extra = path.join(area.caminho, 'extra');
  await writeFile(extra, 'fixture sintética');
  const bloqueado = await limparAreaStagingV9(area);
  assert.equal(bloqueado.limpezaPendente, true);
  assert.equal((await stat(path.join(area.caminho, 'manifesto.json'))).isFile(), true);
  await rm(extra);
  const final = await limparAreaStagingV9(area);
  assert.equal(final.limpezaPendente, false);
  assert.deepEqual(await readdir(raiz), []);
});

test('stream registra pasta antes do conteúdo e persiste dev/ino BigInt sem arredondar', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const pasta = await area.criarPastaStream();
  await registrarObjetoStagingV9(area, pasta);
  const caminho = await area.criarArquivo('conteudo.bin', pasta);
  const handle = await registrarObjetoStagingV9(area, caminho);
  const st = await stat(caminho, { bigint: true });
  const records = (await readFile(path.join(area.caminho, 'manifesto.json'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const content = records.find(o => o.name?.endsWith('/conteudo.bin'));
  assert.equal(content.ino, st.ino.toString());
  assert.equal(content.dev, st.dev.toString());
  await handle.writeFile('fixture sintética');
  await handle.close();
  const r = await limparAreaStagingV9(area);
  assert.equal(r.objetosRemovidos, 2);
  assert.equal(r.limpezaPendente, false);
});

test('hardlink não exclusivo e pasta de área substituída são recusados', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const caminho = await area.criarArquivo('acervo.sqlite');
  const handle = await registrarObjetoStagingV9(area, caminho);
  await handle.close();
  const extra = path.join(raiz, 'hardlink-fixture');
  await link(caminho, extra);
  const bloqueado = await limparAreaStagingV9(area);
  assert.equal(bloqueado.limpezaPendente, true);
  assert.equal((await stat(caminho)).isFile(), true);
  await rm(extra);
  const concluido = await limparAreaStagingV9(area);
  assert.equal(concluido.limpezaPendente, false);

  const segunda = await criarAreaStagingV9({ raizStaging: raiz });
  const movida = `${segunda.caminho}-movida`;
  await rename(segunda.caminho, movida);
  try { await symlink(movida, segunda.caminho, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (erro) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(erro.code)) return; throw erro; }
  const recibo = await limparAreaStagingV9(segunda);
  assert.equal(recibo.limpezaPendente, true);
  assert.equal((await stat(path.join(movida, 'manifesto.json'))).isFile(), true);
});

test('área antiga sem manifesto permanece intacta', async t => {
  const raiz = await fixture(t);
  const antiga = await mkdtemp(path.join(raiz, '.lume-restore-'));
  await writeFile(path.join(antiga, 'acervo.sqlite'), 'fixture sintética');
  const recibo = await recuperarAreasStagingV9({ raizStaging: raiz });
  assert.equal(recibo.limpezaPendente, true);
  assert.equal(await readFile(path.join(antiga, 'acervo.sqlite'), 'utf8'), 'fixture sintética');
});

test('junction no caminho intermediário do stream impede registrar plaintext', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const pasta = await area.criarPastaStream();
  await registrarObjetoStagingV9(area, pasta);
  const movida = `${pasta}-movida`;
  await rename(pasta, movida);
  try { await symlink(movida, pasta, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (erro) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(erro.code)) return; throw erro; }
  await assert.rejects(area.criarArquivo('conteudo.bin', pasta), { code: 'CAMINHO_INVALIDO' });
  assert.equal((await readdir(movida)).length, 0);
});

test('RED P1: recovery preserva área do mesmo processo e handle ativo', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const caminho = await area.criarArquivo('acervo.sqlite');
  const handle = await registrarObjetoStagingV9(area, caminho);
  await handle.writeFile('fixture ativa');
  const r = await recuperarAreasStagingV9({ raizStaging: raiz });
  assert.equal(r.limpezaPendente, true);
  assert.equal(await readFile(caminho, 'utf8'), 'fixture ativa');
  await handle.close();
});

test('RED P2: fachada não permite redirecionar capacidade', async t => {
  const raiz = await fixture(t);
  const a = await criarAreaStagingV9({ raizStaging: raiz });
  const b = await criarAreaStagingV9({ raizStaging: raiz });
  const caminho = await b.criarArquivo('acervo.sqlite');
  const h = await registrarObjetoStagingV9(b, caminho);
  await h.close();
  assert.equal(Object.isFrozen(a), true);
  assert.throws(() => { a.caminho = b.caminho; }, TypeError);
  assert.throws(() => { a.areaStat = {}; }, TypeError);
  const r = await limparAreaStagingV9(a);
  assert.equal(r.limpezaPendente, false);
  assert.equal((await stat(caminho)).isFile(), true);
});

test('RED P2: diário append-only recupera registros anteriores após cauda interrompida', async t => {
  const raiz = await fixture(t);
  const modulo = new URL('../src/backup-staging-v9.js', import.meta.url).href;
  const script = `import { open } from 'node:fs/promises';
import { criarAreaStagingV9, registrarObjetoStagingV9 } from ${JSON.stringify(modulo)};
const area = await criarAreaStagingV9({ raizStaging: process.argv[1] });
let caminho = await area.criarArquivo('acervo.sqlite');
let h = await registrarObjetoStagingV9(area, caminho);
await h.writeFile('fixture anterior'); await h.close();
caminho = await area.criarArquivo('acervo.sqlite-wal');
const probe = await open(caminho, 'r');
const proto = Object.getPrototypeOf(probe); const original = proto.write;
await probe.close();
proto.write = async function(buffer, offset, length) {
  await original.call(this, buffer, offset, Math.max(1, Math.floor(length / 2)));
  process.exit(0);
};
await registrarObjetoStagingV9(area, caminho);
process.exit(2);`;
  const filho = spawnSync(process.execPath, ['--input-type=module', '-e', script, raiz], { windowsHide: true, timeout: 15000 });
  assert.equal(filho.status, 0, `filho falhou: ${filho.status}`);
  const [pasta] = await readdir(raiz);
  const primeiro = path.join(raiz, pasta, 'acervo.sqlite');
  const segundo = path.join(raiz, pasta, 'acervo.sqlite-wal');
  const r = await recuperarAreasStagingV9({ raizStaging: raiz });
  assert.equal(r.limpezaPendente, true);
  await assert.rejects(stat(primeiro), { code: 'ENOENT' });
  assert.equal((await stat(segundo)).isFile(), true);
  assert.equal((await stat(path.join(raiz, pasta, 'manifesto.json'))).isFile(), true);
});

test('filho vivo é preservado; após morte real, dois recoveries concorrentes limpam uma vez', async t => {
  const raiz = await fixture(t);
  const modulo = new URL('../src/backup-staging-v9.js', import.meta.url).href;
  const script = `import { criarAreaStagingV9, registrarObjetoStagingV9 } from ${JSON.stringify(modulo)};
const area = await criarAreaStagingV9({ raizStaging: process.argv[1] });
const caminho = await area.criarArquivo('acervo.sqlite');
const h = await registrarObjetoStagingV9(area, caminho);
await h.writeFile('fixture de filho vivo'); await h.sync();
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);`;
  const filho = spawn(process.execPath, ['--input-type=module', '-e', script, raiz], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (filho.exitCode === null) filho.kill(); });
  const [ready] = await Promise.race([
    once(filho.stdout, 'data'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('filho sem READY')), 15000)),
  ]);
  assert.match(String(ready), /READY/);
  const [nome] = await readdir(raiz);
  const arquivo = path.join(raiz, nome, 'acervo.sqlite');
  const ativo = await recuperarAreasStagingV9({ raizStaging: raiz });
  assert.equal(ativo.limpezaPendente, true);
  assert.ok(ativo.codigos.includes('AREA_EM_USO'));
  assert.equal(await readFile(arquivo, 'utf8'), 'fixture de filho vivo');
  const saiu = once(filho, 'exit'); filho.kill(); await saiu;
  const [a, b] = await Promise.all([
    recuperarAreasStagingV9({ raizStaging: raiz }),
    recuperarAreasStagingV9({ raizStaging: raiz }),
  ]);
  assert.equal(a.objetosRemovidos + b.objetosRemovidos, 1);
  assert.deepEqual(await readdir(raiz), []);
});

test('limpeza local recusa handle entregue ainda aberto', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const caminho = await area.criarArquivo('acervo.sqlite');
  const h = await registrarObjetoStagingV9(area, caminho);
  await h.writeFile('fixture aberta');
  const r = await limparAreaStagingV9(area);
  assert.equal(r.limpezaPendente, true);
  assert.ok(r.codigos.includes('HANDLE_ABERTO'));
  assert.equal(await readFile(caminho, 'utf8'), 'fixture aberta');
  await h.close();
  assert.equal((await limparAreaStagingV9(area)).limpezaPendente, false);
});

test('registro completo com checksum inválido e diário substituído não autorizam remoção', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const caminho = await area.criarArquivo('acervo.sqlite');
  const h = await registrarObjetoStagingV9(area, caminho);
  await h.close();
  const diario = path.join(area.caminho, 'manifesto.json');
  await (await import('node:fs/promises')).appendFile(diario, '{"kind":"object","seq":2,"checksum":"0"}\n');
  assert.equal((await limparAreaStagingV9(area)).limpezaPendente, true);
  assert.equal((await stat(caminho)).isFile(), true);
  const movido = `${diario}.movido`;
  await rename(diario, movido);
  await writeFile(diario, 'outro diário');
  assert.equal((await limparAreaStagingV9(area)).limpezaPendente, true);
  assert.equal((await stat(caminho)).isFile(), true);
});

test('pendentes contam no limite e extra preserva diário para retry após limpar objeto conhecido', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const arquivo = await area.criarArquivo('acervo.sqlite');
  const h = await registrarObjetoStagingV9(area, arquivo); await h.close();
  const extra = path.join(area.caminho, 'extra');
  await writeFile(extra, 'fixture extra');
  const primeiro = await limparAreaStagingV9(area);
  assert.equal(primeiro.limpezaPendente, true);
  assert.equal(primeiro.objetosRemovidos, 1);
  assert.equal(await readFile(extra, 'utf8'), 'fixture extra');
  assert.equal((await stat(path.join(area.caminho, 'manifesto.json'))).isFile(), true);
  await rm(extra);
  assert.equal((await limparAreaStagingV9(area)).limpezaPendente, false);

  const outra = await criarAreaStagingV9({ raizStaging: raiz });
  for (let i = 0; i < 16; i++) await outra.criarPastaStream();
  await assert.rejects(outra.criarPastaStream(), { code: 'LIMITE_OBJETOS' });
});

test('dois processos recovery concorrentes limpam órfão uma vez', async t => {
  const raiz = await fixture(t);
  const modulo = new URL('../src/backup-staging-v9.js', import.meta.url).href;
  const creator = `import { criarAreaStagingV9, registrarObjetoStagingV9 } from ${JSON.stringify(modulo)};
const area = await criarAreaStagingV9({ raizStaging: process.argv[1] });
const p = await area.criarArquivo('acervo.sqlite');
const h = await registrarObjetoStagingV9(area, p); await h.writeFile('fixture concorrente'); await h.sync();
process.exit(0);`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', creator, raiz], { windowsHide: true, timeout: 15000 }).status, 0);
  const recovery = `import { recuperarAreasStagingV9 } from ${JSON.stringify(modulo)};
const r = await recuperarAreasStagingV9({ raizStaging: process.argv[1] });
process.stdout.write(JSON.stringify(r));`;
  const executar = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', recovery, raiz], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`recovery saiu ${code}`)));
  });
  const [a, b] = await Promise.all([executar(), executar()]);
  assert.ok(a.objetosRemovidos + b.objetosRemovidos <= 1);
  assert.deepEqual(await readdir(raiz), []);
});

test('retry considera idempotentes filho e pasta stream já ausentes', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const pasta = await area.criarPastaStream();
  await registrarObjetoStagingV9(area, pasta);
  const arquivo = await area.criarArquivo('conteudo.bin', pasta);
  const h = await registrarObjetoStagingV9(area, arquivo); await h.close();
  await rm(arquivo); await rmdir(pasta);
  const r = await limparAreaStagingV9(area);
  assert.equal(r.limpezaPendente, false);
  assert.deepEqual(await readdir(raiz), []);
});

test('falha de registro não entrega handle quando diário foi alterado', async t => {
  const raiz = await fixture(t);
  const area = await criarAreaStagingV9({ raizStaging: raiz });
  const caminho = await area.criarArquivo('acervo.sqlite');
  await (await import('node:fs/promises')).appendFile(path.join(area.caminho, 'manifesto.json'), '{');
  await assert.rejects(registrarObjetoStagingV9(area, caminho));
  const r = await limparAreaStagingV9(area);
  assert.equal(r.limpezaPendente, true);
  assert.equal((await stat(caminho)).isFile(), true);
});
