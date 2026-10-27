import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { abrirBanco } from '../../src/banco.js';
import { ContextoApp } from '../../src/contexto-app.js';
import { Desktop } from '../../src/desktop.js';
import { prepararProjetosComerciais } from '../../src/projetos-comerciais/esquema.js';
import { prepararTarefas } from '../../src/tarefas-esquema.js';
import { prepararComandosWhatsapp } from '../../src/comandos-whatsapp.js';
import { NotetakerServico } from '../../src/notetaker/servico.js';
import { cabecalhoWav } from '../../src/notetaker/contrato.js';
import { importarArquivo } from '../../src/notetaker/importacao.js';
import { montarPlanoExclusao } from '../../src/notetaker/exclusao-plano.js';
import { selecionarPerfilBoot } from '../../src/perfil-boot.js';
import { acquireExclusiveDb, assertNormalBootAllowed, createMaintenanceMarker, markMaintenanceStarted } from '../../src/perfil-manutencao.js';

const harnessRoot=realpathSync(process.argv[2]);
assert.equal(realpathSync(tmpdir()),harnessRoot,'tmpdir do filho não aponta para a raiz descartável do harness');
const profileRoot=realpathSync(mkdtempSync(join(harnessRoot,'lume-notetaker-03a36-')));
assert.ok(relative(harnessRoot,profileRoot)&&!relative(harnessRoot,profileRoot).startsWith('..'+sep));
assert.match(basename(profileRoot),/^lume-notetaker-/);
const marker=randomUUID();
writeFileSync(join(profileRoot,'.lume-notetaker-test'),marker,{flag:'wx'});
process.env.ASSESSOR_DESKTOP_TEST_PROFILE=profileRoot;
mkdirSync(join(profileRoot,'data'));
mkdirSync(join(profileRoot,'credenciais'));
const dbPath=join(profileRoot,'data','assessor.db');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function quote(name){return `"${String(name).replaceAll('"','""')}"`;}
function databaseSnapshot(db){
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
  const rows=names.map(name=>[name,db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row=>JSON.stringify(row)).sort()]);
  return {schema,rows,foreignKeys:db.prepare('PRAGMA foreign_key_check').all()};
}
function filesSnapshot(root){
  const out=[];
  function walk(dir,prefix=''){
    for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const full=join(dir,entry.name),name=prefix?`${prefix}/${entry.name}`:entry.name,meta=lstatSync(full);
      assert.equal(meta.isSymbolicLink(),false,'fixture de áudio não pode conter link');
      if(entry.isDirectory())walk(full,name);
      else {assert.equal(entry.isFile(),true);const bytes=readFileSync(full);out.push({name,size:bytes.length,sha256:hash(bytes)});}
    }
  }
  if(lstatSync(root).isDirectory())walk(root);
  return out;
}

