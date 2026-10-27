import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { TABELAS_I_V9 } from '../src/backup-acervo-catalogo.js';
import { supervisionarFilho, validarRecibo03A17 } from '../scripts/supervise-backup-v9-roundtrip.mjs';

const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function receipt() {
  return { codigo: 'PARIDADE_CONFIRMADA', fase: 'paridade', pacoteCriado: true, validacao: 'VALIDADA',
    paridade: { eventos: true, conversas_app: true, tabelas: TABELAS_I_V9.map(t => ({ tabela: t.nome,
      origem: { linhas: 0, sha256: emptyHash }, oraculo: { linhas: 0, sha256: emptyHash }, igual: true })) },
    limpeza: 'CONCLUIDA', rssPicoBytes: 100, pacoteEfemero: 'CHAVE_SOMENTE_EM_MEMORIA' };
}
const child = (code, options = {}) => supervisionarFilho({ comando: process.execPath, argumentos: ['-e', code], timeoutMs: 1_000,
  graceMs: 60, finalMs: 300, ...options });
const emit = value => `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`;

test('RED: aceita só recibo conhecido após close e exit0', async () => {
  const start = Date.now();
  const r = await child(`${emit(receipt())} process.stdout.write('\\n'); setTimeout(() => process.exit(0), 120);`);
  assert.equal(r.codigo, 'PARIDADE_CONFIRMADA');
  assert.equal(r.processo.fechamentoConfirmado, true);
  assert.equal(r.processo.exitCode, 0);
  assert.equal(r.supervisao.estado, 'CONCLUIDA');
  assert.equal(r.limpeza, 'CONCLUIDA');
  assert.equal(r.recibo?.paridade.tabelas.length, TABELAS_I_V9.length);
  assert.ok(Date.now() - start >= 120);
});

test('RED: segredo fictício em stderr não aparece em saída alguma', async () => {
  const segredo = 'segredo-ficticio-nao-refletir';
  const r = await child(`process.stderr.write('${segredo}'); ${emit(receipt())}`);
  assert.equal(r.codigo, 'PARIDADE_CONFIRMADA');
  assert.equal(JSON.stringify(r).includes(segredo), false);
});

test('RED: JSON inválido e campo desconhecido são recusados', async () => {
  const invalid = await child("process.stdout.write('{');");
  assert.equal(invalid.codigo, 'RECIBO_INVALIDO');
  const extra = { ...receipt(), segredo: 'não refletir' };
  const wrong = await child(emit(extra));
  assert.equal(wrong.codigo, 'RECIBO_INVALIDO');
  assert.equal(JSON.stringify(wrong).includes('não refletir'), false);
});

test('RED: overflow e linha fragmentada acima do limite são recusados', async () => {
  const r = await child("process.stdout.write('x'.repeat(300000));", { maxStdoutBytes: 32_768 });
  assert.equal(r.codigo, 'SAIDA_EXCEDIDA');
  const fragmented = await child("let i=0; const t=setInterval(()=>{process.stdout.write('x'.repeat(9000)); if(++i===5)clearInterval(t)},5);", { maxStdoutBytes: 32_768 });
  assert.equal(fragmented.codigo, 'SAIDA_EXCEDIDA');
  const stderrOverflow = await child("process.stderr.write('segredo-ficticio'.repeat(9000));", { maxStderrBytes: 1_024 });
  assert.equal(stderrOverflow.codigo, 'SAIDA_EXCEDIDA');
  assert.equal(JSON.stringify(stderrOverflow).includes('segredo-ficticio'), false);
});

test('RED: recibo válido fragmentado é reunido sem aceitar tabela alterada', async () => {
  const json = JSON.stringify(receipt());
  const code = `const s=${JSON.stringify(json)}; process.stdout.write(s.slice(0,200)); setTimeout(()=>process.stdout.write(s.slice(200)),10);`;
  const r = await child(code);
  assert.equal(r.codigo, 'PARIDADE_CONFIRMADA');
  const altered = receipt(); altered.paridade.tabelas[0].tabela = 'tabela_injetada';
  const wrong = await child(emit(altered));
  assert.equal(wrong.codigo, 'RECIBO_INVALIDO');
  assert.equal(JSON.stringify(wrong).includes('tabela_injetada'), false);
});

test('RED: JSON de sucesso seguido de exit1 nunca é sucesso', async () => {
  const r = await child(`${emit(receipt())} process.exitCode=1;`);
  assert.equal(r.codigo, 'FILHO_EXIT_NAO_ZERO');
  assert.equal(r.processo.fechamentoConfirmado, true);
  assert.equal(r.processo.exitCode, 1);
  assert.equal(r.recibo, null);
});

