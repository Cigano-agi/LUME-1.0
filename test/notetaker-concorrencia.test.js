import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,readdir,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {NotetakerServico} from '../src/notetaker/servico.js';
import {cabecalhoWav} from '../src/notetaker/contrato.js';
import {importarArquivo} from '../src/notetaker/importacao.js';
import {criarAudioLocalRuntime} from '../src/audio-local-runtime.js';
import {LumeMcpReadService} from '../src/mcp/read-service.js';
import {prepararIndiceFontes} from '../src/fontes-desktop.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
const wav=(segundos,fill=0)=>Buffer.concat([cabecalhoWav(segundos*32000),Buffer.alloc(segundos*32000,fill)]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function saida(args,texto='gerado',inicio=0){
  await writeFile(args[args.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'pt'},transcription:[{offsets:{from:inicio,to:900},text:texto}]}));
}
async function fixture(runner=(_bin,args)=>saida(args),extra={}){
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-test-'));
  const marker=randomUUID(),before=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;
  await writeFile(join(root,'.lume-notetaker-test'),marker);
  const bundle=join(root,'bundle');await mkdir(bundle);
  const binary=Buffer.from('synthetic executable'),model=Buffer.from('synthetic model');
  const manifest={versao:1,motor:'whisper.cpp',versaoMotor:'test-1',plataforma:process.platform,arquitetura:process.arch,modeloNome:'synthetic',executavelBytes:binary.length,executavelSha256:hash(binary),modeloBytes:model.length,modeloSha256:hash(model)};
  await writeFile(join(bundle,process.platform==='win32'?'whisper-cli.exe':'whisper-cli'),binary);
  await writeFile(join(bundle,'modelo.bin'),model);
  const manifestBytes=Buffer.from(JSON.stringify(manifest));await writeFile(join(bundle,'manifest.json'),manifestBytes);
  const audioLocal=criarAudioLocalRuntime({raiz:bundle,manifestoSha256:hash(manifestBytes),runner});
  const db=abrirBanco(join(root,'db.sqlite'));new ContextoApp(db);new Desktop(db);
  const opts={notetakerExperimento:true,testProfileRoot:root,testMarker:marker,audioLocal,...extra};
  const s=new NotetakerServico(db,opts);
  function session(){const id=s.criarSessao({origem:'importacao',entradas:['importacao']}).id;s.consentir(id,{entradas:['importacao'],confirmar:true});return id;}
  async function close(){db.close();if(before===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=before;await rm(root,{recursive:true,force:true});}
  return {root,db,s,opts,session,close};
}
function upload(s,id,bytes){return importarArquivo({headers:{},complete:true,async *[Symbol.asyncIterator](){yield bytes;}},{servico:s,sessaoId:id});}

test('corte durante ASR impede publicação tardia de fontes e trechos',async()=>{
  const controller=new AbortController();
  let continuar,entrou,runnerTerminou=false;
  const gate=new Promise(resolve=>{continuar=resolve;}),started=new Promise(resolve=>{entrou=resolve;});
  const f=await fixture(async(_binary,args,{signal}={})=>{
    assert.strictEqual(signal,controller.signal);
    entrou();await gate;
    assert.equal(signal.aborted,true);
    runnerTerminou=true;
    await saida(args);
  },{signal:controller.signal});
  try{
    const id=f.session();await upload(f.s,id,wav(1,1));
    const job=f.s.transcreverImportacao(id);
    await started;
    controller.abort();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runnerTerminou,false,'job permanece em drain enquanto runner não encerra');
    continuar();
    await assert.rejects(job,e=>e.code==='CANCELADO');
    assert.equal(runnerTerminou,true);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_fontes WHERE sessao_id=?').get(id).n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_trechos').get().n,0);
  }finally{continuar();await f.close();}
});

test('lease recusa segundo upload antes de await e não rebaixa conclusão',async()=>{
  const f=await fixture();
  try{
    const id=f.session();let resume,ready;const gate=new Promise(r=>resume=r),reached=new Promise(r=>ready=r);
    const slow={headers:{},complete:true,async *[Symbol.asyncIterator](){yield cabecalhoWav(32000);ready();await gate;yield Buffer.alloc(32000,1);}};
    const first=importarArquivo(slow,{servico:f.s,sessaoId:id});await reached;
    await assert.rejects(upload(f.s,id,wav(1,2)),e=>e.code==='CONFLITO');
    resume();await first;
    assert.equal(f.s.estado(id).importacao,'completa');
    assert.equal(f.s.estado(id).partes.length,1);
  }finally{await f.close();}
});