let db,lease,other;
try{
  db=abrirBanco(dbPath);
  new ContextoApp(db);new Desktop(db);prepararProjetosComerciais(db);prepararTarefas(db);prepararComandosWhatsapp(db);
  let service=new NotetakerServico(db,{notetakerExperimento:true,testProfileRoot:profileRoot,testMarker:marker,
    audioLocal:{async estado(){return {disponivel:true};},async transcrever(bytes){return {
      motor:'whisper.cpp',modeloSha256:'a'.repeat(64),audioSha256:hash(bytes),
      trechos:[{inicioMs:0,fimMs:500,texto:'Conteúdo fictício do harness 03A36.'}]
    };}}});
  const sessaoId=service.criarSessao({origem:'importacao',entradas:['importacao']}).id;
  service.consentir(sessaoId,{entradas:['importacao'],confirmar:true});
  const wav=Buffer.concat([cabecalhoWav(32000),Buffer.alloc(32000)]);
  await importarArquivo({headers:{'content-length':String(wav.length),'content-type':'audio/wav'},complete:true,
    async *[Symbol.asyncIterator](){yield wav;}},{servico:service,sessaoId});
  assert.equal((await service.transcreverImportacao(sessaoId)).estado,'concluida');
  assert.equal(service.importacoesAtivas.size,0);
  const partCount=db.prepare('SELECT COUNT(*) n FROM notetaker_partes WHERE sessao_id=?').get(sessaoId).n;
  assert.ok(partCount>0);
  const fkBeforeClose=db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  const beforeDb=databaseSnapshot(db),audioRoot=join(profileRoot,'notetaker-audio'),beforeFiles=filesSnapshot(audioRoot);
  db.close();db=null;service=null;

  const selection=await selecionarPerfilBoot(profileRoot);
  const opId=randomUUID();
  const handle=await createMaintenanceMarker({userData:profileRoot,selection,opId,kind:'notetaker-delete'});
  markMaintenanceStarted(handle);
  lease=await acquireExclusiveDb({selection,maintenanceHandle:handle});
  const fkAfterAcquire=lease.db.prepare('PRAGMA foreign_keys').get().foreign_keys;

  other=new DatabaseSync(dbPath,{timeout:0});
  let contention;
  try{other.exec('BEGIN EXCLUSIVE');other.exec('ROLLBACK');}
  catch(error){contention=error;try{if(other.isTransaction)other.exec('ROLLBACK');}catch{}}
  finally{other.close();other=null;}
  assert.ok(contention&&/busy|locked/i.test(String(contention.message)),
    `segunda conexão não foi recusada durante lease A: ${contention?.message??'BEGIN EXCLUSIVE teve sucesso'}`);

  const foreignKeys=lease.db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  const transaction=()=>{
    lease.db.exec('BEGIN IMMEDIATE');
    try{
      const first=montarPlanoExclusao(lease.db,{sessaoId,notetakerExperimento:true,testProfileRoot:profileRoot,testMarker:marker});
      const second=montarPlanoExclusao(lease.db,{sessaoId,notetakerExperimento:true,testProfileRoot:profileRoot,testMarker:marker});
      assert.deepEqual(second,first);
      assert.equal(lease.db.isTransaction,true);
      assert.equal(lease.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(),undefined);
      lease.db.exec('ROLLBACK');
      return {signature:first.assinatura,files:first.arquivos.length};
    }catch(error){if(lease.db.isTransaction)lease.db.exec('ROLLBACK');throw error;}
  };
  let c0;
  try{c0={state:'compatible',...transaction()};}
  catch(error){
    if(error?.code!=='FECHADO'||foreignKeys!==0)throw error;
    c0={state:'blocked',code:error.code,cause:'A lease opened a connection with PRAGMA foreign_keys=0; C0 correctly rejects it.'};
  }
  assert.deepEqual(databaseSnapshot(lease.db),beforeDb,'C0 alterou estado SQL durante montagem somente leitura');
  assert.deepEqual(filesSnapshot(audioRoot),beforeFiles,'C0 alterou arquivos de áudio');
  assert.deepEqual(lease.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(lease.close()?.closed,true);lease=null;
  assert.throws(()=>assertNormalBootAllowed(profileRoot),{code:'PERFIL_MANUTENCAO_PENDENTE'});

  const verify=new DatabaseSync(dbPath,{timeout:0});
  try{
    assert.deepEqual(databaseSnapshot(verify),beforeDb,'estado SQL divergiu após fechar lease A');
    assert.equal(verify.prepare('SELECT COUNT(*) n FROM notetaker_sessoes WHERE id=?').get(sessaoId).n,1);
    assert.equal(verify.prepare('SELECT COUNT(*) n FROM notetaker_partes WHERE sessao_id=?').get(sessaoId).n,partCount);
    assert.deepEqual(verify.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{verify.close();}
  process.stdout.write(JSON.stringify({state:'ok',c0,sessionId:sessaoId,parts:partCount,
    fkBeforeClose,fkAfterAcquire,fkBeforeC0:foreignKeys,secondConnection:'refused',markerRetained:true,filesUnchanged:true}));
}finally{
  if(other){try{other.close();}catch{}}
  if(lease){try{lease.close();}catch{}}
  if(db){try{db.close();}catch{}}
}