test('RED: watchdog do pai encerra filho em loop síncrono', async () => {
  const start = Date.now();
  const r = await child('while(true){}', { timeoutMs: 80 });
  assert.equal(r.codigo, 'PRAZO_EXCEDIDO');
  assert.equal(r.processo.fechamentoConfirmado, true);
  assert.ok(Date.now() - start < 2_000);
});

test('RED: abort após spawn cancela filho próprio', async () => {
  const controller = new AbortController();
  const pending = child('setInterval(()=>{},1000)', { signal: controller.signal });
  await pause(70); controller.abort();
  const r = await pending;
  assert.equal(r.codigo, 'SUPERVISAO_CANCELADA');
  assert.equal(r.processo.fechamentoConfirmado, true);
});

test('RED: erro de spawn e recibo ausente ficam sem limpeza presumida', async () => {
  const badSpawn = await supervisionarFilho({ comando: path.join(tmpdir(), 'executavel-inexistente'), argumentos: [], timeoutMs: 100 });
  assert.equal(badSpawn.codigo, 'FALHA_SPAWN');
  assert.equal(badSpawn.limpeza, 'PENDENTE');
  const noReceipt = await child('process.exit(0)');
  assert.equal(noReceipt.codigo, 'RECIBO_INVALIDO');
  assert.equal(noReceipt.limpeza, 'PENDENTE');
});

test('RED: o pai preserva raiz e sentinela após falha', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lume-supervisor-sintetico-'));
  const outputRoot = path.join(root, 'saida');
  await mkdir(outputRoot);
  const sentinel = path.join(outputRoot, 'sentinela');
  await writeFile(sentinel, 'intacto');
  try {
    const r = await child('while(true){}', { timeoutMs: 80, source: path.join(root, 'fonte.sqlite'), outputRoot });
    assert.equal(r.codigo, 'PRAZO_EXCEDIDO');
    assert.equal(await readFile(sentinel, 'utf8'), 'intacto');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('RED: CLI exige dois caminhos absolutos e não inicia filho para argumentos inválidos', () => {
  const script = path.resolve('scripts/supervise-backup-v9-roundtrip.mjs');
  const child = spawnSync(process.execPath, [script, '--source', 'relativo', '--output-root', 'relativo'], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  const response = JSON.parse(child.stdout);
  assert.equal(response.codigo, 'ARGUMENTOS_INVALIDOS');
  assert.equal(response.processo.iniciado, false);
  assert.equal(child.stderr, '');
});

test('filho usa apenas a raiz indicada como TEMP, TMP e TMPDIR', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lume-supervisor-temp-'));
  try {
    const code = `const os=require('node:os'); const expected=${JSON.stringify(root)};` +
      `if(process.env.TEMP!==expected||process.env.TMP!==expected||process.env.TMPDIR!==expected||os.tmpdir()!==expected)process.exit(2);` +
      emit(receipt());
    const r = await child(code, { outputRoot: root });
    assert.equal(r.codigo, 'PARIDADE_CONFIRMADA');
    assert.equal(r.processo.fechamentoConfirmado, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recusa estados impossíveis sem rejeitar erro legítimo após validação', () => {
  const divergente = receipt();
  divergente.codigo = 'PARIDADE_DIVERGENTE';
  divergente.paridade.eventos = false;
  divergente.paridade.tabelas.find(t => t.tabela === 'eventos').oraculo.sha256 = '0'.repeat(64);
  divergente.paridade.tabelas.find(t => t.tabela === 'eventos').igual = false;
  assert.equal(validarRecibo03A17(divergente), true);

  const semProva = { ...divergente, fase: 'entrada', pacoteCriado: false, validacao: 'NAO_INICIADA',
    paridade: { eventos: null, conversas_app: null, tabelas: [] } };
  assert.equal(validarRecibo03A17(semProva), false);
  assert.equal(validarRecibo03A17({ ...receipt(), fase: 'validacao' }), false);
  assert.equal(validarRecibo03A17({ ...receipt(), limpeza: 'NAO_NECESSARIA' }), false);
  assert.equal(validarRecibo03A17({ ...receipt(), fase: 'entrada', codigo: 'DIAGNOSTICO_FALHOU' }), false);
  assert.equal(validarRecibo03A17({ ...receipt(), codigo: 'LIMPEZA_PENDENTE', limpeza: 'PENDENTE' }), true);
  assert.equal(validarRecibo03A17({ ...receipt(), codigo: 'CAMINHO_ALTERADO', limpeza: 'PENDENTE' }), true);
  assert.equal(validarRecibo03A17({ ...receipt(), codigo: 'SEMANTICA_INVALIDA', fase: 'validacao',
    validacao: 'RECUSADA', paridade: { eventos: null, conversas_app: null, tabelas: [] } }), true);
});
