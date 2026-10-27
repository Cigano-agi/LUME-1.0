import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,linkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {criarServidor} from '../src/painel/servidor.js';
import {CATALOGO_V10} from '../src/backup-acervo-catalogo-v10.js';
import {AtividadeApps,ATIVIDADE_CONFIG,appIdValido} from '../src/atividade-apps.js';
import {criarColetorApps} from '../src/atividade-apps-nativo.js';

const sample=(appId='editor.exe')=>({estado:'amostra',appId,idleMs:0});
function fixture(t,options={}) {
  const db=new DatabaseSync(':memory:');let civil=new Date(2026,9,27,12).getTime(),mono=0,calls=0;
  let collect=options.coletar??(()=>sample());
  const opts={disponivel:true,agora:()=>new Date(civil),monotonico:()=>mono,coletar:args=>{calls++;return collect(args);}};
  const activity=new AtividadeApps(db,opts);
  t.after(async()=>{await activity.encerrar();db.close();});
  return {db,activity,opts,get calls(){return calls;},setCollect(fn){collect=fn;},tick(ms=5000){civil+=ms;mono+=ms;},civil(ms){civil+=ms;},mono(ms){mono+=ms;},async enable(){await activity.configurar({habilitado:true,consentimento:1});},rows(){return db.prepare('SELECT * FROM atividade_apps_dias').all();}};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('review tracking: opt-in independente, config inválida e plataforma indisponível não coletam',async t=>{
  const f=fixture(t);assert.equal(await f.activity.passo(),false);assert.equal(f.calls,0);
  await assert.rejects(f.activity.configurar({habilitado:true}));
  for(const patch of [{retencaoDias:0},{retencaoDias:31},{pausado:'false'},{consentimento:2},{title:'privado'},{excluidos:['C:\\secret\\app.exe']},{excluidos:['a.exe','a.exe']}])await assert.rejects(f.activity.configurar(patch));
  assert.equal(f.calls,0);await f.enable();f.activity.disponivel=false;
  assert.equal(await f.activity.passo(),false);assert.equal(f.calls,0);assert.equal(f.activity.estado().estado,'indisponivel');
});

test('review tracking: conta apenas pares próximos da mesma identidade e não tempo desde ativação',async t=>{
  const f=fixture(t);await f.enable();f.tick(60000);assert.equal(await f.activity.passo(),false);
  f.tick();assert.equal(await f.activity.passo(),true);assert.equal(f.rows()[0].duracao_ms,5000);
  f.setCollect(()=>sample('browser.exe'));f.tick();assert.equal(await f.activity.passo(),false);
  f.tick();assert.equal(await f.activity.passo(),true);assert.equal(f.activity.estado().resumo.duracaoMs,10000);
  f.tick(7501);assert.equal(await f.activity.passo(),false);assert.equal(f.activity.estado().resumo.duracaoMs,10000);
});

test('review tracking: um coletor em voo; exclusão invalida retorno e apaga agregado atomicamente',async t=>{
  const f=fixture(t);await f.enable();await f.activity.passo();f.tick();await f.activity.passo();
  const d=deferred();let signal;f.setCollect(args=>{signal=args.signal;return d.promise;});f.tick();
  const a=f.activity.passo(),b=f.activity.passo();assert.equal(a,b);await Promise.resolve();const calls=f.calls;
  const changed=f.activity.configurar({excluidos:['editor.exe']});assert.equal(signal.aborted,true);
  f.activity.passo();assert.equal(f.calls,calls);d.resolve(sample());assert.equal(await a,false);await changed;
  assert.deepEqual(f.rows(),[]);assert.equal(f.activity.estado().appAtual,null);
  f.setCollect(()=>sample());await f.activity.configurar({excluidos:[]});f.tick();assert.equal(await f.activity.passo(),false);
  f.tick();assert.equal(await f.activity.passo(),true);assert.equal(f.rows()[0].duracao_ms,5000);
});

test('review tracking: pausar e retomar durante coleta não ressuscita a geração antiga',async t=>{
  const f=fixture(t);await f.enable();await f.activity.passo();f.tick();
  const d=deferred();f.setCollect(()=>d.promise);const work=f.activity.passo();await Promise.resolve();
  const pause=f.activity.configurar({pausado:true}),resume=f.activity.configurar({pausado:false});
  d.resolve(sample());assert.equal(await work,false);await Promise.all([pause,resume]);assert.deepEqual(f.rows(),[]);
  f.setCollect(()=>sample());f.tick();assert.equal(await f.activity.passo(),false);f.tick();assert.equal(await f.activity.passo(),true);
});

test('review tracking: apagar em voo desabilita consentimento e impede retorno tardio',async t=>{
  const f=fixture(t);await f.enable();await f.activity.passo();f.tick();await f.activity.passo();
  const d=deferred();f.setCollect(()=>d.promise);f.tick();const work=f.activity.passo();await Promise.resolve();
  const erase=f.activity.apagar();d.resolve(sample());await work;await erase;
  assert.deepEqual(f.rows(),[]);assert.equal(f.activity.estado().config.consentimento,0);assert.equal(f.activity.estado().estado,'desligado');
  assert.equal(await f.activity.passo(),false);await assert.rejects(f.activity.configurar({habilitado:true}));
});

test('review tracking: lock/unlock, inatividade, erro e resposta contaminada quebram continuidade',async t=>{
  const f=fixture(t);await f.enable();await f.activity.passo();f.tick();f.activity.sistema(true);f.activity.sistema(false);
  assert.equal(await f.activity.passo(),false);assert.deepEqual(f.rows(),[]);
  const invalid=[{estado:'bloqueado'},{estado:'inativo'},{estado:'indisponivel'},sample('C:\\app.exe'),{...sample(),title:'SEGREDO_NAO_PERSISTIR'}, {...sample(),idleMs:-1},{...sample(),idleMs:60000},{...sample(),idleMs:NaN}];
  for(const value of invalid){f.setCollect(()=>value);f.tick();assert.equal(await f.activity.passo(),false);f.setCollect(()=>sample());f.tick();assert.equal(await f.activity.passo(),false);}
  f.setCollect(()=>{throw Error('SEGREDO_NAO_PERSISTIR');});f.tick();assert.equal(await f.activity.passo(),false);
  assert.deepEqual(f.rows(),[]);assert.ok(!JSON.stringify(f.activity.estado()).includes('SEGREDO_NAO_PERSISTIR'));
});

test('review tracking: relógio civil, coleta lenta e meia-noite não fabricam duração',async t=>{
  const f=fixture(t);await f.enable();await f.activity.passo();f.tick();f.civil(60000);assert.equal(await f.activity.passo(),false);
  f.setCollect(()=>{f.tick(2501);return sample();});assert.equal(await f.activity.passo(),false);f.setCollect(()=>sample());f.tick();assert.equal(await f.activity.passo(),false);
  f.civil(12*3600000);f.tick();assert.equal(await f.activity.passo(),false);assert.deepEqual(f.rows(),[]);
});

test('review tracking: reinício preserva escolha e agregado, mas não amostra anterior',async t=>{
  const f=fixture(t);await f.enable();await f.activity.passo();f.tick();await f.activity.passo();await f.activity.encerrar();f.tick();
  const restarted=new AtividadeApps(f.db,f.opts);t.after(()=>restarted.encerrar());
  assert.equal(restarted.estado().config.habilitado,true);assert.equal(await restarted.passo(),false);assert.equal(f.rows()[0].duracao_ms,5000);
  f.tick();assert.equal(await restarted.passo(),true);assert.equal(f.rows()[0].duracao_ms,10000);
});

test('review tracking: retenção funciona desligada, remove futuro e preserva limites do dia',async t=>{
  const f=fixture(t),insert=f.db.prepare('INSERT INTO atividade_apps_dias VALUES(?,?,?,?,?)');
  for(const day of ['2026-10-20','2026-10-21','2026-10-27','2026-10-28'])insert.run(day,'editor.exe',5000,1,day+'T12:00:00.000Z');
  assert.equal(f.activity.estado().resumo.duracaoMs,10000);assert.deepEqual(f.rows().map(r=>r.dia),['2026-10-21','2026-10-27']);
  await f.activity.configurar({retencaoDias:1});assert.deepEqual(f.rows().map(r=>r.dia),['2026-10-27']);assert.equal(f.calls,0);
});

test('review tracking: configuração persistida desconhecida não concede consentimento',async t=>{
  const f=fixture(t);await f.enable();const saved=f.activity.estado().config;saved.versao=2;
  f.db.prepare('UPDATE desktop_config SET valor=? WHERE chave=?').run(JSON.stringify(saved),ATIVIDADE_CONFIG);
  const restarted=new AtividadeApps(f.db,f.opts);assert.equal(restarted.estado().config.habilitado,false);assert.equal(await restarted.passo(),false);await restarted.encerrar();
});

test('review tracking: falha de persistência ao pausar não permite continuidade',async t=>{
  const f=fixture(t);await f.enable();await f.activity.passo();
  f.db.exec("CREATE TRIGGER review_fail BEFORE UPDATE ON desktop_config BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;");
  await assert.rejects(f.activity.configurar({pausado:true}));f.tick();assert.equal(await f.activity.passo(),false);assert.equal(f.activity.estado().estado,'indisponivel');assert.deepEqual(f.rows(),[]);
});

test('review tracking: proteção de dados e encerramento invalidam a coleta em voo',async t=>{
  const f=fixture(t);await f.enable();const d=deferred();let signal;f.setCollect(args=>{signal=args.signal;return d.promise;});const work=f.activity.passo();await Promise.resolve();
  const pause=f.activity.pausarDados();assert.equal(signal.aborted,true);d.resolve(sample());await work;await pause;
  assert.equal(f.activity.estado().estado,'desligado');assert.equal(f.activity.estado().config.consentimento,0);assert.deepEqual(f.rows(),[]);
  await f.activity.configurar({pausado:false});assert.equal(await f.activity.passo(),false);await assert.rejects(f.activity.configurar({habilitado:true}));
  await f.activity.encerrar();assert.equal(await f.activity.passo(),false);
});

test('review tracking: identificadores são basenames restritos e saída não inclui conteúdo',()=>{
  for(const value of ['Editor.exe','../a.exe','a/b.exe','C:\\app.exe','a\u202eb.exe','a.exe\n','https://site.exe','a..exe'])assert.equal(appIdValido(value),false,value);
  assert.equal(appIdValido('editor de código.exe'),true);
});

test('review native: runtime rejeita hardlink do binário mesmo com manifesto coerente, sem executá-lo',t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-app-review-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const bytes=Buffer.from('SYNTHETIC_NOT_EXECUTABLE'),original=join(dir,'original.bin');writeFileSync(original,bytes);linkSync(original,join(dir,'lume-activity.exe'));
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({schema:1,platform:'win32',arch:'x64',file:'lume-activity.exe',sha256:createHash('sha256').update(bytes).digest('hex'),sourceSha256:'a'.repeat(64)}));
  assert.equal(criarColetorApps({platform:'win32',arch:'x64',bin:dir}).disponivel,false);
});

