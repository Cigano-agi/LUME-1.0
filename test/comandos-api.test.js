import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop, VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';
import {createHash} from 'node:crypto';
import {registrarPessoa, fundirPessoas} from '../src/pessoas.js';
import {NegociosDesktop} from '../src/negocios-desktop.js';

const DONO = '5511888888888@s.whatsapp.net';
const DM = '5511999999999@s.whatsapp.net';

function mensagem(id, texto, conversaId = DM) {
  return {
    key: {id, remoteJid: conversaId, fromMe: true},
    messageTimestamp: 1789732800,
    message: {conversation: texto}
  };
}

function mensagemCompleta({id, texto, conversaId, fromMe, autorId, resposta}) {
  const contextInfo = resposta ? {
    stanzaId: resposta.id,
    participant: resposta.autorId,
    quotedMessage: {conversation: resposta.texto || 'mensagem original'}
  } : undefined;
  return {
    key: {id, remoteJid: conversaId, fromMe, ...(conversaId.endsWith('@g.us') ? {participant: autorId} : {})},
    messageTimestamp: 1789732800,
    message: contextInfo ? {extendedTextMessage: {text: texto, contextInfo}} : {conversation: texto},
    ...(!fromMe && autorId ? {pushName: 'Contato'} : {})
  };
}

async function ambienteHttp(t) {
  const db = abrirBanco();
  const contexto = new ContextoApp(db, {donoId: DONO, timeZone: 'America/Sao_Paulo'});
  const desktop = new Desktop(db);
  desktop.aceitar({nome: 'Dono', aceito: true, versao: VERSAO_TERMOS});
  const efeitosExternos = {transporte: 0, ia: 0};
  const conexao = {
    estado: () => ({estado: 'desconectada'}),
    parar: async () => {},
    enviar: async () => { efeitosExternos.transporte++; },
    reagir: async () => { efeitosExternos.transporte++; }
  };
  const servidor = criarServidor(db, {
    desktop: true,
    conexao,
    gerarIA: async () => { efeitosExternos.ia++; throw new Error('IA nao deveria ser chamada.'); }
  });
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => servidor.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const {token} = await (await fetch(base + '/api/sessao')).json();
  return {db, contexto, desktop, base, token, efeitosExternos};
}

const get = (a, caminho) => fetch(a.base + caminho, {headers: {'x-assessor-token': a.token}});
const post = (a, caminho, corpo) => fetch(a.base + caminho, {
  method: 'POST',
  headers: {'content-type': 'application/json', 'x-assessor-token': a.token},
  body: JSON.stringify(corpo)
});

test('comandos atravessam captura, Hoje e API uma vez com fonte permitida', async t => {
  const a = await ambienteHttp(t);
  const lote = {type: 'notify', donoJids: [DONO], messages: [
    mensagem('TASK-API-1', '#lume_tarefa Revisar contrato #comercial'),
    mensagem('REMINDER-API-1', '#lume_lembrete 2026-09-20 09:00 | Ligar para cliente #comercial')
  ]};

  assert.equal(a.contexto.receber(lote).falhas, 0);
  a.contexto.receber(lote);

  const hoje = a.desktop.resumo();
  assert.equal(hoje.fila.total, 2);
  assert.deepEqual(new Set(hoje.tarefas.map(item => item.id)), new Set(['comando:tarefa:1', 'comando:lembrete:1']));
  assert.ok(hoje.tarefas.every(item => Number.isSafeInteger(item.evento_id) && item.conversa_id === DM));

  assert.equal((await fetch(a.base + '/api/v3/comandos')).status, 403);
  const resposta = await fetch(a.base + '/api/v3/comandos?limite=10', {
    headers: {'x-assessor-token': a.token}
  });
  assert.equal(resposta.status, 200);
  const pagina = await resposta.json();
  assert.equal(pagina.total, 2);
  assert.deepEqual(pagina.comandos.map(item => item.tipo).sort(), ['lembrete', 'tarefa']);
  assert.ok(pagina.comandos.every(item => item.eventoId && item.conversaId === DM && item.origemId));

  for (const comando of pagina.comandos) {
    const fonte = await get(a,`/api/v3/fonte?id=${comando.eventoId}`);
    assert.equal(fonte.status, 200);
    assert.equal((await fonte.json()).origem_id, comando.origemId);
  }
});

