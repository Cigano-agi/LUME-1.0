import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { criarServidor } from '../src/painel/servidor.js';

test('seletor HTTP retorna token sem caminho, limita contexto ao projeto escolhido e trata cancelamento', async t => {
  const dir = mkdtempSync(join(homedir(), 'lume-projeto-http-sintetico-'));
  const selecionada = mkdtempSync(join(tmpdir(), 'projeto-lume-seletor-sintetico-'));
  writeFileSync(join(selecionada, 'resumo.md'), 'Fonte sintética do projeto.\n');
  writeFileSync(join(selecionada, '.env'), 'SYNTHETIC_SECRET_DO_NOT_EXPORT');
  writeFileSync(join(selecionada, 'AGENTS.override.md'), 'SYNTHETIC_INSTRUCTIONS_DO_NOT_EXPORT');
  const dbPath = join(dir, 'data', 'assessor.db');
  mkdirSync(join(dir, 'data'));
  const db = abrirBanco(dbPath);
  const agora = new Date('2026-10-05T15:00:00Z');
  new ContextoApp(db);
  const desktop = new Desktop(db);
  const acoes = new AcoesLume(db, { agora: () => agora });
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('teste-local', 'Contato sintético');
  const fonte = Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
    VALUES(?,?,'entrada','texto','{}',?,'2026-10-05T14:00:00Z','2026-10-05','minha',1)`).run('teste-local', 'fonte-http-sintetica', 'Preparar resumo do projeto sintético.').lastInsertRowid);
  acoes.autorizar({ conversa: 'teste-local', permitida: true });
  acoes.registrar({ eventoId: fonte, candidatas: [{ fonte: `E${fonte}`, tipo: 'pendencia', resumo: 'Preparar resumo sintético', trecho: 'Preparar resumo do projeto sintético.', prazo_citado: '' }] });
  const acao = acoes.listar().find(x => x.evento_id === fonte);

  let escolhe = true;
  let chamadas = 0;
  const server = criarServidor(db, {
    desktop: true,
    selecionarProjeto: async () => { chamadas++; return escolhe ? selecionada : null; },
    conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => {} }
  });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    db.close();
    for (const path of [dir, selecionada]) {
      if (!resolve(path).startsWith(resolve(path === dir ? homedir() : tmpdir()) + sep)) throw Error('Pasta temporária inválida');
      rmSync(path, { recursive: true, force: true });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(base + '/api/sessao')).json();
  const headers = { 'x-assessor-token': token, 'content-type': 'application/json' };
  const post = (body, withSession = true) => fetch(base + '/api/v3/execucoes/projeto', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(withSession ? { 'x-assessor-token': token } : {}) }, body: JSON.stringify(body)
  });

  desktop.aceitar({ nome: 'Perfil HTTP sintético', aceito: true, versao: VERSAO_TERMOS });
  assert.equal((await post({}, false)).status, 403, 'seletor exige token de sessão');
  assert.equal(chamadas, 0);

  const selectedResponse = await post({});
  assert.equal(selectedResponse.status, 200);
  const selectedBody = await selectedResponse.json();
  assert.equal(selectedBody.projeto.nome, selectedPathName(selecionada));
  assert.match(selectedBody.projeto.id, /^[a-f0-9]{32}$/);
  assert.deepEqual(selectedBody.projeto.arquivos, [{ caminho: 'resumo.md', bytes: Buffer.byteLength('Fonte sintética do projeto.\n') }]);
  assert.equal(selectedBody.projeto.omitidos, 2);
  assert.ok(!JSON.stringify(selectedBody).includes('SYNTHETIC_SECRET_DO_NOT_EXPORT'));
  assert.ok(!JSON.stringify(selectedBody).includes('AGENTS.override.md'));
  assert.ok(!JSON.stringify(selectedBody).includes(selecionada), 'caminho local não pode vazar na resposta');
  assert.equal(chamadas, 1);

  const escopo = { arquivos: ['resumo.md'], permissoes: { leitura: ['resumo.md'], escrita: ['resumo.md'], ferramentas: [] } };
  const contexto = await postContext({ acao_id: acao.id, projeto_id: selectedBody.projeto.id, escopo }, headers, base);
  assert.equal(contexto.status, 200);
  const contextoBody = await contexto.json();
  assert.equal(contextoBody.contexto.projeto.id, selectedBody.projeto.id);
  assert.deepEqual(contextoBody.contexto.escopo, escopo);
  assert.ok(contextoBody.contexto.digest);
  const aceite = { digest: contextoBody.contexto.digest, projeto_id: selectedBody.projeto.id, fonte_id: acao.evento_id, escopo };
  const blockedStart = await fetch(base + '/api/v3/execucoes/iniciar', { method: 'POST', headers,
    body: JSON.stringify({ contexto_id: contextoBody.contexto.id, assistente: 'codex', confirmar: true,
      chave_idempotencia: 'preview-only-project-01', aceite }) });
  assert.equal(blockedStart.status, 409, 'prévia não pode iniciar um runner ainda não integrado');
  assert.equal((await blockedStart.json()).codigo, 'CODEX_NATIVE_NOT_READY');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 0, 'recusa não cria execução');

  const inventado = await postContext({ acao_id: acao.id, projeto_id: 'a'.repeat(32), escopo }, headers, base);
  assert.equal(inventado.status, 409, 'ID inventado não recebe autoridade de projeto');
  const naoListado = await postContext({ acao_id: acao.id, projeto_id: selectedBody.projeto.id,
    escopo: { arquivos: ['nao-listado.md'], permissoes: { leitura: ['nao-listado.md'], escrita: [], ferramentas: [] } } }, headers, base);
  assert.equal(naoListado.status, 409, 'arquivo que não apareceu no seletor não recebe autoridade');

  const segundaEscolha = await (await post({})).json();
  assert.match(segundaEscolha.projeto.id, /^[a-f0-9]{32}$/);
  assert.notEqual(segundaEscolha.projeto.id, selectedBody.projeto.id);
  assert.equal((await postContext({ acao_id: acao.id, projeto_id: selectedBody.projeto.id, escopo }, headers, base)).status, 409,
    'nova escolha invalida a seleção anterior');

  escolhe = false;
  const cancelamento = await (await post({})).json();
  assert.deepEqual(cancelamento, { cancelado: true });
  assert.equal(chamadas, 3);
  assert.equal((await postContext({ acao_id: acao.id, projeto_id: segundaEscolha.projeto.id, escopo }, headers, base)).status, 409,
    'cancelar invalida a última seleção');
  const canceladoNaoRegistra = await postContext({ acao_id: acao.id, projeto_id: 'b'.repeat(32), escopo }, headers, base);
  assert.equal(canceladoNaoRegistra.status, 409);
});

function selectedPathName(path) { return path.split(/[\\/]/).filter(Boolean).at(-1); }

async function postContext(body, headers, base) {
  return fetch(base + '/api/v3/execucoes/contexto', { method: 'POST', headers, body: JSON.stringify(body) });
}
