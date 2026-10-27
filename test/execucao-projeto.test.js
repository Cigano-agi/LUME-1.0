import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let modulo;
async function api() {
  modulo ??= await import('../src/execucao/projeto.js');
  assert.equal(typeof modulo.prepararProjetoIsolado, 'function', 'src/execucao/projeto.js deve exportar prepararProjetoIsolado');
  return modulo.prepararProjetoIsolado;
}
async function preparar(args) {
  return (await api())(args);
}

test('recusa ADS, nomes de dispositivo e caracteres reservados do Windows em cada componente', async () => {
  const { validarCaminhoProjeto } = await import('../src/execucao/projeto.js');
  for (const caminho of ['file.txt:secret', 'src/CON', 'NUL.txt', 'docs/COM1.md', 'LPT9', 'src/a?.js']) {
    assert.throws(() => validarCaminhoProjeto(caminho), /FORBIDDEN_PATH|INVALID_PATH/, caminho);
  }
  assert.equal(validarCaminhoProjeto('src/arquivo.txt'), true);
});
async function fixture(t) {
  const raiz = await mkdtemp(path.join(tmpdir(), 'lume-projeto-isolado-'));
  t.after(() => rm(raiz, { recursive: true, force: true }));
  const origem = path.join(raiz, 'projeto');
  const destino = path.join(raiz, 'descartavel');
  await mkdir(path.join(origem, 'src'), { recursive: true });
  await mkdir(path.join(origem, 'docs'));
  await writeFile(path.join(origem, 'src', 'index.js'), 'export const valor = 42;\n');
  await writeFile(path.join(origem, 'docs', 'nota.txt'), 'fixture sintética');
  await writeFile(path.join(origem, 'fora.txt'), 'não selecionado');
  return { raiz, origem, destino };
}

test('copia somente os caminhos selecionados e grava manifesto verificável com hashes e escopo', async t => {
  await api();
  const f = await fixture(t);
  const escolhidos = ['src/index.js', 'docs/nota.txt'];
  const resultado = await preparar({ origem: f.origem, destino: f.destino, arquivos: escolhidos });
  assert.deepEqual((await readdir(f.destino, { recursive: true })).map(x => x.replaceAll('\\', '/')).sort(), ['docs', 'docs/nota.txt', 'manifesto.json', 'src', 'src/index.js']);
  const manifesto = JSON.parse(await readFile(path.join(f.destino, 'manifesto.json'), 'utf8'));
  assert.deepEqual(manifesto.arquivos.map(x => x.caminho).sort(), escolhidos.slice().sort());
  assert.deepEqual(manifesto.escopo.arquivos.sort(), escolhidos.slice().sort());
  for (const item of manifesto.arquivos) {
    const conteudo = await readFile(path.join(f.destino, item.caminho));
    assert.equal(item.sha256, sha(conteudo));
    assert.equal(item.bytes, conteudo.length);
  }
  assert.equal(resultado.manifestoSha256, sha(await readFile(path.join(f.destino, 'manifesto.json'))));
  await assert.rejects(readFile(path.join(f.destino, 'fora.txt')), { code: 'ENOENT' });
});

test('recusa caminhos absolutos e travessia, sem copiar arquivo externo', async t => {
  await api();
  const f = await fixture(t), segredo = path.join(f.raiz, 'fora-segura.txt');
  await writeFile(segredo, 'fora da origem');
  for (const caminho of ['../fora-segura.txt', segredo, path.resolve(f.origem, 'src/index.js')]) {
    await assert.rejects(preparar({ origem: f.origem, destino: f.destino, arquivos: [caminho] }));
    await assert.rejects(readFile(path.join(f.destino, 'manifesto.json')), { code: 'ENOENT' });
  }
});

test('recusa árvores Git, credenciais e configuração de agente mesmo quando explicitamente selecionadas', async t => {
  await api();
  const f = await fixture(t);
  const proibidos = ['.git/config', '.env', '.npmrc', '.netrc', '.aws/credentials', 'credentials.json', '.codex/config.toml', 'AGENTS.md', 'AGENTS.override.md', 'AGENTS.local.md'];
  for (const nome of proibidos) {
    const arquivo = path.join(f.origem, nome);
    await mkdir(path.dirname(arquivo), { recursive: true });
    await writeFile(arquivo, 'segredo sintético');
    await assert.rejects(preparar({ origem: f.origem, destino: f.destino, arquivos: [nome] }), undefined, `${nome} deve ser recusado`);
    await assert.rejects(readFile(path.join(f.destino, 'manifesto.json')), { code: 'ENOENT' });
  }
});

test('recusa symlink/junction e hardlink selecionados sem seguir nem copiar o alvo', async t => {
  await api();
  const f = await fixture(t), alvo = path.join(f.raiz, 'alvo-externo.txt');
  await writeFile(alvo, 'conteúdo externo sintético');
  let symlinkCriado = true;
  try { await symlink(alvo, path.join(f.origem, 'link.txt'), 'file'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; symlinkCriado = false; t.diagnostic(`symlink indisponível: ${error.code}`); }
  await link(alvo, path.join(f.origem, 'hardlink.txt'));
  assert.equal((await stat(path.join(f.origem, 'hardlink.txt'))).nlink > 1, true);
  for (const nome of [...(symlinkCriado ? ['link.txt'] : []), 'hardlink.txt']) {
    await assert.rejects(preparar({ origem: f.origem, destino: f.destino, arquivos: [nome] }));
    await assert.rejects(readFile(path.join(f.destino, 'manifesto.json')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(alvo, 'utf8'), 'conteúdo externo sintético');
});

test('não publica manifesto de sucesso quando a origem muda durante a cópia', async t => {
  await api();
  const f = await fixture(t);
  const grande = Buffer.alloc(96 * 1024 * 1024, 0x61);
  await writeFile(path.join(f.origem, 'grande.bin'), grande);
  const tentativa = preparar({ origem: f.origem, destino: f.destino, arquivos: ['grande.bin'] }).then(() => null, error => error);
  await new Promise(resolve => setTimeout(resolve, 0));
  await writeFile(path.join(f.origem, 'grande.bin'), Buffer.alloc(grande.length, 0x62));
  const erro = await tentativa;
  assert.ok(erro instanceof Error && /SOURCE_CHANGED|ALTERAD|MUTAC/i.test(erro.message), `esperado erro de alteração da origem, recebido: ${erro?.message ?? 'sucesso'}`);
  await assert.rejects(readFile(path.join(f.destino, 'manifesto.json')), { code: 'ENOENT' });
});
