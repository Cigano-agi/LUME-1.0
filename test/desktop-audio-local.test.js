import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {DesktopAudio} from '../src/desktop-audio.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {criarAudioLocalRuntime} from '../src/audio-local-runtime.js';
import {lerTranscricaoTransferencia,gravarTranscricaoTransferida,validarTranscricaoTransferencia} from '../src/transcricao-transferencia.js';
import {validarMetadadosAudio} from '../src/audio-desktop-arquivos.js';
import {Backup} from '../src/backup.js';
import {Privacidade} from '../src/privacidade.js';
import {wav as silencio} from './fixtures/audio-wav.js';
// A nonzero sample exercises the mocked ASR instead of digital-silence detection.
function wav(){const bytes=silencio();bytes.writeInt16LE(1,44);return bytes;}

const hash=s=>createHash('sha256').update(s).digest('hex');
function pacote(t){
  const raiz=mkdtempSync(join(tmpdir(),'lume-audio-runtime-'));t.after(()=>rmSync(raiz,{recursive:true,force:true}));
  const binary=Buffer.from('executavel-sintetico'),weights=Buffer.from('modelo-sintetico');
  const manifesto={versao:1,motor:'whisper.cpp',versaoMotor:'teste-1',plataforma:process.platform,arquitetura:process.arch,
    modeloNome:'modelo-teste',executavelBytes:binary.length,executavelSha256:hash(binary),modeloBytes:weights.length,modeloSha256:hash(weights)};
  writeFileSync(join(raiz,process.platform==='win32'?'whisper-cli.exe':'whisper-cli'),binary);writeFileSync(join(raiz,'modelo.bin'),weights);
  const bytes=JSON.stringify(manifesto);writeFileSync(join(raiz,'manifest.json'),bytes);
  return {raiz,manifestoSha256:hash(bytes)};
}
function fixture(t,{runner,agora}={}){
  const config=pacote(t),dir=mkdtempSync(join(tmpdir(),'lume-audio-local-')),db=abrirBanco();
  new ContextoApp(db);new Desktop(db);const arquivos=new ArquivosDados(dir);let chamadas=0,chaves=0;
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const ia=new DesktopIA(db,{segredos:{estado:async()=>({configurada:false,disponivel:false}),ler:async()=>{chaves++;throw new Error('não deve ler chave');}}});
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('sintetica','Conversa sintética');
  const fonte=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('sintetica','audio-1','entrada','audio','{}',NULL,'2026-09-25T18:00:00Z','2026-09-25','dirigida')`).run().lastInsertRowid);
  const chamadasRuntime=[];
  const runtime=criarAudioLocalRuntime({...config,runner:async(binary,args,opts)=>{
    chamadasRuntime.push({binary,args,opts});
    if(runner)return runner(binary,args,opts);
    writeFileSync(args[args.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'pt'},transcription:[{offsets:{from:0,to:900},text:' Rever proposta amanhã.'}]}));
  }});
  const audio=new DesktopAudio(db,{ia,arquivos,audioLocal:runtime,agora,gerar:async()=>{chamadas++;throw new Error('rede proibida');}});
  const preparar=(extra={})=>audio.preparar({fonte,base64:wav().toString('base64'),nome:'Sintético.wav',confirmarVinculo:true,motor:'local',...extra});
  return {db,audio,ia,arquivos,fonte,config,runtime,chamadasRuntime,preparar,remoto:()=>({chamadas,chaves})};
}

test('áudio local: sem chave ou opt-in externo, executa runner determinístico e persiste fonte/hash/segmentos',async t=>{
  const e=fixture(t),estado=await e.audio.estado();assert.equal(estado.padrao,'local');assert.equal(estado.motores.local.disponivel,true);assert.equal(estado.motores.gemini.disponivel,false);
  const p=await e.preparar();assert.equal(p.motor,'local');assert.equal(p.reservaUSD,0);assert.equal(e.chamadasRuntime.length,0);
  const r=await e.audio.transcrever({id:p.id,confirmar:true});assert.equal(r.fonte,e.fonte);assert.equal(r.qualidade,'nao_validada');
  assert.deepEqual(e.remoto(),{chamadas:0,chaves:0});assert.equal(e.ia.gasto(),0);
  const row=e.db.prepare('SELECT * FROM transcricoes').get(),m=JSON.parse(row.audio_metadados_json);
  assert.equal(row.texto,'Rever proposta amanhã.');assert.equal(m.audioSha256,hash(wav()));assert.equal(m.fonte.origemId,'audio-1');assert.equal(m.trechos[0].inicioMs,0);assert.equal(m.consentimento.tipo,'processamento_local');assert.equal(validarMetadadosAudio(m),true);
  assert.deepEqual(readFileSync(row.arquivo),wav());assert.equal(e.db.prepare('SELECT texto FROM eventos').get().texto,null);
  const call=e.chamadasRuntime[0];assert.equal(call.args[call.args.indexOf('-t')+1],'2');assert.equal(call.args[call.args.indexOf('-p')+1],'1');assert(call.args.includes('-ng'));assert.equal(call.opts.timeoutMs,360000);assert.equal(existsSync(call.opts.cwd),false);
  await assert.rejects(()=>e.audio.transcrever({id:p.id,confirmar:true}),/ausente/);assert.equal(e.db.prepare('SELECT count(*) n FROM transcricoes').get().n,1);
});

test('áudio local: ausência ou adulteração de pacote confiável bloqueia sem fallback',async t=>{
  const semConfig=await criarAudioLocalRuntime().estado();assert.equal(semConfig.disponivel,false);assert.match(semConfig.motivo,/manifesto/);
  const e=fixture(t);writeFileSync(join(e.config.raiz,'modelo.bin'),'modelo-adulterado');
  assert.equal((await e.runtime.estado()).disponivel,false);await assert.rejects(()=>e.preparar(),/Integridade/);assert.deepEqual(e.remoto(),{chamadas:0,chaves:0});
  assert.equal(e.chamadasRuntime.length,0);
  const extra=fixture(t);writeFileSync(join(extra.config.raiz,'ggml.dll'),'biblioteca-nao-pinada');assert.equal((await extra.runtime.estado()).disponivel,false);
});

test('áudio local: silêncio digital preserva motivo sem executar ASR e metadados têm contrato fechado',async t=>{
  const e=fixture(t),p=await e.preparar({base64:silencio().toString('base64')});
  const r=await e.audio.transcrever({id:p.id,confirmar:true});
  assert.equal(e.chamadasRuntime.length,0);assert.equal(r.metadados.inferenciaExecutada,false);
  assert.equal(r.metadados.motivoSemFala,'silencio_digital_pcm_zero');assert.match(r.aviso,/silêncio digital/);
  const row=e.db.prepare('SELECT * FROM transcricoes').get(),meta=JSON.parse(row.audio_metadados_json);
  assert.equal(row.texto,null);assert.equal(validarMetadadosAudio(meta),true);
  assert.equal(meta.analiseSinal.totalAmostras,16000);assert.equal(meta.analiseSinal.duracaoAudioMs,1000);
  for(const mutate of [m=>m.inferenciaExecutada=true,m=>delete m.analiseSinal,m=>m.analiseSinal.totalAmostras++,m=>m.analiseSinal.outro='não permitido',m=>m.motivoSemFala='qualidade_aprovada']){
    const invalid=structuredClone(meta);mutate(invalid);assert.throws(()=>validarMetadadosAudio(invalid),/Metadados/);
  }
  assert.deepEqual(e.remoto(),{chamadas:0,chaves:0});
});

test('áudio local: ASR vazio não é apresentado como prova física de silêncio',async t=>{
  const e=fixture(t,{runner:async(binary,args)=>writeFileSync(args[args.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'pt'},transcription:[]}))});
  const p=await e.preparar(),r=await e.audio.transcrever({id:p.id,confirmar:true});
  assert.equal(e.chamadasRuntime.length,1);assert.equal(r.metadados.inferenciaExecutada,true);
  assert.equal(r.metadados.analiseSinal.silencioDigital,false);assert.equal(r.metadados.motivoSemFala,'motor_sem_trechos');
  assert.match(r.aviso,/não comprova silêncio/);assert.equal(r.qualidade,'nao_validada');
});

test('áudio local: configuração não vem do renderer e motor da prévia não pode mudar na confirmação',async t=>{
  const e=fixture(t);
  assert.throws(()=>e.preparar({executavel:'C:/outro.exe'}),/Parâmetros/);
  assert.throws(()=>e.preparar({confirmarVinculo:false}),/Confira/);
  assert.throws(()=>e.preparar({motor:'automatico'}),/Escolha/);
  const p=await e.preparar();await assert.rejects(()=>e.audio.transcrever({id:p.id,confirmar:true,motor:'gemini'}),/trocar/);
  await assert.rejects(()=>e.audio.transcrever({id:p.id,confirmar:false}),/Confirme/);
  assert.equal(e.audio.cancelar({id:p.id}).cancelada,true);await assert.rejects(()=>e.audio.transcrever({id:p.id,confirmar:true}),/ausente/);
});

test('áudio local: fonte exata e revisão são conferidas antes da execução; substituição de prévia é única',async t=>{
  const e=fixture(t),p=await e.preparar(),q=await e.preparar();
  await assert.rejects(()=>e.audio.transcrever({id:p.id,confirmar:true}),/ausente/);
  e.db.exec("UPDATE eventos SET bruto='alterado'");
  await assert.rejects(()=>e.audio.transcrever({id:q.id,confirmar:true}),/mudou/);assert.equal(e.chamadasRuntime.length,0);
  e.db.exec("UPDATE eventos SET permissao='terceiro'");await assert.rejects(()=>e.preparar(),/revogado/);
});

test('áudio local: cancelar/revogar/excluir/alterar durante runner que ignora abort não aplica retorno tardio',async t=>{
  for(const acao of ['cancelar','revogar','excluir','alterar']){
    let ready,release;const iniciou=new Promise(r=>ready=r),aguarda=new Promise(r=>release=r);
    const e=fixture(t,{runner:async(binary,args,opts)=>{ready();await aguarda;writeFileSync(args[args.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'pt'},transcription:[{offsets:{from:0,to:500},text:'Não aplicar.'}]}));}});
    const p=await e.preparar(),pending=e.audio.transcrever({id:p.id,confirmar:true});await iniciou;
    assert.throws(()=>e.preparar(),/Aguarde/);await assert.rejects(()=>e.audio.transcrever({id:p.id,confirmar:true}),/andamento/);
    if(acao==='cancelar')e.audio.cancelar({id:p.id});
    if(acao==='revogar')e.db.exec("UPDATE eventos SET permissao='terceiro'");
    if(acao==='excluir')e.db.exec('DELETE FROM eventos');
    if(acao==='alterar')e.db.exec("UPDATE eventos SET texto='fonte mudou'");
    release();await assert.rejects(()=>pending,/cancelada|mudou|revogada/);
    assert.equal(e.db.prepare('SELECT count(*) n FROM transcricoes').get().n,0);assert.equal(e.arquivos.listarAnexos().length,0);assert.deepEqual(e.remoto(),{chamadas:0,chaves:0});
    assert.equal(existsSync(e.chamadasRuntime[0].opts.cwd),false);
  }
});

test('áudio local: pacote alterado depois da prévia, expiração e falha preservam transcrição anterior',async t=>{
  let clock=new Date('2026-09-25T18:00:00Z');const e=fixture(t,{agora:()=>clock});
  const p=await e.preparar();await e.audio.transcrever({id:p.id,confirmar:true});const old=e.db.prepare('SELECT * FROM transcricoes').get();
  const q=await e.preparar();clock=new Date(clock.getTime()+300001);await assert.rejects(()=>e.audio.transcrever({id:q.id,confirmar:true}),/expirou/);
  const s=await e.preparar();writeFileSync(join(e.config.raiz,'modelo.bin'),'alterado');await assert.rejects(()=>e.audio.transcrever({id:s.id,confirmar:true}),/Integridade/);
  assert.deepEqual(e.db.prepare('SELECT * FROM transcricoes').get(),old);assert.equal(existsSync(old.arquivo),true);assert.equal(e.arquivos.listarAnexos().length,1);
});

test('áudio local: proveniência sobrevive transferência e metadados falsos são rejeitados',async t=>{
  const a=fixture(t),b=fixture(t),p=await a.preparar();await a.audio.transcrever({id:p.id,confirmar:true});
  const evento=a.db.prepare('SELECT * FROM eventos').get(),transcricao=lerTranscricaoTransferencia(a.db,evento);
  gravarTranscricaoTransferida(b.db,{conversa_id:evento.conversa_id,origem_id:evento.origem_id,transcricao});
  assert.deepEqual(JSON.parse(b.db.prepare('SELECT audio_metadados_json FROM transcricoes').get().audio_metadados_json),transcricao.metadadosAudio);
  const falso=structuredClone(transcricao);falso.metadadosAudio.qualidade='aprovada';assert.throws(()=>validarTranscricaoTransferencia(falso),/Metadados/);
  const antigo={...transcricao};delete antigo.metadadosAudio;validarTranscricaoTransferencia(antigo);
  gravarTranscricaoTransferida(b.db,{conversa_id:evento.conversa_id,origem_id:evento.origem_id,transcricao:antigo});assert.equal(b.db.prepare('SELECT audio_metadados_json FROM transcricoes').get().audio_metadados_json,null);
});

test('áudio local: cancelar a preparação assíncrona libera a prévia sem executar motor',async t=>{
  const e=fixture(t);let ready,release;const iniciado=new Promise(r=>ready=r),aguardar=new Promise(r=>release=r);
  e.audio.audioLocal={estado:async()=>{ready();await aguardar;return e.runtime.estado();},transcrever:(...args)=>e.runtime.transcrever(...args)};
  const preparando=e.preparar();await iniciado;
  assert.throws(()=>e.preparar(),/Aguarde/);assert.equal(e.audio.cancelar({id:e.audio.preparandoLocal.id}).cancelada,true);
  release();await assert.rejects(()=>preparando,/cancelada/);assert.equal(e.audio.previaLocal,null);assert.equal(e.chamadasRuntime.length,0);
});

test('áudio local: backup em receptor sem painel de áudio preserva proveniência; exclusão apaga texto e anexo',async t=>{
  const a=fixture(t),p=await a.preparar();await a.audio.transcrever({id:p.id,confirmar:true});
  const expected=JSON.parse(a.db.prepare('SELECT audio_metadados_json FROM transcricoes').get().audio_metadados_json);
  const dir=mkdtempSync(join(tmpdir(),'lume-audio-restauro-')),db=abrirBanco();new ContextoApp(db);new Desktop(db);new DesktopIA(db);
  const arquivos=new ArquivosDados(dir);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const senha='senha-sintetica-audio-local',backup=new Backup(a.db,{arquivos:a.arquivos}),receiver=new Backup(db,{arquivos});
  const exportado=await backup.criar({senha,confirmar:true}),previa=await receiver.preparar({arquivo:JSON.stringify(exportado.pacote),senha});
  receiver.restaurar({id:previa.id,confirmarMeuBackup:true});
  assert.deepEqual(JSON.parse(db.prepare('SELECT audio_metadados_json FROM transcricoes').get().audio_metadados_json),expected);
  assert.equal(arquivos.listarAnexos().length,1);assert.equal(db.prepare('SELECT habilitada FROM desktop_ia_config').get().habilitada,0);
  const privacidade=new Privacidade(a.db,{arquivos:a.arquivos}),apagar=privacidade.preparar({fonte:a.fonte});privacidade.excluir({id:apagar.id,confirmar:'APAGAR'});
  assert.equal(a.db.prepare('SELECT count(*) n FROM transcricoes').get().n,0);assert.equal(a.arquivos.listarAnexos().length,0);
});
