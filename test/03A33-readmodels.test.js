import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {registrarPessoa} from '../src/pessoas.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {ExecucoesLume} from '../src/execucao/servico.js';

const now=new Date('2026-09-27T15:00:00Z');
function env(t){
  const db=abrirBanco(':memory:');t.after(()=>db.close());
  const p=perfilGrafo(db),acoes=new AcoesLume(db,{agora:()=>now});
  const person=(id,nome)=>registrarPessoa(db,{identificador:id,nomeCru:nome,origem:'manual'});
  const source=(conversation,author,date,text='Combinamos preparar a revisão amanhã.')=>{
    p.conversa(conversation);
    return p.evento(conversation,author,{dia:date,texto:text,permissao:'dirigida'});
  };
  const action=(conversation,eventId,summary='Preparar revisão')=>{
    acoes.autorizar({conversa:conversation,permitida:true});
    acoes.registrar({eventoId:eventId,candidatas:[{fonte:'E'+eventId,tipo:'compromisso',resumo:summary,trecho:'Combinamos preparar a revisão amanhã.',prazo_citado:''}]});
    const item=acoes.listar({estado:'sugerido',conversa:conversation})[0];
    acoes.revisar({id:item.id,acao:'confirmar'});
    return item.id;
  };
  return{db,p,acoes,person,source,action};
}

test('03A33 F18: sete dias móveis, prioridade da fonte confirmada e identidade exata',t=>{
  const e=env(t);
  e.person('ana1@lid','Ana');e.person('ana2@lid','Ana');e.person('bia@lid','Bia');
  const old=e.source('ana1@lid','ana1@lid','2026-09-15');
  const fresh=e.source('ana1@lid','ana1@lid','2026-09-26');
  e.source('ana2@lid','ana2@lid','2026-09-27');
  e.source('bia@lid','bia@lid','2026-09-27');e.source('bia@lid','bia@lid','2026-09-27');
  e.action('ana1@lid',fresh);
  const result=e.p.desktop.contatos({periodo:'semana',agora:now});
  assert.equal(result.periodo,'semana');
  assert.equal(result.janela.inicio,'2026-09-20T15:00:00.000Z');
  assert.equal(result.contatos[0].nome,'Ana');
  assert.equal(result.contatos[0].compromissoPendenteComprovado,true);
  assert.equal(result.contatos[0].compromissoFonteId,fresh);
  assert.equal(result.contatos[0].mensagensPeriodo,1);
  assert.equal(result.contatos[0].fonteId,fresh);
  assert.equal(result.contatos[1].mensagensPeriodo,2);
  assert.equal(new Set(result.contatos.filter(c=>c.nome==='Ana').map(c=>c.id)).size,2);
  assert.notEqual(result.contatos[2].fonteId,old);
});

test('03A33 F18: mensagem própria em grupo e nome igual não atribuem compromisso',t=>{
  const e=env(t);e.person('ana@lid','Ana');e.person('bia@lid','Ana');
  const group='time@g.us';e.p.conversa(group);
  const own=e.source(group,'eu@lid','2026-09-27');e.db.prepare('UPDATE eventos SET autor_e_dono=1 WHERE id=?').run(own);
  e.action(group,own);
  const direct=e.source('ana@lid','ana@lid','2026-09-27');
  e.source(group,'bia@lid','2026-09-27');
  const result=e.p.desktop.contatos({periodo:'semana',agora:now});
  assert.ok(result.contatos.every(c=>c.compromissoPendenteComprovado===false));
  assert.equal(result.contatos.find(c=>c.nome==='Ana'&&c.fonteId===direct)?.mensagensPeriodo,1);
});

