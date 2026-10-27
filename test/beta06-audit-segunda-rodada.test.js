// Auditoria independente de 91e8779, 25/09/2026.
// AUDIT-02/03/04 falharam no alvo e passaram após as correções do coordenador.
// AUDIT-01 conserva o bloqueio do grant Hoje; sua passagem não resolve o percurso
// multidiário. UI opt-in: LUME_BETA06_AUDIT_UI=1; captura temporária opcional abaixo.
// Somente SQLite em memória, avaliador injetado e browser com rede externa bloqueada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { createLumeMcpCore } from '../src/mcp/core.js';
import { Backup } from '../src/backup.js';
import { VendasJev } from '../src/vendas/servico.js';
import { interpretarJev, CRITERIOS_TEMPERATURA, CRITERIOS_ETAPA } from '../src/vendas/jev.js';
import { criarServidor } from '../src/painel/servidor.js';

function perfil(t) {
  const db = abrirBanco(':memory:');
  new ContextoApp(db);
  const desktop = new Desktop(db);
  new DesktopIA(db);
  t.after(() => db.close());
  return { db, desktop };
}

function tarefa(t) {
  const f = perfil(t);
  f.now = new Date('2026-09-25T15:00:00Z');
  f.agora = () => f.now;
  f.conversa = 'auditoria-sintetica@s.whatsapp.net';
  const trecho = 'Preparar minuta para a reunião de amanhã.';
  f.db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(f.conversa, 'Contato sintético');
  f.fonte = Number(f.db.prepare(`INSERT INTO eventos
    (conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
    VALUES(?,?,'saida','texto','{}',?,'2026-09-25T14:00:00Z','2026-09-25','minha',1)`)
    .run(f.conversa, 'origem-auditoria', trecho).lastInsertRowid);
  f.acoes = new AcoesLume(f.db, { agora: f.agora });
  f.acoes.autorizar({ conversa: f.conversa, permitida: true });
  f.acoes.registrar({ eventoId: f.fonte, candidatas: [{ fonte: 'E' + f.fonte,
    tipo: 'pendencia', resumo: 'Preparar minuta', trecho, prazo_citado: '' }] });
  f.acao = f.acoes.listar()[0];
  f.exec = new ExecucoesLume(f.db, { agora: f.agora });
  const { contexto } = f.exec.preparar({ acao_id: f.acao.id });
  f.execucao = f.exec.iniciar({ contexto_id: contexto.id, assistente: 'claude', confirmar: true,
    chave_idempotencia: 'audit-inicio-01' }).execucao;
  f.resultado = { execucao_id: f.execucao.id, chave_idempotencia: 'audit-resultado-01',
    resumo: 'Minuta sintética entregue para conferência.', artefatos: ['minuta-sintetica.md'] };
  return f;
}

// A negativa é a proteção correta do grant Hoje. O defeito de produto é oferecer
// Resolver como percurso persistente sem explicar/renegociar esse limite. Não
// trocar o grant por all para fazer a integração funcionar.
test('AUDIT-01: reproduz bloqueio da tarefa na virada do dia preservando o grant Hoje', async t => {
    const f = tarefa(t);
    const core = createLumeMcpCore({ db: f.db, execucoes: f.exec, agora: f.agora,
      authorize: async () => ({ enabled: true, revision: '1', scope: { kind: 'today' } }) });
    const auth = { clientId: 'claude-desktop', credential: 'credencial-sintetica' };
    const antes = await core.executar('lume_obter_contexto_execucao', { execucao_id: f.execucao.id }, auth);
    assert.equal(antes.ok, true);
    f.now = new Date('2026-09-26T15:00:00Z');
    const depois = await core.executar('lume_registrar_resultado', f.resultado, auth);
    assert.equal(depois.ok, false);
    assert.equal(depois.error.code, 'SOURCE_CHANGED');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE tipo='resultado'").get().n, 0);
  });

