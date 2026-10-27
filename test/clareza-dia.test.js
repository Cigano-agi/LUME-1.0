import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ClarezaDia} from '../src/clareza-dia.js';
import {assinaturaFonte} from '../src/tarefas-esquema.js';
import {LEITURA_SQL, LEITURA_PESSOAL_SQL} from '../src/leitura-sql.js';
import {chaveExclusao} from '../src/exclusoes.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
import {registrarPessoa} from '../src/pessoas.js';

function ambiente(t, options = {}) {
  const db = abrirBanco(); t.after(() => db.close());
  const perfil = perfilBeta05(db, options);
  return {db, ...perfil, clareza: new ClarezaDia(db, {desktop: perfil.desktop, agora: () => perfil.agora})};
}
function sugestao(e, fonte, {id = 'sugestao-demo', item = null, estado = 'pendente'} = {}) {
  e.db.prepare(`INSERT INTO desktop_tarefas_sugestoes(id,evento_id,tipo,resumo,trecho,prazo_citado,fontes_total,criada_em,estado,item_id)
    VALUES(?,?,'pendencia','Revisar documentos','Revisar documentos com cuidado','amanhã',1,?,?,?)`)
    .run(id, fonte.id, e.agora.toISOString(), estado, item);
  const registro = e.db.prepare('SELECT * FROM desktop_fontes WHERE id=?').get(fonte.id);
  e.db.prepare('INSERT INTO desktop_tarefas_fontes VALUES(?,?,?)').run(id, fonte.id, assinaturaFonte(registro));
}

test('clareza: vazio orienta primeiro passo sem inventar mensagens, progresso ou dinheiro', t => {
  const e = ambiente(t, {vazio: true}), r = e.clareza.resumo();
  assert.equal(r.cobertura.estado, 'sem-dados'); assert.equal(r.cobertura.ultimaMensagemEm, null);
  assert.equal(r.foco.fonteId, null); assert.equal(r.foco.acao, 'abrir-conversas');
  assert.equal(r.prioridades.total, 0); assert.equal(r.oportunidades.total, 0);
  assert.equal(r.oportunidades.valorCentavos, 0); assert.deepEqual(r.conversas.itens, []);
  assert.equal(r.revisao.total, 0); assert.equal(r.pratica.fonteId, null);
  assert.equal(r.dia, '2026-09-23');
});

test('clareza: retrato jurídico mostra ações com fonte e valores abertos separados de recebimento', t => {
  const e = ambiente(t), r = e.clareza.resumo();
  assert.equal(r.prioridades.total, 3); assert.equal(r.prioridades.itens[0].tipo, 'compromisso');
  assert.equal(r.prioridades.itens[0].quando, '2026-09-24T10:00:00-03:00');
  assert.equal(r.foco.fonteId, e.fontes.ana.id); assert.equal(r.pratica.fonteId, e.fontes.ana.id);
  assert.equal(r.oportunidades.total, 2); assert.equal(r.oportunidades.valorCentavos, 350000);
  assert.equal(r.oportunidades.semValor, 1); assert.match(r.oportunidades.aviso, /Não representam honorários recebidos/);
  assert.equal(r.cobertura.mensagens, 4); assert.equal(r.conversas.itens.length, 4);
  for (const p of r.prioridades.itens) assert.equal(e.desktop.fonte(p.fonteId).conversa_id, p.conversaId);
});

test('clareza: snapshot é somente leitura e não completa tarefas nem concede permissões', t => {
  const e = ambiente(t), antes = e.db.prepare('SELECT total_changes() n').get().n;
  const r = e.clareza.resumo(); e.clareza.resumo();
  assert.equal(e.db.prepare('SELECT total_changes() n').get().n, antes);
  assert.equal(e.db.prepare("SELECT count(*) n FROM itens_crm WHERE estado='aberto'").get().n, 3);
  assert.equal(r.prioridades.total, 3);
});

test('clareza: revogação retira fonte, nome, proposta e valor de todas as seções', t => {
  const e = ambiente(t), fonte = e.mensagem({conversa: 'secreto', nome: 'NOME_SIGILOSO', texto: 'TEXTO_SIGILOSO'});
  e.tarefa(fonte, {titulo: 'TAREFA_SIGILOSA', tipo: 'compromisso'});
  e.negocio(fonte, {titulo: 'NEGOCIO_SIGILOSO', valor_centavos: 999999});
  e.db.prepare("UPDATE eventos SET permissao='compartilhado' WHERE id=?").run(fonte.id);
  const r = e.clareza.resumo(); assert.equal(r.oportunidades.valorCentavos, 350000);
  assert.equal(r.prioridades.total, 3); assert.equal(r.cobertura.mensagens, 4);
  assert.doesNotMatch(JSON.stringify(r), /SIGILOS[OA]/);
  e.db.prepare("INSERT INTO politicas_conversa VALUES('secreto','tudo',?)").run(e.agora.toISOString());
  assert.doesNotMatch(JSON.stringify(e.clareza.resumo()), /SIGILOS[OA]/);
});

