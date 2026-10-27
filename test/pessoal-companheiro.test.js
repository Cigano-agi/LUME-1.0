import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {abrirBanco} from '../src/banco.js';
import {prepararPessoal} from '../src/pessoal/esquema.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {pessoalGet,pessoalPost} from '../src/pessoal/http.js';
import windowModule from '../desktop/companheiro-window.cjs';

function fixture(t){
 const db=abrirBanco(':memory:');prepararPessoal(db);t.after(()=>db.close());
 const events=[],pessoal={ativa:()=>true,validarAviso:()=>true,running:null};
 const conexao={estado:()=>({estado:'conectada'})};
 const service=new CompanheiroPessoal(db,{pessoal,conexao,publicar:s=>events.push(s)});
 return {db,events,pessoal,conexao,service};
}
test('companheiro: preferências silenciosas persistem e estados correspondem ao serviço',t=>{
 const f=fixture(t);assert.deepEqual(f.service.estado(),{enabled:false,som:false,disponivel:true,tema:'system',movimento:'system',volume:.35,pausado:false,adiadoId:null,adiadoAte:null});
 f.service.configurar({enabled:true,som:false});assert.equal(f.events.at(-1).estado,'aguardando');
 f.pessoal.running=Promise.resolve();f.service.sinalizar();assert.equal(f.events.at(-1).estado,'trabalhando');
 f.pessoal.running=null;f.conexao.estado=()=>({estado:'reconectando'});f.service.sinalizar();assert.equal(f.events.at(-1).estado,'desconectado');
 f.pessoal.ativa=()=>false;f.service.sinalizar();assert.equal(f.events.at(-1).estado,'aguardando');
 assert.equal(f.service.estado().pausado,false,'pausar atendimento não pausa a companhia');
 const count=f.events.length;f.service.sinalizar();assert.equal(f.events.length,count);
 assert.equal(new CompanheiroPessoal(f.db).estado().enabled,true);
 assert.throws(()=>f.service.configurar({enabled:true,conteudo:'segredo'}),/inválida/);
});
test('companheiro: API exige booleans exatos sem abrir outra capacidade',async t=>{
 const f=fixture(t),service={companheiro:f.service};
 assert.equal((await pessoalGet(service,'/api/v3/pessoal/companheiro')).som,false);
 await assert.rejects(()=>pessoalPost(service,'/api/v3/pessoal/companheiro',{enabled:true,som:'sim'}));
 await assert.rejects(()=>pessoalPost(service,'/api/v3/pessoal/companheiro',{enabled:true,som:false,acao:'enviar'}));
 assert.equal((await pessoalPost(service,'/api/v3/pessoal/companheiro',{enabled:true,som:true})).som,true);
});
function janelaFixture(){
 const windows=[],handlers=new Map(),prefs=[],opened=[];
 class Window extends EventEmitter {
  constructor(options){super();this.options=options;this.visible=false;this.destroyed=false;this.messages=[];
   this.webContents=new EventEmitter();this.webContents.mainFrame={url:''};
   this.webContents.send=(...args)=>this.messages.push(args);this.webContents.setWindowOpenHandler=h=>this.openHandler=h;
   windows.push(this);
  }
  isDestroyed(){return this.destroyed;}isVisible(){return this.visible;}
  setBounds(b){this.bounds=b;}async loadFile(file){this.webContents.mainFrame.url=pathToFileURL(file).href;}
  showInactive(){this.visible=true;this.inactive=true;}hide(){this.visible=false;}
  destroy(){this.destroyed=true;this.emit('closed');}
 }
 const screen=new EventEmitter();screen.getPrimaryDisplay=()=>({workArea:{x:-1280,y:0,width:1280,height:720}});
 const ipcMain={handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)};
 const manager=windowModule.criarCompanheiro({BrowserWindow:Window,ipcMain,screen,abrir:()=>opened.push(true),configurar:c=>prefs.push(c)});
 const action=(event,data)=>handlers.get('lume-companheiro:acao')(event,data);
 return {windows,handlers,prefs,opened,manager,action};
}
const snapshot={enabled:true,som:false,estado:'aguardando',mensagem:'Por aqui.',notificacaoId:null};
test('companheiro: janela isolada não captura foco e IPC recusa outro renderer/subframe',async()=>{
 const f=janelaFixture();f.manager.atualizar(snapshot);await Promise.resolve();const w=f.windows[0];
 assert.equal(w.inactive,true);assert.equal(w.options.webPreferences.sandbox,true);assert.equal(w.options.webPreferences.nodeIntegration,false);
 assert.equal(w.bounds.x,-336);assert.equal(w.bounds.y,464);
 assert.deepEqual(w.openHandler({url:'https://example.invalid'}),{action:'deny'});
 const trusted={sender:w.webContents,senderFrame:w.webContents.mainFrame};
 await assert.rejects(()=>f.action({sender:{},senderFrame:w.webContents.mainFrame},{acao:'abrir'}));
 await assert.rejects(()=>f.action({sender:w.webContents,senderFrame:{url:w.webContents.mainFrame.url}},{acao:'abrir'}));
 await assert.rejects(()=>f.action(trusted,{acao:'som',som:'yes'}));
 await assert.rejects(()=>f.action(trusted,{acao:'abrir',destino:'https://example.invalid'}));
 await f.action(trusted,{acao:'abrir'});assert.equal(f.opened.length,1);
 await f.action(trusted,{acao:'ocultar'});assert.deepEqual(f.prefs.at(-1),{enabled:false});
 await f.action(trusted,{acao:'som',som:true});assert.deepEqual(f.prefs.at(-1),{som:true});
 f.manager.atualizar({...snapshot,enabled:false});assert.equal(w.visible,false);
 f.manager.encerrar();assert.equal(w.destroyed,true);assert.equal(f.handlers.size,0);
});
test('companheiro: desligar enquanto carrega não reaparece e snapshot inválido não cria janela',async()=>{
 const f=janelaFixture();assert.equal(f.manager.atualizar({...snapshot,estado:'inventado'}),false);assert.equal(f.windows.length,0);
 f.manager.atualizar(snapshot);f.manager.atualizar({...snapshot,enabled:false});await Promise.resolve();assert.equal(f.windows[0].visible,false);
 f.manager.encerrar();assert.equal(f.manager.atualizar(snapshot),false);
});
