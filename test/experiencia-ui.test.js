import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

// Synthetic API replies exercise the real module in an isolated browser DOM.
// They are not shipped in the product and do not assert real-profile acceptance.
const script = await readFile(new URL('../src/painel/experiencia.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/painel/experiencia.css', import.meta.url), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({channel: 'msedge', headless: true}); });
after(async () => { await browser?.close(); });
const item = (id, changes = {}) => ({
  id: 'acao:' + id, acaoId: id, assunto: 'Assunto ' + id, categoria: 'entregas', grupo: 'precisa',
  estado: 'resultado_informado', estadoRotulo: 'Resultado informado · falta conferir', origem: 'sugerido',
  pessoas: [{id: 'p1', nome: 'Pessoa sintética'}], fonte: {eventoId: 81, autor: 'Autora sintética', recebidoEm: '2026-10-26T12:00:00Z', trecho: 'Trecho da fonte', tipo: 'texto'},
  acoes: [{tipo: 'fonte'}, {tipo: 'acao'}], prazo: null, responsavel: null, lacunas: [],
  entrega: {informada: true, verificada: false, enviada: null, aceita: null}, ...changes,
});
const envelope = (itens = [], extra = {}) => ({versao: 1, atualizadoEm: '2026-10-26T12:00:00Z', itens, lacunas: [], pagina: 1, proximaPagina: null, ...extra});
async function pageFor(t, data = envelope()) {
  const page = await browser.newPage({viewport: {width: 1024, height: 768}, reducedMotion: 'reduce'});
  t.after(() => page.close());
  await page.setContent('<body class="lume-vivo"><button id="outside">Fora</button><main style="height:500px;overflow:auto"><section id="today"></section><section id="sales"></section><section id="deliveries"></section><section id="memory"><input id="search"></section><section id="graph"><div id="graph-list"></div></section><div style="height:2000px"></div></main></body>');
  await page.addStyleTag({content: css});
  await page.evaluate(data => {
    window.data = data; window.calls = []; window.pending = []; window.hold = false; window.custom = {}; window.actions = [];
    window.lumeConnectionRequest = (path, body, options) => {
      window.calls.push({path, body, timeout: options.timeout, signal: options.signal});
      if (window.hold) return new Promise((resolve, reject) => window.pending.push({resolve, reject, path}));
      if (window.failure) return Promise.reject(Object.assign(new Error(window.failure.message), {status: window.failure.status}));
      if (Object.hasOwn(window.custom, path)) return Promise.resolve(window.custom[path]);
      if (path.startsWith('/api/v3/experiencia')) {
        const id = new URL(path, 'http://localhost').searchParams.get('id');
        return Promise.resolve(id ? {...window.data, itens: [...window.data.itens, ...Object.values(window.custom).flatMap(value => value.itens || [])].filter(item => item.id === id)} : window.data);
      }
      if (path.startsWith('/api/v3/acoes/item')) return Promise.resolve({acao: {id: new URL(path, 'http://localhost').searchParams.get('id'), trecho: 'Contexto revalidado', estado: 'confirmado', execucao_ui: {estado: 'em_andamento'}}});
      if (path.startsWith('/api/v3/execucoes/timeline')) return Promise.resolve({timeline: [], antes: null});
      if (path.startsWith('/api/v3/execucoes?')) return Promise.resolve({execucoes: []});
      throw new Error('Unexpected path: ' + path);
    };
    window.abrirResolverLume = action => { window.actions.push(['resolver', action.id]); };
    window.abrirAcaoDoAviso = id => { window.actions.push(['acao', id]); };
    window.abrirFonteTarefa = id => { window.actions.push(['fonte', id]); };
    window.navegarLume = view => { window.actions.push(['navigate', view]); };
  }, data);
  await page.addScriptTag({content: script});
  return page;
}
async function load(page, view = 'today') { await page.evaluate(view => window.LumeVivo.carregar(view), view); }
async function open(page, id) { await page.evaluate(id => window.LumeVivo.abrirAssunto(id), id); }