test('clareza: fonte alterada exclui proposta antiga e sugestões obsoletas sem expor campos', t => {
  const e = ambiente(t, {vazio: true}), fonte = e.mensagem({texto: 'Revisar documentos com cuidado'});
  e.negocio(fonte, {titulo: 'PROPOSTA_OBSOLETA', valor_centavos: 990000});
  const item = e.tarefa(fonte, {titulo: 'TAREFA_OBSOLETA'});
  sugestao(e, fonte, {estado: 'aceita', item});
  assert.equal(e.clareza.resumo().prioridades.total, 1);
  e.db.prepare("UPDATE eventos SET texto='A proposta anterior foi substituída. Confira o escopo novo.' WHERE id=?").run(fonte.id);
  const r = e.clareza.resumo();
  assert.equal(r.oportunidades.total, 0); assert.equal(r.oportunidades.valorCentavos, 0);
  assert.equal(r.oportunidades.totalRevisoes, 1); assert.equal(r.prioridades.total, 0);
  assert.doesNotMatch(JSON.stringify(r), /OBSOLETA|990000/);
});

test('clareza: concluídos e negócios encerrados não viram próximos passos ou receita', t => {
  const e = ambiente(t, {vazio: true});
  for (const estado of ['resolvido', 'expirado']) {
    const fonte = e.mensagem(); e.tarefa(fonte, {estado, titulo: 'TAREFA_FORA'});
  }
  for (const etapa of ['fechado', 'encerrado']) e.negocio(e.mensagem(), {etapa, titulo: 'NEGOCIO_FORA', valor_centavos: 700000});
  const r = e.clareza.resumo(); assert.equal(r.prioridades.total, 0);
  assert.equal(r.oportunidades.total, 0); assert.equal(r.oportunidades.valorCentavos, 0);
  assert.doesNotMatch(JSON.stringify(r), /TAREFA_FORA|NEGOCIO_FORA/);
});

test('clareza: revisão conta somente sugestões atuais e não converte prazo citado em compromisso', t => {
  const e = ambiente(t, {vazio: true}), fonte = e.mensagem({texto: 'Revisar documentos com cuidado'});
  sugestao(e, fonte); let r = e.clareza.resumo();
  assert.equal(r.revisao.total, 1); assert.equal(r.prioridades.total, 0);
  assert.doesNotMatch(JSON.stringify(r), /amanhã/);
  e.db.prepare("UPDATE eventos SET texto='Contexto corrigido' WHERE id=?").run(fonte.id);
  assert.equal(e.clareza.resumo().revisao.total, 0);
});

test('clareza: idade pertence à mensagem e conversa recente não significa não lida', t => {
  const e = ambiente(t, {vazio: true, agora: new Date('2026-09-24T01:00:00Z')});
  const nova = e.mensagem({data: '2026-09-23T22:00:00Z', texto: 'Texto recente'});
  e.mensagem({data: '2020-01-01T12:00:00Z', texto: 'Histórico importado depois'});
  let r = e.clareza.resumo(); assert.equal(r.dia, '2026-09-23');
  assert.equal(r.cobertura.idadeHoras, 3); assert.equal(r.conversas.itens[0].fonteId, nova.id);
  assert.match(r.cobertura.aviso, /não da última sincronização/);
  assert.equal(Object.hasOwn(r.cobertura, 'conectado'), false);
  assert.equal(Object.hasOwn(r.conversas.itens[0], 'naoLidas'), false);
  e.clareza.agora = () => new Date('2026-10-01T00:00:00Z');
  r = e.clareza.resumo(); assert.equal(r.cobertura.estado, 'antiga');
  assert.equal(r.conversas.itens[0].trecho, 'Texto recente');
});

