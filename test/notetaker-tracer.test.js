import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm,access,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {abrirBanco} from '../src/banco.js';
import {prepararNotetaker} from '../src/notetaker/esquema.js';
import {leituraFonteSql, LEITURA_SQL} from '../src/leitura-sql.js';
import {NotetakerServico} from '../src/notetaker/servico.js';
import {Privacidade} from '../src/privacidade.js';
import {cabecalhoWav} from '../src/notetaker/contrato.js';
import {importarArquivo} from '../src/notetaker/importacao.js';
import {randomUUID} from 'node:crypto';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {LumeMcpReadService} from '../src/mcp/read-service.js';

test('schema aditivo e predicado estático negam fonte local órfã', async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-'));
  try{
    const db=abrirBanco(join(root,'db.sqlite'));
    prepararNotetaker(db);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'notetaker_%' AND type='table'").get().n,5);
    assert.match(LEITURA_SQL,/notetaker_trecho/);
    assert.equal(leituraFonteSql(db),LEITURA_SQL,'sem raiz gerida de áudio o ramo local fecha');
    db.close();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('cancelamento, falha de disco simulada e journal órfão preservam estado incompleto',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-')),marker=randomUUID(),old=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;let db;
  try{
    await writeFile(join(root,'.lume-notetaker-test'),marker);
    db=abrirBanco(join(root,'db.sqlite'));
    const opts={notetakerExperimento:true,testProfileRoot:root,testMarker:marker},s=new NotetakerServico(db,opts);
    const id=s.criarSessao({origem:'importacao',entradas:['importacao']}).id;s.consentir(id,{entradas:['importacao'],confirmar:true});
    const controller=new AbortController(),header=cabecalhoWav(61*32000),primeira=Buffer.alloc(60*32000);
    const req={headers:{},complete:false,async *[Symbol.asyncIterator](){yield header;yield primeira;controller.abort();yield Buffer.alloc(32000);}};
    await assert.rejects(importarArquivo(req,{servico:s,sessaoId:id,signal:controller.signal}),/cancelada/);
    assert.equal(s.estado(id).partes.length,1);assert.equal(s.estado(id).importacao,'incompleta');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notetaker_fontes').get().n,0);
    const orphan=randomUUID(),audio=join(root,'notetaker-audio',orphan+'.wav'),journal=audio+'.journal';
    await writeFile(audio,Buffer.from('órfão'));
    await writeFile(journal,JSON.stringify({parteId:orphan,sessaoId:id,nome:orphan+'.wav',sha256:'0'.repeat(64)}));
    new NotetakerServico(db,opts);
    await assert.rejects(access(audio));await assert.rejects(access(journal));
    const id2=s.criarSessao({origem:'importacao',entradas:['importacao']}).id;s.consentir(id2,{entradas:['importacao'],confirmar:true});
    const disco={...s,autorizada:s.autorizada.bind(s),iniciarImportacao:s.iniciarImportacao.bind(s),marcarImportacao:s.marcarImportacao.bind(s),guardarParte(){throw Object.assign(new Error('disco cheio'),{code:'ENOSPC'});}};
    const req2={headers:{},complete:true,async *[Symbol.asyncIterator](){yield cabecalhoWav(32000);yield Buffer.alloc(32000);}};
    await assert.rejects(importarArquivo(req2,{servico:disco,sessaoId:id2}),/disco cheio/);
    assert.equal(s.estado(id2).importacao,'incompleta');
  }finally{db?.close();if(old===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=old;await rm(root,{recursive:true,force:true});}
});

test('schema legado/parcial falha fechado e perfil sem injeção não inicia',async()=>{
  const antigo=new DatabaseSync(':memory:');assert.equal(leituraFonteSql(antigo),LEITURA_SQL);
  antigo.exec('CREATE TABLE notetaker_sessoes(id TEXT,consentimento_em TEXT,direitos_revogados_em TEXT,excluida_em TEXT,estado TEXT)');
  assert.equal(leituraFonteSql(antigo),LEITURA_SQL);antigo.close();
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-')),marker='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try{
    await writeFile(join(root,'.lume-notetaker-test'),marker);
    const db=abrirBanco(join(root,'db.sqlite'));
    assert.throws(()=>new NotetakerServico(db,{notetakerExperimento:true,testProfileRoot:root,testMarker:marker}),/indisponível/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notetaker_sessoes').get().n,0);
    db.close();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('DB fora do perfil é recusado antes de criar tabelas ou arquivos locais',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-')),outro=await mkdtemp(join(tmpdir(),'lume-banco-'));
  const marker=randomUUID(),old=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;
  let db;
  try{
    await writeFile(join(root,'.lume-notetaker-test'),marker);
    db=new DatabaseSync(join(outro,'externo.sqlite'));
    assert.throws(()=>new NotetakerServico(db,{notetakerExperimento:true,testProfileRoot:root,testMarker:marker}),/Banco fora/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'notetaker_%'").get().n,0);
    await assert.rejects(access(join(root,'notetaker-audio')));
  }finally{db?.close();if(old===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=old;await rm(root,{recursive:true,force:true});await rm(outro,{recursive:true,force:true});}
});

test('audioRoot, journal e original simbólicos são recusados',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-')),outside=await mkdtemp(join(tmpdir(),'lume-symlink-target-'));
  const marker=randomUUID(),old=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;
  let db;
  try{
    await writeFile(join(root,'.lume-notetaker-test'),marker);
    const opts={notetakerExperimento:true,testProfileRoot:root,testMarker:marker};
    db=new DatabaseSync(join(root,'db.sqlite'));
    try{await symlink(outside,join(root,'notetaker-audio'),'junction');}
    catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlink não permitido neste Windows.');return;}throw e;}
    assert.throws(()=>new NotetakerServico(db,opts));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'notetaker_%'").get().n,0);
    await unlink(join(root,'notetaker-audio'));
    db.close();db=abrirBanco(join(root,'db.sqlite'));
    const s=new NotetakerServico(db,opts),id=s.criarSessao({origem:'importacao',entradas:['importacao']}).id;
    s.consentir(id,{entradas:['importacao'],confirmar:true});
    const wav=Buffer.concat([cabecalhoWav(32),Buffer.alloc(32)]),part=s.guardarParte(id,{posicao:0,bytes:wav});
    const path=join(root,'notetaker-audio',part.id+'.wav');
    await unlink(path);await symlink(outside,path,'junction');
    await assert.rejects(s.audio(part.id));
    await unlink(path);
    const journal=join(root,'notetaker-audio',randomUUID()+'.journal');
    await symlink(outside,journal,'junction');
    assert.throws(()=>new NotetakerServico(db,opts),/ponteiro simbólico/);
  }finally{db?.close();if(old===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=old;await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('banco legado somente leitura mantém consultas sem tabelas locais',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-'));
  try{
    const path=join(root,'antigo.sqlite'),db=abrirBanco(path);
    new ContextoApp(db);new Desktop(db);
    for(const t of ['notetaker_fontes','notetaker_trechos','notetaker_partes','notetaker_sessoes'])db.exec(`DROP TABLE ${t}`);
    assert.equal(leituraFonteSql(db),LEITURA_SQL);
    assert.doesNotThrow(()=>new Desktop(db));assert.doesNotThrow(()=>new ContextoApp(db));
    db.close();
    const ro=new DatabaseSync(path,{readOnly:true});
    try{
      assert.equal(leituraFonteSql(ro),LEITURA_SQL);
      assert.equal(new LumeMcpReadService(ro).fonte(1,{kind:'all'}),null);
    }finally{ro.close();}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('posição em lacuna é recusada, retry conflitante não substitui e privacidade fecha v8',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-')),marker='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',old=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  let db;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;
  try{
    await writeFile(join(root,'.lume-notetaker-test'),marker);
    db=abrirBanco(join(root,'db.sqlite'));const s=new NotetakerServico(db,{notetakerExperimento:true,testProfileRoot:root,testMarker:marker});
    const id=s.criarSessao({origem:'importacao',entradas:['importacao']}).id;s.consentir(id,{entradas:['importacao'],confirmar:true});
    const wav=Buffer.concat([cabecalhoWav(2),Buffer.alloc(2)]);
    assert.throws(()=>s.guardarParte(id,{posicao:1,bytes:wav}),/lacuna/);
    s.guardarParte(id,{posicao:0,bytes:wav});
    const outro=Buffer.from(wav);outro[44]=1;
    assert.throws(()=>s.guardarParte(id,{posicao:0,bytes:outro}),/diferentes/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notetaker_partes').get().n,1);
    assert.throws(()=>new Privacidade(db).schemaConhecido(),/v9/);
  }finally{db?.close();if(old===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=old;await rm(root,{recursive:true,force:true});}
});