test('retry completo só verifica: mesmo hash é idempotente e prefixo maior não altera nada',async()=>{
  const f=await fixture();
  try{
    prepararIndiceFontes(f.db);
    for(const maior of [61,120]){
      const id=f.session(),original=wav(60,1),part=(await upload(f.s,id,original)).partes[0];
      assert.equal((await f.s.transcreverImportacao(id)).estado,'concluida');
      const snapshot=async()=>({
        state:f.s.estado(id),
        rows:f.db.prepare('SELECT id,posicao,sha256,caminho FROM notetaker_partes WHERE sessao_id=? ORDER BY posicao').all(id),
        sources:f.db.prepare('SELECT evento_id,audio_sha256 FROM notetaker_fontes WHERE sessao_id=? ORDER BY evento_id').all(id),
        fts:f.db.prepare("SELECT COUNT(*) n FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH 'gerado'").get().n,
        files:(await readdir(join(f.root,'notetaker-audio'))).sort()
      });
      const before=await snapshot();
      const same=await upload(f.s,id,original);
      assert.deepEqual(same.partes.map(p=>p.id),[part.id]);assert.ok(same.partes.every(p=>p.repetida));
      assert.deepEqual(await snapshot(),before,'retry idêntico não altera revisão/DB/arquivos');
      await assert.rejects(upload(f.s,id,wav(maior,1)),e=>e.code==='CONFLITO');
      assert.deepEqual(await snapshot(),before,`retry maior ${maior}s deixou estado/partes/fontes imutáveis`);
    }
  }finally{await f.close();}
});

test('retry completo menor com prefixo idêntico não altera sessão de 61s',async()=>{
  const f=await fixture();
  try{
    const id=f.session();await upload(f.s,id,wav(61,1));
    const before=f.s.estado(id),files=(await readdir(join(f.root,'notetaker-audio'))).sort();
    await assert.rejects(upload(f.s,id,wav(60,1)),e=>e.code==='CONFLITO');
    assert.deepEqual(f.s.estado(id),before);
    assert.deepEqual((await readdir(join(f.root,'notetaker-audio'))).sort(),files);
  }finally{await f.close();}
});

test('original sparse acima do teto é recusado antes da leitura integral',async()=>{
  const f=await fixture();
  try{
    const id=f.session(),part=(await upload(f.s,id,wav(1,1))).partes[0];
    assert.equal((await f.s.transcreverImportacao(id)).estado,'concluida');
    const file=join(f.root,'notetaker-audio',part.id+'.wav'),fd=await open(file,'w');
    try{await fd.truncate(60*32000+45);}finally{await fd.close();}
    await assert.rejects(f.s.audio(part.id),/excede o tamanho gerido/);
    const evento=f.db.prepare('SELECT evento_id FROM notetaker_fontes WHERE parte_id=?').get(part.id).evento_id;
    assert.equal(new LumeMcpReadService(f.db).fonte(evento,{kind:'all'}),null);
  }finally{await f.close();}
});

test('falha na segunda parte não publica fontes; retry sincroniza gerado, tempo e FTS',async()=>{
  let calls=0,round=1;
  const f=await fixture(async(_binary,args)=>{calls++;if(calls===2)throw Error('falha segunda parte');await saida(args,round===1?'primeiro gerado':'novo gerado',round===1?0:100);});
  try{
    prepararIndiceFontes(f.db);
    const id=f.session();await upload(f.s,id,wav(61,1));
    assert.equal((await f.s.transcreverImportacao(id)).estado,'falha');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_fontes WHERE sessao_id=?').get(id).n,0);
    assert.equal(new LumeMcpReadService(f.db).fontes({scope:{kind:'all'},limit:10}).rows.length,0);
    round=2;assert.equal((await f.s.transcreverImportacao(id)).estado,'concluida');
    const atual=f.db.prepare('SELECT t.inicio_ms,t.texto_gerado,t.texto_corrigido,e.texto,f.inicio_ms fonte_inicio FROM notetaker_trechos t JOIN notetaker_fontes f ON f.trecho_id=t.id JOIN eventos e ON e.id=f.evento_id WHERE f.sessao_id=? ORDER BY f.inicio_ms LIMIT 1').get(id);
    assert.deepEqual({...atual},{inicio_ms:100,texto_gerado:'novo gerado',texto_corrigido:null,texto:'novo gerado',fonte_inicio:100});
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_fontes WHERE sessao_id=?').get(id).n,2);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH 'primeiro'").get().n,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH 'novo'").get().n,2);
  }finally{await f.close();}
});