test('Comercial separa etapa confirmada, avaliação inferida e ausência de registro sem probabilidade', async t => {
  const page = await pageFor(t, envelope([
    item('venda', {categoria: 'comercial', negocio: {etapa: 'proposta'}, avaliacao: {origem: 'jev', etapa: 'fechado', temperatura: 'quente', confianca: 0.98}}),
    item('manual', {categoria: 'comercial', avaliacao: {origem: 'manual', etapa: 'interesse', temperatura: 'morno'}}),
    item('sem', {categoria: 'comercial'}),
  ]));
  await load(page, 'sales');
  const sale = page.locator('[data-assunto-id="acao:venda"]');
  assert.equal(await sale.locator('[data-evidence="confirmed"]').innerText(), 'Etapa confirmada: Proposta');
  assert.match(await sale.locator('[data-evidence="inferred"]').innerText(), /Avaliação inferida · confira[\s\S]*Etapa avaliada: Fechado[\s\S]*Interesse: quente/);
  assert.doesNotMatch(await sale.innerText(), /98|%/);
  assert.match(await page.locator('[data-assunto-id="acao:manual"] [data-evidence="manual"]').innerText(), /Avaliação registrada por você/);
  assert.match(await page.locator('[data-assunto-id="acao:manual"] [data-evidence="missing"]').innerText(), /sem registro/);
  assert.match(await page.locator('[data-assunto-id="acao:sem"]').innerText(), /Avaliação comercial indisponível/);
  await open(page, 'acao:venda');
  assert.equal(await page.locator('dialog [data-evidence="confirmed"]').innerText(), 'Etapa confirmada: Proposta');
  assert.match(await page.locator('dialog [data-evidence="inferred"]').innerText(), /Etapa avaliada: Fechado/);
  assert.equal(await page.evaluate(() => window.calls.some(call => call.body !== undefined)), false);
});

test('detalhe prepara conteúdo exato sem aprovar envio e acompanha só por confirmação',async t=>{
  const data=envelope([item('draft',{conversaId:'550000000001@s.whatsapp.net',acoes:[{tipo:'preparar'},{tipo:'acompanhar'}]})]);
  const page=await pageFor(t,data);
  await page.evaluate(()=>{window.custom['/api/v3/pessoal/mensagem/preparar']={estado:'pendente'};window.custom['/api/v3/pessoal/acompanhamento']={registrado:true};});
  await open(page,'acao:draft');await page.locator('summary').filter({hasText:'Preparar resposta'}).click();
  await page.getByLabel('Resposta exata',{exact:true}).fill('Sou Lume, assistente. Resposta fictícia.');
  await page.getByLabel('Motivo desta resposta',{exact:true}).fill('Ensaio da proposta local.');
  await page.getByRole('button',{name:'Guardar resposta preparada'}).click();
  await page.getByRole('status').filter({hasText:'Nenhum envio foi aprovado'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.body).map(c=>[c.path,c.body.baloes])),[['/api/v3/pessoal/mensagem/preparar',['Sou Lume, assistente. Resposta fictícia.']]]);
  await page.locator('summary').filter({hasText:'Acompanhar assunto'}).click();await page.getByRole('button',{name:'Confirmar acompanhamento'}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.path==='/api/v3/pessoal/acompanhamento'));
  assert.equal(await page.evaluate(()=>window.calls.find(c=>c.path==='/api/v3/pessoal/acompanhamento').body.confirmar),true);
  assert.equal(await page.evaluate(()=>window.calls.some(c=>/aprovar|enviar/.test(c.path))),false);
});

test('Agora limita cada bloco a três, expande por teclado e usa identidades de assunto', async t => {
  const data = envelope(['precisa', 'cuidando', 'mudou'].flatMap(grupo => Array.from({length: 5}, (_, i) => item(grupo + i, {grupo}))));
  const page = await pageFor(t, data); await load(page, 'hoje');
  assert.equal(await page.locator('.lv-section').count(), 3);
  assert.equal(await page.locator('.lv-card:visible').count(), 9);
  const expand = page.locator('[aria-controls="lv-extra-precisa"]'); await expand.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('.lv-card:visible').count(), 11);
  assert.equal(await expand.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('.lv-card').first().getAttribute('data-assunto-id'), 'acao:precisa0');
  assert.equal(await page.evaluate(() => window.calls[0].timeout), 15000);
  assert.equal(await page.evaluate(() => window.calls.every(call => call.body === undefined)), true);
});

