// Independent review: synthetic bytes and local SQLite only; no account, inference or transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createHash,createHmac} from 'node:crypto';
import {getMediaKeys} from '@whiskeysockets/baileys';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {ContextoPessoal} from '../src/pessoal/contexto.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {prepararIndiceFontes,prepararFontes} from '../src/fontes-desktop.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {MidiaArquivos,processarUmaMidiaCiclo} from '../src/ciclo-midia-worker.js';
import {reclamarEtapaCiclo,bloquearMidiaSemSuporteCiclo,retomarMidiaSuportada} from '../src/ciclo-captura.js';
import {baixarMidiaWhatsapp,MAX_AUDIO_DOWNLOAD} from '../src/audio-whatsapp.js';
import {chaveExclusao,chaveConversa} from '../src/exclusoes.js';

const agora=new Date('2026-10-26T12:00:00Z'),jid='551100001234@s.whatsapp.net';
const hash=b=>createHash('sha256').update(b).digest();
const bytes=Buffer.from('Documento girassol sintético.');
const baixar=async()=>({mime:'text/plain',base64:bytes.toString('base64')});
const extraido={estado:'extraido',texto:bytes.toString(),paginas:0,truncado:false};
function fixture(t,{ftsAntes=false,tipo='documentMessage',caption}={}){
  const dir=mkdtempSync(join(tmpdir(),'lume-midia-review-')),db=abrirBanco(join(dir,'dados.sqlite'));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  new Desktop(db);const app=new ContextoApp(db);
  app.receber({type:'history',messages:[{key:{id:'review-1',remoteJid:jid},messageTimestamp:Math.floor(agora.getTime()/1000),message:{[tipo]:{mimetype:tipo==='imageMessage'?'image/png':'text/plain',...(caption?{caption}: {})}}}]});
  if(ftsAntes)prepararIndiceFontes(db);
  const arquivos=new MidiaArquivos(db,new ArquivosDados(dir));
  if(!ftsAntes)prepararIndiceFontes(db);
  return {dir,db,app,arquivos,id:db.prepare('SELECT id FROM eventos').get().id};
}
const processar=f=>processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar});
const hits=(db,word)=>db.prepare('SELECT rowid FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH ?').all(word);
const integrity=db=>db.exec("INSERT INTO desktop_fontes_fts(desktop_fontes_fts,rank) VALUES('integrity-check',1)");

for(const ftsAntes of [true,false])for(const campo of ['texto','bruto','origem_id','permissao'])
test(`review mídia: FTS ${ftsAntes?'antes':'depois'} do leitor, edição de ${campo} invalida extração`,async t=>{
  const f=fixture(t,{ftsAntes});assert.equal((await processar(f)).estado,'concluida');
  assert.equal(hits(f.db,'girassol').length,1);
  const original=f.db.prepare('SELECT caminho FROM ciclo_midias').get().caminho;
  const valor={texto:'Legenda revisada.',bruto:'{"revisado":true}',origem_id:'review-2',permissao:'minha'}[campo];
  f.db.prepare(`UPDATE eventos SET ${campo}=? WHERE id=?`).run(valor,f.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM transcricoes').get().n,0);
  assert.equal(hits(f.db,'girassol').length,0);
  integrity(f.db);assert.deepEqual(readFileSync(original),bytes,'original capturado preservado');
  prepararFontes(f.db);integrity(f.db);
});

for(const ftsAntes of [true,false])test(`review mídia: exclusão SQL limpa overlay e FTS, órfão recolhido (${ftsAntes})`,async t=>{
  const f=fixture(t,{ftsAntes});await processar(f);
  const original=f.db.prepare('SELECT caminho FROM ciclo_midias').get().caminho;
  const alheio=join(f.arquivos.arquivos.anexos,'arquivo-alheio.txt');writeFileSync(alheio,'preservar');
  f.db.prepare('DELETE FROM eventos WHERE id=?').run(f.id);
  assert.equal(hits(f.db,'girassol').length,0);integrity(f.db);
  assert.equal(f.db.prepare('SELECT count(*) n FROM transcricoes').get().n,0);
  utimesSync(original,new Date(0),new Date(0));
  assert.equal(f.arquivos.recuperar({agora:new Date(),idadeMs:0}).removidos,1);
  assert.equal(existsSync(original),false);assert.equal(readFileSync(alheio,'utf8'),'preservar');
});

for(const fase of ['download','extracao'])for(const mudanca of ['bruto','permissao','exclusao','conversa_excluida','delete'])
test(`review mídia: ${mudanca} durante ${fase} não grava resultado tardio`,async t=>{
  const f=fixture(t);let liberar,iniciou;
  const inicio=new Promise(r=>iniciou=r),espera=new Promise(r=>liberar=r);
  const p=processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,
    baixar:async()=>{if(fase==='download'){iniciou();await espera;}return baixar();},
    extrair:async()=>{if(fase==='extracao'){iniciou();await espera;}return extraido;}});
  await inicio;
  if(mudanca==='bruto')f.db.prepare('UPDATE eventos SET bruto=? WHERE id=?').run('{"novo":true}',f.id);
  if(mudanca==='permissao')f.db.prepare("UPDATE eventos SET permissao='compartilhado' WHERE id=?").run(f.id);
  if(mudanca==='exclusao')f.db.prepare('INSERT INTO priv_excluidos VALUES(?,?)').run(chaveExclusao(jid,'review-1'),agora.toISOString());
  if(mudanca==='conversa_excluida')f.db.prepare('INSERT INTO priv_conversas_excluidas VALUES(?,?)').run(chaveConversa(jid),agora.toISOString());
  if(mudanca==='delete')f.db.prepare('DELETE FROM eventos WHERE id=?').run(f.id);
  liberar();assert.notEqual((await p)?.estado,'concluida');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ciclo_midias').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM transcricoes').get().n,0);
  assert.deepEqual(f.arquivos.listar(),[]);integrity(f.db);
});