test('resolver da Home conclui tarefa e lembrete de comando sem atingir item CRM com o mesmo numero', async t => {
  const a = await ambienteHttp(t);
  a.contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem('TASK-RESOLVER', '#lume_tarefa Revisar contrato'),
    mensagem('REMINDER-RESOLVER', '#lume_lembrete 2026-09-20 09:00 | Ligar para cliente')
  ]});
  const evento = a.db.prepare("SELECT conversa_id,origem_id FROM eventos WHERE origem_id='TASK-RESOLVER'").get();
  const crmId = Number(a.db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em)
    VALUES(?,?,'pendencia','Item CRM de controle','2026-09-19T12:00:00Z')`).run(evento.conversa_id, evento.origem_id).lastInsertRowid);
  assert.equal(crmId, 1, 'o teste precisa provar que IDs iguais nao colidem entre tabelas');

  let resposta = await post(a, '/api/v3/resolver', {id: 'comando:tarefa:1'});
  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), {ok: true});
  assert.equal(a.db.prepare('SELECT estado FROM lume_comando_tarefas WHERE id=1').get().estado, 'concluida');
  assert.equal(a.db.prepare('SELECT estado FROM itens_crm WHERE id=1').get().estado, 'aberto');

  resposta = await post(a, '/api/v3/resolver', {id: 'comando:lembrete:1'});
  assert.equal(resposta.status, 200);
  assert.equal(a.db.prepare('SELECT estado FROM lume_comando_lembretes WHERE id=1').get().estado, 'concluido');
  assert.deepEqual(a.desktop.resumo().tarefas.map(item => item.id), [1]);

  resposta = await post(a, '/api/v3/resolver', {id: 1});
  assert.equal(resposta.status, 200);
  assert.equal(a.db.prepare('SELECT estado FROM itens_crm WHERE id=1').get().estado, 'resolvido');
  assert.equal(a.desktop.resumo().fila.total, 0);
});

test('resolver de comando rejeita ID malformado e efeito cuja fonte foi revogada', async t => {
  const a = await ambienteHttp(t);
  a.contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem('TASK-OCULTA', '#lume_tarefa Nao concluir sem acesso')
  ]});
  a.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE origem_id='TASK-OCULTA'").run();

  for (const id of ['comando:tarefa:01', 'comando:tarefa:1x', 'comando:negocio:1', 'comando:tarefa:9007199254740992']) {
    const resposta = await post(a, '/api/v3/resolver', {id});
    assert.equal(resposta.status, 400, id);
  }
  const revogada = await post(a, '/api/v3/resolver', {id: 'comando:tarefa:1'});
  assert.equal(revogada.status, 400);
  assert.equal(a.db.prepare('SELECT estado FROM lume_comando_tarefas WHERE id=1').get().estado, 'aberta');
});

test('API de comandos valida estado, tipo, tag, cursor e limite', async t => {
  const a = await ambienteHttp(t);
  for (const consulta of [
    'estado=inventado',
    'tipo=inventado',
    'tag=%20',
    'cursor=abc',
    'cursor=0',
    'limite=0',
    'limite=101'
  ]) {
    const resposta = await fetch(`${a.base}/api/v3/comandos?${consulta}`, {
      headers: {'x-assessor-token': a.token}
    });
    assert.equal(resposta.status, 400, consulta);
  }
});

test('terceiro local segue legível e NULL revoga comandos, tags e Hoje antes das contagens', async t => {
  const a = await ambienteHttp(t);
  a.contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem('TASK-REVOGADA', '#lume_tarefa Nao revelar #restrita')
  ]});
  a.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE origem_id='TASK-REVOGADA'").run();
  const headers = {'x-assessor-token': a.token};
  let comandos = await (await fetch(`${a.base}/api/v3/comandos`, {headers})).json();
  let tags = await (await fetch(`${a.base}/api/v3/tags?entidadeTipo=tarefa`, {headers})).json();
  assert.equal(comandos.total, 0, 'comando derivado com assinatura antiga não reaparece');
  assert.equal(tags.total, 0, 'tag derivada com assinatura antiga não reaparece');
  assert.ok(a.desktop.carteira().conversas.some(item => item.id === DM), 'a conversa local segue legível');

  a.db.prepare("UPDATE eventos SET permissao=NULL WHERE origem_id='TASK-REVOGADA'").run();
  comandos = await (await fetch(`${a.base}/api/v3/comandos`, {headers})).json();
  tags = await (await fetch(`${a.base}/api/v3/tags?entidadeTipo=tarefa`, {headers})).json();
  assert.equal(comandos.total, 0);
  assert.equal(tags.total, 0);
  assert.equal(a.desktop.resumo().fila.total, 0);
  assert.ok(!a.desktop.carteira().conversas.some(item => item.id === DM), 'NULL também remove a conversa local');
});

test('consulta tipada de tags reaplica a politica na origem e no alvo antes de contar', async t => {
  const a = await ambienteHttp(t);
  const grupo = '120363000000000000@g.us';
  a.contexto.receber({type: 'history', donoJids: [DONO], messages: [
    mensagemCompleta({id: 'ALVO-TERCEIRO', texto: 'SEGREDO_DE_TERCEIRO', conversaId: grupo, fromMe: false, autorId: 'cliente@s.whatsapp.net'}),
    mensagemCompleta({
      id: 'CMD-TAG-ALVO', texto: '#lume_tag confidencial', conversaId: grupo, fromMe: true, autorId: DONO,
      resposta: {id: 'ALVO-TERCEIRO', autorId: 'cliente@s.whatsapp.net'}
    })
  ]});

  a.desktop.politica({conversa: grupo, politica: 'tudo'});
  const headers = {'x-assessor-token': a.token};
  let resposta = await fetch(`${a.base}/api/v3/tags?entidadeTipo=mensagem`, {headers});
  assert.equal(resposta.status, 200);
  let pagina = await resposta.json();
  assert.equal(pagina.total, 1);
  assert.deepEqual(pagina.facetas, [{chave: 'confidencial', nome: 'confidencial', total: 1}]);
  assert.equal(pagina.entidades[0].entidade.id, 'ALVO-TERCEIRO');

  a.desktop.politica({conversa: grupo, politica: 'so-minhas'});
  resposta = await fetch(`${a.base}/api/v3/tags?entidadeTipo=mensagem`, {headers});
  pagina = await resposta.json();
  assert.equal(pagina.total, 0);
  assert.deepEqual(pagina.facetas, []);
  assert.ok(!JSON.stringify(pagina).includes('ALVO-TERCEIRO'));
  assert.ok(!JSON.stringify(pagina).includes('SEGREDO_DE_TERCEIRO'));
  const comandosFiltrados = await (await fetch(`${a.base}/api/v3/comandos?tag=confidencial`, {headers})).json();
  assert.equal(comandosFiltrados.total, 0);
});

test('filtro de tag em Hoje acontece antes da contagem e paginacao', async t => {
  const a = await ambienteHttp(t);
  a.contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem('TASK-TAG-1', '#lume_tarefa Revisar proposta #vip'),
    mensagem('REMINDER-TAG-1', '#lume_lembrete 2026-09-20 09:00 | Telefonar #retorno')
  ]});
  const pagina = a.desktop.resumo({tag: 'VIP'});
  assert.equal(pagina.fila.total, 1);
  assert.equal(pagina.tarefas.length, 1);
  assert.equal(pagina.tarefas[0].id, 'comando:tarefa:1');
});

test('Hoje preserva tarefas e lembretes que precisam revisar ou perderam a origem', async t => {
  const a = await ambienteHttp(t);
  a.contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem('TASK-REVISAR', '#lume_tarefa Conferir alteracao #atencao'),
    mensagem('REMINDER-REMOVIDO', '#lume_lembrete 2026-09-20 09:00 | Conferir origem #atencao')
  ]});
  a.contexto.atualizarMensagens([{
    key: {remoteJid: DM, id: 'TASK-REVISAR'},
    update: {message: {conversation: '#lume_tarefa texto alterado'}}
  }]);
  a.contexto.removerMensagens({keys: [{remoteJid: DM, id: 'REMINDER-REMOVIDO'}]});

  const estadosHoje = new Map(a.desktop.resumo().tarefas.map(item => [item.id, item.estado]));
  assert.equal(estadosHoje.get('comando:tarefa:1'), 'revisar');
  assert.equal(estadosHoje.get('comando:lembrete:1'), 'origem_removida');

  const pagina = await (await fetch(`${a.base}/api/v3/comandos`, {
    headers: {'x-assessor-token': a.token}
  })).json();
  assert.deepEqual(new Set(pagina.comandos.map(item => item.estado)), new Set(['revisar', 'origem_removida']));
  const tarefa = await (await get(a, '/api/v3/tarefas')).json();
  const lembrete = await (await get(a, '/api/v3/lembretes')).json();
  assert.equal(tarefa.comandos.itens[0].estado, 'revisar');
  assert.equal(lembrete.comandos.itens[0].estado, 'origem_removida');
});

test('API de tags exige tipo e valida filtros e paginacao', async t => {
  const a = await ambienteHttp(t);
  const headers = {'x-assessor-token': a.token};
  for (const consulta of ['', 'entidadeTipo=inventada', 'entidadeTipo=tarefa&tag=%20', 'entidadeTipo=tarefa&cursor=0', 'entidadeTipo=tarefa&limite=101']) {
    const resposta = await fetch(`${a.base}/api/v3/tags?${consulta}`, {headers});
    assert.equal(resposta.status, 400, consulta);
  }
  assert.equal((await fetch(`${a.base}/api/v3/tags?entidadeTipo=tarefa`)).status, 403);
});

test('tags de cliente projetam JID exato no mesmo ID canonico de Contatos', async t => {
  const a = await ambienteHttp(t);
  const jidAna1 = '111111111111@lid';
  const jidAna2 = '222222222222@lid';
  const jidSemCadastro = '333333333333@s.whatsapp.net';
  const ana1 = registrarPessoa(a.db, {identificador: jidAna1, nomeCru: 'Ana Silva', origem: 'manual'}).pessoaId;
  const ana2 = registrarPessoa(a.db, {identificador: jidAna2, nomeCru: 'Ana Silva', origem: 'manual'}).pessoaId;
  assert.notEqual(ana1, ana2);

  a.contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem('CLIENTE-ANA-1', '#lume_cliente #vip', jidAna1),
    mensagem('CLIENTE-ANA-2', '#lume_cliente #vip', jidAna2),
    mensagem('CLIENTE-SEM-CADASTRO', '#lume_cliente #vip', jidSemCadastro)
  ]});

  const headers = {'x-assessor-token': a.token};
  let pagina = await (await fetch(`${a.base}/api/v3/tags?entidadeTipo=contato`, {headers})).json();
  assert.deepEqual(new Set(pagina.entidades.map(item => item.entidade.id)), new Set([
    `p:${ana1}`,
    `p:${ana2}`,
    'a:' + createHash('sha256').update(jidSemCadastro).digest('hex')
  ]));

  fundirPessoas(a.db, {deId: ana2, paraId: ana1});
  pagina = await (await fetch(`${a.base}/api/v3/tags?entidadeTipo=contato`, {headers})).json();
  assert.deepEqual(new Set(pagina.entidades.map(item => item.entidade.id)), new Set([
    `p:${ana1}`,
    'a:' + createHash('sha256').update(jidSemCadastro).digest('hex')
  ]));
});

test('cliente citado em grupo usa o participante exato, sem busca por nome', async t => {
  const a = await ambienteHttp(t);
  const grupo = '120363000000000001@g.us';
  const participante = '444444444444@lid';
  const pessoaId = registrarPessoa(a.db, {identificador: participante, nomeCru: 'Ana Silva', origem: 'manual'}).pessoaId;
  a.contexto.receber({type: 'history', donoJids: [DONO], messages: [
    mensagemCompleta({id: 'GRUPO-ALVO', texto: 'Pode me chamar', conversaId: grupo, fromMe: false, autorId: participante}),
    mensagemCompleta({
      id: 'GRUPO-CLIENTE', texto: '#lume_cliente #proposta', conversaId: grupo, fromMe: true, autorId: DONO,
      resposta: {id: 'GRUPO-ALVO', autorId: participante}
    })
  ]});
  a.desktop.politica({conversa: grupo, politica: 'tudo'});
  const pagina = await (await fetch(`${a.base}/api/v3/tags?entidadeTipo=contato`, {
    headers: {'x-assessor-token': a.token}
  })).json();
  assert.equal(pagina.entidades.length, 1);
  assert.equal(pagina.entidades[0].entidade.id, `p:${pessoaId}`);
});

test('Hoje, Tarefas e Lembretes filtram efeitos de comando antes do total e da pagina', async t => {
  const a = await ambienteHttp(t);
  const lote = {type: 'notify', donoJids: [DONO], messages: [
    mensagem('TASK-DEST-1', '#lume_tarefa Primeira tarefa #vip'),
    mensagem('TASK-DEST-2', '#lume_tarefa Outra tarefa #interno'),
    mensagem('REM-DEST-1', '#lume_lembrete 2026-09-20 09:00 | Retornar #vip')
  ]};
  a.contexto.receber(lote);
  a.contexto.receber(lote);

  const hoje = await (await get(a, '/api/v3/resumo?tag=VIP')).json();
  assert.equal(hoje.fila.total, 2);

  let tarefas = await (await get(a, '/api/v3/tarefas?tag=vip&limite=1')).json();
  assert.equal(tarefas.comandos.total, 1);
  assert.equal(tarefas.comandos.itens.length, 1);
  assert.equal(tarefas.comandos.itens[0].id, 'comando:tarefa:1');
  assert.equal(tarefas.sugestoes.length, 0);

  let lembretes = await (await get(a, '/api/v3/lembretes?tag=vip&limite=1')).json();
  assert.equal(lembretes.comandos.total, 1);
  assert.equal(lembretes.comandos.itens[0].id, 'comando:lembrete:1');

  a.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE origem_id IN('TASK-DEST-1','REM-DEST-1')").run();
  tarefas = await (await get(a, '/api/v3/tarefas?tag=vip&limite=1')).json();
  lembretes = await (await get(a, '/api/v3/lembretes?tag=vip&limite=1')).json();
  assert.equal(tarefas.comandos.total, 0, 'ação derivada com assinatura antiga não reaparece');
  assert.equal(lembretes.comandos.total, 0, 'lembrete derivado com assinatura antiga não reaparece');

  a.db.prepare("UPDATE eventos SET permissao=NULL WHERE origem_id IN('TASK-DEST-1','REM-DEST-1')").run();
  tarefas = await (await get(a, '/api/v3/tarefas?tag=vip&limite=1')).json();
  lembretes = await (await get(a, '/api/v3/lembretes?tag=vip&limite=1')).json();
  assert.equal(tarefas.comandos.total, 0);
  assert.equal(lembretes.comandos.total, 0);
  assert.ok(!JSON.stringify({tarefas, lembretes}).includes('TASK-DEST-1'));
  assert.equal(a.efeitosExternos.transporte, 0);
  assert.equal(a.efeitosExternos.ia, 0);
});

test('Conversas e Contatos mantêm terceiro local legível sem unir homônimos e ocultam NULL', async t => {
  const a = await ambienteHttp(t);
  const ana1 = '5511000000001@s.whatsapp.net';
  const ana2 = '5511000000002@s.whatsapp.net';
  const pessoa1 = registrarPessoa(a.db, {identificador: ana1, nomeCru: 'Ana', origem: 'manual'}).pessoaId;
  registrarPessoa(a.db, {identificador: ana2, nomeCru: 'Ana', origem: 'manual'});
  a.contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem('CONV-VIP', '#lume_tag VIP', ana1),
    mensagem('CONTATO-VIP', '#lume_cliente #vip', ana1),
    mensagem('CONTATO-OUTRO', '#lume_cliente #outro', ana2)
  ]});

  const conversas = await (await get(a, '/api/v3/conversas/resumo?tag=vip')).json();
  assert.equal(conversas.pagina.total, 1);
  assert.equal(conversas.conversas[0].id, ana1);

  let contatos = await (await get(a, '/api/v3/contatos?tag=VIP')).json();
  assert.equal(contatos.pagina.total, 1);
  assert.equal(contatos.contatos[0].id, `p:${pessoa1}`);
  assert.ok(!JSON.stringify(contatos).includes(ana2));

  a.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE origem_id IN('CONV-VIP','CONTATO-VIP')").run();
  contatos = await (await get(a, '/api/v3/contatos?tag=vip')).json();
  const revogadas = await (await get(a, '/api/v3/conversas/resumo?tag=vip')).json();
  assert.equal(contatos.pagina.total, 1);
  assert.equal(revogadas.pagina.total, 1);
  assert.equal(contatos.contatos[0].id, `p:${pessoa1}`);

  a.db.prepare("UPDATE eventos SET permissao=NULL WHERE origem_id IN('CONV-VIP','CONTATO-VIP')").run();
  contatos = await (await get(a, '/api/v3/contatos?tag=vip')).json();
  const ocultas = await (await get(a, '/api/v3/conversas/resumo?tag=vip')).json();
  assert.equal(contatos.pagina.total, 0);
  assert.equal(ocultas.pagina.total, 0);
});

test('Negocios valida associacao, origem do comando e fonte atual antes do total', async t => {
  const a = await ambienteHttp(t);
  a.contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem('FONTE-NEGOCIO', 'Mensagem que sustenta o negocio'),
    mensagem('FONTE-NEGOCIO-SEM-TAG', 'Outra oportunidade'),
    mensagem('COMANDO-TAG-NEGOCIO', '#lume_tarefa Preparar proposta #vip')
  ]});
  const fonte = a.db.prepare("SELECT id FROM eventos WHERE origem_id='FONTE-NEGOCIO'").get().id;
  const negocios = new NegociosDesktop(a.db);
  const salvo = negocios.salvar({
    previa: negocios.preparar({fonte}).id,
    confirmar: true,
    titulo: 'Proposta comprovada',
    etapa: 'proposta'
  });
  const fonteSemTag = a.db.prepare("SELECT id FROM eventos WHERE origem_id='FONTE-NEGOCIO-SEM-TAG'").get().id;
  const semTag = negocios.salvar({
    previa: negocios.preparar({fonte: fonteSemTag}).id,
    confirmar: true,
    titulo: 'Nao pertence ao filtro',
    etapa: 'interesse'
  });
  const vinculo = a.db.prepare(`SELECT t.id tag_id,c.id comando_id,c.conversa_id,c.origem_id,c.criado_em
    FROM lume_tags t JOIN lume_comandos c ON c.origem_id='COMANDO-TAG-NEGOCIO' WHERE t.chave='vip'`).get();
  a.db.prepare(`INSERT INTO lume_tags_entidades
    (tag_id,entidade_tipo,entidade_id,comando_id,conversa_id,origem_id,procedencia,estado,criada_em)
    VALUES(?,'negocio',?,?,?,?,?,'ativa',?)`)
    .run(vinculo.tag_id, salvo.id, vinculo.comando_id, vinculo.conversa_id, vinculo.origem_id, 'interface', vinculo.criado_em);

  let pagina = await (await get(a, '/api/v3/negocios?tag=VIP')).json();
  assert.equal(pagina.pagina.total, 1);
  assert.equal(pagina.negocios[0].id, salvo.id);
  assert.ok(!JSON.stringify(pagina).includes(semTag.id));

  a.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE origem_id='COMANDO-TAG-NEGOCIO'").run();
  pagina = await (await get(a, '/api/v3/negocios?tag=vip')).json();
  assert.equal(pagina.pagina.total, 1);
  assert.ok(JSON.stringify(pagina).includes(salvo.id));

  a.db.prepare("UPDATE eventos SET permissao=NULL WHERE origem_id='COMANDO-TAG-NEGOCIO'").run();
  pagina = await (await get(a, '/api/v3/negocios?tag=vip')).json();
  assert.equal(pagina.pagina.total, 0);
  assert.ok(!JSON.stringify(pagina).includes(salvo.id));

  a.db.prepare("UPDATE eventos SET permissao='minha' WHERE origem_id='COMANDO-TAG-NEGOCIO'").run();
  a.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE origem_id='FONTE-NEGOCIO'").run();
  pagina = await (await get(a, '/api/v3/negocios?tag=vip')).json();
  assert.equal(pagina.pagina.total, 0);
});

test('seis destinos exigem sessao e rejeitam tag, paginacao e campos extras invalidos', async t => {
  const a = await ambienteHttp(t);
  const rotas = [
    '/api/v3/resumo',
    '/api/v3/tarefas',
    '/api/v3/lembretes',
    '/api/v3/conversas/resumo',
    '/api/v3/contatos',
    '/api/v3/negocios'
  ];
  for (const rota of rotas) assert.equal((await fetch(a.base + rota)).status, 403, rota);
  for (const sufixo of [
    '/api/v3/resumo?tag=nao-existe',
    '/api/v3/tarefas?limite=0',
    '/api/v3/lembretes?cursor=adulterado',
    '/api/v3/conversas/resumo?extra=1',
    '/api/v3/contatos?pagina=0',
    '/api/v3/negocios?contatos=talvez'
  ]) assert.equal((await get(a, sufixo)).status, 400, sufixo);
  assert.equal(a.efeitosExternos.transporte, 0);
  assert.equal(a.efeitosExternos.ia, 0);
});

test('matriz dos seis destinos mantem total e IDs unicos entre duas paginas', async t => {
  const a = await ambienteHttp(t);
  const messages = [];
  for (let i = 1; i <= 21; i++) messages.push(mensagem(`PAGE-TASK-${i}`, `#lume_tarefa Tarefa ${i} #lote`));
  for (let i = 1; i <= 2; i++) messages.push(mensagem(`PAGE-REM-${i}`, `#lume_lembrete 2026-09-${20 + i} 09:00 | Lembrete ${i} #lote`));
  const contatos = [];
  for (let i = 1; i <= 13; i++) {
    const jid = `551177770${String(i).padStart(4, '0')}@s.whatsapp.net`;
    contatos.push(jid);
    messages.push(mensagem(`PAGE-CONV-${i}`, '#lume_tag lote', jid));
    messages.push(mensagem(`PAGE-CONTATO-${i}`, '#lume_cliente #lote', jid));
  }
  for (let i = 1; i <= 7; i++) messages.push(mensagem(`PAGE-BUSINESS-SOURCE-${i}`, `Fonte do negocio ${i}`));
  a.contexto.receber({type: 'notify', donoJids: [DONO], messages});

  const negocios = new NegociosDesktop(a.db);
  const origemTag = a.db.prepare(`SELECT t.id tag_id,c.id comando_id,c.conversa_id,c.origem_id,c.criado_em
    FROM lume_tags t JOIN lume_comandos c ON c.origem_id='PAGE-TASK-1' WHERE t.chave='lote'`).get();
  for (let i = 1; i <= 7; i++) {
    const fonte = a.db.prepare('SELECT id FROM eventos WHERE origem_id=?').get(`PAGE-BUSINESS-SOURCE-${i}`).id;
    const negocio = negocios.salvar({
      previa: negocios.preparar({fonte}).id,
      confirmar: true,
      titulo: `Negocio ${i}`,
      etapa: 'interesse'
    });
    a.db.prepare(`INSERT INTO lume_tags_entidades
      (tag_id,entidade_tipo,entidade_id,comando_id,conversa_id,origem_id,procedencia,estado,criada_em)
      VALUES(?,'negocio',?,?,?,?,?,'ativa',?)`)
      .run(origemTag.tag_id, negocio.id, origemTag.comando_id, origemTag.conversa_id, origemTag.origem_id, 'interface', origemTag.criado_em);
  }

  const hoje1 = await (await get(a, '/api/v3/resumo?tag=lote&pagina=1')).json();
  const hoje2 = await (await get(a, '/api/v3/resumo?tag=lote&pagina=2')).json();
  assert.equal(hoje1.fila.total, 23);
  assert.equal(hoje2.fila.total, 23);
  assert.equal(new Set([...hoje1.tarefas, ...hoje2.tarefas].map(item => item.id)).size, hoje1.tarefas.length + hoje2.tarefas.length);

  const tarefas1 = (await (await get(a, '/api/v3/tarefas?tag=lote&limite=10')).json()).comandos;
  const tarefas2 = (await (await get(a, `/api/v3/tarefas?tag=lote&limite=10&cursor=${tarefas1.proximoCursor}`)).json()).comandos;
  assert.equal(tarefas1.total, 21);
  assert.equal(tarefas2.total, 21);
  assert.equal(new Set([...tarefas1.itens, ...tarefas2.itens].map(item => item.id)).size, 20);

  const lembretes1 = (await (await get(a, '/api/v3/lembretes?tag=lote&limite=1')).json()).comandos;
  const lembretes2 = (await (await get(a, `/api/v3/lembretes?tag=lote&limite=1&cursor=${lembretes1.proximoCursor}`)).json()).comandos;
  assert.equal(lembretes1.total, 2);
  assert.equal(lembretes2.total, 2);
  assert.notEqual(lembretes1.itens[0].id, lembretes2.itens[0].id);

  const conversas1 = await (await get(a, '/api/v3/conversas/resumo?tag=lote&pagina=1')).json();
  const conversas2 = await (await get(a, '/api/v3/conversas/resumo?tag=lote&pagina=2')).json();
  assert.equal(conversas1.pagina.total, 13);
  assert.equal(conversas2.pagina.total, 13);
  assert.equal(new Set([...conversas1.conversas, ...conversas2.conversas].map(item => item.id)).size, 13);

  const pessoas1 = await (await get(a, '/api/v3/contatos?tag=lote&pagina=1')).json();
  const pessoas2 = await (await get(a, '/api/v3/contatos?tag=lote&pagina=2')).json();
  assert.equal(pessoas1.pagina.total, 13);
  assert.equal(pessoas2.pagina.total, 13);
  assert.equal(new Set([...pessoas1.contatos, ...pessoas2.contatos].map(item => item.id)).size, 13);

  const negocios1 = await (await get(a, '/api/v3/negocios?tag=lote&pagina=1')).json();
  const negocios2 = await (await get(a, '/api/v3/negocios?tag=lote&pagina=2')).json();
  assert.equal(negocios1.pagina.total, 7);
  assert.equal(negocios2.pagina.total, 7);
  assert.equal(new Set([...negocios1.negocios, ...negocios2.negocios].map(item => item.id)).size, 7);
  assert.equal(a.efeitosExternos.transporte, 0);
  assert.equal(a.efeitosExternos.ia, 0);
});