test('resposta antiga ignorando abort não sobrescreve a navegação mais recente', async t => {
  const page = await pageFor(t); await page.evaluate(() => { window.hold = true; window.first = window.LumeVivo.carregar('today'); window.second = window.LumeVivo.carregar('sales'); });
  assert.equal(await page.evaluate(() => window.calls[0].signal.aborted), true);
  await page.evaluate(data => window.pending[1].resolve(data), envelope([item('novo', {categoria: 'comercial'})]));
  await page.evaluate(() => window.second);
  await page.evaluate(data => window.pending[0].resolve(data), envelope([item('antigo')])); await page.evaluate(() => window.first);
  assert.match(await page.locator('#lv-sales').innerText(), /Assunto novo/);
  assert.equal(await page.getByText('Assunto antigo', {exact: true}).count(), 0);
});

test('invalidar cancela cargas e elimina cards e detalhe, inclusive resposta tardia', async t => {
  const page = await pageFor(t, envelope([item('a')])); await load(page); await open(page, 'acao:a');
  assert.equal(await page.locator('dialog[open]').count(), 1);
  await page.evaluate(() => { window.hold = true; window.work = window.LumeVivo.carregar('deliveries'); window.dispatchEvent(new Event('lume:invalidate')); });
  assert.equal(await page.locator('dialog').count(), 0);
  await page.evaluate(data => window.pending[0].resolve(data), envelope([item('tardio')])); await page.evaluate(() => window.work);
  assert.equal(await page.locator('.lv-card').count(), 0);
  assert.equal(await page.evaluate(() => window.calls.at(-1).signal.aborted), true);
});

test('drawer revalida identidade, mantém fonte literal, trap e retorno de foco e scroll', async t => {
  const page = await pageFor(t, envelope([item('a', {assunto: '<img src=x onerror=alert(1)>', acontecimento: '<script>perigo</script>'})])); await load(page);
  const opener = page.locator('.lv-card-title button'); await opener.focus();
  await page.evaluate(() => document.querySelector('main').scrollTop = 60);
  const scroll = await page.locator('main').evaluate(node => node.scrollTop);
  await open(page, 'acao:a');
  assert.equal(await page.locator('dialog img, dialog script, .lv-card img').count(), 0);
  assert.match(await page.locator('dialog').innerText(), /Autora sintética/);
  assert.match(await page.locator('dialog').innerText(), /Responsável não informado/);
  assert.match(await page.locator('dialog').innerText(), /Prazo não informado/);
  const close = page.getByRole('button', {name: 'Fechar assunto'}); await close.focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Resolver');
  await page.keyboard.press('Tab'); assert.equal(await close.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await opener.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('main').evaluate(node => node.scrollTop), scroll);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.path.startsWith('/api/v3/acoes/item')).length), 1);
});

test('trocar assunto durante carga não mistura identidade nem contexto', async t => {
  const page = await pageFor(t); await page.evaluate(() => { window.hold = true; window.first = window.LumeVivo.abrirAssunto('acao:a'); window.second = window.LumeVivo.abrirAssunto('acao:b'); });
  await page.evaluate(data => { window.hold = false; window.pending[1].resolve(data); }, envelope([item('b')])); await page.evaluate(() => window.second);
  await page.evaluate(data => window.pending[0].resolve(data), envelope([item('a')])); await page.evaluate(() => window.first);
  assert.equal(await page.locator('.lv-drawer-body').getAttribute('data-assunto-id'), 'acao:b');
  assert.equal(await page.locator('#lv-detail-title').textContent(), 'Assunto b');
});