for(const acao of ['abort','pausa'])test(`review mídia: ${acao} durante extração devolve claim e libera capacidade`,async t=>{
  const f=fixture(t),controller=new AbortController();let ativo=true,liberar,iniciou;
  const inicio=new Promise(r=>iniciou=r),espera=new Promise(r=>liberar=r);
  const p=processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar,signal:controller.signal,podeProcessar:()=>ativo,extrair:async()=>{iniciou();await espera;return extraido;}});
  await inicio;if(acao==='abort')controller.abort();else ativo=false;liberar();assert.equal(await p,null);
  assert.equal(f.db.prepare("SELECT estado FROM etapas WHERE etapa='midia'").get().estado,'pendente');
  assert.equal(f.db.prepare('SELECT count(*) n FROM transcricoes').get().n,0);assert.deepEqual(f.arquivos.listar(),[]);
  assert.equal((await processar(f)).estado,'concluida');
});

for(const estado of ['sem_texto','indisponivel','parcial'])test(`review mídia: ${estado} fica explícito e original permanece`,async t=>{
  const f=fixture(t);const extracao=estado==='parcial'?{...extraido,truncado:true,motivo:'limite_texto'}:
    {estado,texto:'',paginas:1,truncado:false,...(estado==='indisponivel'?{motivo:'pdf_protegido'}:{})};
  assert.equal((await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar,extrair:async()=>extracao})).estado,'concluida');
  const contexto=new ContextoPessoal(f.db).recuperar({conversaId:jid});
  const trans=f.db.prepare('SELECT * FROM transcricoes').get();assert.match(trans.modelo,/^documento-local:/);
  if(estado==='parcial'){assert.equal(contexto.fontes[0].conteudo,'documento_extraido_parcial');assert.match(contexto.fontes[0].texto,/girassol/);}
  else {assert.equal(contexto.fontes.length,0);assert.ok(contexto.lacunas.some(l=>String(l.tipo).startsWith('documento_')));}
  assert.deepEqual(readFileSync(f.db.prepare('SELECT caminho FROM ciclo_midias').get().caminho),bytes);integrity(f.db);
});

