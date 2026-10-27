// Real HTTP server, SQLite and personal service. Only the external provider/keychain boundary is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {abrirBanco} from '../src/banco.js';
import {Desktop, VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {criarServidor} from '../src/painel/servidor.js';

const base = '/api/v3/pessoal';
const getPaths = ['', '/conversas', '/organizacao', '/classificador', '/chatgpt', '/chatgpt/modelos', '/avaliacao', '/avaliacao/relatorio'];
const postPaths = ['/config', '/conversa', '/atendimento', '/classificador', '/vinculo', '/credencial', '/mensagem/preparar', '/mensagem/aprovar', '/chatgpt/login', '/chatgpt/modelo', '/chatgpt/conta', '/chatgpt/testar', '/chatgpt/sair', '/chatgpt/retomar', '/avaliacao/iniciar', '/avaliacao/proximo', '/avaliacao/revisar', '/avaliacao/aceitar'];
const jid = '550000000001@s.whatsapp.net';
async function fixture(t, {readOnly = false, accepted = true} = {}) {
  const db = abrirBanco(), contexto = new ContextoApp(db), desktop = new Desktop(db), calls = [], credentials = [];
  if (accepted) desktop.aceitar({nome: 'HTTP sintético', aceito: true, versao: VERSAO_TERMOS});
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(jid, 'Contato sintético');
  db.prepare("INSERT INTO desktop_config VALUES('pessoal-chatgpt-model','synthetic-model')").run();
  const state = {available: true, connected: true, planEnabled: true, model: 'synthetic-model', paused: false, account: {id: 'synthetic-account', email: 'synthetic@example.invalid'}, accounts: []};
  const chatgpt = {
    estado: async () => ({...state}), modelos: async () => [{id: 'synthetic-model', name: 'Modelo sintético'}], encerrar() {},
    iniciarLogin: async data => {calls.push(['login', data]); return {url: 'https://auth.openai.com/api/accounts/authorize?synthetic=true', expiresAt: '2026-10-26T20:00:00Z'};},
    selecionarModelo: async model => {calls.push(['model', model]); state.model = model; db.prepare("UPDATE desktop_config SET valor=? WHERE chave='pessoal-chatgpt-model'").run(model); return {...state};},
    selecionarConta: async id => {calls.push(['account', id]); return {...state};},
    responder: async request => {calls.push(['response', request]); return {completed: true, model: state.model, requestId: 'synthetic-only-' + calls.length, text: JSON.stringify({decisao: 'consultar_dono', resumo: 'Resposta de teste sintético', trecho: '', baloes: [], fontes: [], motivo: 'Nenhuma inferência real.'})};},
    sair: async () => {calls.push(['logout']); return {ok: true};}, retomar: () => {calls.push(['resume']); state.paused = false;}
  };
  const pessoal = new LumePessoal(db, {desktop, chatgpt, telegram: {estado: async () => ({enabled: false}), agendar: () => false}, conexao: {enviarTexto: () => assert.fail('HTTP fixture cannot send')}, fetchImpl: async () => assert.fail('No external network')});
  pessoal.salvarCredencial = async (tipo, token) => credentials.push({tipo, token});
  const server = criarServidor(db, {desktop: true, readOnly, pessoal, contexto, conexao: {estado: () => ({estado: 'desconectada'})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const {token} = await (await fetch(origin + '/api/sessao')).json();
  t.after(async () => {await new Promise(resolve => {server.close(resolve); server.closeAllConnections();}); await pessoal.encerrar(); db.close();});
  const request = async (path, {body, auth = true, headers = {}} = {}) => {
    return new Promise((resolve, reject) => {
      const req = httpRequest(origin + base + path, {method: body === undefined ? 'GET' : 'POST', headers: {...(auth ? {'x-assessor-token': token} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers}}, response => {
        let raw = ''; response.setEncoding('utf8'); response.on('data', chunk => raw += chunk);
        response.on('end', () => {try {resolve({status: response.statusCode, data: JSON.parse(raw), cache: response.headers['cache-control']});} catch (error) {reject(error);}});
        response.on('error', reject);
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  return {db, contexto, pessoal, calls, credentials, request, state};
}

test('HTTP pessoal: sessão, origem e primeiro acesso bloqueiam todas as fronteiras sem efeitos', async t => {
  const f = await fixture(t);
  for (const path of getPaths) for (const headers of [{}, {'x-assessor-token': 'wrong-session'}]) assert.equal((await f.request(path, {auth: false, headers})).status, 403, path);
  for (const path of postPaths) assert.equal((await f.request(path, {body: {}, auth: false})).status, 403, path);
  for (const headers of [{origin: 'https://untrusted.invalid'}, {host: 'untrusted.invalid'}, {'sec-fetch-site': 'cross-site'}]) {
    assert.equal((await f.request('', {headers})).status, 403, JSON.stringify(headers));
    for (const path of ['/chatgpt/testar', '/mensagem/preparar', '/mensagem/aprovar']) assert.equal((await f.request(path, {body: {}, headers})).status, 403);
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.credentials, []); assert.equal(f.pessoal.ativa(), false);
  const initial = await fixture(t, {accepted: false});
  for (const path of getPaths) assert.equal((await initial.request(path)).status, 403);
  for (const path of postPaths) assert.equal((await initial.request(path, {body: {}})).status, 403);
  assert.deepEqual(initial.calls, []);
});

test('HTTP pessoal: ensaio readOnly permite consulta autenticada e recusa todas as operações', async t => {
  const f = await fixture(t, {readOnly: true});
  for (const path of getPaths) {const response = await f.request(path); assert.equal(response.status, 200, path); assert.equal(response.cache, 'no-store');}
  for (const path of postPaths) assert.equal((await f.request(path, {body: {}})).status, 403, path);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.credentials, []); assert.equal(f.pessoal.ativa(), false);
});

test('HTTP pessoal: mensagem do dono exige preparo válido, confirmação booleana e hash exato sem enviar no endpoint', async t => {
  const f = await fixture(t);
  await f.request('/config', {body: {enabled: true}});
  await f.request('/conversa', {body: {conversaId: jid, categoria: 'team', modo: 'rascunhar', remoto: true}});
  const body = {conversaId: jid, baloes: ['Lume, assistente do Fabrício.', 'Convite sintético para testar autorização.', 'Este texto não será enviado.', 'Obrigado.'], motivo: 'Pedido explícito sintético de convite para validar o endpoint.'};
  assert.equal((await f.request('/mensagem/preparar', {body})).status, 400, 'No source cannot prepare');
  const ingested = f.contexto.receber({type: 'history', messages: [{key: {id: 'synthetic-http-owner-message', remoteJid: jid, fromMe: false}, messageTimestamp: Math.floor(Date.now() / 1000), message: {conversation: 'Histórico sintético para identificar a conversa.'}}]});
  assert.equal(ingested.falhas, 0);
  for (const invalid of [{...body, extra: true}, {...body, baloes: [...body.baloes, 'Excesso']}, {...body, baloes: ['Sem identificação']}, {...body, conversaId: '*'}]) assert.equal((await f.request('/mensagem/preparar', {body: invalid})).status, 400);
  const prepared = await f.request('/mensagem/preparar', {body});
  assert.equal(prepared.status, 200); assert.equal(prepared.data.estado, 'pendente');
  assert.deepEqual((await f.request('/mensagem/preparar', {body})).data, prepared.data);
  const approval = {id: prepared.data.id, versao: prepared.data.versao};
  for (const invalid of [approval, {...approval, confirmar: false}, {...approval, confirmar: 'true'}, {...approval, confirmar: true, versao: 'wrong'}, {...approval, confirmar: true, id: 'other-proposal'}, {...approval, confirmar: true, extra: true}]) assert.equal((await f.request('/mensagem/aprovar', {body: invalid})).status, 400);
  assert.equal(f.pessoal.proposta(approval.id).estado, 'pendente');
  for (const headers of [{origin: 'https://evil.invalid'}, {host: 'evil.invalid'}, {'sec-fetch-site': 'cross-site'}]) assert.equal((await f.request('/mensagem/aprovar', {body: {...approval, confirmar: true}, headers})).status, 403);
  assert.equal((await f.request('/mensagem/aprovar', {body: {...approval, confirmar: true}, auth: false})).status, 403);
  const approved = await f.request('/mensagem/aprovar', {body: {...approval, confirmar: true}});
  assert.equal(approved.status, 200); assert.equal(approved.data.estado, 'aprovada');
  assert.equal(f.pessoal.proposta(approval.id).aprovada_por, 'local:owner');
  assert.equal((await f.request('/mensagem/aprovar', {body: {...approval, confirmar: true}})).status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saidas').get().n, 0); assert.deepEqual(f.calls, []);
});

test('HTTP pessoal: configuração, vínculos e credenciais próprias validam campos e não expõem tokens', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/config', {body: {enabled: true}})).data.enabled, true);
  assert.equal((await f.request('/conversa', {body: {conversaId: jid, categoria: 'vip_client', modo: 'rascunhar', remoto: true}})).status, 200);
  for (const [tipo, recurso] of [['github', 'synthetic/repository'], ['clickup', 'synthetic_task_1']]) {
    assert.equal((await f.request('/vinculo', {body: {conversaId: jid, tipo, recurso}})).status, 200);
    const token = 'SYNTHETIC_ONLY_' + tipo.toUpperCase() + '_TOKEN';
    assert.deepEqual((await f.request('/credencial', {body: {tipo, token}})).data, {configurada: true});
    const status = await f.request(''); assert.equal(JSON.stringify(status.data).includes(token), false);
  }
  assert.equal((await f.request('')).data.conversas[0].vinculos.length, 2);
  assert.equal(f.credentials.length, 2);
  assert.equal((await f.request('/vinculo', {body: {conversaId: jid, tipo: 'github', recurso: 'synthetic/repository', remover: true}})).data.length, 1);
  for (const [path, body] of [['/config', {enabled: true, extra: true}], ['/config', {enabled: 'true'}], ['/conversa', {conversaId: '*', categoria: 'vip_client', modo: 'atender', remoto: true}], ['/vinculo', {conversaId: jid, tipo: 'github', recurso: 'https://evil.invalid'}], ['/credencial', {tipo: 'chatgpt', token: 'SYNTHETIC_ONLY_TOKEN'}], ['/credencial', {tipo: 'github', token: 'short'}], ['/credencial', {tipo: 'clickup', token: 'contains whitespace'}], ['/credencial', {tipo: 'github', token: 'a'.repeat(2049)}], ['/credencial', {tipo: 'github', token: 'SYNTHETIC_ONLY_TOKEN', extra: true}]]) assert.equal((await f.request(path, {body})).status, 400, path);
  for (const path of getPaths) assert.equal((await f.request(path + '?unexpected=1')).status, 400);
  assert.equal((await f.request('/config?unexpected=1', {body: {enabled: false}})).status, 400);
  assert.equal(f.pessoal.ativa(), true); assert.equal(f.credentials.length, 2);
  const secret = 'SYNTHETIC_ONLY_NOT_IN_ERROR';
  f.pessoal.salvarCredencial = async () => {throw new Error(secret);};
  const failed = await f.request('/credencial', {body: {tipo: 'github', token: secret}});
  assert.equal(failed.status, 400); assert.equal(JSON.stringify(failed.data).includes(secret), false);
  assert.deepEqual(f.calls, [], 'Configuration never consumes the plan');
});

test('HTTP pessoal: login/modelo/conta e avaliação encaminham somente ações explícitas; aceite incompleto recusado', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/chatgpt/login', {body: {accountId: 'synthetic-account'}})).status, 200);
  assert.equal((await f.request('/chatgpt/conta', {body: {id: 'synthetic-account'}})).status, 200);
  assert.equal((await f.request('/chatgpt/modelo', {body: {model: 'synthetic-model'}})).status, 200);
  assert.equal(f.calls.filter(call => call[0] === 'response').length, 0);
  assert.equal((await f.request('/chatgpt/testar', {body: {unexpected: true}})).status, 400);
  assert.equal((await f.request('/chatgpt/testar', {body: {}})).data.completed, true);
  assert.match(f.calls.find(call => call[0] === 'response')[1].input[0].content, /sem conteúdo privado/);
  const prepared = await f.request('/avaliacao/iniciar', {body: {confirmar: true}});
  assert.equal(prepared.status, 200); assert.equal(prepared.data.executados, 0);
  assert.equal(f.calls.filter(call => call[0] === 'response').length, 1, 'Preparing the corpus does not call the provider');
  assert.equal((await f.request('/avaliacao/aceitar', {body: {confirmar: true}})).status, 400);
  const next = await f.request('/avaliacao/proximo', {body: {}});
  assert.equal(next.status, 200); assert.equal(next.data.executados, 1);
  assert.equal(f.calls.filter(call => call[0] === 'response').length, 2, 'One explicit next request executes one synthetic provider call');
  const report = (await f.request('/avaliacao/relatorio')).data;
  assert.equal(report.casos.length, 100); assert.equal(report.execucao.resultados.length, 1);
  const result = report.execucao.resultados[0];
  const review = {id: result.id, digest: result.digest, interpretacao: false, fontes: false, resposta: false, criticoAtendido: false, revisadoPor: 'Teste sintético', evidencia: 'Resultado sintético somente para testar o contrato HTTP.'};
  assert.equal((await f.request('/avaliacao/revisar', {body: {...review, digest: 'stale'}})).status, 400);
  assert.equal((await f.request('/avaliacao/revisar', {body: review})).data.revisados, 1);
  assert.equal((await f.request('/avaliacao/aceitar', {body: {confirmar: true}})).status, 400);
  assert.equal((await f.request('/avaliacao')).data.liberada, false);
  assert.equal((await f.request('/chatgpt/retomar', {body: {}})).status, 200);
  assert.equal((await f.request('/chatgpt/sair', {body: {}})).status, 200);
  assert.equal(f.calls.filter(call => call[0] === 'response').length, 2);
});