test('clareza: lista curta preserva totais completos e prazo livre fica literal', t => {
  const e = ambiente(t, {vazio: true});
  for (let i = 0; i < 8; i++) {
    const fonte = e.mensagem({conversa: 'c' + i, nome: 'Demo ' + i});
    e.tarefa(fonte, {quando: 'depois de receber os documentos'});
    e.negocio(fonte, {valor_centavos: 10000});
  }
  const r = e.clareza.resumo(); assert.equal(r.prioridades.total, 8);
  assert.equal(r.prioridades.itens.length, 3); assert.equal(r.oportunidades.total, 8);
  assert.equal(r.oportunidades.valorCentavos, 80000); assert.equal(r.oportunidades.itens.length, 3);
  assert.equal(r.conversas.total, 8); assert.equal(r.conversas.itens.length, 4);
  assert.equal(r.prioridades.itens[0].quando, 'depois de receber os documentos');
});

test('B02: personal reading includes local group and limits imported contribution', t => {
  const e = ambiente(t, {vazio: true});
  e.db.prepare("INSERT INTO conversas_app VALUES('grupo-b02','Grupo de teste')").run();
  const terceiro = e.mensagem({conversa:'grupo-b02', nome:'Grupo de teste', permissao:'terceiro', texto:'Mensagem local do grupo'});
  const importado = e.mensagem({conversa:'grupo-b02', nome:'Grupo de teste', permissao:'compartilhado', texto:'Imported contribution exact'});
  const irmaoImportado = e.mensagem({conversa:'grupo-b02', nome:'Grupo de teste', permissao:'compartilhado', texto:'Outra mensagem do pacote'});
  const dm = e.mensagem({conversa:'dm-b02', nome:'Contato novo', permissao:'dirigida', texto:'Mensagem do contato novo'});
  e.db.prepare("INSERT INTO f10_projetos VALUES('p-b02','Synthetic project',?)").run(e.agora.toISOString());
  e.db.exec("INSERT INTO f10_origens VALUES('origem-b02','Synthetic origin','Synthetic machine','Synthetic key')");
  for (const pacote of ['pacote-a','pacote-b']) e.db.prepare(`INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em)
    VALUES(?,'origem-b02',?,'p-b02',?,?)`).run(importado.id,pacote,e.agora.toISOString(),e.agora.toISOString());
  const ler = sql => e.db.prepare(`SELECT e.id FROM eventos e WHERE ${sql} ORDER BY e.id`).all().map(r=>r.id);
  assert.deepEqual(ler(LEITURA_PESSOAL_SQL), [terceiro.id, importado.id, dm.id]);
  assert.equal(ler(LEITURA_SQL).includes(irmaoImportado.id), false,
    'one imported source does not grant external access to other group messages');
  let r=e.clareza.resumo();
  assert.equal(r.cobertura.mensagens,3);
  assert.equal(r.conversas.total,2);
  assert.equal(r.conversas.itens.some(c=>c.id==='grupo-b02'),true);
  assert.equal(r.conversas.itens.some(c=>c.id==='dm-b02'),true);
  e.db.prepare('INSERT INTO priv_excluidos(hash,excluido_em) VALUES(?,?)')
    .run(chaveExclusao('grupo-b02', terceiro.origem),e.agora.toISOString());
  e.db.prepare('DELETE FROM eventos WHERE id=?').run(terceiro.id);
  r=e.clareza.resumo();
  assert.equal(r.cobertura.mensagens,2);
  assert.equal(r.conversas.itens.find(c=>c.id==='grupo-b02').mensagens,1,
    'deleting this source leaves only the exact imported contribution');
});
test('Desktop somenteAcoes preserva tarefas, comandos, ordem e filtros sem consultar métricas/recentes', t => {
  const e = ambiente(t);
  e.contexto.receber({type:'notify',donoJids:['5511888888888@s.whatsapp.net'],messages:[{
    key:{id:'comando-clareza',remoteJid:'5511999999999@s.whatsapp.net',fromMe:true},
    messageTimestamp:1789732800,message:{conversation:'#lume_tarefa Revisar minuta #revisao'}
  }]});
  assert.ok(e.desktop.resumo().tarefas.some(t=>String(t.id).startsWith('comando:')));
  for (const filtro of [{}, {ordem:'recentes'}, {ordem:'antigas'}, {ordem:'oportunidades'}, {tag:'revisao'}]) {
    const normal=e.desktop.resumo(filtro), rapido=e.desktop.resumo({...filtro,somenteAcoes:true});
    assert.deepEqual(rapido.tarefas,normal.tarefas); assert.deepEqual(rapido.fila,normal.fila);
    assert.equal(Object.hasOwn(rapido,'mensagens'),false); assert.equal(Object.hasOwn(rapido,'recentes'),false);
    assert.equal(Object.hasOwn(normal,'mensagens'),true); assert.equal(Object.hasOwn(normal,'recentes'),true);
  }
  e.desktop.buscar=()=>{throw new Error('Busca de mensagens não deve executar');};
  assert.doesNotThrow(()=>e.desktop.resumo({somenteAcoes:true}));
  assert.throws(()=>e.desktop.resumo({somenteAcoes:'sim'}),/Opção/);
});

