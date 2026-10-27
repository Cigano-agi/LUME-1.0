// Duas instalações sintéticas, HTTP/UI reais, assinatura Ed25519 real.
// A identidade fica em memória: não prova DPAPI nem a janela nativa de salvamento.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {criarServidor} from '../src/painel/servidor.js';
import {assinarPacote,fingerprint,verificarPacote} from '../src/compartilhamento.js';
import {prepararEsquemaTranscricao,gravarTranscricao} from '../src/transcricao.js';
const audio=process.env.ASSESSOR_E2E_AUDIO==='1';
const output=resolve(audio?'work/f10-audio-qa':'work/f10-qa');mkdirSync(output,{recursive:true});
async function ambiente(){const db=abrirBanco(),ctx=new ContextoApp(db);let k=null;
 const identidade=async(op,valor)=>{
  if(op==='f10-criar')k??=generateKeyPairSync('ed25519');
  if(op==='f10-assinar'){const p=assinarPacote(JSON.parse(valor),k.privateKey);return{chave_publica:p.chave_publica,assinatura:p.assinatura};}
  return {disponivel:true,criada:!!k,...(k?{fingerprint:fingerprint(k.publicKey)}:{})};
 };
 const server=criarServidor(db,{desktop:true,contexto:ctx,identidade,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return{db,ctx,server,url:`http://127.0.0.1:${server.address().port}`,key:()=>k};
}
const a=await ambiente(),b=await ambiente(),browser=await chromium.launch({channel:'msedge',headless:true}),errors=[];
async function abrir(env,nome){const p=await browser.newPage({viewport:{width:1320,height:960},acceptDownloads:true});p.on('pageerror',e=>errors.push(e.message));await p.goto(env.url+'/app');await p.locator('#owner').fill(nome);await p.locator('#consent').check();await p.getByRole('button',{name:'Preparar meu espaço'}).click();await p.locator('#skip').click();await p.locator('nav [data-view=settings]').click();await p.locator('#settings-choice-data').click();await p.locator('#f10-create-identity').waitFor({state:'attached'});return p;}
async function abrirDetalhe(p,texto){const s=p.locator('.settings-card summary').filter({hasText:texto});if(!await s.evaluate(e=>e.parentElement.open))await s.click();}
async function projeto(p,nome,selecionar){await abrirDetalhe(p,'2 ·');await p.locator('#f10-name').fill(nome);if(selecionar)for(const c of await p.locator('#f10-conversations input').all())await c.check();await p.locator('#f10-project-form button').click();await p.waitForFunction(()=>document.getElementById('f10-status').textContent.startsWith('Projeto criado'));return p.locator('#f10-export-project').inputValue();}
try{
 const texto='Decisão sintética: revisar o instalador na sexta. <img src=x onerror=alert(1)>';
 if(audio){
  prepararEsquemaTranscricao(a.db);a.db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('audio','Áudio de teste');
  a.db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('audio','a1','entrada','audio','{}',NULL,'2026-09-18T12:00:00.000Z','2026-09-18','minha')").run();
  gravarTranscricao(a.db,{conversaId:'audio',origemId:'a1',textoOriginal:'Transcrição: '+texto});
 }else a.ctx.nota({titulo:'ReadyWorks teste',texto});
 const pa=await abrir(a,'Remetente de teste');await abrirDetalhe(pa,'1 ·');await pa.locator('#f10-create-identity').click();await pa.waitForFunction(()=>document.getElementById('f10-identity').textContent.startsWith('Seu código'));
 await projeto(pa,'Projeto de teste',true);await abrirDetalhe(pa,'3 ·');await pa.locator('#f10-recipient').fill('Receptor de teste');await pa.locator('#f10-export-form button').click();await pa.locator('#f10-export-preview').waitFor({state:'visible'});
 assert.equal(await pa.locator('#f10-export-preview img').count(),0);
 if(audio){await pa.getByText('Inclui transcrição, original e tentativas',{exact:true}).click();assert.match(await pa.locator('#f10-export-preview').innerText(),/Transcrição: Decisão sintética/);}
 await pa.locator('#f10-export-preview').scrollIntoViewIfNeeded();await pa.screenshot({path:resolve(output,'01-exportar.png')});
 const downloaded=pa.waitForEvent('download');await pa.getByRole('button',{name:'Confirmar e salvar arquivo'}).click();const download=await downloaded,path=resolve(output,'pacote-sintetico.json');await download.saveAs(path);
 const p=verificarPacote(readFileSync(path,'utf8'));assert.equal(p.pacote.conteudo.eventos.length,1);
 if(audio){assert.equal(p.pacote.conteudo.eventos[0].texto,null);assert.equal(p.pacote.conteudo.eventos[0].transcricao.textoOriginal,'Transcrição: '+texto);}
 const pb=await abrir(b,'Receptor de teste'),bp=await projeto(pb,'Projeto recebido',false);await abrirDetalhe(pb,'Receber um projeto');await pb.locator('#f10-file').setInputFiles(path);await pb.locator('#f10-import-project').waitFor();await pb.locator('#f10-import-project').selectOption(bp);await pb.locator('#f10-fingerprint').fill('0'.repeat(64));await pb.getByRole('button',{name:'Conferi o remetente · importar'}).click();await pb.waitForFunction(()=>document.getElementById('feedback').textContent.includes('impressão digital'));assert.equal(b.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);
 await pb.locator('#f10-fingerprint').fill(p.fingerprint);await pb.locator('#f10-import-preview').scrollIntoViewIfNeeded();await pb.screenshot({path:resolve(output,'02-conferir-remetente.png')});await pb.getByRole('button',{name:'Conferi o remetente · importar'}).click();await pb.waitForFunction(()=>document.getElementById('f10-status').textContent.startsWith('1 fontes novas'));
 await pb.locator('nav [data-view=memory]').click();await pb.locator('#memory-mode-search').click();await pb.locator('#search').fill('instalador');await pb.locator('#search-form button').click();await pb.waitForFunction(()=>document.getElementById('results').textContent.includes('Recebido por compartilhamento'));assert.match(await pb.locator('#results').innerText(),/Remetente de teste/);assert.equal(await pb.locator('#results img').count(),0);
 await pb.screenshot({path:resolve(output,'03-fonte-compartilhada.png')});
 if(audio){await pb.getByRole('button',{name:'Conferir transcrição',exact:true}).click();await pb.locator('.transcript-proof').waitFor();assert.match(await pb.locator('.transcript-proof').innerText(),/Transcrição: Decisão sintética/);assert.equal(await pb.locator('.transcript-proof img').count(),0);await pb.screenshot({path:resolve(output,'04-original-recebido.png')});}
 await pb.locator('nav [data-view=settings]').click();await pb.locator('#settings-choice-data').click();await abrirDetalhe(pb,'Origens recebidas');await pb.locator('#f10-origins summary').click();await pb.getByRole('button',{name:'Conferir remoção',exact:true}).click();await pb.locator('#f10-origins input').fill('REMOVER');await pb.getByRole('button',{name:'Remover origem',exact:true}).click();await pb.waitForFunction(()=>document.getElementById('f10-status').textContent.startsWith('1 fontes apagadas'));assert.equal(b.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);
 await pb.setViewportSize({width:820,height:900});assert.equal(await pb.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);writeFileSync(resolve(output,'evidence.json'),JSON.stringify({data:new Date().toISOString(),audio,transcricao:audio?'original, tentativas, captura separada e comparação após importação conferidos':'sem áudio neste cenário',assinatura:'Ed25519 real',cofre:'simulado em memória',rede:'apenas loopback; nenhum envio externo',checks:['prévia e exportação por projeto','download de JSON válido','fingerprint incorreto não importa','fingerprint conferido importa','procedência na Memória','XSS literal','remoção de origem','820px'],errors},null,2));console.log('F10 UI PASS: exportação, confiança, importação, origem e remoção.');
}finally{await browser.close();for(const e of[a,b]){await new Promise(r=>e.server.close(r));e.db.close();}}
