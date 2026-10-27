// Integration proof with real SQLite/domain classes; only remote inference and transports are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop, VERSAO_TERMOS} from '../src/desktop.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {TelegramDiario} from '../src/pessoal/telegram-diario.js';
import {hash} from '../src/pessoal/politica.js';

const DM = '551100000001@s.whatsapp.net', OTHER = '551100000002@s.whatsapp.net';
const OWNER = '123456789', BOT = '987654321';
const REQUEST = 'Pode conferir o relatório antes de responder?';
const OWNER_MESSAGE = {conversaId: DM, motivo: 'Convite sintético escrito explicitamente pelo dono para teste.', baloes: ['Olá, sou Lume, assistente do Fabrício.', 'Este é um convite inteiramente sintético.', 'Podemos conversar sobre o projeto de teste?', 'Sem compromisso; fique à vontade para responder.']};
const telegramUpdate = (text, id = 1, owner = OWNER) => ({update_id: id, message: {message_id: id, date: 1793008800, chat: {id: Number(owner), type: 'private'}, from: {id: Number(owner), is_bot: false}, text}});

test('ciclo: conversa longa mantém vinte fontes e exemplos próprios sem falhar antes de interpretar',async t=>{
  const f=await fixture(t);await f.pessoal.configurar({enabled:true});
  for(let i=0;i<30;i++)f.receive({type:'history',fromMe:i%2===0,text:'Mensagem histórica sintética '+i+' sobre o relatório.'});
  f.allow();const e=f.receive();f.due(e.id);
  const sources=f.pessoal.contexto.recuperar({conversaId:DM,pergunta:e.texto,remoto:true}).fontes;
  const examples=f.pessoal.personalidade.exemplos({conversaId:DM,remoto:true});
  assert.equal(sources.length,20);assert.equal(examples.length,8);
  await f.pessoal.tick();assert.equal(f.calls.length,1);assert.ok(f.db.prepare('SELECT 1 FROM lume_acoes WHERE evento_id=?').get(e.id));
});

