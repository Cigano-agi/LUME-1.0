import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {criarPonteAtualizacoes} from '../desktop/atualizacoes-ponte.js';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
const require=createRequire(import.meta.url),{criarAtualizador,carregarPoliticaRelease,codigoErro}=require('../desktop/atualizacoes.cjs');

class FakeUpdater extends EventEmitter{
 constructor(){super();this.checks=0;this.downloads=0;this.installs=0;}
 setFeedURL(v){this.feed=v;}
 async checkForUpdates(){this.checks++;this.emit('checking-for-update');this.emit('update-available',{version:'3.1.0-beta.2'});}
 async downloadUpdate(){this.downloads++;this.emit('download-progress',{percent:42.4,transferred:424,total:1000});this.emit('update-downloaded',{version:'3.1.0-beta.2'});}
 quitAndInstall(){this.installs++;}
}
const policy={enabled:true,channel:'beta',feedUrl:'https://lume-crm-fawn.vercel.app/releases/beta'};
test('atualizador percorre verificar, baixar e preparar instalação com progresso real',async()=>{
 const fake=new FakeUpdater(),states=[],u=criarAtualizador(fake,{versaoAtual:'3.1.0-beta.1',politica:policy,onState:s=>states.push(s)});
 assert.equal(fake.autoDownload,false);assert.equal(fake.autoInstallOnAppQuit,false);assert.equal(fake.channel,'beta');assert.equal(fake.allowDowngrade,false);assert.deepEqual(fake.feed,{provider:'generic',url:policy.feedUrl});
 await u.verificar();assert.equal(u.estado().estado,'disponivel');
 await u.baixar();assert.equal(states.find(s=>s.estado==='baixando'&&s.progresso)?.progresso.percentual,42.4);assert.equal(u.estado().estado,'pronta');
 u.prepararInstalacao();u.instalarAgora();assert.equal(fake.installs,1);u.encerrar();
});
test('canal estável usa latest.yml e nunca permite downgrade',()=>{
 const fake=new FakeUpdater(),u=criarAtualizador(fake,{versaoAtual:'3.2.0',politica:{enabled:true,channel:'estavel',feedUrl:'https://lume-crm-fawn.vercel.app/releases/estavel'}});
 assert.equal(u.estado().canal,'estavel');assert.equal(fake.channel,'latest');assert.equal(fake.allowPrerelease,false);assert.equal(fake.allowDowngrade,false);u.encerrar();
});
test('instalação sem política de release fica fechada e erros viram códigos curtos',async()=>{
 const fake=new FakeUpdater(),u=criarAtualizador(fake,{versaoAtual:'3.1.0-beta.1',politica:{enabled:false,channel:'beta'}});
 assert.equal(u.estado().estado,'indisponivel');await assert.rejects(()=>u.verificar(),/não estão disponíveis/);assert.equal(fake.checks,0);
 assert.equal(codigoErro(new Error('publisher signature mismatch')),'ASSINATURA_INVALIDA');assert.equal(codigoErro(new Error('net::ERR_FAILED')),'REDE_INDISPONIVEL');
 assert.equal(carregarPoliticaRelease('arquivo-que-nao-existe').enabled,false);
});
test('ponte aceita somente estado fechado e mantém comandos separados',async()=>{
 const porta=new EventEmitter();porta.postMessage=m=>setImmediate(()=>porta.emit('message',{data:{tipo:'atualizacao-resposta',id:m.id,estado:{disponivel:true,estado:'disponivel',canal:'beta',versaoAtual:'3.1.0-beta.1',versaoNova:'3.1.0-beta.2',extra:'segredo'}}}));
 const ponte=criarPonteAtualizacoes(porta,{versao:'3.1.0-beta.1',suportado:true,timeout:1000});const estado=await ponte.executar('verificar');
 assert.equal(estado.estado,'disponivel');assert.equal(estado.extra,undefined);await assert.rejects(()=>ponte.executar('apagar'),/indisponíveis/);ponte.encerrar();
});
test('HTTP exige sessão e encaminha somente ações conhecidas ao atualizador',async t=>{
 const db=abrirBanco();new Desktop(db).aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
 const calls=[],state={disponivel:true,estado:'em_dia',canal:'beta',versaoAtual:'3.1.0-beta.1',versaoNova:null,progresso:null,codigoErro:null,verificadoEm:null};
 const atualizacoes={estado:()=>state,executar:async acao=>{calls.push(acao);return{...state,estado:'verificando'};}};
 const server=criarServidor(db,{desktop:true,atualizacoes,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
 const base=`http://127.0.0.1:${server.address().port}`,token=(await (await fetch(base+'/api/sessao')).json()).token;
 assert.equal((await (await fetch(base+'/api/v3/atualizacoes')).json()).estado,'em_dia');
 const post=(path,body={},auth=token)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-assessor-token':auth},body:JSON.stringify(body)});
 assert.equal((await post('/api/v3/atualizacoes/verificar')).status,200);assert.deepEqual(calls,['verificar']);
 assert.equal((await post('/api/v3/atualizacoes/apagar')).status,404);assert.equal((await post('/api/v3/atualizacoes/baixar',{},'invalido')).status,403);
});
