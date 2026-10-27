import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { criarPonteCentral, whatsappParaCentral } from '../desktop/central-ponte.js';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';

const ID = 'b84c33d7-35c6-4a89-bf3f-7f9dc7c8b133';
const estado = { situacao: 'registrado', consentido: true, registrado: true, revogada: false, instalacaoId: ID, ultimoSucessoEm: '2026-09-18T12:00:00.000Z', proximaTentativaEm: null, falhasConsecutivas: 0 };

test('ponte IPC envia comandos fechados e remove credenciais ou campos extras da resposta', async () => {
  const porta = new EventEmitter(), chamadas = [];
  porta.postMessage = mensagem => {
    chamadas.push(mensagem);
    setImmediate(() => porta.emit('message', { data: { tipo: 'central-resposta', id: mensagem.id, estado: { ...estado, token: 'NAO_VAZAR', conversa: 'NAO_VAZAR' } } }));
  };
  const central = criarPonteCentral(porta, { timeout: 1000 });
  const consultado = await central.consultar();
  assert.deepEqual(Object.keys(consultado).sort(), ['consentido','feedbackHabilitado','falhasConsecutivas','instalacaoId','proximaTentativaEm','registrado','revogada','situacao','ultimoSucessoEm'].sort());
  assert.equal(JSON.stringify(consultado).includes('NAO_VAZAR'), false);
  await central.consentir('LUME-ABCDEFGHIJKL');
  await central.autorizarFeedback('LUME-ABCDEFGHIJKL');
  await central.ativarAcompanhamento();
  await central.desativarAcompanhamento();
  await central.revogar();
  assert.deepEqual(chamadas.map(({ tipo, acao, convite }) => ({ tipo, acao, ...(convite ? { convite } : {}) })), [
    { tipo: 'central-comando', acao: 'consultar' },
    { tipo: 'central-comando', acao: 'consentir', convite: 'LUME-ABCDEFGHIJKL' },
    { tipo: 'central-comando', acao: 'autorizar-feedback', convite: 'LUME-ABCDEFGHIJKL' },
    { tipo: 'central-comando', acao: 'ativar-acompanhamento' },
    { tipo: 'central-comando', acao: 'desativar-acompanhamento' },
    { tipo: 'central-comando', acao: 'revogar' }
  ]);
  await assert.rejects(central.consentir('convite ruim'), /Inválido/i);
  assert.equal(chamadas.length, 6);
  central.encerrar();
});

test('mapeamento do WhatsApp para o pulso usa somente categorias permitidas', () => {
  assert.equal(whatsappParaCentral('conectada'), 'conectado');
  assert.equal(whatsappParaCentral('aguardando_qr'), 'pareando');
  assert.equal(whatsappParaCentral('reconectando'), 'pareando');
  assert.equal(whatsappParaCentral('auth_invalida'), 'erro');
  assert.equal(whatsappParaCentral('C:\\perfil\\privado'), 'pausado');
});

test('ponte de feedback entrega somente recibo válido, sem token ao painel',async()=>{
  const porta=new EventEmitter(),chamadas=[];
  porta.postMessage=mensagem=>{chamadas.push(mensagem);setImmediate(()=>porta.emit('message',{data:{tipo:'central-resposta',id:mensagem.id,recibo:{id:ID,recebidoEm:'2026-09-24T15:00:00.000Z',token:'NAO_VAZAR'}}}));};
  const central=criarPonteCentral(porta,{timeout:1000});
  const dados={chaveCliente:ID,categoria:'erro',etapa:'conexao',relato:'O QR parou após a leitura.',utilidade:null};
  assert.deepEqual(await central.enviarFeedback(dados),{id:ID,recebidoEm:'2026-09-24T15:00:00.000Z'});
  assert.deepEqual(chamadas[0].dados,{...dados,contatoAutorizado:false});
  await assert.rejects(central.enviarFeedback({...dados,contatoAutorizado:'sim'}),/campos/i);
  assert.equal(chamadas[0].token,undefined);
  await assert.rejects(central.enviarFeedback({...dados,conversa:'segredo'}),/campos/i);
  central.encerrar();
});