async function fixture(t, {disk = false, balloons = ['Vou conferir o relatório e preparar a resposta.'], model, transport, at = new Date()} = {}) {
  const dir = disk ? mkdtempSync(join(tmpdir(), 'lume-pessoal-ciclo-')) : null;
  const path = dir ? join(dir, 'sintetico.sqlite') : ':memory:';
  let now = new Date(at), seq = 0;
  const f = {calls: [], sent: [], path, connectionState: 'conectada'};
  const connect = () => {
    f.db = abrirBanco(path);
    f.contexto = new ContextoApp(f.db, {donoId: '551199999999@s.whatsapp.net'});
    f.desktop = new Desktop(f.db);
    f.desktop.aceitar({nome: 'Pessoa sintética', aceito: true, versao: VERSAO_TERMOS});
    f.diario = new TelegramDiario(f.db, {botId: BOT, donoId: OWNER, agora: () => now, validarSaida: link => f.pessoal.validarAviso(link)});
    const chatgpt = {estado: async () => ({available: true, connected: true}), encerrar() {}, responder: async request => {
      const input = JSON.parse(request.input.at(-1).content);
      f.calls.push(input);
      if (model) return model({f, request, input});
      return {completed: true, text: JSON.stringify({decisao: 'consultar_dono', resumo: 'Conferir o relatório antes da resposta', trecho: input.mensagemAtual.texto, baloes: balloons, fontes: [input.mensagemAtual.id], motivo: 'Confira o rascunho e autorize esta versão.'})};
    }};
    f.pessoal = new LumePessoal(f.db, {
      desktop: f.desktop, chatgpt, agora: () => now,
      telegram: {estado: async () => ({enabled: true}), agendar: (...args) => f.diario.agendar(...args)},
      conexao: {estado: () => ({estado: f.connectionState}), enviarTexto: async (jid, text, waId) => {
        assert.equal(f.db.prepare('SELECT estado FROM saidas WHERE motivo=?').get(waId)?.estado, 'incerta', 'Durable claim precedes transport');
        assert.equal(f.pessoal.autorizarTransporte(jid, waId, text), true);
        assert.equal(f.pessoal.autorizarTransporte(jid, waId, text + ' conteúdo adulterado'), false);
        f.sent.push({jid, text, waId});
        return transport ? transport({f, jid, text, waId}) : waId;
      }},
      fetchImpl: async () => {throw new Error('Unexpected external request in synthetic fixture');}
    });
  };
  connect();
  t.after(async () => {await f.pessoal.encerrar(); f.db.close(); if (dir) rmSync(dir, {recursive: true, force: true});});
  f.receive = ({jid = DM, text = REQUEST, type = 'notify', fromMe = false, origemId = `synthetic-${++seq}`} = {}) => {
    const result = f.contexto.receber({type, messages: [{key: {id: origemId, remoteJid: jid, fromMe, ...(jid.endsWith('@g.us') ? {participant: OTHER} : {})}, messageTimestamp: Math.floor(now.getTime() / 1000), pushName: 'Contato sintético', message: {conversation: text}}]});
    assert.equal(result.falhas, 0, JSON.stringify(f.db.prepare('SELECT erro FROM falhas_ingestao').all()));
    return f.db.prepare('SELECT * FROM eventos WHERE conversa_id=? AND origem_id=?').get(jid, origemId);
  };
  f.allow = (jid = DM, {categoria = 'vip_client', modo = 'rascunhar', remoto = true} = {}) => {
    f.db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(jid, 'Contato sintético');
    return f.pessoal.configurarConversa({conversaId: jid, categoria, modo, remoto});
  };
  f.due = id => {
    const stage = f.db.prepare("SELECT * FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(id);
    assert.ok(stage, 'Notify has a durable assistance stage');
    now = new Date(stage.proxima_tentativa_em);
    return stage;
  };
  f.time = value => now = new Date(value);
  f.proposal = async (event = f.receive()) => {
    f.due(event.id); await f.pessoal.tick();
    const proposal = f.db.prepare('SELECT * FROM pessoal_propostas WHERE evento_id=?').get(event.id);
    assert.ok(proposal, JSON.stringify(f.db.prepare("SELECT estado,resultado FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(event.id)));
    return proposal;
  };
  f.approve = async (proposal, owner = OWNER) => {
    const update = telegramUpdate(`aprovar ${proposal.id} ${proposal.conteudo_hash.slice(0, 12)}`, ++seq, owner);
    f.diario.aceitar(update);
    const accepted = f.diario.proxima();
    if (!accepted) return null;
    const reply = await f.pessoal.conversar(accepted, {diario: f.diario, signal: new AbortController().signal});
    f.diario.concluir(accepted, reply);
    return reply;
  };
  f.reopen = async () => {assert.ok(disk); await f.pessoal.encerrar(); f.db.close(); connect();};
  await f.pessoal.configurar({enabled: true});
  return f;
}

test('mensagem do dono: fonte só identifica conversa, quatro balões, preparo idempotente e envio único após aprovação exata', async t => {
  const f = await fixture(t, {disk: true}); f.allow();
  const source = f.receive({type: 'history', text: 'Registro histórico sintético do destinatário.'});
  const prepared = f.pessoal.prepararMensagemDono(OWNER_MESSAGE);
  assert.equal(prepared.estado, 'pendente'); assert.deepEqual(prepared.baloes, OWNER_MESSAGE.baloes);
  assert.deepEqual(f.pessoal.prepararMensagemDono(OWNER_MESSAGE), prepared);
  const proposal = f.pessoal.proposta(prepared.id);
  assert.equal(proposal.evento_id, source.id); assert.equal(proposal.acao_id, null);
  assert.match(proposal.motivo, /Fonte identifica a conversa; não representa uma solicitação recebida/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n, 1);
  await f.pessoal.tick(); assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
  assert.throws(() => f.pessoal.aprovar(prepared.id, 'incorrect-hash', 'local:owner'));
  f.pessoal.aprovar(prepared.id, prepared.versao, 'local:owner'); await f.pessoal.tick();
  assert.deepEqual(f.sent.map(sent => sent.text), OWNER_MESSAGE.baloes);
  assert.ok(f.sent.every(sent => sent.jid === DM)); assert.equal(new Set(f.sent.map(sent => sent.waId)).size, 4);
  assert.equal(f.pessoal.proposta(prepared.id).estado, 'enviada');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM saidas WHERE estado='enviada'").get().n, 4);
  await f.reopen(); await f.pessoal.tick();
  assert.equal(f.pessoal.prepararMensagemDono(OWNER_MESSAGE).id, prepared.id);
  assert.throws(() => f.pessoal.aprovar(prepared.id, prepared.versao, 'local:owner'));
  assert.equal(f.sent.length, 4); assert.equal(f.calls.length, 0);
});

test('mensagem do dono: offline preserva aprovada sem claim; reconexão envia os mesmos quatro balões uma vez', async t => {
  const f = await fixture(t, {disk: true}); f.allow(); f.receive({type: 'history'});
  const prepared = f.pessoal.prepararMensagemDono(OWNER_MESSAGE);
  f.pessoal.aprovar(prepared.id, prepared.versao, 'local:owner');
  f.connectionState = 'desconectada'; await f.pessoal.tick(); await f.reopen(); await f.pessoal.tick();
  assert.equal(f.pessoal.proposta(prepared.id).estado, 'aprovada'); assert.equal(f.sent.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saidas').get().n, 0);
  f.connectionState = 'conectada'; await f.pessoal.tick(); await f.pessoal.tick();
  assert.equal(f.pessoal.proposta(prepared.id).estado, 'enviada'); assert.equal(f.sent.length, 4); assert.equal(f.calls.length, 0);
});

test('mensagem do dono: contrato real conectada permite envio e queda entre balões preserva o restante sem claim', async t => {
  const f = await fixture(t, {disk: true, transport: ({f, waId}) => {if (f.sent.length === 1) f.connectionState = 'desconectada'; return waId;}});
  f.allow(); f.receive({type: 'history'});
  const prepared = f.pessoal.prepararMensagemDono(OWNER_MESSAGE);
  f.pessoal.aprovar(prepared.id, prepared.versao, 'local:owner'); await f.pessoal.tick();
  assert.equal(f.sent.length, 1, 'The real connected state permits the first balloon');
  assert.equal(f.pessoal.proposta(prepared.id).estado, 'aprovada', 'Known disconnection before balloon two is not an uncertain dispatch');
  assert.deepEqual(f.db.prepare('SELECT estado FROM saidas ORDER BY id').all().map(r => r.estado), ['enviada']);
  await f.reopen(); await f.pessoal.tick(); assert.equal(f.sent.length, 1);
  f.connectionState = 'conectada'; await f.pessoal.tick(); await f.pessoal.tick();
  assert.deepEqual(f.sent.map(r => r.text), OWNER_MESSAGE.baloes, 'Resume skips the already confirmed first balloon');
  assert.equal(new Set(f.sent.map(r => r.waId)).size, 4);
  assert.equal(f.pessoal.proposta(prepared.id).estado, 'enviada');
});

test('mensagem do dono: renovar expirada sem saídas muda ID e invalida aprovação antiga', async t => {
  for (const approved of [false, true]) await t.test(approved ? 'aprovada sem saída' : 'pendente sem saída', async child => {
    const start = new Date();
    const f = await fixture(child, {at: start}); f.allow(); f.receive({type: 'history'});
    const old = f.pessoal.prepararMensagemDono(OWNER_MESSAGE), oldPolicyVersion = f.pessoal.politica.regra(DM).versao;
    if (approved) f.pessoal.aprovar(old.id, old.versao, 'local:owner');
    f.time(start.getTime() + 25 * 3600000);
    assert.throws(() => f.pessoal.aprovar(old.id, old.versao, 'local:owner'));
    const renewed = f.pessoal.prepararMensagemDono(OWNER_MESSAGE);
    assert.notEqual(renewed.id, old.id, 'Expired content can be explicitly prepared again');
    assert.equal(renewed.estado, 'pendente');
    assert.ok(f.pessoal.politica.regra(DM).versao > oldPolicyVersion);
    assert.throws(() => f.pessoal.aprovar(old.id, old.versao, 'local:owner'), 'Old ID/hash must remain invalid after renewal');
    assert.deepEqual(f.pessoal.prepararMensagemDono(OWNER_MESSAGE), renewed, 'Renewal is itself idempotent');
    f.pessoal.aprovar(renewed.id, renewed.versao, 'local:owner'); await f.pessoal.tick();
    assert.equal(f.sent.length, 4); assert.equal(f.pessoal.proposta(renewed.id).estado, 'enviada');
  });
});

test('mensagem do dono: expiração nunca renova proposta com saída registrada ou estado terminal', async t => {
  for (const state of ['enviada', 'incerta', 'cancelada', 'recusada', 'aprovada-com-saida']) await t.test(state, async child => {
    const start = new Date(); const f = await fixture(child, {at: start}); f.allow(); f.receive({type: 'history'});
    const prepared = f.pessoal.prepararMensagemDono(OWNER_MESSAGE);
    if (state === 'enviada') {f.pessoal.aprovar(prepared.id, prepared.versao, 'local:owner'); await f.pessoal.tick();}
    else if (state === 'aprovada-com-saida') {
      f.pessoal.aprovar(prepared.id, prepared.versao, 'local:owner');
      const key = 'pessoal:' + prepared.id + ':0', out = f.pessoal.saidas.preparar({conversaId: DM, corpo: OWNER_MESSAGE.baloes[0], idempotencia: key});
      f.db.prepare('INSERT INTO pessoal_proposta_saidas(proposta_id,ordem,saida_id,wa_id,atualizado_em) VALUES(?,?,?,?,?)').run(prepared.id, 0, out.id, hash(key).slice(0, 40).toUpperCase(), start.toISOString());
    } else f.db.prepare('UPDATE pessoal_propostas SET estado=? WHERE id=?').run(state, prepared.id);
    const count = f.sent.length, version = f.pessoal.politica.regra(DM).versao;
    f.time(start.getTime() + 25 * 3600000);
    try {assert.equal(f.pessoal.prepararMensagemDono(OWNER_MESSAGE).id, prepared.id);} catch (error) {if (error.code === 'ERR_ASSERTION') throw error;}
    assert.equal(f.pessoal.politica.regra(DM).versao, version);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n, 1);
    assert.throws(() => f.pessoal.aprovar(prepared.id, prepared.versao, 'local:owner'));
    await f.pessoal.tick(); assert.equal(f.sent.length, count);
  });
});

test('mensagem do dono: sem fonte, sem identificação, excesso e categorias bloqueadas não preparam saída', async t => {
  const f = await fixture(t); f.allow();
  assert.throws(() => f.pessoal.prepararMensagemDono(OWNER_MESSAGE), /fonte autorizada/);
  f.receive({type: 'history'});
  for (const baloes of [[], [...OWNER_MESSAGE.baloes, 'Quinto balão proibido.'], ['Olá, mensagem sem identificação.'], ['Lume assistente ' + 'x'.repeat(2200)], ['Lume assistente', '']]) assert.throws(() => f.pessoal.prepararMensagemDono({...OWNER_MESSAGE, baloes}));
  for (const categoria of ['family', 'unknown', 'friend', 'supplier']) {
    f.allow(DM, {categoria}); assert.throws(() => f.pessoal.prepararMensagemDono(OWNER_MESSAGE));
  }
  const group = '120000000001@g.us'; f.allow(group, {categoria: 'team'}); f.receive({jid: group, type: 'history'});
  assert.throws(() => f.pessoal.prepararMensagemDono({...OWNER_MESSAGE, conversaId: group}));
  f.allow(DM, {remoto: false}); assert.throws(() => f.pessoal.prepararMensagemDono(OWNER_MESSAGE));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n, 0); assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
});

test('mensagem do dono: mensagem nova invalida versão e intervenção manual bloqueia novo preparo', async t => {
  const f = await fixture(t); f.allow(); f.receive({type: 'history'});
  const prepared = f.pessoal.prepararMensagemDono(OWNER_MESSAGE);
  f.pessoal.aprovar(prepared.id, prepared.versao, 'local:owner');
  f.receive({text: 'Nova mensagem sintética muda o contexto antes do envio.'});
  assert.equal(f.pessoal.proposta(prepared.id).estado, 'cancelada');
  assert.throws(() => f.pessoal.aprovar(prepared.id, prepared.versao, 'local:owner'));
  await f.pessoal.tick(); assert.equal(f.sent.length, 0);
  const replacement = f.pessoal.prepararMensagemDono(OWNER_MESSAGE); assert.notEqual(replacement.id, prepared.id);
  f.receive({fromMe: true, text: 'Vou conduzir esta conversa manualmente.'});
  assert.equal(f.pessoal.proposta(replacement.id).estado, 'cancelada');
  assert.throws(() => f.pessoal.prepararMensagemDono(OWNER_MESSAGE));
  assert.equal(f.pessoal.politica.regra(DM).pausada, true); assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
});

test('resumo diário: primeira ativação não envia passado; 23h São Paulo agenda uma vez inclusive após reinício', async t => {
  const f = await fixture(t, {disk: true, at: '2026-10-26T11:00:00Z'});
  const summaries = () => f.db.prepare("SELECT id FROM telegram_saidas WHERE id LIKE 'resumo:%' ORDER BY id").all().map(row => row.id);
  await f.pessoal.tick();
  assert.deepEqual(summaries(), [], 'First activation at 08h does not send an old summary');
  f.time('2026-10-27T01:59:59Z'); await f.pessoal.tick();
  assert.deepEqual(summaries(), []);
  f.time('2026-10-27T02:00:00Z'); await f.pessoal.tick(); await f.pessoal.tick();
  assert.deepEqual(summaries(), ['resumo:2026-10-26']);
  f.time('2026-10-27T03:00:00Z'); await f.reopen(); await f.pessoal.tick();
  assert.deepEqual(summaries(), ['resumo:2026-10-26'], 'Midnight/restart never repeats the 23h summary');
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('resumo diário: abrir 08h após vários dias offline agenda apenas o último resumo pendente', async t => {
  const f = await fixture(t, {disk: true, at: '2026-10-23T11:00:00Z'});
  await f.pessoal.tick();
  f.time('2026-10-26T11:00:00Z'); await f.reopen(); await f.pessoal.tick(); await f.pessoal.tick();
  assert.deepEqual(f.db.prepare("SELECT id FROM telegram_saidas WHERE id LIKE 'resumo:%'").all().map(row => row.id), ['resumo:2026-10-25']);
  assert.equal(f.db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-resumo-ultimo-dia'").get().valor, '2026-10-25');
  await f.reopen(); await f.pessoal.tick();
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM telegram_saidas WHERE id LIKE 'resumo:%'").get().n, 1);
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('ciclo: notify → silêncio12s → fonte literal → aprovação exata → envio/recibo → acompanhamento → reinício sem repetir', async t => {
  const f = await fixture(t, {disk: true});
  f.allow();
  const event = f.receive();
  const stage = f.due(event.id);
  assert.equal(Date.parse(stage.proxima_tentativa_em) - Date.parse(stage.atualizado_em), 12000);
  f.time(Date.parse(stage.proxima_tentativa_em) - 1);
  await f.pessoal.tick();
  assert.equal(f.calls.length, 0, 'Inference waits for the full silence window');
  const proposal = await f.proposal(event);
  assert.equal(proposal.estado, 'pendente');
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.calls[0].contexto.fontes.map(source => source.id), [event.id]);
  assert.equal(f.db.prepare('SELECT trecho FROM lume_acoes WHERE id=?').get(proposal.acao_id).trecho, REQUEST);
  assert.match(JSON.parse(proposal.baloes)[0], /^Lume, assistente do Fabrício:/);
  assert.throws(() => f.pessoal.aprovar(proposal.id, '000000000000', OWNER));
  await f.approve(proposal);
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'aprovada');
  await f.pessoal.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].jid, DM);
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'enviada');
  assert.equal(f.db.prepare('SELECT estado FROM saidas').get().estado, 'enviada');
  assert.equal(f.db.prepare('SELECT recibo FROM pessoal_proposta_saidas').get().recibo, 'aceita');
  assert.equal(f.db.prepare('SELECT estado FROM lume_acoes WHERE id=?').get(proposal.acao_id).estado, 'sugerido', 'Send receipt does not resolve the work');
  assert.ok(f.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get('pessoal-acompanhamento:' + proposal.acao_id));
  f.pessoal.receberRecibos([{key: {id: f.sent[0].waId, remoteJid: OTHER}, update: {status: 4}}]);
  assert.equal(f.db.prepare('SELECT recibo FROM pessoal_proposta_saidas').get().recibo, 'aceita', 'Recipient must match the receipt');
  f.pessoal.receberRecibos([{key: {id: f.sent[0].waId, remoteJid: DM}, update: {status: 3}}]);
  assert.equal(f.db.prepare('SELECT recibo FROM pessoal_proposta_saidas').get().recibo, 'entregue');
  f.pessoal.receberRecibos([{key: {id: f.sent[0].waId, remoteJid: DM}, update: {status: 2}}]);
  assert.equal(f.db.prepare('SELECT recibo FROM pessoal_proposta_saidas').get().recibo, 'entregue', 'Receipt cannot regress');
  await f.reopen(); await f.pessoal.tick(); await f.pessoal.tick();
  assert.equal(f.sent.length, 1, 'Reopening the same database does not resend');
  assert.equal(f.calls.length, 1, 'Completed inference is not repeated');
});

test('ciclo: history e append alimentam fontes sem resposta atrasada; replay notify não reinterpreta', async t => {
  const f = await fixture(t); f.allow();
  const past = f.receive({type: 'history'}), appended = f.receive({type: 'append'});
  await f.pessoal.tick();
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM etapas WHERE etapa='assistencia'").get().n, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  assert.ok(f.pessoal.contexto.recuperar({conversaId: DM, remoto: true}).fontes.some(source => source.id === past.id));
  assert.ok(f.pessoal.contexto.recuperar({conversaId: DM, remoto: true}).fontes.some(source => source.id === appended.id));
  const live = f.receive({origemId: 'replay-notify'});
  await f.proposal(live);
  f.receive({origemId: 'replay-notify'}); await f.pessoal.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n, 1);
});

test('ciclo: opt-in de uma conversa não autoriza outra e remoto=false impede inferência', async t => {
  const f = await fixture(t); f.allow(); f.allow(OTHER, {remoto: false});
  const event = f.receive({jid: OTHER}); f.due(event.id); await f.pessoal.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.db.prepare("SELECT estado FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(event.id).estado, 'desistida');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n, 0);
});

test('ciclo: categorias passivas e grupos nunca criam saída ou transporte', async t => {
  for (const [index, categoria] of ['family', 'unknown', 'friend', 'supplier', 'team'].entries()) {
    await t.test(categoria === 'team' ? 'grupo classificado como equipe' : categoria, async child => {
      const f = await fixture(child), jid = categoria === 'team' ? '120000000000001@g.us' : `55110000001${index}@s.whatsapp.net`;
      f.allow(jid, {categoria, modo: 'observar'});
      assert.throws(() => f.allow(jid, {categoria, modo: 'atender'}));
      // Group source remains third-party by default; no reading override is fabricated.
      const event = f.receive({jid}); f.due(event.id); await f.pessoal.tick(); await f.pessoal.tick();
      assert.equal(f.sent.length, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saidas').get().n, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n, 0);
      assert.equal(f.pessoal.politica.podeEnviar(jid).permitido, false);
    });
  }
});

test('ciclo: intervenção manual invalida aprovação e permanece pausada após configurar novamente', async t => {
  const f = await fixture(t); f.allow(); const proposal = await f.proposal();
  await f.approve(proposal);
  const manual = f.receive({fromMe: true, text: 'Eu vou conferir pessoalmente.'});
  assert.equal(manual.autor_e_dono, 1); assert.equal(manual.do_proprio_bot, 0);
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'cancelada');
  assert.equal(f.pessoal.politica.regra(DM).pausada, true);
  f.allow();
  assert.equal(f.pessoal.politica.regra(DM).pausada, true, 'Saving a policy does not silently resume manual pause');
  await f.pessoal.tick(); assert.equal(f.sent.length, 0);
  f.pessoal.politica.retomar(DM, OWNER);
  assert.equal(f.pessoal.politica.regra(DM).pausada, false);
  assert.throws(() => f.pessoal.aprovar(proposal.id, proposal.conteudo_hash.slice(0, 12), OWNER));
  await f.pessoal.tick(); assert.equal(f.sent.length, 0, 'Explicit resume does not resurrect invalid approvals');
});

test('ciclo: permissão é reconferida antes de cada balão após intervenção durante transporte', async t => {
  const f = await fixture(t, {balloons: ['Primeiro rascunho sintético.', 'Segundo rascunho sintético.'], transport: ({f, waId}) => {
    if (f.sent.length === 1) f.receive({fromMe: true, text: 'Parei o atendimento e vou responder.'});
    return waId;
  }});
  f.allow(); const proposal = await f.proposal(); await f.approve(proposal); await f.pessoal.tick();
  assert.equal(f.sent.length, 1, 'The second balloon never reaches the transport');
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'cancelada');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saidas').get().n, 1);
  await f.pessoal.tick(); assert.equal(f.sent.length, 1);
});

test('ciclo: fonte ou consentimento alterado enquanto o modelo responde descarta a proposta', async t => {
  for (const reason of ['fonte', 'consentimento']) await t.test(reason, async child => {
    let started, release;
    const reached = new Promise(resolve => started = resolve);
    const blocked = new Promise(resolve => release = resolve);
    const f = await fixture(child, {model: async ({input}) => {
      started(); await blocked;
      return {completed: true, text: JSON.stringify({decisao: 'responder', resumo: 'Conferir o relatório', trecho: input.mensagemAtual.texto, baloes: ['Rascunho preparado com fonte anterior.'], fontes: [input.mensagemAtual.id], motivo: 'Confirmação necessária.'})};
    }});
    f.allow(); const event = f.receive(); f.due(event.id);
    const processing = f.pessoal.tick(); await reached;
    if (reason === 'fonte') f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Pedido alterado enquanto o modelo respondia.', event.id);
    else f.allow(DM, {remoto: false});
    release(); await processing;
    assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n, 0);
    assert.equal(f.db.prepare("SELECT estado FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(event.id).estado, 'falha');
  });
});

test('ciclo: aprovação de terceiro, grupo ou remetente divergente não altera a proposta', async t => {
  const f = await fixture(t); f.allow(); const proposal = await f.proposal();
  const text = `aprovar ${proposal.id} ${proposal.conteudo_hash.slice(0, 12)}`;
  const foreign = telegramUpdate(text, 201, '333333333');
  const group = telegramUpdate(text, 202); group.message.chat.type = 'group';
  const forged = telegramUpdate(text, 203); forged.message.from.id = 333333333;
  for (const update of [foreign, group, forged]) {
    assert.equal(await f.pessoal.conversar(update, {diario: f.diario}), null);
    f.diario.aceitar(update);
  }
  assert.equal(f.diario.proxima(), null);
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'pendente');
  await f.pessoal.tick(); assert.equal(f.sent.length, 0);
});

test('ciclo: transporte incerto sobrevive ao reinício e recibo reconcilia sem reenviar', async t => {
  const f = await fixture(t, {disk: true, transport: () => {throw Error('simulated lost transport acknowledgement');}});
  f.allow(); const proposal = await f.proposal(); await f.approve(proposal); await f.pessoal.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'incerta');
  assert.equal(f.db.prepare('SELECT estado FROM saidas').get().estado, 'incerta');
  await f.reopen(); await f.pessoal.tick();
  assert.equal(f.sent.length, 1);
  f.pessoal.receberRecibos([{key: {id: f.sent[0].waId, remoteJid: DM}, update: {status: 3}}]);
  assert.equal(f.db.prepare('SELECT estado FROM saidas').get().estado, 'enviada');
  assert.equal(f.db.prepare('SELECT recibo FROM pessoal_proposta_saidas').get().recibo, 'entregue');
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'enviada', 'Receipt reconciles the uncertain proposal after every balloon is confirmed');
  await f.pessoal.tick(); assert.equal(f.sent.length, 1);
  assert.equal(f.db.prepare('SELECT estado FROM lume_acoes WHERE id=?').get(proposal.acao_id).estado, 'sugerido');
});