test('retry recusa republicar geração e tempo após correção humana',async()=>{
  let round=1;const f=await fixture((_binary,args)=>saida(args,round===1?'primeiro gerado':'novo gerado',round===1?0:100));
  try{
    const id=f.session();await upload(f.s,id,wav(1,1));assert.equal((await f.s.transcreverImportacao(id)).estado,'concluida');
    const row=f.db.prepare('SELECT f.evento_id,t.id trecho_id FROM notetaker_fontes f JOIN notetaker_trechos t ON t.id=f.trecho_id WHERE f.sessao_id=?').get(id);
    f.db.prepare('UPDATE notetaker_trechos SET texto_corrigido=?,ator_correcao=? WHERE id=?').run('correção humana','humano',row.trecho_id);
    f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('correção humana',row.evento_id);
    f.db.prepare("UPDATE notetaker_sessoes SET asr_estado='falha' WHERE id=?").run(id);
    assert.equal(new LumeMcpReadService(f.db).fonte(row.evento_id,{kind:'all'}),null);
    round=2;assert.equal((await f.s.transcreverImportacao(id)).estado,'falha');
    const atual=f.db.prepare('SELECT t.inicio_ms,t.texto_gerado,t.texto_corrigido,e.texto,f.inicio_ms fonte_inicio FROM notetaker_trechos t JOIN notetaker_fontes f ON f.trecho_id=t.id JOIN eventos e ON e.id=f.evento_id WHERE t.id=?').get(row.trecho_id);
    assert.deepEqual({...atual},{inicio_ms:0,texto_gerado:'primeiro gerado',texto_corrigido:'correção humana',texto:'correção humana',fonte_inicio:0});
  }finally{await f.close();}
});

test('mudança do áudio durante await ASR impede publicação',async()=>{
  let f,partId;
  f=await fixture(async(_binary,args)=>{await writeFile(join(f.root,'notetaker-audio',partId+'.wav'),wav(1,9));await saida(args);});
  try{
    const id=f.session();partId=(await upload(f.s,id,wav(1,1))).partes[0].id;
    assert.equal((await f.s.transcreverImportacao(id)).estado,'falha');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_fontes WHERE sessao_id=?').get(id).n,0);
  }finally{await f.close();}
});

test('mudança posterior do áudio fecha fonte, busca e revalidação MCP',async()=>{
  const f=await fixture();
  try{
    const id=f.session(),part=(await upload(f.s,id,wav(1,1))).partes[0];
    assert.equal((await f.s.transcreverImportacao(id)).estado,'concluida');
    const evento=f.db.prepare('SELECT evento_id FROM notetaker_fontes WHERE sessao_id=?').get(id).evento_id;
    const mcp=new LumeMcpReadService(f.db),source=mcp.fonte(evento,{kind:'all'});
    assert.ok(source);assert.equal(mcp.revalidar(source,{kind:'all'}),true);
    await writeFile(join(f.root,'notetaker-audio',part.id+'.wav'),wav(1,9));
    assert.equal(mcp.fonte(evento,{kind:'all'}),null);
    assert.equal(mcp.fontes({scope:{kind:'all'},limit:10}).rows.length,0);
    assert.equal(mcp.revalidar(source,{kind:'all'}),false);
    const noRoot={prepare(sql){if(sql==='PRAGMA database_list')return {all:()=>[]};return f.db.prepare(sql);}};
    assert.equal(new LumeMcpReadService(noRoot).fonte(evento,{kind:'all'}),null);
    const novoHash=hash(wav(1,9));
    f.db.prepare('UPDATE notetaker_partes SET sha256=? WHERE id=?').run(novoHash,part.id);
    f.db.prepare('UPDATE notetaker_fontes SET audio_sha256=?,inicio_ms=100,revisao=revisao+1 WHERE evento_id=?').run(novoHash,evento);
    assert.ok(mcp.fonte(evento,{kind:'all'}),'hash atualizado torna a fonte verificável de novo');
    assert.equal(mcp.revalidar(source,{kind:'all'}),false,'token antigo deve refletir hash/tempo da fonte');
  }finally{await f.close();}
});

test('reserva ASR recusa segundo job na mesma sessão e em outra sessão',async()=>{
  for(const same of [true,false]){
    let release,active=0,peak=0,calls=0;const gate=new Promise(r=>release=r);
    const f=await fixture(async(_binary,args)=>{calls++;peak=Math.max(peak,++active);await gate;await saida(args);active--;});
    try{
      const id=f.session();await upload(f.s,id,wav(1,1));
      const other=same?id:f.session();if(!same)await upload(f.s,other,wav(1,2));
      const first=f.s.transcreverImportacao(id);await sleep(100);
      const second=f.s.transcreverImportacao(other).then(v=>v,e=>e);
      await sleep(100);release();const result=await second;assert.equal(result.code,'CONFLITO');
      assert.equal((await first).estado,'concluida');assert.equal(calls,1);assert.equal(peak,1);
    }finally{release();await f.close();}
  }
});