test('review native: bytes alterados após construção são recusados antes de execFile',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-app-review-changed-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const bytes=Buffer.from('SYNTHETIC_NOT_EXECUTABLE'),file=join(dir,'lume-activity.exe');writeFileSync(file,bytes);
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({schema:1,platform:'win32',arch:'x64',file:'lume-activity.exe',sha256:createHash('sha256').update(bytes).digest('hex'),sourceSha256:'a'.repeat(64)}));
  const collector=criarColetorApps({platform:'win32',arch:'x64',bin:dir});assert.equal(collector.disponivel,true);
  writeFileSync(file,'CHANGED_SYNTHETIC_NOT_EXECUTABLE');let calls=0;const original=childProcess.execFile;
  childProcess.execFile=(...args)=>{calls++;queueMicrotask(()=>args.at(-1)(Error('blocked by independent test')));return {kill(){}};};syncBuiltinESMExports();
  try{assert.deepEqual(await collector.coletar(),{estado:'indisponivel'});assert.equal(calls,0);}finally{childProcess.execFile=original;syncBuiltinESMExports();}
});

async function httpFixture(t,{readOnly=false,desktop=true}={}){
  const db=abrirBanco(),contexto=new ContextoApp(db);new Desktop(db).aceitar({nome:'Revisão sintética atividade',aceito:true,versao:VERSAO_TERMOS});
  let clock=new Date(2026,9,27,12).getTime(),mono=0;
  const activity=new AtividadeApps(db,{disponivel:true,coletar:()=>sample(),agora:()=>new Date(clock),monotonico:()=>mono});
  const server=criarServidor(db,{desktop,readOnly,contexto,atividadeApps:activity,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const {token}=await(await fetch(origin+'/api/sessao')).json();
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await activity.encerrar();db.close();});
  const request=async(path,{body,auth=true,headers={}}={})=>{const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{'x-assessor-token':token}:{}),'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  return {db,activity,contexto,request,async record(){await activity.configurar({habilitado:true,consentimento:1});await activity.passo();clock+=5000;mono+=5000;await activity.passo();}};
}

