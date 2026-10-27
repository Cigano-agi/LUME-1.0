// Real Web Audio output from product code, captured only inside an isolated browser.
// No microphone, system-loopback capture, personal profile or physical playback.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {Novidades} from '../src/novidades.js';
import {criarServidor} from '../src/painel/servidor.js';
if(!process.argv.includes('--run')){console.log('Use --run for isolated synthetic-profile audio verification.');process.exit(0);}
const root=resolve('.'),out=resolve(process.env.LUME_AUDIO_QA_OUT||'work/lume-layout-20261027/audio');
await mkdir(out,{recursive:true});
const db=abrirBanco(':memory:'),desktop=new Desktop(db);new ContextoApp(db);
desktop.aceitar({nome:'Áudio · ensaio sintético',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
let external=0;const forbidden=()=>{external++;throw Error('External access forbidden in audio QA');};
const conexao={estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},enviarTexto:forbidden};
const pessoal=new LumePessoal(db,{desktop,conexao,chatgpt:{estado:async()=>({available:false,connected:false,accounts:[]}),modelos:async()=>[],encerrar(){},responder:forbidden},telegram:{estado:async()=>({enabled:false}),agendar:forbidden},fetchImpl:forbidden});
pessoal.companheiro=new CompanheiroPessoal(db,{pessoal,conexao,publicar(){}});
const novidades=new Novidades(db,{versao:'3.2.0-beta.8',buscar:forbidden});
const server=criarServidor(db,{desktop:true,pessoal,conexao,novidades});let browser;
const report={synthetic:true,proof:'Real browser oscillators/gain/output forked into MediaStreamDestination; decoded PCM. Browser speaker output muted. No human audibility claim.',checks:[],signals:[],errors:[],started:new Date().toISOString()};
function wav(samples,rate){const b=Buffer.alloc(44+samples.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples.length*2,40);samples.forEach((v,i)=>b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,v))*32767),44+i*2));return b;}
async function probe(context){await context.addInitScript(()=>{
 const Native=window.AudioContext,originalConnect=AudioNode.prototype.connect,originalStart=OscillatorNode.prototype.start;
 const state=window.audioProbe={contexts:[],starts:[],recording:false,recorders:[]};
 function record(c){const recorder=new MediaRecorder(c.probeDestination.stream),chunks=[];recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.start();state.recorders.push({recorder,chunks,context:c});}
 window.AudioContext=class extends Native{constructor(...args){super(...args);this.probeDestination=this.createMediaStreamDestination();state.contexts.push(this);if(state.recording)record(this);}};
 AudioNode.prototype.connect=function(destination,...args){if(destination===this.context.destination&&this.context.probeDestination)return originalConnect.call(this,this.context.probeDestination,...args);return originalConnect.call(this,destination,...args);};
 OscillatorNode.prototype.start=function(...args){state.starts.push({frequency:this.frequency.value,at:performance.now()});return originalStart.apply(this,args);};
 state.begin=()=>{state.recording=true;state.recorders=[];for(const c of state.contexts)if(c.state!=='closed')record(c);};
 state.end=async()=>{state.recording=false;const records=state.recorders;assertCount(records);const item=records[0];const blob=await new Promise(resolve=>{item.recorder.onstop=()=>resolve(new Blob(item.chunks,{type:item.recorder.mimeType}));item.recorder.stop();});const decoded=await item.context.decodeAudioData(await blob.arrayBuffer());const samples=Array.from(decoded.getChannelData(0));let peak=0,energy=0;for(const v of samples){peak=Math.max(peak,Math.abs(v));energy+=v*v;}return{samples,sampleRate:decoded.sampleRate,duration:decoded.duration,peak,rms:Math.sqrt(energy/samples.length)};};
 function assertCount(records){if(records.length!==1)throw Error('Expected one real audio context, got '+records.length);}
});}
function energyAt(samples,rate,frequency){let real=0,imaginary=0;for(let i=0;i<samples.length;i++){const angle=2*Math.PI*frequency*i/rate;real+=samples[i]*Math.cos(angle);imaginary+=samples[i]*Math.sin(angle);}return(real*real+imaginary*imaginary)/(samples.length*samples.length);}
async function capture(page,name,action){
 await page.evaluate(()=>audioProbe.begin());await action();await page.waitForTimeout(450);const signal=await page.evaluate(()=>audioProbe.end());
 assert(signal.peak>.005&&signal.peak<.2,`${name}: non-silent, unclipped signal`);assert(signal.rms>0.0005);assert(signal.duration>=.2&&signal.duration<.7);
 const frequencies=name.includes('conclusao')?[523.25,659.25]:[620,930],noise=energyAt(signal.samples,signal.sampleRate,4000);
 const bands=frequencies.map(frequency=>({frequency,energy:energyAt(signal.samples,signal.sampleRate,frequency)}));for(const band of bands)assert(band.energy>Math.max(1e-9,noise*100),`${name}: expected tone ${band.frequency}Hz in generated PCM`);
 await writeFile(join(out,name+'.wav'),wav(signal.samples,signal.sampleRate));const {samples,...metrics}=signal;report.signals.push({name,...metrics,bands});return signal;
}
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await probe(context);
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external++;return route.abort();}return route.continue();});
 await page.goto(origin+'/app',{waitUntil:'networkidle'});await page.locator('#l1-global-sound').waitFor();await page.locator('#l1-sound-summary').click();
 assert.equal(await page.locator('#l1-preview-decisao').isDisabled(),true);assert.equal(await page.evaluate(()=>audioProbe.contexts.length),0);
 await page.locator('#l1-global-sound').click();await page.waitForFunction(()=>LumePreferencias.estado().som);assert.equal(await page.evaluate(()=>audioProbe.starts.length),0);
 const low=await capture(page,'01-decisao-35',()=>page.locator('#l1-preview-decisao').click());
 assert.match(await page.locator('#l1-audio-status').innerText(),/Prévia de decisão/);
 await page.locator('#l1-global-volume').evaluate(n=>{n.value='.7';n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));});await page.waitForFunction(()=>LumePreferencias.estado().volume===.7);
 const high=await capture(page,'02-decisao-70',()=>page.locator('#l1-preview-decisao').click());
 assert(high.peak/low.peak>1.75&&high.peak/low.peak<2.25,'doubling volume changes rendered amplitude');
 await capture(page,'03-conclusao-70',()=>page.locator('#l1-preview-conclusao').click());
 const count=await page.evaluate(()=>audioProbe.starts.length);
 await page.locator('#l1-global-volume').evaluate(n=>{n.value='0';n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));});await page.waitForFunction(()=>LumePreferencias.estado().volume===0);
 await page.locator('#l1-preview-decisao').click();assert.match(await page.locator('#l1-audio-status').innerText(),/volume está em zero/);assert.equal(await page.evaluate(()=>audioProbe.starts.length),count);
 await page.reload({waitUntil:'networkidle'});assert.equal(await page.evaluate(()=>audioProbe.starts.length),0);assert.equal(pessoal.companheiro.estado().volume,0);
 report.checks.push('Panel preview uses real synthesis; starts silent; explicit opt-in is silent; two sounds captured; doubled volume doubles amplitude; zero volume and reload are silent.');
 await context.close();
 const companionContext=await browser.newContext({viewport:{width:340,height:400},reducedMotion:'reduce'});await probe(companionContext);
 await companionContext.addInitScript(()=>{window.lumeCompanheiro={onState(fn){window.emitCompanion=fn;return()=>{};}};for(const k of ['abrir','ocultar','som','adiar','pausar','expandir'])window.lumeCompanheiro[k]=async()=>{};});
 const companion=await companionContext.newPage();companion.on('pageerror',e=>report.errors.push(e.message));
 await companion.route('**/*',async route=>{const url=new URL(route.request().url());if(url.hostname!=='lume-audio.test'){external++;return route.abort();}const relative=url.pathname.replace(/^\/src\/painel\/fonts\//,'/src/painel/fonts/').replace(/^\//,'');const target=resolve(root,relative);assert(target.startsWith(root+sep));try{await route.fulfill({body:await readFile(target),contentType:target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.woff2')?'font/woff2':'text/html'});}catch{await route.fulfill({status:404,body:''});}});
 await companion.goto('http://lume-audio.test/desktop/companheiro.html');
 // Grant only this isolated page a gesture; no personal-window or system input.
 await companion.locator('#expandir').click();
 const sample={estado:'atencao',som:true,volume:.7,pausado:false,tema:'light',movimento:'reduce',notificacaoId:'qa:first',assunto:{id:'qa',assunto:'Aviso sintético de QA',fonteId:1,grupo:'precisa',estado:'pendente'}};
 await companion.evaluate(p=>emitCompanion(p),sample);assert.equal(await companion.evaluate(()=>audioProbe.starts.length),0);
 await capture(companion,'04-notificacao-decisao',()=>companion.evaluate(p=>emitCompanion(p),{...sample,notificacaoId:'qa:decision'}));
 await companion.evaluate(p=>emitCompanion(p),{...sample,notificacaoId:'qa:decision'});assert.equal(await companion.evaluate(()=>audioProbe.starts.length),2);
 await capture(companion,'05-notificacao-conclusao',()=>companion.evaluate(p=>emitCompanion(p),{...sample,notificacaoId:'qa:done',assunto:{...sample.assunto,grupo:'mudou',estado:'verificado'}}));
 await companion.evaluate(p=>emitCompanion(p),{...sample,notificacaoId:'qa:paused',pausado:true});assert.equal(await companion.evaluate(()=>audioProbe.starts.length),4);
 await companion.reload();await companion.evaluate(p=>emitCompanion(p),{...sample,notificacaoId:'qa:done',assunto:{...sample.assunto,grupo:'mudou',estado:'verificado'}});assert.equal(await companion.evaluate(()=>audioProbe.starts.length),0);
 report.checks.push('Product companion renderer plays both real signals on new sourced synthetic events; first state, duplicate, pause and reload stay silent. IPC state producer is synthetic.');
 assert.deepEqual(report.errors,[]);assert.equal(external,0);report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;process.exitCode=1;}finally{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await pessoal.encerrar();db.close();report.external=external;report.finished=new Date().toISOString();await writeFile(join(out,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