test('falha de sync do diretório preserva journal e não emite recibo enganoso',async()=>{
  const e=Object.assign(new Error('disco sintético'),{code:'EIO'});
  const f=await fixture(undefined,{sincronizarDiretorio:()=>{throw e;}});
  try{
    const id=f.session();
    await assert.rejects(upload(f.s,id,wav(1,1)),x=>x.code==='EIO');
    assert.equal(f.s.estado(id).importacao,'incompleta');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_partes').get().n,0);
    assert.equal((await readdir(join(f.root,'notetaker-audio'))).filter(n=>n.endsWith('.journal')).length,1);
  }finally{await f.close();}
});

test('fsync de diretório indisponível no Windows mantém journal até restart verificado', {skip:process.platform!=='win32'},async()=>{
  const e=Object.assign(new Error('diretório sem fsync'),{code:'EPERM'});
  const f=await fixture(undefined,{sincronizarDiretorio:()=>{throw e;}});
  try{
    const id=f.session(),receipt=await upload(f.s,id,wav(1,1));
    assert.equal(receipt.partes[0].durabilidade,'reinicio_pendente');
    assert.equal(f.s.estado(id).partes[0].durabilidade,'reinicio_pendente');
    assert.equal((await readdir(join(f.root,'notetaker-audio'))).filter(n=>n.endsWith('.journal')).length,1);
    new NotetakerServico(f.db,f.opts);
    assert.equal((await readdir(join(f.root,'notetaker-audio'))).filter(n=>n.endsWith('.journal')).length,0);
    assert.equal(f.s.estado(id).partes[0].durabilidade,'verificada');
  }finally{await f.close();}
});

test('revogação e exclusão durante ASR não publicam fontes',async()=>{
  for(const change of ['revogar','excluir']){
    let f,id;
    f=await fixture(async(_binary,args)=>{
      if(change==='revogar')f.db.prepare('UPDATE notetaker_sessoes SET direitos_revogados_em=? WHERE id=?').run(new Date().toISOString(),id);
      else f.db.prepare('DELETE FROM notetaker_sessoes WHERE id=?').run(id);
      await saida(args);
    });
    try{
      id=f.session();await upload(f.s,id,wav(1,1));
      assert.equal((await f.s.transcreverImportacao(id)).estado,'falha');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_fontes').get().n,0);
    }finally{await f.close();}
  }
});

test('job ASR antigo não publica nem marca nova reserva como falha após reinício',async()=>{
  let liberar,chegou;const gate=new Promise(r=>liberar=r),atual=new Promise(r=>chegou=r);
  const f=await fixture(async(_binary,args)=>{chegou();await gate;await saida(args,'resposta antiga');});
  try{
    const id=f.session();await upload(f.s,id,wav(1,1));
    const primeiro=f.s.transcreverImportacao(id);await atual;
    const reservaAntiga=f.db.prepare('SELECT revisao FROM notetaker_sessoes WHERE id=?').get(id).revisao;
    f.db.prepare("UPDATE notetaker_sessoes SET asr_estado='interrompida' WHERE id=?").run(id);
    const nova=f.db.prepare("UPDATE notetaker_sessoes SET asr_estado='em_curso',revisao=revisao+1 WHERE id=? AND asr_estado='interrompida' RETURNING revisao").get(id).revisao;
    assert.equal(nova,reservaAntiga+1);
    liberar();assert.equal((await primeiro).estado,'falha');
    assert.equal(f.db.prepare('SELECT asr_estado FROM notetaker_sessoes WHERE id=?').get(id).asr_estado,'em_curso');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_fontes WHERE sessao_id=?').get(id).n,0);
  }finally{liberar();await f.close();}
});

test('reserva ASR recusa revisão no teto sem alterar estado ou fontes',async()=>{
  const f=await fixture();
  try{
    const id=f.session();await upload(f.s,id,wav(1,1));
    f.db.prepare('UPDATE notetaker_sessoes SET revisao=9007199254740991 WHERE id=?').run(id);
    const anterior=f.db.prepare('SELECT asr_estado,revisao FROM notetaker_sessoes WHERE id=?').get(id);
    await assert.rejects(f.s.transcreverImportacao(id),{code:'CONFLITO'});
    assert.deepEqual(f.db.prepare('SELECT asr_estado,revisao FROM notetaker_sessoes WHERE id=?').get(id),anterior);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_fontes WHERE sessao_id=?').get(id).n,0);
  }finally{await f.close();}
});
