import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('./fixtures/03A36-content-child.mjs', import.meta.url));
const preserved={internalEvent:0,derivedEvent:0,externalEvent:1,reboundAction:1,nonBaseProject:1,internalProjectSource:0,
  externalProjectSource:1,sharedTag:1,externalTagAssociation:1,foreignKeys:0};
function run(mode, root) {
  const result = spawnSync(process.execPath, [child, mode, root], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
    windowsHide: true, env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `filho ${mode} terminou por sinal`);
  assert.equal(result.status, 0, `filho ${mode} falhou: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
function crash(mode, root, expected) {
  const result = spawnSync(process.execPath, [child, mode, root], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
    windowsHide: true, env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null);
  assert.equal(result.status, expected, `crash ${mode} divergiu: ${result.stderr}`);
}
function failRun(mode,root){
  const result=spawnSync(process.execPath,[child,mode,root],{cwd:process.cwd(),encoding:'utf8',timeout:30000,windowsHide:true,
    env:{...process.env,TEMP:root,TMP:root,TMPDIR:root}});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null);assert.notEqual(result.status,0);
  assert.match(result.stderr,/PERFIL_MANUTENCAO_INVALIDA/);return result;
}
function withRoot(prefix, action) {
  const home = realpathSync(homedir()), root = realpathSync(mkdtempSync(join(home, prefix)));
  const guard = randomUUID(); writeFileSync(join(root, '.lume-03a36-content'), guard, { flag: 'wx' });
  let completed=false;
  try { const value=action(root);completed=true;return value; }
  finally { if(completed){const actual=realpathSync(root);assert.equal(dirname(actual),home);assert.equal(readFileSync(join(actual,'.lume-03a36-content'),'utf8'),guard);rmSync(actual,{recursive:true,force:false});} }
}

test('C1 executa duas partes, emite recibo privado e conclui no mesmo perfil sintético', () => withRoot('lume-03a36-content-', root => {
    const setup = run('setup', root); assert.equal(setup.parts, 2);
    const result = run('execute', root);
    assert.deepEqual(result, { mode: 'execute', sessions: 0, parts: 0, control: 'concluida', receipt: { estado: 'concluida', arquivos_pendentes: 0 },preserved });
}));

test('C1 recupera crash após primeiro rename com rollback frio e conteúdo intacto', () => withRoot('lume-03a36-content-rename-', root => {
  run('setup', root); crash('crash-rename', root, 71); const result=run('recover', root);
  assert.deepEqual(result, { mode:'recover',sessions:1,parts:2,control:'abortada',receipt:null });
}));

for(const [mode,status] of [['crash-before-rename',76],['crash-rename-last',77]])
  test(`C1 faz rollback frio em ${mode}`,()=>withRoot(`lume-03a36-content-${mode}-`,root=>{
    run('setup',root);crash(mode,root,status);const result=run('recover',root);assert.equal(result.control,'abortada');assert.equal(result.sessions,1);assert.equal(result.parts,2);
  }));

for (const [mode,status] of [['crash-commit',73],['crash-unlink',72]])
  test(`C1 completa recovery frio em ${mode}`, () => withRoot(`lume-03a36-content-${mode}-`, root => {
    run('setup',root);crash(mode,root,status);const result=run('recover',root);
    assert.deepEqual(result,{mode:'recover',sessions:0,parts:0,control:'concluida',receipt:{estado:'concluida',arquivos_pendentes:0},preserved});
  }));

for(const [mode,status] of [['crash-unlink-last',78],['crash-progress',79]])
  test(`C1 completa prefixo pós-commit em ${mode}`,()=>withRoot(`lume-03a36-content-${mode}-`,root=>{
    run('setup',root);crash(mode,root,status);const result=run('recover',root);assert.equal(result.control,'concluida');assert.deepEqual(result.preserved,preserved);
  }));

test('C1 conclui sessão sem WAV com recibo SQL próprio', () => withRoot('lume-03a36-content-zero-', root => {
  const setup=run('setup-zero',root);assert.equal(setup.parts,0);const result=run('execute',root);
  assert.deepEqual(result,{mode:'execute',sessions:0,parts:0,control:'concluida',receipt:{estado:'concluida',arquivos_pendentes:0}});
}));

test('C1 recusa clone, JSON, DB arbitrário e consumo duplo', () => withRoot('lume-03a36-content-guards-', root => {
  run('setup',root);const result=run('guards',root);
  assert.deepEqual(result,{mode:'guards',sessions:0,parts:0,control:'concluida',receipt:{estado:'concluida',arquivos_pendentes:0},preserved});
}));

test('C1 reutiliza DDL terminal retido numa segunda exclusão', () => withRoot('lume-03a36-content-second-', root => {
  run('setup-zero',root);run('execute',root);const next=run('setup-next',root);assert.equal(next.parts,0);
  const result=run('execute',root);assert.deepEqual(result,{mode:'execute',sessions:0,parts:0,control:'concluida',receipt:{estado:'concluida',arquivos_pendentes:0}});
}));

test('backup v9 recusa controle ativo antes do snapshot e ignora objetos terminais no catálogo global', () => withRoot('lume-03a36-content-backup-', root => {
  run('setup',root);crash('crash-rename',root,71);const active=run('backup',root);
  assert.deepEqual(active,{mode:'backup',code:'EXCLUSAO_ATIVA',bytes:0,tempBefore:[],tempAfter:[]});run('recover',root);
  run('setup-next',root);run('execute',root);const terminal=run('backup',root);
  assert.equal(terminal.code,'SCHEMA_INCOMPLETO');assert.equal(terminal.bytes,0);assert.deepEqual(terminal.tempAfter,[]);
}));

test('recovery recusa duas ausências não contabilizadas antes de mutar progresso', () => withRoot('lume-03a36-content-prefix-', root => {
  run('setup',root);crash('crash-commit',root,73);
  const journal=join(root,'lume-notetaker-content','notetaker-delete-journal'),op=join(journal,readdirSync(journal)[0]);
  for(const name of readdirSync(op).filter(x=>x.endsWith('.wav')))unlinkSync(join(op,name));
  failRun('recover',root);assert.equal(existsSync(join(root,'lume-notetaker-content','perfil-manutencao.json')),true);
}));

test('recovery recusa origem recriada depois do terminal e preserva evidência', () => withRoot('lume-03a36-content-origin-', root => {
  const setup=run('setup',root);crash('crash-cleanup',root,74);
  writeFileSync(join(root,'lume-notetaker-content','notetaker-audio',setup.state.files[0]),Buffer.from('recriado'));
  failRun('recover',root);assert.equal(existsSync(join(root,'lume-notetaker-content','perfil-manutencao.json')),true);
}));

test('recovery repete limpeza concluída interrompida após remover manifesto', () => withRoot('lume-03a36-content-terminal-replay-', root => {
  run('setup',root);crash('crash-cleanup',root,74);const completed=run('recover',root);assert.equal(completed.control,'concluida');
}));

test('recovery repete fase abortada sem reabrir transição terminal', () => withRoot('lume-03a36-content-abort-replay-', root => {
  run('setup',root);crash('crash-rename',root,71);crash('recover-crash-abort',root,75);const result=run('recover',root);
  assert.deepEqual(result,{mode:'recover',sessions:1,parts:2,control:'abortada',receipt:null});
}));