test('review HTTP: atividade exige sessão, origem local e consultas/corpos estritos',async t=>{
  const f=await httpFixture(t),path='/api/v3/atividade-apps';
  assert.equal((await f.request(path,{auth:false})).status,403);
  assert.equal((await f.request(path,{headers:{origin:'https://example.invalid'}})).status,403);
  assert.equal((await f.request(path+'/config',{auth:false,body:{habilitado:true,consentimento:1}})).status,403);
  for(const suffix of ['?dias=31','?dias=1&dias=2','?titulo=privado','?limite=101'])assert.equal((await f.request(path+suffix)).status,400);
  assert.equal((await f.request(path+'/config',{body:{habilitado:true,consentimento:1,janela:'privado'}})).status,400);
  assert.equal((await f.request(path+'/config',{body:{habilitado:true}})).status,400);
  assert.equal((await f.request(path+'/config',{body:{habilitado:true,consentimento:1}})).status,200);
  assert.equal((await f.request(path)).body.local,true);
});

test('review HTTP: modo somente leitura e contexto não desktop não habilitam tracking',async t=>{
  const f=await httpFixture(t,{readOnly:true});assert.equal((await f.request('/api/v3/atividade-apps/config',{body:{habilitado:true,consentimento:1}})).status,403);
  const other=await httpFixture(t,{desktop:false});assert.equal((await other.request('/api/v3/atividade-apps')).status,404);
});