test('review mídia: comando recuperar-midia só pelo dono privado, um evento e nenhum dependente reaberto',async t=>{
  const f=fixture(t,{tipo:'imageMessage'});
  bloquearMidiaSemSuporteCiclo(f.db,reclamarEtapaCiclo(f.db,'midia',{agora}),{agora});
  const antes=f.db.prepare("SELECT * FROM etapas WHERE etapa!='midia' ORDER BY etapa").all();
  const pessoal=new LumePessoal(f.db,{desktop:{perfil:()=>({aceito:true})},chatgpt:{responder:()=>assert.fail('Sem inferência'),estado:async()=>({}),encerrar(){}},agora:()=>agora});
  f.db.prepare("INSERT INTO desktop_config VALUES('pessoal-enabled','1') ON CONFLICT(chave) DO UPDATE SET valor='1'").run();
  const diario={donoId:'123',botId:'456'},update={update_id:1,message:{chat:{id:123,type:'private'},from:{id:123},text:`recuperar-midia E${f.id}`}};
  for(const invalido of [{...update,message:{...update.message,from:{id:999}}},{...update,message:{...update.message,chat:{id:999,type:'private'}}},{...update,message:{...update.message,chat:{id:123,type:'group'}}},{...update,message:{...update.message,from:{id:123,is_bot:true}}}])assert.equal(await pessoal.conversar(invalido,{diario}),null);
  assert.equal(f.db.prepare("SELECT estado FROM etapas WHERE etapa='midia'").get().estado,'desistida');
  assert.match((await pessoal.conversar(update,{diario})).text,/não reabre respostas/);
  assert.equal(f.db.prepare("SELECT estado FROM etapas WHERE etapa='midia'").get().estado,'pendente');
  assert.deepEqual(f.db.prepare("SELECT * FROM etapas WHERE etapa!='midia' ORDER BY etapa").all(),antes);
  assert.equal(f.db.prepare('SELECT count(*) n FROM saidas').get().n,0);
  assert.equal(retomarMidiaSuportada(f.db,f.id,{agora}),false);
  await pessoal.encerrar();
});

test('review mídia: migração retira trigger antigo sem depender da ordem e preserva overlay de áudio',async t=>{
  const f=fixture(t,{ftsAntes:true});await processar(f);
  f.db.exec(`CREATE TRIGGER IF NOT EXISTS documento_local_fonte_alterada AFTER UPDATE OF texto,bruto,conversa_id,origem_id,permissao ON eventos BEGIN
    DELETE FROM transcricoes WHERE conversa_id=OLD.conversa_id AND origem_id=OLD.origem_id AND modelo LIKE 'documento-local:%'; END`);
  prepararFontes(f.db);prepararFontes(f.db);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Legenda após migração.',f.id);
  assert.equal(hits(f.db,'girassol').length,0);integrity(f.db);
  f.app.receber({type:'history',messages:[{key:{id:'review-audio',remoteJid:jid},messageTimestamp:Math.floor(agora.getTime()/1000),message:{audioMessage:{mimetype:'audio/ogg'}}}]});
  f.db.prepare("INSERT INTO transcricoes(conversa_id,origem_id,quando,texto,estado,modelo,criado_em) VALUES(?,?,?,?,?,?,?)")
    .run(jid,'review-audio',agora.toISOString(),'Voz margarida preservada.','transcrito','whisper-local',agora.toISOString());
  const audioId=f.db.prepare("SELECT id FROM eventos WHERE origem_id='review-audio'").get().id;
  f.db.prepare("UPDATE eventos SET permissao='minha' WHERE id=?").run(audioId);
  assert.equal(f.db.prepare("SELECT texto FROM transcricoes WHERE origem_id='review-audio'").get().texto,'Voz margarida preservada.');
  assert.equal(hits(f.db,'margarida').length,1);integrity(f.db);
});

test('review mídia: invalidação funciona sem FTS e criação posterior não ressuscita extração',async t=>{
  const f=fixture(t);f.db.exec('DROP TABLE desktop_fontes_fts');
  for(const {name} of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'desktop_fontes_%' OR name LIKE 'desktop_transcricao_fts_%')").all())f.db.exec('DROP TRIGGER '+name);
  prepararFontes(f.db);await processar(f);
  const anterior=new ContextoPessoal(f.db).recuperar({conversaId:jid}).fontes[0];assert.match(anterior.texto,/girassol/);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Revisão atual da fonte.',f.id);
  const atual=new ContextoPessoal(f.db).recuperar({conversaId:jid}).fontes[0];
  assert.equal(atual.texto,'Revisão atual da fonte.');assert.notEqual(atual.assinatura,anterior.assinatura);
  prepararIndiceFontes(f.db);assert.equal(hits(f.db,'girassol').length,0);assert.equal(hits(f.db,'atual').length,1);integrity(f.db);
});

test('review mídia: imagem com legenda permanece identificada como legenda sem interpretação visual',async t=>{
  const f=fixture(t,{tipo:'imageMessage',caption:'Confira o desenho sintético.'});
  assert.equal((await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar:async()=>({mime:'image/png',base64:Buffer.from('bytes sintéticos').toString('base64')})})).estado,'concluida');
  const fonte=new ContextoPessoal(f.db).recuperar({conversaId:jid}).fontes[0];
  assert.equal(fonte.texto,'Confira o desenho sintético.');assert.equal(fonte.conteudo,'legenda_apenas_imagem_nao_interpretada');
  assert.equal(f.db.prepare('SELECT count(*) n FROM transcricoes').get().n,0);
});