// Falhava em 91e8779. Correção concorrente do coordenador revalidada neste teste.
test('AUDIT-02: revogar o assistente preserva a leitura local do histórico já recebido', t => {
    const f = tarefa(t);
    f.exec.registrar('resultado', f.resultado);
    f.exec.revogar({ execucao_id: f.execucao.id, confirmar: true });
    assert.throws(() => f.exec.obter({ id: f.execucao.id }, { clientId: 'claude-desktop', scope: { kind: 'all' } }),
      { code: 'SCOPE_REVOKED' });
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE tipo='resultado'").get().n, 1);
    const local = f.exec.obter({ id: f.execucao.id });
    assert.equal(local.execucao.estado, 'revogada');
    assert.equal(local.contexto.autorizacao.estado, 'revogada');
    assert.ok(local.execucao.timeline.some(e => e.tipo === 'resultado' && e.resumo === f.resultado.resumo));
    assert.ok(f.exec.historico({ id: f.execucao.id }).timeline.some(e => e.tipo === 'resultado'));
    assert.throws(() => f.exec.registrar('resultado', f.resultado), { code: 'SCOPE_REVOKED' });
    f.db.prepare("UPDATE eventos SET texto='Fonte sintética alterada.' WHERE id=?").run(f.fonte);
    assert.throws(() => f.exec.obter({ id: f.execucao.id }), { code: 'SOURCE_CHANGED' });
  });

test('AUDIT-03: restauração mantém histórico local visível após nova autorização de Organizar, sem reativar o executor', async t => {
    const origem = tarefa(t), destino = perfil(t), senha = 'senha de auditoria sintetica';
    origem.exec.registrar('resultado', origem.resultado);
    const criado = await new Backup(origem.db).criar({ senha, confirmar: true });
    const backup = new Backup(destino.db);
    const previa = await backup.preparar({ arquivo: JSON.stringify(criado.pacote), senha });
    backup.restaurar({ id: previa.id, confirmarMeuBackup: true });
    new AcoesLume(destino.db, { agora: () => new Date('2026-09-26T15:00:00Z') })
      .autorizar({ conversa: origem.conversa, permitida: true });
    const exec = new ExecucoesLume(destino.db);
    assert.equal(destino.db.prepare('SELECT estado FROM lume_execucoes').get().estado, 'revogada');
    assert.throws(() => exec.registrar('resultado', origem.resultado, { clientId: 'claude-desktop', scope: { kind: 'all' } }),
      { code: 'SCOPE_REVOKED' });
    assert.equal(new AcoesLume(destino.db).listar().length, 1);
    assert.equal(exec.listar({ acao_id: origem.acao.id }).execucoes.length, 1);
    const local = exec.obter({ id: origem.execucao.id });
    assert.equal(local.execucao.estado, 'revogada');
    assert.equal(local.execucao.historico_importado, true);
    assert.equal(local.contexto.historico_importado, true);
    assert.equal(local.contexto.autorizacao.estado, 'revogada');
    assert.ok(exec.historico({ id: origem.execucao.id }).timeline.some(e => e.tipo === 'resultado'));
    assert.throws(() => exec.obter({ id: origem.execucao.id }, { clientId: 'claude-desktop', scope: { kind: 'all' } }),
      { code: 'SCOPE_REVOKED' });
    assert.throws(() => exec.fonteAutorizada(origem.execucao.id), { code: 'SCOPE_REVOKED' });
    assert.throws(() => exec.registrar('resultado', origem.resultado), { code: 'SCOPE_REVOKED' });
    const procedencia = destino.db.prepare("SELECT * FROM lume_ciclo_importacoes WHERE tabela='lume_execucoes' AND registro_id=?")
      .get(origem.execucao.id);
    assert.ok(procedencia);
    destino.db.prepare("DELETE FROM lume_ciclo_importacoes WHERE tabela='lume_execucoes' AND registro_id=?").run(origem.execucao.id);
    assert.throws(() => exec.obter({ id: origem.execucao.id }), { code: 'SOURCE_CHANGED' });
    destino.db.prepare('INSERT INTO lume_ciclo_importacoes VALUES(?,?,?,?,?)').run(procedencia.tabela,
      procedencia.registro_id, procedencia.backup_sha256, procedencia.importado_em, procedencia.estado_original);
    const contextoId = destino.db.prepare('SELECT contexto_id FROM lume_execucoes WHERE id=?').get(origem.execucao.id).contexto_id;
    assert.throws(() => exec.iniciar({ contexto_id: contextoId, assistente: 'claude', confirmar: true,
      chave_idempotencia: 'audit-nao-reativar-01' }), error => ['SOURCE_CHANGED', 'CONTEXT_EXPIRED'].includes(error.code));
    destino.db.prepare('DELETE FROM lume_acoes_conversas WHERE conversa_id=?').run(origem.conversa);
    assert.throws(() => exec.obter({ id: origem.execucao.id }), { code: 'SOURCE_CHANGED' });
    new AcoesLume(destino.db).autorizar({ conversa: origem.conversa, permitida: true });
    destino.db.prepare("UPDATE eventos SET texto='Fonte alterada depois do restauro.' WHERE id=?").run(origem.fonte);
    assert.throws(() => exec.obter({ id: origem.execucao.id }), { code: 'SOURCE_CHANGED' });
  });