test('review HTTP: apagar tracking remove registros e exige novo consentimento',async t=>{
  const f=await httpFixture(t);await f.record();assert.equal(f.activity.estado().resumo.duracaoMs,5000);
  assert.equal((await f.request('/api/v3/atividade-apps/apagar',{body:{extra:true}})).status,400);
  const r=await f.request('/api/v3/atividade-apps/apagar',{body:{}});assert.equal(r.status,200);assert.equal(r.body.resumo.duracaoMs,0);assert.equal(r.body.config.consentimento,0);
});

test('review direitos: apagar todos os dados também revoga consentimento em memória',async t=>{
  const f=await httpFixture(t);await f.record();const preview=await f.request('/api/v3/dados/preparar-exclusao',{body:{tudo:true}});
  assert.equal(preview.status,200);assert.equal(preview.body.contagens.atividade_apps_dias,1);
  const erased=await f.request('/api/v3/dados/excluir',{body:{id:preview.body.id,confirmar:'APAGAR'}});assert.equal(erased.status,200);
  assert.equal(f.db.prepare('SELECT count(*) n FROM atividade_apps_dias').get().n,0);
  const state=await f.request('/api/v3/atividade-apps');assert.equal(state.body.config.habilitado,false);assert.equal(state.body.config.consentimento,0);
  assert.equal((await f.request('/api/v3/atividade-apps/config',{body:{habilitado:true}})).status,400);
});

test('review direitos: exportação de conversas não contém tracking; exclusão de fonte não apaga atividade alheia',async t=>{
  const f=await httpFixture(t);await f.record();const source=f.contexto.nota({texto:'Nota sintética de teste independente'}).id;
  const exported=await f.request('/api/v3/dados/exportar',{body:{confirmar:true}});assert.equal(exported.status,200);assert.ok(!JSON.stringify(exported.body).includes('editor.exe'));assert.ok(!JSON.stringify(exported.body).includes('atividade_apps'));
  const row=CATALOGO_V10.find(x=>x.nome==='atividade_apps_dias');assert.equal(row.decisao,'X');
  const preview=await f.request('/api/v3/dados/preparar-exclusao',{body:{fonte:source}});assert.equal(preview.status,200);
  assert.equal((await f.request('/api/v3/dados/excluir',{body:{id:preview.body.id,confirmar:'APAGAR'}})).status,200);
  assert.equal(f.db.prepare('SELECT SUM(duracao_ms) total FROM atividade_apps_dias').get().total,5000);assert.equal(f.activity.estado().estado,'desligado');assert.equal(f.activity.estado().config.consentimento,0);
  assert.equal((await f.request('/api/v3/atividade-apps/config',{body:{habilitado:true}})).status,400);
});