test('revogação remove conteúdo anterior e retry recupera só resposta autorizada', async t => {
  const page = await pageFor(t, envelope([item('privado')])); await load(page);
  await page.evaluate(() => window.failure = {status: 403, message: 'Sem acesso'}); await open(page, 'acao:privado');
  assert.equal(await page.locator('.lv-card').count(), 0);
  assert.equal(await page.getByRole('button', {name: 'Resolver', exact: true}).count(), 0);
  assert.match(await page.locator('dialog').innerText(), /permissão atual/);
  await page.evaluate(data => { window.failure = null; window.data = data; }, envelope([item('privado', {assunto: 'Contexto autorizado novo'})]));
  await page.getByRole('button', {name: 'Tentar novamente'}).click();
  await page.waitForFunction(() => document.getElementById('lv-detail-title').textContent === 'Contexto autorizado novo');
  assert.equal(await page.getByRole('button', {name: 'Resolver', exact: true}).count(), 1);
});

test('ações ausentes não oferecem Resolver nem fonte, entrega não infere envio ou aceite', async t => {
  const page = await pageFor(t, envelope([item('a', {acoes: []})])); await load(page, 'deliveries'); await open(page, 'acao:a');
  assert.equal(await page.getByRole('button', {name: 'Resolver', exact: true}).count(), 0);
  assert.equal(await page.getByRole('button', {name: 'Conferir fonte', exact: true}).count(), 0);
  const detail = await page.locator('dialog').innerText();
  assert.match(detail, /Conclusão informada: registrado/); assert.match(detail, /Resultado verificado: sem registro/);
  assert.match(detail, /Envio: sem registro/); assert.match(detail, /Aceite: sem registro/);
  assert.deepEqual(await page.evaluate(() => window.actions), []);
});

test('vazio real, erro recuperável e duplicação de identidade não viram cartões', async t => {
  const page = await pageFor(t); await load(page, 'sales');
  assert.equal(await page.locator('.lv-card').count(), 0); assert.match(await page.locator('#lv-sales').innerText(), /Nenhum assunto/);
  await page.evaluate(() => window.failure = {message: 'A resposta demorou mais que o esperado.'}); await load(page, 'sales');
  assert.match(await page.getByRole('alert').innerText(), /demorou/);
  await page.evaluate(data => { window.failure = null; window.data = data; }, envelope([item('dup'), item('dup')]));
  await page.getByRole('button', {name: 'Tentar novamente'}).click();
  await page.waitForFunction(() => document.querySelector('[role=alert]').textContent.includes('identidade inválida'));
  assert.equal(await page.locator('.lv-card').count(), 0);
});

test('timeline usa execução, pagina cursor, deduplica eventos e restaura controle após fim', async t => {
  const page = await pageFor(t, envelope([item('a')]));
  await page.evaluate(() => {
    window.custom['/api/v3/execucoes?acao_id=a'] = {execucoes: [{id: 'exec-a', estado: 'resultado_informado'}]};
    window.custom['/api/v3/execucoes/timeline?id=exec-a&limite=20'] = {timeline: [{id: 20, tipo: 'resultado', em: '2026-10-26', resumo: 'Resultado sintético'}], antes: 20};
    window.custom['/api/v3/execucoes/timeline?id=exec-a&limite=20&antes=20'] = {timeline: [{id: 20, tipo: 'resultado'}, {id: 19, tipo: 'inicio', em: '2026-10-25'}], antes: null};
  });
  await open(page, 'acao:a'); await page.getByRole('button', {name: 'Carregar histórico', exact: true}).click();
  await page.getByRole('button', {name: 'Ver registros anteriores'}).click();
  await page.waitForFunction(() => document.querySelector('.lv-timeline').children.length === 2);
  assert.equal(await page.locator('.lv-timeline .lv-item').count(), 2);
  assert.match(await page.locator('dialog').innerText(), /Resultado informado/);
  assert.match(await page.evaluate(() => document.activeElement.textContent), /Início do histórico/);
});

