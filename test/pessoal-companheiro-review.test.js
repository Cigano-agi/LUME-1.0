import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {abrirBanco} from '../src/banco.js';
import {prepararPessoal} from '../src/pessoal/esquema.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';

const require = createRequire(import.meta.url);
const {criarCompanheiro} = require('../desktop/companheiro-window.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = (extra = {}) => ({enabled:true,som:false,estado:'aguardando',mensagem:'Por aqui, acompanhando.',notificacaoId:null,...extra});

// Reuse the maintenance fixture, never its test cases. Enhance only Electron mocks:
// real main/window/controller/lifecycle remain loaded; no real Electron/profile/network.
const fixtureURL = new URL('./maintenance-main.test.js', import.meta.url);
let fixtureSource = readFileSync(fixtureURL, 'utf8').split("test('main preserva")[0]
  .replaceAll('import.meta.url', JSON.stringify(fixtureURL.href))
  .replace("import('../src/mcp/desktop-broker.js')", `import(${JSON.stringify(new URL('../src/mcp/desktop-broker.js', import.meta.url).href)})`)
  .replace('const events = [], workers = [], brokers = [], windows = [];',
    'const events = [], workers = [], brokers = [], windows = [], ipcHandlers = new Map();')
  .replace('constructor() {\n', 'constructor(options) {\n')
  .replace('constructor() {\r\n', 'constructor(options) {\r\n')
  .replace("super(); windows.push(this); this.url = ''; this.destroyed = false;", "super(); windows.push(this); this.options = options; this.visible = false; this.url = ''; this.destroyed = false;")
  .replace('this.webContents = new EventEmitter();', "this.webContents = new EventEmitter(); this.webContents.mainFrame = {url:''}; this.webContents.send = (...args) => events.push(['renderer',...args]);")
  .replace('isMinimized() { return false; }', "isMinimized() { return false; } isVisible() { return this.visible; } showInactive() { this.visible = true; } hide() { this.visible = false; } getBounds() { return {x:0,y:0,width:1320,height:880}; } setBounds(bounds) { this.bounds = bounds; } destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }")
  .replace("this.url = pathToFileURL(file).href; events.push('local');", "this.url = pathToFileURL(file).href; this.webContents.mainFrame.url = this.url; events.push('local');")
  .replace('ipcMain:{handle:()=>{},removeHandler:()=>{}},screen:new EventEmitter()',
    "ipcMain:{handle:(channel,fn)=>{if(ipcHandlers.has(channel))throw Error('duplicate IPC handler');ipcHandlers.set(channel,fn);},removeHandler:channel=>ipcHandlers.delete(channel)},screen:Object.assign(new EventEmitter(),{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1080}}),getDisplayMatching:()=>({workArea:{x:0,y:0,width:1920,height:1080}})})")
  .replace('return { app, events, workers, brokers, windows, defaultSession, hooks:', 'return { app, events, workers, brokers, windows, defaultSession, ipcHandlers, screen:electron.screen, hooks:');
fixtureSource += '\nexport {setup, boot, acknowledgeShutdown, until, opId};';
const fixture = await import(`data:text/javascript;base64,${Buffer.from(fixtureSource).toString('base64')}`);

test('review: companion enabled survives maintenance with initial snapshot before ready', async t => {
  const x = fixture.setup(); t.after(x.dispose);
  await fixture.boot(x);
  const first = x.workers[0];
  first.emit('message', {tipo:'companheiro-estado',estado:state()});
  await tick();
  assert.equal(x.windows[1].isVisible(), true);
  const pending = x.hooks.iniciarManutencaoInterna(fixture.opId);
  assert.equal(x.windows[1].isDestroyed(), true);
  const cut = first.sent.find(message => message.tipo === 'intake-cut-pedido');
  first.emit('message', {tipo:'intake-cut-ack',boot:cut.boot,pedido:cut.pedido,perfil:cut.perfil,opId:fixture.opId});
  await fixture.until(() => first.sent.some(message => message.tipo === 'shutdown-pedido'));
  fixture.acknowledgeShutdown(first);
  const handle = await pending;
  const finishing = x.controller().endMaintenance(handle);
  await fixture.until(() => x.workers[1]);
  // service.js publishes companion.iniciar() before its pronto message.
  x.workers[1].emit('message', {tipo:'companheiro-estado',estado:state()});
  await fixture.boot(x, 1);
  await finishing; await tick();
  assert.equal(x.ipcHandlers.size, 1, 'exactly one IPC handler after restart');
  assert.equal(x.screen.listenerCount('display-removed'), 1, 'old screen listener removed');
  assert.equal(x.windows.filter(w => w.options?.transparent && !w.isDestroyed() && w.isVisible()).length, 1,
    'enabled companion must be restored without requiring a later state change');
  first.emit('message', {tipo:'companheiro-estado',estado:state({enabled:false})});
  assert.equal(x.windows.at(-1).isVisible(), true, 'old generation cannot hide the new companion');
  x.app.quit(); fixture.acknowledgeShutdown(x.workers[1]);
  await fixture.until(() => x.events.includes('quit'));
  assert.equal(x.ipcHandlers.size, 0);
  assert.equal(x.screen.listenerCount('display-removed'), 0);
});

function windowFixture({configure = () => {}, holdLoad = false} = {}) {
  let resolveLoad;
  const pendingLoad = new Promise(resolve => { resolveLoad = resolve; });
  const windows = [], handlers = new Map(), screen = new EventEmitter();
  screen.getPrimaryDisplay = () => ({workArea:{x:-1280,y:0,width:1280,height:720}});
  class Window extends EventEmitter {
    constructor(options) { super(); this.options=options; this.visible=false; this.destroyed=false; this.webContents=new EventEmitter(); this.webContents.mainFrame={url:''}; this.webContents.send=()=>{}; this.webContents.setWindowOpenHandler=fn=>{this.open=fn;}; windows.push(this); }
    isDestroyed(){return this.destroyed;} isVisible(){return this.visible;} showInactive(){this.visible=true;} hide(){this.visible=false;}
    setBounds(bounds){this.bounds=bounds;} destroy(){this.destroyed=true;this.visible=false;this.emit('closed');}
    loadFile(file){this.webContents.mainFrame.url=new URL(`file:///${file.replaceAll('\\','/')}`).href;return holdLoad?pendingLoad:Promise.resolve();}
  }
  const manager=criarCompanheiro({BrowserWindow:Window,ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},screen,abrir:()=>{},configurar:configure});
  return {manager,windows,handlers,screen,resolveLoad};
}

