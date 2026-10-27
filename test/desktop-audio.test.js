import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {DesktopAudio} from '../src/desktop-audio.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {Privacidade} from '../src/privacidade.js';
import {Backup} from '../src/backup.js';
import {validarAudioWav,decodificarAudio,reservaAudioMicros,conferirTranscricao} from '../src/audio-desktop-contrato.js';
import {wav} from './fixtures/audio-wav.js';

const agora=()=>new Date('2026-09-18T15:00:00Z');
async function env(t,{gerar,ler}={}){
 const dir=mkdtempSync(join(tmpdir(),'assessor-audio-')),db=abrirBanco();new ContextoApp(db);const desktop=new Desktop(db),arquivos=new ArquivosDados(dir),calls=[];
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const ia=new DesktopIA(db,{agora,segredos:{estado:async()=>({configurada:true,disponivel:true}),ler:ler||(async()=> 'chave_sintetica')}});
 await ia.configurar({habilitada:true,limiteUSD:1,cienteEnvio:true});db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('audio','Grupo de teste');ia.permitir({conversa:'audio',permitida:true});
 const fonte=Number(db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('audio','a1','entrada','audio','{}',NULL,'2026-09-18T12:00:00.000Z','2026-09-18','minha')").run().lastInsertRowid);
 const audio=new DesktopAudio(db,{ia,arquivos,gerar:async req=>{calls.push(req);return gerar?gerar(req):{dados:{transcricao:'  Transcrição: Rever a proposta amanhã.  '}};}});
 const preparar=(extra={})=>audio.preparar({fonte,base64:wav().toString('base64'),nome:'Audio.wav',confirmarVinculo:true,...extra});
 return {db,dir,desktop,ia,audio,arquivos,calls,fonte,preparar};
}

test('áudio desktop: duração vem do PCM, formato fechado e custo sem cobrar base64 como texto',()=>{
 assert.equal(validarAudioWav(wav(1.25)).segundos,1.25);assert.ok(reservaAudioMicros(wav(300))<40000);assert.ok(reservaAudioMicros(wav(1))>24000);
 for(const offset of [4,16,20,22,24,28,32,34,40]){const b=wav();b[offset]^=1;assert.throws(()=>validarAudioWav(b),/inválido/);}
 for(const b of [Buffer.alloc(0),wav(0),wav(301)])assert.throws(()=>validarAudioWav(b));
 assert.throws(()=>decodificarAudio(wav().toString('base64')+'\n'));assert.throws(()=>decodificarAudio('AA=='));
 for(const result of [{transcricao:''},{transcricao:'fala',extra:true},{transcricao:42},null])assert.throws(()=>conferirTranscricao(result));
});
test('áudio desktop: preparar é local; confirmar reserva, envia somente áudio e guarda original/anexo',async t=>{
 const e=await env(t),p=e.preparar();assert.equal(e.calls.length,0);assert.equal(e.ia.gasto(),0);assert.equal(p.segundos,1);assert.equal(p.fontes[0].id,e.fonte);
 const r=await e.audio.transcrever({id:p.id,confirmar:true});assert.equal(r.fonte,e.fonte);assert.equal(e.calls.length,1);
 const req=e.calls[0];assert.equal(req.pedido.tools,undefined);assert.equal(req.pedido.contents[0].parts.length,1);assert.equal(req.pedido.contents[0].parts[0].inlineData.mimeType,'audio/wav');
 const row=e.db.prepare('SELECT * FROM transcricoes').get();assert.equal(row.texto_original,'  Transcrição: Rever a proposta amanhã.  ');assert.equal(row.texto,'Rever a proposta amanhã.');assert.deepEqual(readFileSync(row.arquivo),wav());assert.equal(e.db.prepare('SELECT texto FROM eventos').get().texto,null);
 assert.equal(e.ia.gasto(),Math.round(p.reservaUSD*1e6));assert.equal(e.db.prepare('SELECT estado FROM desktop_ia_gastos').get().estado,'concluido');
 assert.equal(readdirSync(e.audio.arquivos.journals).length,0);assert.equal(e.desktop.buscar({q:'proposta'}).mensagens[0].id,e.fonte);
 await assert.rejects(()=>e.audio.transcrever({id:p.id,confirmar:true}),/ausente/);
});
test('áudio desktop: confirmação, leitura, opt-in e orçamento não são ampliados pelo arquivo',async t=>{
 const e=await env(t);assert.throws(()=>e.preparar({confirmarVinculo:false}),/Confira/);assert.throws(()=>e.preparar({fonte:-1}),/Confira/);
 const p=e.preparar();await assert.rejects(()=>e.audio.transcrever({id:p.id,confirmar:false}),/Confirme/);assert.equal(e.calls.length,0);
 e.ia.permitir({conversa:'audio',permitida:false});assert.throws(()=>e.preparar(),/autorização/);e.ia.permitir({conversa:'audio',permitida:true});
 e.db.exec("UPDATE eventos SET permissao='terceiro'");assert.throws(()=>e.preparar(),/indisponível/);e.db.exec("UPDATE eventos SET permissao='minha'");
 await e.ia.configurar({habilitada:true,limiteUSD:0.001,cienteEnvio:true});assert.throws(()=>e.preparar(),/limite diário/);assert.equal(e.calls.length,0);
});
test('áudio desktop: cancelamento durante leitura da chave impede rede e reserva',async t=>{
 let ready,release;const started=new Promise(r=>ready=r),held=new Promise(r=>release=r);
 const e=await env(t,{ler:async()=>{ready();await held;return 'chave_sintetica';}}),p=e.preparar(),pending=e.audio.transcrever({id:p.id,confirmar:true});
 await started;assert.equal(e.audio.cancelar({id:p.id}).cancelada,true);release();await assert.rejects(()=>pending,/cancelada/);assert.equal(e.calls.length,0);assert.equal(e.ia.gasto(),0);assert.equal(e.ia.operacoes.size,0);
});
test('áudio desktop: cancelar ou revogar durante provedor que ignora abort não persiste resultado',async t=>{
 for(const acao of ['cancelar','revogar','excluir']){
  let ready,release,signal;const started=new Promise(r=>ready=r),held=new Promise(r=>release=r);
  const e=await env(t,{gerar:async req=>{signal=req.signal;ready();await held;return{dados:{transcricao:'Não deve persistir'}};}}),p=e.preparar(),pending=e.audio.transcrever({id:p.id,confirmar:true});await started;
  if(acao==='cancelar')e.audio.cancelar({id:p.id});else if(acao==='revogar')e.ia.permitir({conversa:'audio',permitida:false});else e.db.exec('DELETE FROM eventos');
  if(acao!=='excluir')assert.equal(signal.aborted,true);release();await assert.rejects(()=>pending,/cancelada|mudou|revogada/);
  assert.equal(e.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n,0);assert.equal(e.db.prepare('SELECT estado FROM desktop_ia_gastos').get().estado,'incerto');assert.equal(e.ia.gasto(),Math.round(p.reservaUSD*1e6));assert.equal(e.arquivos.listarAnexos().length,0);
 }
});
test('áudio desktop: substituição conserva anterior em falha e limpa anexo antigo após sucesso',async t=>{
 let invalid=false;const e=await env(t,{gerar:async()=>({dados:invalid?{errado:'falha'}:{transcricao:'Fala original'}})}),p=e.preparar();await e.audio.transcrever({id:p.id,confirmar:true});const old=e.db.prepare('SELECT * FROM transcricoes').get();
 invalid=true;const q=e.preparar();assert.equal(q.substitui,true);await assert.rejects(()=>e.audio.transcrever({id:q.id,confirmar:true}),/válida/);assert.equal(e.db.prepare('SELECT arquivo FROM transcricoes').get().arquivo,old.arquivo);assert.ok(existsSync(old.arquivo));
 invalid=false;const next=e.preparar();await e.audio.transcrever({id:next.id,confirmar:true});assert.equal(existsSync(old.arquivo),false);assert.equal(e.arquivos.listarAnexos().length,1);
});
test('áudio desktop: journal remove arquivo sem commit e preserva arquivo confirmado',async t=>{
 const e=await env(t),store=e.audio.arquivos,id=randomUUID(),path=store.caminho(id);mkdirSync(e.arquivos.anexos,{recursive:true});mkdirSync(store.journals,{recursive:true});
 writeFileSync(store.journal(id),JSON.stringify({id,anterior:null}));writeFileSync(path,wav());assert.deepEqual(store.recuperar(),{concluidas:1,pendentes:0});assert.equal(existsSync(path),false);
 const p=e.preparar();await e.audio.transcrever({id:p.id,confirmar:true});const row=e.db.prepare('SELECT arquivo FROM transcricoes').get(),persistido=row.arquivo.match(/audio-([a-f0-9-]+)\.wav$/)[1];
 writeFileSync(store.journal(persistido),JSON.stringify({id:persistido,anterior:null}));assert.deepEqual(store.recuperar(),{concluidas:1,pendentes:0});assert.ok(existsSync(row.arquivo));
});
test('áudio desktop: backup e exclusão incluem o novo anexo',async t=>{
 const a=await env(t),b=await env(t),p=a.preparar();await a.audio.transcrever({id:p.id,confirmar:true});b.db.exec('DELETE FROM eventos;DELETE FROM conversas_app');
 const backupA=new Backup(a.db,{arquivos:a.arquivos}),backupB=new Backup(b.db,{arquivos:b.arquivos}),senha='senha sintética do teste';
 const exported=await backupA.criar({senha,confirmar:true}),preview=await backupB.preparar({arquivo:JSON.stringify(exported.pacote),senha});backupB.restaurar({id:preview.id,confirmarMeuBackup:true});
 assert.equal(b.arquivos.listarAnexos().length,1);assert.equal(b.desktop.fonte(a.fonte).transcricao.textoOriginal,a.desktop.fonte(a.fonte).transcricao.textoOriginal);
 const priv=new Privacidade(a.db,{arquivos:a.arquivos}),del=priv.preparar({fonte:a.fonte});priv.excluir({id:del.id,confirmar:'APAGAR'});assert.equal(a.arquivos.listarAnexos().length,0);
});

test('áudio desktop: download é local ao fluxo e revogação impede retornar bytes atrasados',async t=>{
 const e=await env(t);let release,ready;const started=new Promise(r=>ready=r),held=new Promise(r=>release=r);let signal;
 e.audio.baixador=async(bruto,options)=>{signal=options.signal;ready();await held;return {base64:wav().toString('base64'),nome:'Teste.wav',mime:'audio/wav'};};
 const download=e.audio.baixar({fonte:e.fonte});await started;assert.equal(e.calls.length,0);e.ia.invalidar();assert.equal(signal.aborted,true);release();await assert.rejects(()=>download,/cancelado/);assert.equal(e.audio.downloads.size,0);
 e.db.exec("UPDATE eventos SET permissao='terceiro'");await assert.rejects(()=>e.audio.baixar({fonte:e.fonte}),/revogado/);
});