test('ciclo: queda após claim durável e antes do estado da proposta reconcilia sem novo transporte', async t => {
  const f = await fixture(t, {disk: true});
  f.allow(); const proposal = await f.proposal(); await f.approve(proposal);
  const key = 'pessoal:' + proposal.id + ':0', waId = hash(key).slice(0, 40).toUpperCase();
  const out = f.pessoal.saidas.preparar({conversaId: DM, corpo: JSON.parse(proposal.baloes)[0], idempotencia: key});
  f.db.prepare('INSERT INTO pessoal_proposta_saidas(proposta_id,ordem,saida_id,wa_id,atualizado_em) VALUES(?,?,?,?,?)').run(proposal.id, 0, out.id, waId, new Date().toISOString());
  // Crash boundary: the durable transport claim exists, but proposal update never ran.
  f.db.prepare("UPDATE saidas SET estado='incerta',motivo=? WHERE id=?").run(waId, out.id);
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'aprovada');
  await f.reopen(); await f.pessoal.tick(); await f.pessoal.tick();
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'incerta');
  assert.equal(f.sent.length, 0, 'Recovery never calls transport for a claimed output');
  f.pessoal.receberRecibos([{key: {id: waId, remoteJid: DM}, update: {status: 3}}]);
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'enviada');
  assert.equal(f.db.prepare('SELECT estado FROM saidas WHERE id=?').get(out.id).estado, 'enviada');
  assert.equal(f.db.prepare('SELECT recibo FROM pessoal_proposta_saidas WHERE saida_id=?').get(out.id).recibo, 'entregue');
  await f.reopen(); await f.pessoal.tick(); assert.equal(f.sent.length, 0);
});

