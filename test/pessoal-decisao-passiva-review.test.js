// Independent boundary review: real in-memory SQLite and domain cycle;
// provider responses, profile consent and transports are entirely synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {TelegramDiario} from '../src/pessoal/telegram-diario.js';

const DM = '551100000071@s.whatsapp.net';
const OWNER = '700001', BOT = '700002';
const DEADLINE = 'A cotação vence hoje às 18h.';
const SUMMARY = 'Cotação vence hoje às 18h; o dono precisa decidir, sem confirmar compra.';

async function fixture(t, {categoria = 'vip_client', modo = 'rascunhar', answer} = {}) {
  const db = abrirBanco(':memory:');
  const contexto = new ContextoApp(db, {donoId: '551199999971@s.whatsapp.net'});
  let now = new Date(), seq = 0;
  const calls = [], transports = [], externalRequests = [];
  const diario = new TelegramDiario(db, {botId: BOT, donoId: OWNER, agora: () => now});
  const f = {db, calls, transports, externalRequests, answer};
  const pessoal = new LumePessoal(db, {
    desktop: {perfil: () => ({aceito: true})},
    agora: () => now,
    chatgpt: {
      estado: async () => ({connected: false, available: false}),
      encerrar() {},
      responder: async request => {
        const input = JSON.parse(request.input.at(-1).content);
        calls.push(input);
        const output = f.answer ? await f.answer(input) : {
          decisao: 'passivo', resumo: SUMMARY, trecho: input.mensagemAtual.texto,
          baloes: [], fontes: [input.mensagemAtual.id], motivo: 'Decisão exclusiva do dono.'
        };
        return {completed: true, text: JSON.stringify(output)};
      }
    },
    telegram: {estado: async () => ({enabled: true}), agendar: (...args) => diario.agendar(...args)},
    conexao: {
      estado: () => ({estado: 'conectada'}),
      enviarTexto: async (...args) => {transports.push(args); return 'synthetic-receipt';}
    },
    fetchImpl: async (...args) => {externalRequests.push(args); throw Error('Network forbidden in review fixture');}
  });
  f.pessoal = pessoal;
  t.after(async () => {await pessoal.encerrar(); db.close();});
  db.prepare('INSERT INTO conversas_app(id,nome) VALUES(?,?)').run(DM, 'Pessoa sintética');
  pessoal.configurarConversa({conversaId: DM, categoria, modo, remoto: true});
  await pessoal.configurar({enabled: true});
  f.receive = (text = DEADLINE, {fromMe = false} = {}) => {
    const id = `passive-review-${++seq}`;
    const result = contexto.receber({type: 'notify', messages: [{
      key: {id, remoteJid: DM, fromMe}, messageTimestamp: Math.floor(now.getTime() / 1000),
      pushName: 'Pessoa sintética', message: {conversation: text}
    }]});
    assert.equal(result.falhas, 0);
    return db.prepare('SELECT * FROM eventos WHERE conversa_id=? AND origem_id=?').get(DM, id);
  };
  f.stage = event => db.prepare("SELECT * FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(event.id);
  f.process = async event => {
    const stage = f.stage(event);
    assert.ok(stage, 'New notify must enter the durable assistance queue');
    now = new Date(stage.proxima_tentativa_em);
    await pessoal.tick();
    return f.stage(event);
  };
  f.proposals = () => db.prepare('SELECT * FROM pessoal_propostas ORDER BY criada_em,id').all();
  f.actions = () => db.prepare('SELECT * FROM lume_acoes ORDER BY id').all();
  f.alerts = () => db.prepare('SELECT * FROM telegram_saidas ORDER BY id').all();
  f.assertNoDispatch = () => {
    assert.deepEqual(transports, []);
    assert.deepEqual(externalRequests, []);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM saidas').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pessoal_proposta_saidas').get().n, 0);
    assert.equal(pessoal.avaliacao.estado().liberada, false, 'No evaluation or acceptance was created');
  };
  return f;
}