test('03A33 F08: ações projetam execução em lote e invalidada fecha novo Resolver',t=>{
  const e=env(t),id=e.source('ana@lid','ana@lid','2026-09-27');
  const actionId=e.action('ana@lid',id);
  const service=new ExecucoesLume(e.db,{agora:()=>now});e.acoes.definirExecucoes(service);
  assert.equal(e.acoes.listar({estado:'ativos'})[0].execucao_ui.estado,'nenhuma');
  const contextId=service.preparar({acao_id:actionId}).contexto.id;
  const executionId=service.iniciar({contexto_id:contextId,assistente:'claude',confirmar:true,chave_idempotencia:'03A33-start'}).execucao.id;
  assert.equal(e.acoes.listar({estado:'ativos'})[0].execucao_ui.estado,'aguardando_assistente');
  service.registrar('inicio',{execucao_id:executionId,chave_idempotencia:'03A33-begin'});
  let item=e.acoes.listar({estado:'ativos'})[0];
  assert.equal(item.execucao_ui.estado,'em_andamento');
  assert.equal(item.execucao_ui.id,executionId);
  const detached=new AcoesLume(e.db,{agora:()=>now});
  assert.equal(detached.listar({estado:'ativos'})[0].execucao_ui.estado,'indisponivel');
  e.db.prepare('UPDATE lume_execucao_contexto_guardas SET invalidada_em=?,motivo=? WHERE contexto_id=?').run(now.toISOString(),'fonte alterada',contextId);
  item=e.acoes.listar({estado:'ativos'})[0];
  assert.equal(item.execucao_ui.estado,'invalidada');
  assert.ok(!JSON.stringify(item.execucao_ui).includes('Combinamos'));
  assert.equal(service.resumoParaAcoes([actionId])[0].estado,'invalidada');
  assert.throws(()=>service.resumoParaAcoes([actionId,actionId]),{code:'INVALID_INPUT'});
});

test('03A33 F08: fonte alterada não vira ausência de execução e retorno requer conferência',t=>{
  const e=env(t),id=e.source('ana@lid','ana@lid','2026-09-27');const actionId=e.action('ana@lid',id);
  const service=new ExecucoesLume(e.db,{agora:()=>now});e.acoes.definirExecucoes(service);
  const contextId=service.preparar({acao_id:actionId}).contexto.id;
  const executionId=service.iniciar({contexto_id:contextId,assistente:'claude',confirmar:true,chave_idempotencia:'03A33-start2'}).execucao.id;
  service.registrar('resultado',{execucao_id:executionId,chave_idempotencia:'03A33-result',resumo:'Revisão entregue para conferir.',artefatos:[]});
  assert.equal(service.resumoParaAcoes([actionId])[0].estado,'resultado_informado');
  service.registrar('verificacao',{execucao_id:executionId,chave_idempotencia:'03A33-check',confirmar:true,nota:'Conferi o material entregue.'});
  assert.equal(service.resumoParaAcoes([actionId])[0].estado,'verificado');
  e.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte modificada.',id);
  assert.equal(service.resumoParaAcoes([actionId])[0].estado,'indisponivel');
});

test('03A33 F08: revogação, contexto importado e prazo expirado ficam fechados',t=>{
  const e=env(t),id=e.source('ana@lid','ana@lid','2026-09-27');const actionId=e.action('ana@lid',id);
  let current=now;
  const service=new ExecucoesLume(e.db,{agora:()=>current,revisaoConector:client=>client==='claude-desktop'?'revision-03A33':null});
  e.acoes.definirExecucoes(service);
  const contextId=service.preparar({acao_id:actionId}).contexto.id;
  const executionId=service.iniciar({contexto_id:contextId,assistente:'claude',confirmar:true,chave_idempotencia:'03A33-time',manter_contexto:true}).execucao.id;
  current=new Date(now.getTime()+8*86400000);
  assert.equal(service.resumoParaAcoes([actionId])[0].estado,'expirada');
  current=now;
  service.revogar({execucao_id:executionId,confirmar:true});
  assert.equal(service.resumoParaAcoes([actionId])[0].estado,'revogada');
  e.db.exec('CREATE TABLE IF NOT EXISTS lume_ciclo_importacoes(tabela TEXT,registro_id TEXT,backup_sha256 TEXT,importado_em TEXT)');
  e.db.prepare('INSERT INTO lume_ciclo_importacoes(tabela,registro_id) VALUES(?,?)').run('lume_execucao_contextos',contextId);
  assert.equal(service.resumoParaAcoes([actionId])[0].estado,'indisponivel');
});