test('ciclo: revogar consentimento depois da aprovação cancela o envio já preparado', async t => {
  const f = await fixture(t); f.allow(); const proposal = await f.proposal(); await f.approve(proposal);
  f.allow(DM, {remoto: false}); await f.pessoal.tick();
  assert.equal(f.pessoal.proposta(proposal.id).estado, 'cancelada');
  assert.equal(f.sent.length, 0);
  assert.notEqual(f.diario.proximaSaida()?.id.startsWith('proposta:'), true);
});

test('ciclo: nova mensagem consolida o pedido e espera o silêncio da mensagem mais recente', async t => {
  const f = await fixture(t); f.allow();
  const first = f.receive(), firstStage = f.due(first.id);
  const latest = f.receive({text: 'Confira também a versão mais recente do relatório.'});
  // The injected clock cannot change SQLite strftime; move only the latest queue deadline by 1s.
  const deadline = new Date(Date.parse(firstStage.proxima_tentativa_em) + 1000).toISOString();
  f.db.prepare("UPDATE etapas SET proxima_tentativa_em=? WHERE evento_id=? AND etapa='assistencia'").run(deadline, latest.id);
  await f.pessoal.tick(); await f.pessoal.tick();
  assert.equal(f.calls.length, 0, 'Neither the old request nor the not-yet-quiet latest request reaches inference');
  assert.equal(f.db.prepare("SELECT estado FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(first.id).estado, 'concluida');
  const proposal = await f.proposal(latest);
  assert.equal(proposal.evento_id, latest.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].mensagemAtual.id, latest.id);
  assert.deepEqual(new Set(f.calls[0].contexto.fontes.map(source => source.id)), new Set([first.id, latest.id]));
});

test('ciclo: revogação remove resposta anterior e fonte do próximo diálogo enviado ao modelo', async t => {
  const inputs = [];
  const secret = 'DETALHE_SINTETICO_REVOGAVEL';
  const f = await fixture(t, {model: async ({request, input}) => {
    inputs.push(request.input);
    return {completed: true, text: JSON.stringify({resposta: input.contexto.fontes.length ? `O recorte autorizado contém ${secret}.` : 'Não há fonte autorizada para responder.', acompanhar: null})};
  }});
  f.allow();
  const source = f.receive({type: 'history', text: `O relatório contém ${secret} para revisão.`});
  const first = telegramUpdate('Como está a revisão?', 401);
  f.diario.aceitar(first);
  const claimed = f.diario.proxima();
  const reply = await f.pessoal.conversar(claimed, {diario: f.diario, signal: new AbortController().signal});
  assert.match(reply.text, /DETALHE_SINTETICO_REVOGAVEL/);
  assert.equal(reply.vinculo.fontes[0].id, source.id);
  f.diario.concluir(claimed, reply);
  const output = f.diario.proximaSaida(); assert.ok(output);
  f.diario.enviada(output, {message_id: 900});
  assert.ok(f.diario.historico().some(entry => entry.role === 'assistant' && entry.content.includes(secret)));
  f.allow(DM, {remoto: false});
  assert.ok(!f.diario.historico().some(entry => entry.role === 'assistant' && entry.content.includes(secret)));
  const second = telegramUpdate('Pode conferir de novo?', 402);
  f.diario.aceitar(second);
  const next = f.diario.proxima();
  const nextReply = await f.pessoal.conversar(next, {diario: f.diario, signal: new AbortController().signal});
  f.diario.concluir(next, nextReply);
  assert.equal(inputs.length, 2);
  assert.doesNotMatch(JSON.stringify(inputs[1]), /DETALHE_SINTETICO_REVOGAVEL/);
  assert.deepEqual(JSON.parse(inputs[1].at(-1).content).contexto.fontes, []);
  assert.equal(f.sent.length, 0);
});