test('review: display removal repositions; shutdown rejects a late load and clears IPC/listeners', async () => {
  const x=windowFixture({holdLoad:true});
  x.manager.atualizar(state());
  const w=x.windows[0];
  assert.equal(w.options.webPreferences.sandbox,true);
  assert.equal(w.options.webPreferences.contextIsolation,true);
  assert.equal(w.options.webPreferences.nodeIntegration,false);
  x.screen.getPrimaryDisplay=()=>({workArea:{x:0,y:0,width:1920,height:1080}});
  x.screen.emit('display-removed');
  assert.deepEqual(w.bounds,{x:1584,y:824,width:320,height:240});
  x.manager.encerrar(); x.resolveLoad(); await tick();
  assert.equal(w.visible,false);assert.equal(w.destroyed,true);
  assert.equal(x.handlers.size,0);assert.equal(x.screen.listenerCount('display-removed'),0);
  assert.equal(x.manager.atualizar(state()),false);
});

test('review: same sender/frame with changed URL is denied and navigation is blocked', async () => {
  const x=windowFixture();x.manager.atualizar(state());await tick();
  const w=x.windows[0],handler=x.handlers.get('lume-companheiro:acao');
  w.webContents.mainFrame.url='https://attacker.invalid/';
  await assert.rejects(handler({sender:w.webContents,senderFrame:w.webContents.mainFrame},{acao:'estado'}),/Origem/);
  const e={prevented:false,preventDefault(){this.prevented=true;}};
  w.webContents.emit('will-navigate',e,'https://attacker.invalid/');
  assert.equal(e.prevented,true);assert.equal(w.open().action,'deny');x.manager.encerrar();
});

