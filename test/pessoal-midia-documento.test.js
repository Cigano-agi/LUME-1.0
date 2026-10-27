import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createHash,createHmac} from 'node:crypto';
import {getMediaKeys} from '@whiskeysockets/baileys';
import {baixarMidiaWhatsapp} from '../src/audio-whatsapp.js';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {ContextoPessoal} from '../src/pessoal/contexto.js';
import {MidiaArquivos,processarUmaMidiaCiclo} from '../src/ciclo-midia-worker.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {Privacidade} from '../src/privacidade.js';
import {Desktop} from '../src/desktop.js';
import {prepararIndiceFontes} from '../src/fontes-desktop.js';
import {retomarMidiaSuportada,bloquearMidiaSemSuporteCiclo,reclamarEtapaCiclo} from '../src/ciclo-captura.js';
import {chaveExclusao} from '../src/exclusoes.js';
const agora=new Date('2026-10-26T10:00:00Z'),jid='551199999001@s.whatsapp.net';
const hash=b=>createHash('sha256').update(b).digest();
function fixture(t,tipo='documentMessage'){
 const dir=mkdtempSync(join(tmpdir(),'lume-doc-')),db=abrirBanco(join(dir,'dados.sqlite'));
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 new Desktop(db);const app=new ContextoApp(db);app.receber({type:'history',messages:[{key:{id:'synthetic-doc',remoteJid:jid},messageTimestamp:Math.floor(agora.getTime()/1000),message:{[tipo]:{mimetype:tipo==='imageMessage'?'image/png':'text/plain'}}}]});
 prepararIndiceFontes(db);const arquivos=new MidiaArquivos(db,new ArquivosDados(dir)),id=db.prepare('SELECT id FROM eventos').get().id;
 return {db,app,arquivos,id,contexto:new ContextoPessoal(db)};
}
test('mídia: preserva imagem autenticada sem dizer que foi interpretada',async t=>{
 const f=fixture(t,'imageMessage');
 const r=await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar:async()=>({mime:'image/png',base64:Buffer.from('PNG sintético').toString('base64')})});
 assert.equal(r.estado,'concluida');assert.equal(f.db.prepare('SELECT mime FROM ciclo_midias').get().mime,'image/png');
 assert.equal(f.contexto.recuperar({conversaId:jid}).fontes.length,0);
 assert.equal(await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora}),null);
});
test('retomada explícita recupera só original antes não suportado e não reabre interpretação antiga',async t=>{
 const f=fixture(t,'imageMessage');const claim=reclamarEtapaCiclo(f.db,'midia',{agora});
 assert.equal(bloquearMidiaSemSuporteCiclo(f.db,claim,{agora}).estado,'desistida');
 const antes=f.db.prepare("SELECT * FROM etapas WHERE etapa!='midia' ORDER BY etapa").all();
 assert.equal(retomarMidiaSuportada(f.db,f.id,{agora}),true);assert.equal(retomarMidiaSuportada(f.db,f.id,{agora}),false);
 assert.deepEqual(f.db.prepare("SELECT * FROM etapas WHERE etapa!='midia' ORDER BY etapa").all(),antes);
 const r=await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar:async()=>({mime:'image/png',base64:Buffer.from('Imagem sintética').toString('base64')})});
 assert.equal(r.estado,'concluida');assert.equal(retomarMidiaSuportada(f.db,f.id,{agora}),false);
});
test('retomada não aceita fonte excluída',t=>{
 const f=fixture(t);bloquearMidiaSemSuporteCiclo(f.db,reclamarEtapaCiclo(f.db,'midia',{agora}),{agora});
 f.db.prepare('INSERT INTO priv_excluidos(hash,excluido_em) VALUES(?,?)').run(chaveExclusao(jid,'synthetic-doc'),agora.toISOString());
 assert.equal(retomarMidiaSuportada(f.db,f.id,{agora}),false);
});
test('documento: texto extraído local integra fonte, ação, busca e exclusão existentes',async t=>{
 const f=fixture(t),texto='Enviar contrato para revisão amanhã.';
 const r=await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar:async()=>({mime:'text/plain',base64:Buffer.from(texto).toString('base64')})});
 assert.equal(r.estado,'concluida');
 const fonte=f.contexto.recuperar({conversaId:jid}).fontes[0];assert.equal(fonte.texto,texto);assert.equal(fonte.conteudo,'documento_extraido');
 const publica=new Desktop(f.db).fonte(f.id);assert.equal(publica.documento.estado,'extraido');assert.equal(publica.transcricao,undefined);
 assert.ok(f.contexto.registrarDemanda({eventoId:f.id,resumo:'Revisar contrato',trecho:texto}).acaoId);
 const {caminho}=f.db.prepare('SELECT caminho FROM ciclo_midias').get();assert.equal(existsSync(caminho),true);
 const priv=new Privacidade(f.db,{arquivos:f.arquivos.arquivos}),p=priv.preparar({fonte:f.id});priv.excluir({id:p.id,confirmar:'APAGAR'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM transcricoes').get().n,0);assert.equal(existsSync(caminho),false);
});
test('documento: alteração da fonte descarta extração antiga, sem alterar original capturado',async t=>{
 const f=fixture(t);await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar:async()=>({mime:'text/plain',base64:Buffer.from('Texto original do documento.').toString('base64')})});
 assert.equal(f.db.prepare('SELECT texto FROM eventos').get().texto,null);
 f.db.prepare('UPDATE eventos SET bruto=? WHERE id=?').run('{"alterado":true}',f.id);
 assert.equal(f.contexto.recuperar({conversaId:jid}).fontes.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n,0);
});
test('documentos concorrentes aguardam capacidade antes de reclamar ou baixar outra fonte',async t=>{
 const f=fixture(t);f.app.receber({type:'history',messages:[{key:{id:'synthetic-doc-2',remoteJid:jid},messageTimestamp:Math.floor(agora.getTime()/1000),message:{documentMessage:{mimetype:'text/plain'}}}]});
 let concluir,iniciou,downloads=0;const inicio=new Promise(r=>{iniciou=r;});
 const baixar=async()=>{downloads++;return {mime:'text/plain',base64:Buffer.from('Contrato sintético.').toString('base64')};};
 const primeira=processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar,extrair:()=>{iniciou();return new Promise(r=>{concluir=r;});}});
 await inicio;
 assert.equal(await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar}),null);
 assert.equal(downloads,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM etapas WHERE etapa='midia' AND estado='em_curso'").get().n,1);
 concluir({estado:'extraido',texto:'Contrato sintético.',paginas:0,truncado:false});assert.equal((await primeira).estado,'concluida');
 assert.equal((await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar})).estado,'concluida');
 assert.equal(downloads,2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n,2);
});
test('documento: edição de legenda com FTS não duplica remoção e retira texto extraído antigo',async t=>{
 const f=fixture(t);prepararIndiceFontes(f.db);await processarUmaMidiaCiclo(f.db,{arquivos:f.arquivos,agora,baixar:async()=>({mime:'text/plain',base64:Buffer.from('Contrato girassol original.').toString('base64')})});
 assert.ok(f.db.prepare("SELECT rowid FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH 'girassol'").get());
 f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Nova legenda.',f.id);
 assert.equal(f.db.prepare("SELECT rowid FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH 'girassol'").get(),undefined);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n,0);
 assert.equal(f.contexto.recuperar({conversaId:jid}).fontes[0].texto,'Nova legenda.');
 f.db.exec("INSERT INTO desktop_fontes_fts(desktop_fontes_fts,rank) VALUES('integrity-check',1)");
});
for(const [tipo,campo,keyType,mime] of [['imagem','imageMessage','image','image/png'],['documento','documentMessage','document','application/pdf']])
test('download '+tipo+': chave específica, hashes/MAC reais e host fixo',async()=>{
 const bytes=Buffer.from('conteúdo sintético '+tipo),mediaKey=Buffer.alloc(32,7),{cipherKey,iv,macKey}=await getMediaKeys(mediaKey,keyType);
 const cipher=createCipheriv('aes-256-cbc',cipherKey,iv),body=Buffer.concat([cipher.update(bytes),cipher.final()]);
 const encrypted=Buffer.concat([body,createHmac('sha256',macKey).update(iv).update(body).digest().subarray(0,10)]);
 const media={mediaKey,fileSha256:hash(bytes),fileEncSha256:hash(encrypted),mimetype:mime,fileLength:bytes.length,url:'https://mmg.whatsapp.net/synthetic'};
 const bruto=()=>JSON.stringify({mensagem:{message:{[campo]:media}}});let calls=0;
 const r=await baixarMidiaWhatsapp(bruto(),{tipo,fetchFn:async(url,o)=>{calls++;assert.equal(o.redirect,'error');return new Response(encrypted);}});
 assert.deepEqual(Buffer.from(r.base64,'base64'),bytes);assert.equal(calls,1);
 media.url='https://private.invalid/synthetic';await assert.rejects(()=>baixarMidiaWhatsapp(bruto(),{tipo,fetchFn:()=>assert.fail('No remote host')}));
 media.url='https://mmg.whatsapp.net/synthetic';media.fileSha256=Buffer.alloc(32);await assert.rejects(()=>baixarMidiaWhatsapp(bruto(),{tipo,fetchFn:async()=>new Response(encrypted)}));
});