test('review native: cancelamento aguarda callback de fechamento e impede helper sobreposto',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-app-review-overlap-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const bytes=Buffer.from('SYNTHETIC_NOT_EXECUTABLE');writeFileSync(join(dir,'lume-activity.exe'),bytes);
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({schema:1,platform:'win32',arch:'x64',file:'lume-activity.exe',sha256:createHash('sha256').update(bytes).digest('hex'),sourceSha256:'a'.repeat(64)}));
  const original=childProcess.execFile;let calls=0,kills=0,close;
  childProcess.execFile=(file,args,options,callback)=>{calls++;close=callback;assert.equal(file,join(dir,'lume-activity.exe'));assert.deepEqual(args,['--sample']);assert.equal(options.windowsHide,true);assert.equal(options.timeout,2500);assert.equal(options.maxBuffer,2048);return {kill(){kills++;}};};syncBuiltinESMExports();
  try{
    const collector=criarColetorApps({platform:'win32',arch:'x64',bin:dir}),controller=new AbortController();
    const first=collector.coletar({signal:controller.signal});controller.abort();assert.equal(kills,1);
    await assert.rejects(collector.coletar(),/OCUPADA/);assert.equal(calls,1);
    close(null,JSON.stringify(sample()));assert.deepEqual(await first,{estado:'indisponivel'});
    const next=collector.coletar();assert.equal(calls,2);close(null,JSON.stringify({estado:'inativo'}));assert.deepEqual(await next,{estado:'inativo'});
  }finally{childProcess.execFile=original;syncBuiltinESMExports();}
});

test('review backup v10: roundtrip real sintético exclui atividade e restaura consentimento desligado',async t=>{
  const root=mkdtempSync(join(tmpdir(),'lume-activity-roundtrip-')),profile=join(root,'original'),data=join(profile,'data');mkdirSync(data,{recursive:true});
  const db=abrirBanco(join(data,'assessor.db')),contexto=new ContextoApp(db);new Desktop(db).aceitar({nome:'Revisão de backup sintético',aceito:true,versao:VERSAO_TERMOS});
  contexto.nota({texto:'Fonte sintética preservada pelo backup de acervo'});
  let clock=new Date(2026,9,27,12).getTime(),mono=0;const activity=new AtividadeApps(db,{disponivel:true,coletar:()=>sample('private-synthetic-app.exe'),agora:()=>new Date(clock),monotonico:()=>mono});
  await activity.configurar({habilitado:true,consentimento:1});await activity.passo();clock+=5000;mono+=5000;await activity.passo();
  const server=criarServidor(db,{desktop:true,contexto,atividadeApps:activity,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(origin+'/api/sessao')).json();
  t.after(async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});await activity.encerrar();db.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
  const post=(path,body)=>fetch(origin+'/api/v3/dados/'+path,{method:'POST',headers:{'x-assessor-token':token,'content-type':'application/json'},body:JSON.stringify(body)});
  const senha='Senha sintética de roundtrip independente 2026';const exported=await post('backup-v10/criar',{senha});assert.equal(exported.status,200);const receipt=await exported.json();
  const download=await fetch(origin+'/api/v3/dados/backup-v10/arquivo?ticket='+receipt.id);assert.equal(download.status,200);const bytes=Buffer.from(await download.arrayBuffer());assert.equal(bytes.length,receipt.bytes);
  const upload=await fetch(origin+'/api/v3/dados/backup-v10/importar',{method:'POST',headers:{'x-assessor-token':token,'x-lume-backup-password':Buffer.from(senha).toString('base64'),'content-type':'application/octet-stream'},body:bytes});
  assert.equal(upload.status,200);const preview=await upload.json();const restoredResponse=await post('backup-v10/restaurar',{id:preview.id,confirmarMeuBackup:true});assert.equal(restoredResponse.status,200);const restored=await restoredResponse.json();
  assert.ok(resolve(restored.destinoNovo).startsWith(resolve(root)+sep),'restauração sintética deve permanecer na raiz temporária própria');
  const restoredDb=new DatabaseSync(join(restored.destinoNovo,'data','assessor.db'));
  try{
    assert.equal(restoredDb.prepare('SELECT count(*) n FROM eventos').get().n,1);
    assert.equal(restoredDb.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(ATIVIDADE_CONFIG),undefined);
    const table=restoredDb.prepare("SELECT name FROM sqlite_master WHERE name='atividade_apps_dias'").get();if(table)assert.equal(restoredDb.prepare('SELECT count(*) n FROM atividade_apps_dias').get().n,0);
    let calls=0;const restarted=new AtividadeApps(restoredDb,{disponivel:true,coletar:()=>{calls++;return sample();}});
    assert.equal(restarted.estado().config.habilitado,false);assert.equal(restarted.estado().config.consentimento,0);assert.equal(await restarted.passo(),false);assert.equal(calls,0);await restarted.encerrar();
  }finally{restoredDb.close();}
  assert.equal(activity.estado().config.habilitado,true,'restauração em novo perfil não altera escolha do perfil de origem');assert.equal(activity.estado().resumo.duracaoMs,5000);
});