test('Hoje troca JIDs sintéticos por rótulos de contato, grupo e canal sem perder fontes nem nomes humanos', async t => {
  const e = ambiente(t, {vazio: true});
  const casos = [
    {id: '000000000000@lid', tipo: 'contato', nome: '000000000000@lid'},
    {id: '000000000000-0000000000@g.us', tipo: 'grupo', nome: '000000000000-0000000000@g.us'},
    {id: '000000000000000000@newsletter', tipo: 'canal', nome: null},
  ];
  const fontes = new Map();
  for (const caso of casos) {
    const fonte = e.mensagem({conversa: caso.id, nome: caso.nome || caso.id,
      texto: `Mensagem sintética de ${caso.tipo}`});
    if (caso.nome === null) e.db.prepare('DELETE FROM conversas_app WHERE id=?').run(caso.id);
    if (caso.tipo === 'grupo') e.db.prepare(`INSERT INTO grupos_app(id,nome,atualizado_em) VALUES(?,?,?)`)
      .run(caso.id, caso.id, e.agora.toISOString());
    e.tarefa(fonte, {titulo: `Conferir ${caso.tipo}`});
    e.negocio(fonte, {titulo: `Proposta ${caso.tipo}`, valor_centavos: null});
    fontes.set(caso.id, fonte.id);
  }
  const humano = e.mensagem({conversa: 'demo-humano', nome: 'Ana Ribeiro · demonstração',
    texto: 'Mensagem sintética com nome confirmado'});
  e.tarefa(humano, {titulo: 'Conferir Ana'});
  e.negocio(humano, {titulo: 'Proposta Ana', valor_centavos: null});
  fontes.set(humano.conversa, humano.id);

  const resumo = e.clareza.resumo();
  assert.equal(resumo.conversas.total, 4);
  assert.equal(resumo.conversas.itens.find(item => item.id === humano.conversa).nome,
    'Ana Ribeiro · demonstração', 'nome humano permanece intacto');
  for (const caso of casos) {
    await t.test(`rótulo de ${caso.tipo} mantém identidade sem mostrar JID`, () => {
      const item = resumo.conversas.itens.find(conversa => conversa.id === caso.id);
      assert.ok(item, `conversa ${caso.tipo} mantém seu ID`);
      assert.equal(item.fonteId, fontes.get(caso.id), `conversa ${caso.tipo} mantém a fonte`);
      assert.match(item.nome, new RegExp(caso.tipo, 'i'), `rótulo de ${caso.tipo} é compreensível`);
      assert.doesNotMatch(item.nome, /@|(?:\d[^\d]*){6,}/, `rótulo de ${caso.tipo} não revela JID`);
    });
  }
  for (const secao of [resumo.prioridades.itens, resumo.oportunidades.itens]) {
    for (const item of secao) {
      assert.equal(item.fonteId, fontes.get(item.conversaId), 'ação e negócio mantêm a fonte exata');
      assert.doesNotMatch(item.conversaNome, /@|(?:\d[^\d]*){6,}/,
        'ação e negócio não exibem identificador interno');
    }
  }
  assert.ok(fontes.has(resumo.foco.conversaId));
  assert.equal(resumo.foco.fonteId, fontes.get(resumo.foco.conversaId));
  assert.doesNotMatch(resumo.foco.descricao, /@|(?:\d[^\d]*){6,}/,
    'destaque principal não exibe identificador interno');
});

test('Hoje usa o nome local conhecido antes de recorrer ao rótulo genérico', t => {
  const e = ambiente(t, {vazio: true});
  const id = '111111111111@lid';
  e.mensagem({conversa: id, nome: id, texto: 'Mensagem sintética sem nome de conversa'});
  registrarPessoa(e.db, {identificador: id, nomeCru: 'Beatriz Exemplo'});
  const item = e.clareza.resumo().conversas.itens[0];
  assert.equal(item.id, id);
  assert.equal(item.nome, 'Beatriz Exemplo');
});