test('review mídia: DOCX não suportado conserva arquivo e explicita indisponibilidade',async t=>{
  const f=fixture(t);
  assert.equal((await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar:async()=>({mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',base64:bytes.toString('base64')})})).estado,'concluida');
  assert.equal(f.db.prepare('SELECT motivo FROM transcricoes').get().motivo,'formato_nao_suportado');
  assert.equal(new ContextoPessoal(f.db).recuperar({conversaId:jid}).fontes.length,0);
  assert.deepEqual(readFileSync(f.db.prepare('SELECT caminho FROM ciclo_midias').get().caminho),bytes);
});

async function criptografia(tipo){
  const campo=tipo==='imagem'?'imageMessage':'documentMessage',mime=tipo==='imagem'?'image/png':'application/pdf';
  const mediaKey=Buffer.alloc(32,33),{iv,cipherKey,macKey}=await getMediaKeys(mediaKey,tipo==='imagem'?'image':'document');
  const cipher=createCipheriv('aes-256-cbc',cipherKey,iv),body=Buffer.concat([cipher.update(bytes),cipher.final()]);
  const encrypted=Buffer.concat([body,createHmac('sha256',macKey).update(iv).update(body).digest().subarray(0,10)]);
  const media={mediaKey,fileSha256:hash(bytes),fileEncSha256:hash(encrypted),mimetype:mime,url:'https://mmg.whatsapp.net/review',fileLength:bytes.length};
  return {media,encrypted,raw:()=>JSON.stringify({mensagem:{message:{[campo]:media}}})};
}
for(const tipo of ['imagem','documento'])test(`review mídia: ${tipo} verifica MAC, hashes, host, limite e redirect`,async()=>{
  const f=await criptografia(tipo),fetchFn=async(_url,opts)=>{assert.equal(opts.redirect,'error');return new Response(f.encrypted);};
  assert.deepEqual(Buffer.from((await baixarMidiaWhatsapp(f.raw(),{tipo,fetchFn})).base64,'base64'),bytes);
  for(const url of ['https://mmg.whatsapp.net.evil.invalid/x','https://127.0.0.1/x','file:///x','https://u:p@mmg.whatsapp.net/x','https://mmg.whatsapp.net:444/x','https://mmg.whatsapp.net/x#fragment']){
    f.media.url=url;await assert.rejects(()=>baixarMidiaWhatsapp(f.raw(),{tipo,fetchFn:()=>assert.fail('Host recusado antes do fetch')}));
  }
  f.media.url='https://mmg.whatsapp.net/review';
  const bad=Buffer.from(f.encrypted);bad[4]^=1;
  await assert.rejects(()=>baixarMidiaWhatsapp(f.raw(),{tipo,fetchFn:async()=>new Response(bad)}));
  f.media.fileEncSha256=hash(bad);
  await assert.rejects(()=>baixarMidiaWhatsapp(f.raw(),{tipo,fetchFn:async()=>new Response(bad)}),'MAC não pode ser substituído por hash');
  f.media.fileEncSha256=hash(f.encrypted);f.media.fileSha256=Buffer.alloc(32);
  await assert.rejects(()=>baixarMidiaWhatsapp(f.raw(),{tipo,fetchFn}));
  f.media.fileSha256=hash(bytes);f.media.fileLength=MAX_AUDIO_DOWNLOAD+1;
  await assert.rejects(()=>baixarMidiaWhatsapp(f.raw(),{tipo,fetchFn:()=>assert.fail('Limite declarado antes do fetch')}));
  f.media.fileLength=bytes.length;
  await assert.rejects(()=>baixarMidiaWhatsapp(f.raw(),{tipo,fetchFn:async()=>new Response(f.encrypted,{headers:{'content-length':String(MAX_AUDIO_DOWNLOAD+2048)}})}));
});

for(const fase of ['fetch','stream'])test(`review mídia: cancelamento termina ${fase} que ignora sinal`,async()=>{
  const f=await criptografia('documento'),controller=new AbortController();
  const fetchFn=fase==='fetch'?()=>new Promise(()=>{}):async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{})}));
  const start=performance.now();
  const p=baixarMidiaWhatsapp(f.raw(),{tipo:'documento',signal:controller.signal,fetchFn});
  setTimeout(()=>controller.abort(),20);
  await assert.rejects(()=>p,/cancelado/);assert.ok(performance.now()-start<1000);
});
