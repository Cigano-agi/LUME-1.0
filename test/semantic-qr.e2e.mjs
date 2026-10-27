// Contrato visual da falha de pareamento e dos quatro tipos de ação.
// Usa HTTP/UI reais, banco em memória e apenas dados sintéticos.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilHoje} from './fixtures/hoje-profile.js';

const db=abrirBanco(),{contexto,adicionar}=perfilHoje(db),out='work/semantic-qr-qa';mkdirSync(out,{recursive:true});
for(const [tipo,texto] of [
  ['compromisso','Enviar a proposta combinada.'],
  ['pendencia','Conferir o documento pendente.'],
  ['lead','Responder a oportunidade comercial.'],
  ['decisao','Decidir a data da reunião.']
])adicionar({tipo,texto});

let estado='aguardando_qr',qr='qr-antigo',qrVersao=1,tentativas=0;
const conexao={
  estado:()=>({estado,qr,qrVersao,qrGeradoEm:qr?'2026-09-19T12:00:00.000Z':null}),
  iniciar:async()=>{tentativas++;throw Error('Falha técnica sintética que não deve virar outro aviso.');},
  parar:async()=>{estado='desconectada';qr=null;}
};
const server=criarServidor(db,{contexto,conexao,desktop:true,gerarIA:async()=>{throw Error('Provider forbidden');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],external=[];
const page=await browser.newPage({viewport:{width:1320,height:950}});
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});

const fit=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');
const tipos=['compromisso','pendencia','lead','decisao'];
const conferirTipos=async (selector,esperados=4)=>{
  const cards=page.locator(selector);
  assert.equal(await cards.count(),esperados);
  const chaves=(await cards.evaluateAll(nodes=>nodes.map(node=>node.dataset.actionType))).sort();
  assert.equal(new Set(chaves).size,esperados);
  assert.ok(chaves.every(tipo=>tipos.includes(tipo)));
  const visual=await cards.evaluateAll(nodes=>nodes.map(node=>{
    const label=node.querySelector('.action-type-label'),style=getComputedStyle(node),labelStyle=getComputedStyle(label),bodyStyle=getComputedStyle(document.body);
    return{tipo:node.dataset.actionType,texto:label.textContent.trim(),visivel:Boolean(label.offsetWidth&&label.offsetHeight),tom:labelStyle.color,borda:style.borderLeftColor,cor:labelStyle.color,fundo:bodyStyle.backgroundColor};
  }));
  const rotulos={compromisso:'Compromisso',decisao:'Decisão',lead:'Oportunidade',pendencia:'Pendência'};
  assert.deepEqual(visual.map(item=>item.texto).sort(),chaves.map(tipo=>rotulos[tipo]).sort());
  assert.ok(visual.every(item=>item.visivel),'type labels must remain visible');
  assert.equal(new Set(visual.map(item=>item.tom)).size,esperados,'computed label tones must be distinct: '+JSON.stringify(visual));
  const rgb=value=>{
    if(value.startsWith('#'))return value.slice(1).match(/../g).map(part=>parseInt(part,16));
    return value.match(/[\d.]+/g).slice(0,3).map(Number);
  };
  const lum=value=>rgb(value).map(channel=>channel/255).map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4).reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index],0);
  const contrast=(a,b)=>{const values=[lum(a),lum(b)].sort((x,y)=>y-x);return(values[0]+.05)/(values[1]+.05);};
  assert.ok(visual.every(item=>contrast(item.cor,item.fundo)>=4.5),'labels need readable text contrast');
  return visual;
};

try{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(origin+'/app');await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#connect-step').waitFor();

  // Reproduz um QR ainda presente antes de a tentativa falhar.
  await page.evaluate(()=>status());await page.locator('#qr').waitFor({state:'visible'});assert.ok(await page.locator('#qr').getAttribute('src'));
  await page.locator('#pair').click();await page.locator('#pair-error').waitFor({state:'visible'});
  assert.equal(tentativas,1);
  assert.equal(await page.locator('#pair-error').innerText(),'Não consegui conectar agora. Confira a internet e tente gerar o código novamente.');
  assert.equal(await page.getByRole('button',{name:'Gerar outro QR',exact:true}).count(),1);
  assert.equal(await page.locator('#feedback').isVisible(),false,'generic toast must not duplicate the pairing error');
  assert.equal(await page.locator('#qr').isVisible(),false);assert.equal(await page.locator('#qr').getAttribute('src'),null);
  assert.equal(await page.locator('#qr-status').isVisible(),false);assert.equal(await page.locator('#qr-renewal').isVisible(),false);

  // Um estado de erro vence qualquer QR residual devolvido pelo transporte.
  estado='erro';qr='qr-ainda-antigo';qrVersao=2;await page.evaluate(()=>status());
  assert.equal(await page.locator('#pair-error').innerText(),'Não consegui conectar agora. Confira a internet e tente gerar o código novamente.');
  assert.equal(await page.locator('#qr').getAttribute('src'),null);assert.equal(await page.locator('#qr').isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Gerar outro QR',exact:true}).count(),1);
  for(const width of [390,820,1320]){await page.setViewportSize({width,height:950});await fit();await page.screenshot({path:`${out}/qr-error-${width}.png`,fullPage:true});}

  await page.locator('#skip').click();await page.locator('#first-use').waitFor({state:'visible'});await page.locator('#first-hide').click();await page.locator('#first-use').waitFor({state:'hidden'});
  await page.evaluate(()=>{clearTimeout(toastTimer);document.getElementById('feedback').hidden=true;});
  await page.locator('#tasks .task-action').first().waitFor();
  const todayVisual=await conferirTipos('#tasks .task-action:visible',3);
  for(const width of [390,820,1320]){await page.setViewportSize({width,height:950});await fit();await page.locator('#tasks').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/today-types-${width}.png`,fullPage:true});}

  await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-conversations').click();
  await page.locator('.conversation-card').getByRole('button',{name:'Abrir conversa'}).click();await page.locator('.conversation-action').first().waitFor();
  const conversationVisual=await conferirTipos('.conversation-action');
  for(const width of [390,820,1320]){await page.setViewportSize({width,height:950});await fit();await page.locator('#conversation-detail').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/conversation-types-${width}.png`,fullPage:true});}

  assert.equal(await page.evaluate(()=>document.getAnimations().filter(animation=>animation.playState==='running').length),0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const report={date:new Date().toISOString(),synthetic:true,passed:true,widths:[390,820,1320],errors,external,checks:['one specific pairing error','one exact retry CTA','stale QR cleared','error state wins over residual QR','both real action renderers expose text and data-action-type','four distinct computed tones','label contrast >= 4.5','reduced motion','no horizontal overflow'],todayVisual,conversationVisual};
  writeFileSync(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}