test('review: native close handles synchronous preference failure without throwing', async () => {
  const x=windowFixture({configure:()=>{throw Error('Lume indisponível.');}});
  x.manager.atualizar(state());await tick();
  const w=x.windows[0],e={preventDefault(){}};
  try { assert.doesNotThrow(()=>w.emit('close',e)); assert.equal(w.visible,false); }
  finally { x.manager.encerrar(); }
});

test('review: preload initial snapshot cannot overwrite a newer pushed state', async () => {
  let resolveInitial,bridge;
  const ipcRenderer=new EventEmitter();
  ipcRenderer.invoke=()=>new Promise(resolve=>{resolveInitial=resolve;});
  vm.runInNewContext(readFileSync(new URL('../desktop/companheiro-preload.cjs',import.meta.url),'utf8'),{
    require:name=>{assert.equal(name,'electron');return {ipcRenderer,contextBridge:{exposeInMainWorld:(_key,value)=>{bridge=value;}}};}
  });
  const received=[],unsubscribe=bridge.onState(s=>received.push(s));
  ipcRenderer.emit('lume-companheiro:estado',{},state({estado:'trabalhando'}));
  resolveInitial(state({estado:'pausado'}));await tick();
  assert.equal(received.at(-1).estado,'trabalhando','late initial response must not roll back current state');
  unsubscribe();assert.equal(ipcRenderer.listenerCount('lume-companheiro:estado'),0);
});

test('review: hide persists across service recreation; attention never exports private proposal text', async t => {
  const db=abrirBanco(':memory:');prepararPessoal(db);t.after(()=>db.close());
  const events=[],pessoal={ativa:()=>true,validarAviso:()=>true,running:null},conexao={estado:()=>({estado:'conectada'})};
  const service=new CompanheiroPessoal(db,{pessoal,conexao,publicar:s=>events.push(s)});
  assert.equal(service.estado().som,false);
  const event=db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local) VALUES(?,?,'entrada','texto','{}',?,?,?)")
    .run('private-fixture@s.whatsapp.net','fixture-message','PRIVATE_SOURCE_FIXTURE','2026-10-26T00:00:00Z','2026-10-26').lastInsertRowid;
  db.prepare("INSERT INTO pessoal_propostas(id,conversa_id,evento_id,versao,politica_hash,conteudo_hash,baloes,fontes,motivo,estado,criada_em) VALUES(?,?,?,1,'policy','digest',?,?,'PRIVATE_REASON_FIXTURE','pendente','2026-10-26T00:00:00Z')")
    .run('opaque-proposal-id','private-fixture@s.whatsapp.net',event,'["PRIVATE_REPLY_FIXTURE"]','[{"private":"PRIVATE_SOURCE_FIXTURE"}]');
  service.configurar({enabled:true});
  assert.equal(events.at(-1).estado,'atencao');
  assert.equal(events.at(-1).notificacaoId,'proposta:opaque-proposal-id');
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_|private-fixture/);
  pessoal.validarAviso=()=>false;service.sinalizar();
  assert.equal(events.at(-1).estado,'aguardando');assert.equal(events.at(-1).notificacaoId,null);
  const x=windowFixture({configure:c=>{const result=service.configurar(c);x.manager.atualizar(events.at(-1));return result;}});
  x.manager.atualizar(events.at(-1));await tick();
  const w=x.windows[0];
  await x.handlers.get('lume-companheiro:acao')({sender:w.webContents,senderFrame:w.webContents.mainFrame},{acao:'ocultar'});
  assert.equal(w.isVisible(),false);
  assert.deepEqual(new CompanheiroPessoal(db).estado(),{enabled:false,som:false,disponivel:true,tema:'system',movimento:'system',volume:.35,pausado:false,adiadoId:null,adiadoAte:null});
  x.manager.encerrar();
});