for (const categoria of ['vip_client', 'lead', 'team']) {
  for (const modo of ['rascunhar', 'atender']) {
    test(`passivo prevalece sobre permissão técnica: ${categoria}/${modo}`, async t => {
      const f = await fixture(t, {categoria, modo});
      assert.equal(f.pessoal.politica.podeEnviar(DM).permitido, true, 'Test must reach a genuinely eligible DM');
      const event = f.receive();
      const stage = await f.process(event);
      assert.equal(stage.estado, 'concluida', stage.resultado);
      assert.equal(f.calls.length, 1);
      assert.equal(f.actions().length, 1);
      assert.equal(f.actions()[0].evento_id, event.id);
      assert.equal(f.actions()[0].trecho, DEADLINE);
      assert.equal(f.actions()[0].resumo, SUMMARY);
      assert.equal(JSON.parse(stage.resultado).acaoId, f.actions()[0].id);
      assert.deepEqual(f.proposals(), [], 'Passive information must not become an approvable response');
      assert.equal(f.alerts().length, 1);
      assert.equal(f.alerts()[0].id, `demanda:${event.id}`);
      assert.equal(f.alerts()[0].dono_id, OWNER);
      assert.match(f.alerts()[0].texto, /18h/);
      assert.equal(f.alerts()[0].estado, 'preparada', 'Owner notice is persisted, not sent');
      const source = JSON.parse(f.alerts()[0].vinculo).fontes.find(s => s.id === event.id);
      assert.ok(source);
      assert.equal(source.conversaId, DM);
      await f.pessoal.tick(); await f.pessoal.tick();
      assert.equal(f.calls.length, 1, 'Finished passive step must not be interpreted again');
      assert.equal(f.actions().length, 1);
      assert.equal(f.alerts().length, 1);
      f.assertNoDispatch();
    });
  }
}

test('balão indevido do provedor é descartado quando a decisão é passivo', async t => {
  const forbiddenDraft = 'Conteúdo sintético que jamais deve virar proposta ou aviso de aprovação.';
  const f = await fixture(t, {modo: 'atender', answer: input => ({
    decisao: 'passivo', resumo: SUMMARY, trecho: input.mensagemAtual.texto,
    baloes: [forbiddenDraft], fontes: [input.mensagemAtual.id], motivo: 'Sem resposta ao contato.'
  })});
  assert.equal(f.pessoal.politica.podeEnviar(DM).permitido, true);
  const stage = await f.process(f.receive());
  assert.equal(stage.estado, 'concluida', stage.resultado);
  assert.equal(f.actions().length, 1);
  assert.deepEqual(f.proposals(), []);
  assert.equal(f.alerts().length, 1);
  assert.ok(f.alerts().every(a => !a.texto.includes(forbiddenDraft) && !a.id.startsWith('proposta:')));
  await f.pessoal.tick();
  f.assertNoDispatch();
});

test('saudação passiva sem pendência não cria demanda, aviso nem proposta', async t => {
  const f = await fixture(t, {answer: input => ({
    decisao: 'passivo', resumo: '', trecho: '', baloes: ['Resposta indevida à saudação.'],
    fontes: [input.mensagemAtual.id], motivo: 'Conversa sem pendência.'
  })});
  assert.equal(f.pessoal.politica.podeEnviar(DM).permitido, true);
  const stage = await f.process(f.receive('Olá, bom dia!'));
  assert.equal(stage.estado, 'concluida');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.actions(), []);
  assert.deepEqual(f.alerts(), []);
  assert.deepEqual(f.proposals(), []);
  f.assertNoDispatch();
});

test('P070: fornecedor gera pendência e alerta de vencimento sem criar resposta', async t => {
  const f = await fixture(t, {categoria: 'supplier', modo: 'observar'});
  assert.equal(f.pessoal.politica.podeEnviar(DM).permitido, false);
  const stage = await f.process(f.receive());
  assert.equal(stage.estado, 'concluida', stage.resultado);
  assert.equal(f.calls.length, 1, 'Explicitly shared supplier information can inform the owner');
  assert.equal(f.calls[0].categoria, 'supplier');
  assert.equal(f.actions().length, 1);
  assert.equal(f.actions()[0].trecho, DEADLINE);
  assert.match(f.actions()[0].resumo, /18h/);
  assert.equal(f.alerts().length, 1);
  assert.equal(f.alerts()[0].dono_id, OWNER);
  assert.match(f.alerts()[0].texto, /18h/);
  assert.deepEqual(f.proposals(), []);
  f.assertNoDispatch();
});