test('AUDIT-04: Vendas mostra necessidade de revisão e confiança baixa no resultado do Jev',
  { skip: process.env.LUME_BETA06_AUDIT_UI !== '1', timeout: 45000 }, async t => {
    const f = tarefa(t);
    f.desktop.aceitar({ nome: 'Pessoa sintética', aceito: true, versao: VERSAO_TERMOS });
    f.desktop.configurarGuia({ dispensado: true });
    const answer = (criteria, value) => ({ type: 'choice', choice: value, confidence: 0.4,
      probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, k === value ? 0.4 : 0.6 / (Object.keys(criteria).length - 1)])) });
    const resultado = interpretarJev({ model: 'typesafe/jev-1.14', answers: {
      temperatura: answer(CRITERIOS_TEMPERATURA, 'quente'), etapa: answer(CRITERIOS_ETAPA, 'proposta') } });
    assert.equal(resultado.revisao, 'necessaria');
    const vendas = new VendasJev(f.db, { avaliar: async () => resultado,
      segredos: { ler: async () => 'chave-sintetica-nenhum-provedor' } });
    const previa = vendas.preparar({ conversa_id: f.conversa });
    await vendas.avaliar({ previa_id: previa.id, confirmar: true });
    const server = criarServidor(f.db, { desktop: true,
      segredosJev: { estado: async () => ({ disponivel: true, configurada: false }) },
      conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => {} } });
    let browser;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ channel: 'msedge', headless: true });
      const page = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
      const external = [], errors = [];
      await page.route('**/*', route => {
        if (!route.request().url().startsWith(origin + '/')) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin + '/app');
      await page.waitForFunction(() => typeof window.abrirAvaliacaoVenda === 'function');
      await page.evaluate(conversa => window.abrirAvaliacaoVenda(conversa, 'Contato sintético'), f.conversa);
      await page.locator('#sales-dialog .sales-meter h3').waitFor();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.locator('#sales-dialog').evaluate(n => n.scrollWidth > n.clientWidth), false);
        await page.locator('#sales-title').focus();
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.querySelector('#sales-dialog').contains(document.activeElement)), true);
        }
        await page.locator('#sales-title').focus();
        if (process.env.LUME_BETA06_AUDIT_CAPTURAS) await page.screenshot({
          path: join(process.env.LUME_BETA06_AUDIT_CAPTURAS, `jev-confianca-${width}.png`) });
      }
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      const texto = await page.locator('#sales-dialog').innerText();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#sales-dialog').isVisible(), false);
      assert.match(texto, /revisão (?:é )?necessária|baixa confiança|confiança.*40|40.*confiança/i);
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