test('paginação preserva identidades, acessa assunto da segunda página e Kanban por teclado', async t => {
  const page = await pageFor(t, envelope([item('a', {categoria: 'comercial'})], {proximaPagina: 2}));
  await page.evaluate(data => window.custom['/api/v3/experiencia?pagina=2'] = data, envelope([item('b', {categoria: 'comercial'})], {pagina: 2}));
  await load(page, 'Comercial');
  await page.getByRole('button', {name: 'Carregar mais assuntos'}).click();
  await page.waitForFunction(() => document.querySelectorAll('.lv-card').length === 2);
  const kanban = page.getByRole('button', {name: 'Kanban', exact: true}); await kanban.focus(); await page.keyboard.press('Enter');
  assert.equal(await kanban.getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', {name: 'Abrir assunto: Assunto b', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.lv-drawer-body')?.dataset.assuntoId === 'acao:b');
  assert.equal(await page.locator('#lv-detail-title').textContent(), 'Assunto b');
});

test('fonte usa identificador real e Resolver apenas abre o fluxo existente', async t => {
  const page = await pageFor(t, envelope([item('a')])); await load(page); await open(page, 'acao:a');
  await page.getByRole('button', {name: 'Resolver', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => window.actions), [['resolver', 'a']]);
  await open(page, 'acao:a'); await page.getByRole('button', {name: 'Conferir fonte', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => window.actions), [['resolver', 'a'], ['fonte', 81]]);
  assert.equal(await page.evaluate(() => window.calls.every(call => call.body === undefined)), true);
});

test('revogação durante timeline remove o contexto e todas as ações do drawer', async t => {
  const page = await pageFor(t, envelope([item('privado')]));
  await page.evaluate(() => window.custom['/api/v3/execucoes?acao_id=privado'] = {execucoes: [{id: 'exec-privado', estado: 'em_andamento'}]});
  await load(page); await open(page, 'acao:privado');
  await page.evaluate(() => window.failure = {status: 403, message: 'Fonte revogada'});
  await page.getByRole('button', {name: 'Carregar histórico', exact: true}).click();
  await page.waitForFunction(() => document.getElementById('lv-detail-title').textContent === 'Assunto indisponível');
  assert.equal(await page.locator('.lv-card').count(), 0);
  assert.equal(await page.getByRole('button', {name: 'Resolver', exact: true}).count(), 0);
  assert.equal(await page.getByText('Trecho da fonte', {exact: true}).count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Tentar novamente');
});

test('Relações usa navegação existente, sem duplicar busca nem controles de Pessoas', async t => {
  const page = await pageFor(t); await load(page, 'memory'); await load(page, 'memory');
  assert.equal(await page.locator('#lv-memory-links').count(), 1);
  assert.equal(await page.locator('#search').count(), 1);
  await page.getByRole('button', {name: 'Relações · mapa e lista'}).click();
  assert.deepEqual(await page.evaluate(() => window.actions), [['navigate', 'graph']]);
  await load(page, 'graph'); assert.equal(await page.locator('#graph-list.lv-relations').count(), 1);
  await load(page, 'contacts'); assert.equal(await page.evaluate(() => window.calls.length), 0);
});

test('ação pessoal sugerida sem execução mantém fonte sem consultar ACL de Resolver', async t => {
  const page = await pageFor(t, envelope([item('pessoal')]));
  await page.evaluate(() => {
    window.custom['/api/v3/acoes/item?id=pessoal'] = {acao: {id: 'pessoal', estado: 'sugerido', execucao_ui: {estado: 'nenhuma'}}};
    const request = window.lumeConnectionRequest;
    window.lumeConnectionRequest = (path, ...rest) => {
      if (path.startsWith('/api/v3/execucoes')) throw Object.assign(new Error('Fonte não autorizada para Resolver'), {status: 409, code: 'SOURCE_CHANGED'});
      return request(path, ...rest);
    };
  });
  await open(page, 'acao:pessoal');
  assert.match(await page.locator('dialog').innerText(), /Fontes/);
  assert.equal(await page.getByRole('button', {name: 'Resolver', exact: true}).count(), 0);
  await page.getByRole('button', {name: 'Conferir fonte'}).click();
  assert.deepEqual(await page.evaluate(() => window.actions), [['fonte', 81]]);
});
