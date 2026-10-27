import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {AcoesLume} from '../src/acoes-lume.js';

// Independent integration assertions. All sources and derived actions are fictional;
// this does not test extraction or interpretation of later messages.
function setup(t) {
  const db = abrirBanco(':memory:');
  t.after(() => db.close());
  const profile = perfilGrafo(db), actions = new AcoesLume(db);
  const add = (conversation, text = 'Prepare o relatório da revisão.') => {
    profile.conversa(conversation);
    actions.autorizar({conversa: conversation, permitida: true});
    const event = profile.evento(conversation, 'autor-ficticio', {texto: text});
    actions.registrar({eventoId: event, candidatas: [{fonte: `E${event}`, tipo: 'pendencia',
      resumo: text, trecho: text, prazo_citado: ''}]});
    return {event, id: db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(event).id};
  };
  return {db, ...profile, actions, add};
}

test('audit: duas ações da mesma fonte não são fundidas na contagem de Conversas', t => {
  const f = setup(t), first = f.add('duas', 'Prepare o relatório. Confirme a reunião.');
  f.actions.registrar({eventoId: first.event, candidatas: [
    {fonte: `E${first.event}`, tipo: 'pendencia', resumo: 'Outra ação', trecho: 'Confirme a reunião.', prazo_citado: ''},
  ]});
  assert.equal(f.desktop.conversaDetalhe({conversa: 'duas'}).acoes, 2);
  assert.equal(f.desktop.carteira({filtro: 'acoes'}).conversas[0].acoes, 2);
});

test('audit: consulta exata com caracteres SQL não puxa ações de outra conversa', t => {
  const f = setup(t), exact = f.add('dm%_');
  f.add('dmAB'); f.add("dm' OR 1=1 --");
  assert.deepEqual(f.actions.listar({estado: 'ativos', conversa: 'dm%_'}).map(a => a.id), [exact.id]);
  assert.deepEqual(f.actions.listar({estado: 'ativos', conversa: 'inexistente'}), []);
  assert.equal(f.desktop.conversaDetalhe({conversa: 'dm%_'}).acoes, 1);
});

test('audit: registros legados e atuais permanecem contados sem promover lead', t => {
  const f = setup(t), source = f.add('mista');
  const event = f.db.prepare('SELECT * FROM eventos WHERE id=?').get(source.event);
  f.db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em)
    VALUES(?,?,'lead','Oportunidade fictícia','2026-09-26')`).run(event.conversa_id, event.origem_id);
  const detail = f.desktop.conversaDetalhe({conversa: 'mista'});
  assert.equal(detail.acoes, 2); assert.equal(detail.oportunidades, 1);
  f.actions.revisar({id: source.id, acao: 'confirmar'});
  f.actions.revisar({id: source.id, acao: 'resolver'});
  assert.equal(f.desktop.conversaDetalhe({conversa: 'mista'}).acoes, 1);
  assert.equal(f.desktop.carteira({filtro: 'oportunidades'}).conversas[0].oportunidades, 1);
});

test('audit: estacionada futura não conta; vencida conta sem virar resolvida', t => {
  const f = setup(t), action = f.add('lembrete');
  f.actions.revisar({id: action.id, acao: 'estacionar', lembrarEm: '2199-01-01T12:00:00.000Z', fuso: 'America/Sao_Paulo'});
  assert.equal(f.desktop.conversaDetalhe({conversa: 'lembrete'}).acoes, 0);
  assert.equal(f.desktop.carteira({filtro: 'acoes'}).pagina.total, 0);
  f.db.prepare('UPDATE lume_acoes SET lembrar_em=? WHERE id=?').run('2000-01-01T12:00:00.000Z', action.id);
  assert.equal(f.desktop.conversaDetalhe({conversa: 'lembrete'}).acoes, 1);
  assert.equal(f.actions.obter(action.id).estado, 'estacionado');
});

test('audit: fonte alterada ou autorização removida some também dos números', t => {
  const f = setup(t), first = f.add('restrita'), second = f.add('restrita');
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte alterada no teste.', first.event);
  assert.equal(f.desktop.conversaDetalhe({conversa: 'restrita'}).acoes, 1);
  assert.equal(f.desktop.carteira({filtro: 'acoes'}).conversas[0].acoes, 1);
  f.actions.autorizar({conversa: 'restrita', permitida: false});
  assert.equal(f.desktop.conversaDetalhe({conversa: 'restrita'}).acoes, 0);
  assert.equal(f.desktop.carteira({filtro: 'acoes'}).pagina.total, 0);
  f.actions.autorizar({conversa: 'restrita', permitida: true});
  assert.equal(f.desktop.conversaDetalhe({conversa: 'restrita'}).acoes, 0);
  assert.equal(f.actions.obter(second.id), null);
});

test('audit: procedência compartilhada revogada não deixa contagem residual', t => {
  const f = setup(t), action = f.add('compartilhada');
  f.db.exec(`INSERT INTO f10_projetos VALUES('aud-x','Teste','2026-09-26');
    INSERT INTO f10_origens VALUES('aud-f','Teste','m','k');`);
  f.db.prepare(`UPDATE eventos SET permissao='compartilhado' WHERE id=?`).run(action.event);
  f.db.prepare(`INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em)
    VALUES(?,'aud-f','aud-p','aud-x','2026-09-26','2026-09-26')`).run(action.event);
  // Signatures intentionally follow the source mutation only by registering it again.
  f.actions.registrar({eventoId: action.event, candidatas: [{fonte: `E${action.event}`, tipo: 'pendencia',
    resumo: 'Prepare o relatório da revisão.', trecho: 'Prepare o relatório da revisão.', prazo_citado: ''}]});
  const expected = f.actions.listar({estado: 'ativos', conversa: 'compartilhada'}).length;
  assert.ok(expected > 0);
  assert.equal(f.desktop.conversaDetalhe({conversa: 'compartilhada'}).acoes, expected);
  f.db.prepare('DELETE FROM f10_procedencias WHERE evento_id=?').run(action.event);
  assert.equal(f.desktop.carteira({filtro: 'acoes'}).pagina.total, 0);
  assert.deepEqual(f.actions.listar({estado: 'ativos', conversa: 'compartilhada'}), []);
});