test('rascunho local de feedback sobrevive à mudança da porta do painel',async t=>{
  const db=abrirBanco();new Desktop(db).aceitar({nome:'Pessoa teste',aceito:true,versao:VERSAO_TERMOS});
  const central={consultar:async()=>estado,enviarFeedback:async()=>({id:ID,recebidoEm:'2026-09-24T15:00:00.000Z'})};
  const iniciar=async()=>{const server=criarServidor(db,{desktop:true,central,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,base:`http://127.0.0.1:${server.address().port}`};};
  let a=await iniciar();t.after(async()=>{await new Promise(resolve=>a.server.close(resolve));db.close();});
  const chaveCliente='14d10888-d8f2-4464-b178-f8fb9c999efe';
  const rascunho={chaveCliente,categoria:'erro',etapa:'conexao',relato:'A conexão parou depois do QR.',utilidade:null};
  const sessao=await(await fetch(`${a.base}/api/sessao`)).json();
  const post=(base,path,body,token)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-assessor-token':token},body:JSON.stringify(body)});
  assert.equal((await post(a.base,'/api/v3/central/feedback-rascunho',{rascunho},sessao.token)).status,200);
  assert.equal((await fetch(`${a.base}/api/v3/central/feedback-rascunho`)).status,403);
  await new Promise(resolve=>a.server.close(resolve));
  a=await iniciar();
  const outraSessao=await(await fetch(`${a.base}/api/sessao`)).json();
  const retomado=await(await fetch(`${a.base}/api/v3/central/feedback-rascunho`,{headers:{'x-assessor-token':outraSessao.token}})).json();
  assert.deepEqual(retomado.rascunho,rascunho);
  const enviado=await post(a.base,'/api/v3/central/feedback',rascunho,outraSessao.token);
  assert.equal(enviado.status,200);
  assert.equal((await post(a.base,'/api/v3/central/feedback',{...rascunho,relato:'curto'},outraSessao.token)).status,400);
  const limpo=await(await fetch(`${a.base}/api/v3/central/feedback-rascunho`,{headers:{'x-assessor-token':outraSessao.token}})).json();
  assert.equal(limpo.rascunho,null);
});

test('HTTP local exige aceite, CSRF e confirmação fechada para consentir ou revogar', async t => {
  const db = abrirBanco();
  const chamadas = [];
  const central = {
    consultar: async () => { chamadas.push(['consultar']); return estado; },
    consentir: async convite => { chamadas.push(['consentir', convite]); return estado; },
    autorizarFeedback: async convite => { chamadas.push(['autorizar-feedback',convite]); return {...estado,consentido:false,feedbackHabilitado:true}; },
    ativarAcompanhamento: async () => { chamadas.push(['ativar-acompanhamento']); return estado; },
    desativarAcompanhamento:async()=>{chamadas.push(['desativar-acompanhamento']);return {...estado,consentido:false,feedbackHabilitado:true};},
    revogar: async () => { chamadas.push(['revogar']); return { ...estado, situacao: 'revogada_localmente', consentido: false, registrado: false, instalacaoId: null }; }
  };
  const server = criarServidor(db, { desktop: true, central, conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/v3/central`)).status, 403);
  new Desktop(db).aceitar({ nome: 'Pessoa teste', aceito: true, versao: VERSAO_TERMOS });
  assert.deepEqual(await (await fetch(`${base}/api/v3/central`)).json(), estado);
  const sessao = await (await fetch(`${base}/api/sessao`)).json();
  const post = (path, body, csrf = sessao.token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-assessor-token': csrf }, body: JSON.stringify(body) });
  assert.equal((await post('/api/v3/central/consentir', { convite: 'LUME-ABCDEFGHIJKL', confirmar: true }, 'errado')).status, 403);
  assert.equal((await post('/api/v3/central/consentir', { convite: 'LUME-ABCDEFGHIJKL' })).status, 400);
  assert.equal((await post('/api/v3/central/consentir', { convite: 'LUME-ABCDEFGHIJKL', confirmar: true, conversa: 'segredo' })).status, 400);
  assert.equal((await post('/api/v3/central/consentir', { convite: 'LUME-ABCDEFGHIJKL', confirmar: true })).status, 200);
  assert.equal((await post('/api/v3/central/autorizar-feedback',{convite:'LUME-ABCDEFGHIJKL'},'errado')).status,403);
  assert.equal((await post('/api/v3/central/autorizar-feedback',{convite:'LUME-ABCDEFGHIJKL',conversa:'segredo'})).status,400);
  assert.equal((await post('/api/v3/central/autorizar-feedback',{convite:'LUME-ABCDEFGHIJKL'})).status,200);
  assert.equal((await post('/api/v3/central/ativar-acompanhamento',{})).status,400);
  assert.equal((await post('/api/v3/central/ativar-acompanhamento',{confirmar:true})).status,200);
  assert.equal((await post('/api/v3/central/desativar-acompanhamento',{confirmar:true})).status,400);
  assert.equal((await post('/api/v3/central/desativar-acompanhamento',{confirmar:'DESLIGAR'})).status,200);
  assert.equal((await post('/api/v3/central/revogar', { confirmar: true })).status, 400);
  assert.equal((await post('/api/v3/central/revogar', { confirmar: 'REVOGAR' })).status, 200);
  assert.deepEqual(chamadas, [['consultar'], ['consentir', 'LUME-ABCDEFGHIJKL'],['autorizar-feedback','LUME-ABCDEFGHIJKL'],['ativar-acompanhamento'],['desativar-acompanhamento'], ['revogar']]);
});

test('HTTP local mantém o aplicativo funcional quando a Central está offline', async t => {
  const db = abrirBanco(); new Desktop(db).aceitar({ nome: 'Offline', aceito: true, versao: VERSAO_TERMOS });
  const central = { consultar: async () => { throw new Error('token e caminho privados'); } };
  const server = criarServidor(db, { desktop: true, central, conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const resposta = await fetch(`${base}/api/v3/central`);
  assert.equal(resposta.status, 503);
  assert.equal(JSON.stringify(await resposta.json()).includes('privados'), false);
  assert.equal((await fetch(`${base}/api/v3/perfil`)).status, 200);
});
