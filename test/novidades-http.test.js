import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';
import { criarServidor } from '../src/painel/servidor.js';

test('HTTP mantém consentimento, consulta e revogação separados da Central', async t => {
  const db = abrirBanco();
  new Desktop(db).aceitar({ nome: 'Pessoa teste', aceito: true, versao: VERSAO_TERMOS });
  let estado = { disponivel: true, consentido: false, situacao: 'desligado', comunicado: null };
  const chamadas = [];
  const novidades = {
    estado: () => ({ ...estado }),
    ativar: () => { chamadas.push(['ativar']); estado = { ...estado, consentido: true, situacao: 'ativo' }; return { ...estado }; },
    desativar: () => { chamadas.push(['desativar']); estado = { ...estado, consentido: false, situacao: 'desligado' }; return { ...estado }; },
    verificar: async () => { chamadas.push(['verificar']); return { ...estado, situacao: 'sem_novidades' }; }
  };
  const central = { consultar: async () => { throw new Error('não deveria participar'); } };
  const server = criarServidor(db, { desktop: true, novidades, central, conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sessao = await (await fetch(base + '/api/sessao')).json();
  const post = (path, body, token = sessao.token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-assessor-token': token }, body: JSON.stringify(body) });

  assert.deepEqual(await (await fetch(base + '/api/v3/novidades')).json(), estado);
  assert.equal((await post('/api/v3/novidades/ativar', { confirmar: true }, 'errado')).status, 403);
  assert.equal((await post('/api/v3/novidades/ativar', { confirmar: true, central: true })).status, 400);
  assert.equal((await post('/api/v3/novidades/ativar', { confirmar: true })).status, 200);
  assert.equal((await post('/api/v3/novidades/verificar', { clique: true })).status, 400);
  assert.equal((await post('/api/v3/novidades/verificar', {})).status, 200);
  assert.equal((await post('/api/v3/novidades/desativar', { confirmar: true })).status, 400);
  assert.equal((await post('/api/v3/novidades/desativar', { confirmar: 'DESLIGAR' })).status, 200);
  assert.deepEqual(chamadas, [['ativar'], ['verificar'], ['desativar']]);
});