test('review: native preference promise cannot confirm success before utility persistence result', async t => {
  const x=fixture.setup();t.after(x.dispose);await fixture.boot(x);
  x.workers[0].emit('message',{tipo:'companheiro-estado',estado:state()});await tick();
  const w=x.windows[1],handler=x.ipcHandlers.get('lume-companheiro:acao');
  let settled=false;
  void handler({sender:w.webContents,senderFrame:w.webContents.mainFrame},{acao:'ocultar'}).then(()=>{settled=true;},()=>{settled=true;});
  await tick();
  assert.ok(x.workers[0].sent.some(m=>m.tipo==='companheiro-preferencia'));
  const premature=settled;
  x.app.quit();fixture.acknowledgeShutdown(x.workers[0]);
  await fixture.until(()=>x.events.includes('quit'));
  assert.equal(premature,false,'postMessage alone is not a persistence acknowledgement; write errors must reach the control');
});

test('review: preference receipt binds exact ID, reports failure and rejects pending work at shutdown', async t => {
  const x=fixture.setup();t.after(x.dispose);await fixture.boot(x);
  const worker=x.workers[0];worker.emit('message',{tipo:'companheiro-estado',estado:state()});await tick();
  const w=x.windows[1],handler=x.ipcHandlers.get('lume-companheiro:acao'),event={sender:w.webContents,senderFrame:w.webContents.mainFrame};
  const sent=()=>worker.sent.findLast(m=>m.tipo==='companheiro-preferencia');
  let outcome='pending';
  const first=handler(event,{acao:'som',som:true}).then(()=>{outcome='accepted';},()=>{outcome='rejected';});
  worker.emit('message',{tipo:'companheiro-preferencia-resposta',id:'unknown-id',ok:true});await tick();
  assert.equal(outcome,'pending');
  worker.emit('message',{tipo:'companheiro-preferencia-resposta',id:sent().id,ok:false});await first;
  assert.equal(outcome,'rejected');
  const second=handler(event,{acao:'som',som:false});
  worker.emit('message',{tipo:'companheiro-preferencia-resposta',id:sent().id,ok:true});
  assert.equal(await second,true);
  const third=handler(event,{acao:'ocultar'}),rejected=assert.rejects(third,/indisponível/),lateId=sent().id;
  x.app.quit();await rejected;
  worker.emit('message',{tipo:'companheiro-preferencia-resposta',id:lateId,ok:true});
  assert.equal(x.hooks.active.preferenciasCompanheiro.size,0);
  fixture.acknowledgeShutdown(worker);await fixture.until(()=>x.events.includes('quit'));
});

test('review: missing preference receipt times out once without resending', async t => {
  const x=fixture.setup();t.after(x.dispose);await fixture.boot(x);
  const worker=x.workers[0];worker.emit('message',{tipo:'companheiro-estado',estado:state()});await tick();
  const w=x.windows[1];
  const pending=x.ipcHandlers.get('lume-companheiro:acao')({sender:w.webContents,senderFrame:w.webContents.mainFrame},{acao:'ocultar'});
  // The production timeout is unref'ed; keep this isolated test alive until it fires.
  const keepAlive=setTimeout(()=>{},11000);t.after(()=>clearTimeout(keepAlive));
  await assert.rejects(pending,/confirmar a preferência/);
  assert.equal(worker.sent.filter(m=>m.tipo==='companheiro-preferencia').length,1);
  assert.equal(x.hooks.active.preferenciasCompanheiro.size,0);
  x.app.quit();fixture.acknowledgeShutdown(worker);await fixture.until(()=>x.events.includes('quit'));
});
