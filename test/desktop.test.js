import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';
import { criarServidor } from '../src/painel/servidor.js';

function fixture(t) {
  const db = abrirBanco(); t.after(() => db.close());
  const contexto = new ContextoApp(db), produto = new Desktop(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('grupo@g.us', 'Equipe de teste');
  const insert = db.prepare(`INSERT INTO eventos (conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES ('grupo@g.us',?,'entrada',?,?,'texto','{}',?,'2026-09-17T12:00:00Z','2026-09-17',?)`);
  insert.run('propria', 'eu', 1, 'Confirmar orçamento 100%', 'minha');
  insert.run('dirigida', 'colega', 0, 'Pode revisar comigo?', 'dirigida');
  insert.run('segredo', 'terceiro', 0, 'Projeto secreto sensível', 'terceiro');
  insert.run('legada', 'legado', 0, 'Sem classificação', null);
  return { db, contexto, produto };
}
test('desktop: leitura pessoal inclui terceiro local classificado, sem evento sem classificação', t => {
  const { db, produto } = fixture(t);
  for (const origem of ['propria', 'segredo', 'legada']) db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em) VALUES('grupo@g.us',?,'pendencia',?,'2026-09-17')`).run(origem, origem);
  assert.equal(produto.resumo().mensagens, 3);
  assert.equal(produto.resumo().tarefas.length, 2);
  assert.equal(produto.buscar({ q: 'secreto' }).mensagens.length, 1);
  assert.deepEqual(produto.buscar({ q: '%' }).mensagens.map(x => x.origem_id), ['propria']);
  assert.ok(!JSON.stringify(produto.grafo()).includes('legada'));
  assert.equal(produto.grafo().arestas.length, 3);
  assert.throws(() => produto.resolver({ id: 3 }), /indisponível/);
  assert.throws(() => produto.buscar({ antes: NaN }), /Paginação/);
});
test('desktop: política antiga não reduz leitura pessoal nem inclui evento sem classificação', t => {
  const { produto } = fixture(t);
  produto.politica({ conversa: 'grupo@g.us', politica: 'tudo' });
  assert.equal(produto.resumo().mensagens, 3);
  assert.equal(produto.buscar({ q: 'secreto' }).mensagens.length, 1);
  assert.equal(produto.grafo().total.ligacoes, 3);
  assert.equal(produto.grafo({foco:'c:grupo@g.us'}).arestas.length, 3);
  produto.politica({ conversa: 'grupo@g.us', politica: 'so-minhas' });
  assert.equal(produto.resumo().mensagens, 3);
  assert.equal(produto.grafo().arestas.length, 3);
  assert.throws(() => produto.politica({ conversa: 'ausente', politica: 'tudo' }), /não encontrada/);
});
test('desktop: aceite é versionado, explícito e persistido no banco', t => {
  const { db, produto } = fixture(t);
  assert.equal(produto.perfil().aceito, false);
  assert.throws(() => produto.aceitar({ nome: 'Teste', aceito: 'true', versao: VERSAO_TERMOS }));
  assert.throws(() => produto.aceitar({ nome: 'Teste', aceito: true, versao: 'antiga' }));
  produto.aceitar({ nome: 'Ana', aceito: true, versao: VERSAO_TERMOS });
  assert.equal(new Desktop(db).perfil().nome, 'Ana');
  assert.ok(produto.perfil().aceitoEm);
});
test('desktop: paginação não repete fontes e preserva procedência sem payload bruto', t => {
  const { produto } = fixture(t);
  const a = produto.buscar({ limite: 1 }), b = produto.buscar({ limite: 1, antes: a.proximoAntes });
  const c = produto.buscar({ limite: 1, antes: b.proximoAntes });
  assert.notEqual(a.mensagens[0].origem_id, b.mensagens[0].origem_id);
  assert.notEqual(b.mensagens[0].origem_id, c.mensagens[0].origem_id);
  assert.equal(c.proximoAntes, null);
  assert.equal(a.mensagens[0].bruto, undefined);
  assert.equal(a.mensagens[0].conversa_id, 'grupo@g.us');
});
test('desktop HTTP: bloqueia API legada, pareamento sem aceite, origem externa e mutação sem token', async t => {
  const db = abrirBanco(); let iniciou = 0;
  const conexao = { estado: () => ({ estado: 'desconectada', qr: null }), iniciar: async () => iniciou++, parar: async () => {} };
  const server = criarServidor(db, { conexao, desktop: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(base + '/api/sessao')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Assessor-Token': token };
  const post = (route, body, h = headers) => fetch(base + route, { method: 'POST', headers: h, body: JSON.stringify(body) });
  for (const route of ['/api/timeline','/api/mensagens','/api/crm','/api/config','/data/assessor.db','/.env']) assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await post('/api/conectar', {})).status, 403);
  assert.equal(iniciou, 0);
  assert.equal((await fetch(base + '/api/v3/resumo')).status, 403);
  const estado = await (await fetch(base + '/api/estado')).json();
  assert.equal(estado.total, undefined);
  assert.equal(estado.pendencias, undefined);
  const aceite = { nome: 'Teste', aceito: true, versao: VERSAO_TERMOS };
  assert.equal((await post('/api/v3/aceite', aceite, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post('/api/v3/aceite', aceite, { ...headers, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/v3/aceite', aceite)).status, 200);
  assert.equal((await post('/api/conectar', {})).status, 200); assert.equal(iniciou, 1);
  const page = await fetch(base + '/app');
  assert.ok(!page.headers.get('content-security-policy').includes('unsafe-inline'));
  assert.equal((await post('/api/v3/nota', { titulo: 'Primeira ideia', texto: 'Ação real' })).status, 201);
  const res = await (await fetch(base + '/api/v3/busca?q=Ação')).json();
  assert.equal(res.mensagens[0].texto, 'Ação real');
});
test('desktop HTTP publica diagnóstico de vínculo sem QR nem campo inesperado', async t => {
  const db=abrirBanco();
  const conexao={estado:()=>({estado:'reconectando',qr:'qr-privado',qrVersao:4,
    ultimoFechamento:{codigo:515,tentativas:1,em:'2026-10-05T12:00:00.000Z'},
    segredoAcidental:'token-privado'})};
  const server=criarServidor(db,{conexao,desktop:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const state=await (await fetch(`http://127.0.0.1:${server.address().port}/api/estado`)).json();
  assert.equal(state.conexao.ultimoFechamento.codigo,515);
  assert.equal(state.conexao.qrDisponivel,true);
  assert.equal(state.conexao.qr,undefined);
  assert.equal(state.conexao.segredoAcidental,undefined);
  assert.doesNotMatch(JSON.stringify(state),/qr-privado|token-privado/);
});