test('demanda passiva não contorna a exigência de trecho literal', async t => {
  const f = await fixture(t, {answer: input => ({
    decisao: 'passivo', resumo: SUMMARY, trecho: 'O fornecedor aprovou uma compra inexistente.',
    baloes: [], fontes: [input.mensagemAtual.id], motivo: 'Trecho inventado pelo stub.'
  })});
  const stage = await f.process(f.receive());
  assert.equal(stage.estado, 'falha');
  assert.deepEqual(f.actions(), []);
  assert.deepEqual(f.proposals(), []);
  assert.ok(f.alerts().every(a => a.id.startsWith('falha:')));
  f.assertNoDispatch();
});

test('controle positivo: responder factual ainda prepara versão pendente sem enviá-la', async t => {
  const f = await fixture(t, {answer: input => ({
    decisao: 'responder', resumo: 'Confirmar o recebimento do briefing.', trecho: input.mensagemAtual.texto,
    baloes: ['Lume, assistente do Fabrício: briefing recebido.'], fontes: [input.mensagemAtual.id],
    motivo: 'Informação factual para revisão do dono.'
  })});
  const stage = await f.process(f.receive('O briefing foi recebido; pode confirmar o recebimento?'));
  assert.equal(stage.estado, 'concluida', stage.resultado);
  assert.equal(f.proposals().length, 1);
  assert.equal(f.proposals()[0].estado, 'pendente');
  assert.match(f.alerts()[0].id, /^proposta:/);
  await f.pessoal.tick();
  f.assertNoDispatch();
});

test('intervenção invalida versão antiga; retomada exige preparo e aprovação novos', async t => {
  const f = await fixture(t, {answer: input => ({
    decisao: 'responder', resumo: 'Registrar pedido atual para revisão.', trecho: input.mensagemAtual.texto,
    baloes: ['Lume, assistente do Fabrício: ' + input.mensagemAtual.texto],
    fontes: [input.mensagemAtual.id], motivo: 'Revise esta versão antes de responder.'
  })});
  await f.process(f.receive('Confira apenas o primeiro documento sintético.'));
  const old = f.proposals()[0];
  assert.equal(old.estado, 'pendente');
  f.receive('Eu assumo esta conversa manualmente agora.', {fromMe: true});
  assert.equal(f.pessoal.politica.regra(DM).pausada, true);
  assert.equal(f.pessoal.proposta(old.id).estado, 'cancelada');
  const callsBeforeContact = f.calls.length;
  await f.process(f.receive('Agora pode mandar a resposta que estava pronta.'));
  assert.equal(f.calls.length, callsBeforeContact, 'Contact cannot lift manual pause or regenerate a stale draft');
  assert.equal(f.pessoal.politica.podeEnviar(DM).permitido, false);
  assert.throws(() => f.pessoal.aprovar(old.id, old.conteudo_hash.slice(0, 12), 'local:synthetic-owner'));
  f.pessoal.politica.retomar(DM, 'local:synthetic-owner');
  assert.equal(f.pessoal.politica.podeEnviar(DM).permitido, true);
  assert.equal(f.pessoal.proposta(old.id).estado, 'cancelada');
  assert.throws(() => f.pessoal.aprovar(old.id, old.conteudo_hash.slice(0, 12), 'local:synthetic-owner'));
  await f.process(f.receive('Após a retomada, confira o segundo documento sintético.'));
  const fresh = f.proposals().find(p => p.id !== old.id);
  assert.ok(fresh);
  assert.equal(fresh.estado, 'pendente', 'Resume does not approve the freshly prepared version');
  assert.notEqual(fresh.conteudo_hash, old.conteudo_hash);
  assert.equal(fresh.aprovada_por, null);
  assert.equal(f.pessoal.proposta(old.id).estado, 'cancelada');
  await f.pessoal.tick();
  f.assertNoDispatch();
});