test('AUDIT-PRIV: revogação durante leitura da chave Jev impede envio; replay não duplica avaliação', async t => {
  const f = tarefa(t);
  let liberarChave, enviados = 0;
  const vendas = new VendasJev(f.db, {
    segredos: { ler: () => new Promise(resolve => { liberarChave = resolve; }) },
    avaliar: async () => { enviados++; return {}; }
  });
  const previa = vendas.preparar({ conversa_id: f.conversa });
  const pendente = vendas.avaliar({ previa_id: previa.id, confirmar: true });
  await assert.rejects(vendas.avaliar({ previa_id: previa.id, confirmar: true }), { code: 'JEV_OCUPADO' });
  vendas.invalidar();
  liberarChave('chave-sintetica');
  await assert.rejects(pendente, { code: 'JEV_CANCELADO' });
  await assert.rejects(vendas.avaliar({ previa_id: previa.id, confirmar: true }), { code: 'JEV_FONTE_ALTERADA' });
  assert.equal(enviados, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_vendas_avaliacoes').get().n, 0);
});

test('AUDIT-03-UI: titular abre histórico importado com aviso, contexto e resultado sem controles de execução',
  { skip: process.env.LUME_BETA06_AUDIT_UI !== '1', timeout: 45000 }, async t => {
    const origem = tarefa(t), destino = perfil(t), senha = 'senha de auditoria sintetica';
    origem.exec.registrar('resultado', origem.resultado);
    const criado = await new Backup(origem.db).criar({ senha, confirmar: true }), backup = new Backup(destino.db);
    const previa = await backup.preparar({ arquivo: JSON.stringify(criado.pacote), senha });
    backup.restaurar({ id: previa.id, confirmarMeuBackup: true });
    const acoes = new AcoesLume(destino.db, { agora: () => new Date('2026-09-26T15:00:00Z') });
    acoes.autorizar({ conversa: origem.conversa, permitida: true });
    const acao = acoes.obter(origem.acao.id);
    destino.desktop.aceitar({ nome: 'Titular sintético', aceito: true, versao: VERSAO_TERMOS });
    destino.desktop.configurarGuia({ dispensado: true });
    const server = criarServidor(destino.db, { desktop: true,
      conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => {} } });
    let browser;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ channel: 'msedge', headless: true });
      const page = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1280 } });
      const external = [], errors = [], writes = [];
      await page.route('**/*', route => {
        const req = route.request();
        if (!req.url().startsWith(origin + '/')) { external.push(req.url()); return route.abort(); }
        if (req.method() === 'POST' && req.url().includes('/api/v3/execucoes/')) writes.push(req.url());
        return route.continue();
      });
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin + '/app');
      await page.waitForFunction(() => typeof window.abrirResolverLume === 'function');
      await page.evaluate(acao => window.abrirResolverLume(acao, { historico: true }), acao);
      await page.getByRole('button', { name: 'Ver histórico preservado' }).click();
      const dialog = page.locator('#resolver-dialog');
      await dialog.getByText(/Histórico importado do seu backup/).waitFor();
      assert.equal(await dialog.locator('.resolver-state').getAttribute('data-state'), 'revogada');
      await dialog.locator('.resolver-context-detail summary').click();
      assert.match(await dialog.locator('.resolver-sources').innerText(), /Preparar minuta para a reunião/);
      assert.match(await dialog.locator('.resolver-timeline').innerText(), /Minuta sintética entregue para conferência/);
      assert.equal(await dialog.locator('form,input,textarea,select,.resolver-revoke').count(), 0);
      assert.equal(await dialog.getByRole('button', { name: /Autorizar contexto|Copiar pedido|Guardar resultado|Confirmar resultado/ }).count(), 0);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1280 });
        assert.equal(await dialog.evaluate(n => n.scrollWidth > n.clientWidth), false);
        if (process.env.LUME_BETA06_AUDIT_CAPTURAS) await page.screenshot({
          path: join(process.env.LUME_BETA06_AUDIT_CAPTURAS, `resolver-importado-${width}.png`) });
      }
      assert.deepEqual(external, []); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(), false);
    } finally {
      await browser?.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
