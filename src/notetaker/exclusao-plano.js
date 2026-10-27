import { createHash } from 'node:crypto';
import { construirRecorteInterno } from './direitos-selecao.js';
import { PK_EXCLUSAO, validarSchemaExclusao } from './exclusao-schema.js';

const fail = (code='INTEGRIDADE') => { throw Object.assign(new Error('Não foi possível montar o plano privado.'), { code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
function collectLimited(statement, budget) {
  const collected=[];
  for(const row of statement.iterate()){
    const rowBytes=Buffer.byteLength(JSON.stringify(row));
    if(rowBytes>budget.maxBytesLinha||budget.linhas+1>budget.maxLinhas||budget.bytes+rowBytes>budget.maxBytesTotal)
      throw Object.assign(new Error('Expansão do plano acima do limite.'),{code:'LIMITE'});
    budget.linhas++;budget.bytes+=rowBytes;collected.push(row);
  }
  return collected;
}

function rowsByTable(rows, aux) {
  const result = new Map();
  for (const source of [rows, aux]) for (const [name, list] of Object.entries(source ?? {})) {
    if (!result.has(name)) result.set(name, []);
    result.get(name).push(...list);
  }
  return result;
}
function pkTuple(row, columns) {
  const values = columns.map(name => row[name]);
  if (values.some(value => value === undefined || value === null)) fail();
  return values;
}
function tupleKey(tuple) { return JSON.stringify(tuple); }
function sortTuples(values) { return values.sort((a,b)=>tupleKey(a).localeCompare(tupleKey(b))); }

function buildTables(db, base) {
  const selected = rowsByTable(base.rows, base.aux), events = new Set((base.rows.eventos ?? []).map(x=>x.id));
  const actions = new Set((base.rows.lume_acoes ?? []).filter(x=>events.has(x.evento_id)).map(x=>x.id));
  const contexts = new Set((base.rows.lume_execucao_contextos ?? []).map(x=>x.id));
  const executions = new Set((base.rows.lume_execucoes ?? []).map(x=>x.id));
  const businesses = new Set((base.rows.desktop_negocios ?? []).map(x=>x.id));
  const projectSources = base.rows.lume_projetos_fontes ?? [];
  const selectedProjects = new Map((base.rows.lume_projetos_comerciais ?? []).map(p=>[p.id,p]));
  const deletedProjects = new Set();
  for (const [id, project] of selectedProjects) {
    const links = projectSources.filter(x=>x.projeto_id===id);
    const selectedBase = links.some(x=>events.has(x.evento_id)&&x.base===1);
    if (selectedBase) deletedProjects.add(id);
  }
  const commands = new Set((base.rows.lume_comandos ?? []).filter(x=>events.has(x.evento_id)).map(x=>x.id));
  const noteConversations = selected.get('conversas_app') ?? [];
  const budget={...base.orcamento};
  const selectedAssociations=base.rows.lume_tags_entidades??[];
  const externalAssociations=selectedAssociations.length?collectLimited(db.prepare(`SELECT e.* /* c0:external-associations */ FROM lume_tags_entidades e
    WHERE EXISTS (SELECT 1 FROM lume_tags_entidades a JOIN d3_comandos c ON c.id=a.comando_id WHERE a.tag_id=e.tag_id)
      AND NOT EXISTS (SELECT 1 FROM d3_comandos c WHERE c.id=e.comando_id)
    ORDER BY e.tag_id,e.entidade_tipo,e.entidade_id,e.comando_id`),budget):[];
  const externalCommandsByTag = new Set(externalAssociations.map(x=>x.tag_id));
  const selectedContexts=base.rows.lume_execucao_contextos??[];
  const reboundActions=selectedContexts.length?collectLimited(db.prepare(`SELECT a.* FROM lume_acoes a
    WHERE EXISTS (SELECT 1 FROM lume_execucao_contextos cx JOIN d3_contextos c ON c.id=cx.id WHERE cx.acao_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM d3_eventos e WHERE e.id=a.evento_id)
    ORDER BY a.id`),budget):[];
  const reboundHistory=reboundActions.length?collectLimited(db.prepare(`SELECT h.* FROM lume_acoes_historico h
    WHERE EXISTS (SELECT 1 FROM lume_execucao_contextos cx JOIN d3_contextos c ON c.id=cx.id
      JOIN lume_acoes a ON a.id=cx.acao_id WHERE h.acao_id=a.id
        AND NOT EXISTS (SELECT 1 FROM d3_eventos e WHERE e.id=a.evento_id))
    ORDER BY h.acao_id,h.id`),budget):[];
  selected.set('lume_acoes',[...(selected.get('lume_acoes')??[]),...reboundActions]);
  selected.set('lume_acoes_historico',[...(selected.get('lume_acoes_historico')??[]),...reboundHistory]);
  selected.set('lume_tags_entidades',[...(selected.get('lume_tags_entidades')??[]),...externalAssociations]);

  const custom = new Map();
  const put = (name, remove=[], preserve=[]) => custom.set(name,{remove,preserve});
  const removeBy = (name, predicate) => (selected.get(name) ?? []).filter(predicate);
  const preserveBy = (name, predicate) => (selected.get(name) ?? []).filter(predicate);
  put('lume_acoes', removeBy('lume_acoes',x=>actions.has(x.id)), preserveBy('lume_acoes',x=>!actions.has(x.id)));
  put('lume_acoes_historico', removeBy('lume_acoes_historico',x=>actions.has(x.acao_id)), preserveBy('lume_acoes_historico',x=>!actions.has(x.acao_id)));
  put('lume_execucao_contextos', [...(base.rows.lume_execucao_contextos??[])], []);
  put('lume_execucao_contexto_guardas', removeBy('lume_execucao_contexto_guardas',x=>contexts.has(x.contexto_id)), preserveBy('lume_execucao_contexto_guardas',x=>!contexts.has(x.contexto_id)));
  put('lume_execucao_contexto_grants', removeBy('lume_execucao_contexto_grants',x=>contexts.has(x.contexto_id)), preserveBy('lume_execucao_contexto_grants',x=>!contexts.has(x.contexto_id)));
  put('lume_execucoes', removeBy('lume_execucoes',x=>contexts.has(x.contexto_id)), preserveBy('lume_execucoes',x=>!contexts.has(x.contexto_id)));
  put('lume_execucao_eventos', removeBy('lume_execucao_eventos',x=>executions.has(x.execucao_id)), preserveBy('lume_execucao_eventos',x=>!executions.has(x.execucao_id)));
  put('desktop_tarefas_sugestoes', [...(base.rows.desktop_tarefas_sugestoes??[])], []);
  put('desktop_tarefas_fontes', [...(base.rows.desktop_tarefas_fontes??[])], []);
  const targetPairs=new Set((base.rows.eventos??[]).map(e=>JSON.stringify([e.conversa_id,e.origem_id])));
  const deletedItems=new Set((selected.get('itens_crm')??[]).filter(x=>targetPairs.has(JSON.stringify([x.conversa_id,x.origem_id]))).map(x=>x.id));
  put('itens_crm', removeBy('itens_crm',x=>deletedItems.has(x.id)), preserveBy('itens_crm',x=>!deletedItems.has(x.id)));
  put('rascunhos', removeBy('rascunhos',x=>deletedItems.has(x.item_id)), preserveBy('rascunhos',x=>!deletedItems.has(x.item_id)));
  put('desktop_negocios', removeBy('desktop_negocios',x=>events.has(x.evento_id)), preserveBy('desktop_negocios',x=>!events.has(x.evento_id)));
  put('desktop_negocios_historico', removeBy('desktop_negocios_historico',x=>businesses.has(x.negocio_id)), preserveBy('desktop_negocios_historico',x=>!businesses.has(x.negocio_id)));
  put('lume_projetos_comerciais', removeBy('lume_projetos_comerciais',x=>deletedProjects.has(x.id)), preserveBy('lume_projetos_comerciais',x=>!deletedProjects.has(x.id)));
  put('lume_projetos_fontes', removeBy('lume_projetos_fontes',x=>deletedProjects.has(x.projeto_id)||events.has(x.evento_id)), preserveBy('lume_projetos_fontes',x=>!deletedProjects.has(x.projeto_id)&&!events.has(x.evento_id)));
  put('lume_projetos_historico', removeBy('lume_projetos_historico',x=>deletedProjects.has(x.projeto_id)), preserveBy('lume_projetos_historico',x=>!deletedProjects.has(x.projeto_id)));
  put('lume_comandos', removeBy('lume_comandos',x=>commands.has(x.id)), preserveBy('lume_comandos',x=>!commands.has(x.id)));
  put('lume_comando_tarefas', removeBy('lume_comando_tarefas',x=>commands.has(x.comando_id)), preserveBy('lume_comando_tarefas',x=>!commands.has(x.comando_id)));
  put('lume_comando_lembretes', removeBy('lume_comando_lembretes',x=>commands.has(x.comando_id)), preserveBy('lume_comando_lembretes',x=>!commands.has(x.comando_id)));
  put('lume_tags_entidades', removeBy('lume_tags_entidades',x=>commands.has(x.comando_id)), preserveBy('lume_tags_entidades',x=>!commands.has(x.comando_id)));
  put('lume_tags', removeBy('lume_tags',x=>!externalCommandsByTag.has(x.id)), preserveBy('lume_tags',x=>externalCommandsByTag.has(x.id)));
  const affectedLinks = collectLimited(db.prepare(`SELECT fonte_id,derivado_id FROM priv_vinculos
    WHERE EXISTS (SELECT 1 FROM d3_eventos e WHERE e.id=priv_vinculos.fonte_id)
       OR EXISTS (SELECT 1 FROM d3_eventos e WHERE e.id=priv_vinculos.derivado_id)
    ORDER BY fonte_id,derivado_id`),budget);
  put('priv_vinculos', affectedLinks, []);
  const deletedProjectSources=new Set((projectSources??[]).filter(x=>deletedProjects.has(x.projeto_id)||events.has(x.evento_id)).map(x=>x.id));
  put('lume_projetos_importados_guardas', removeBy('lume_projetos_importados_guardas',x=>deletedProjectSources.has(x.fonte_id)), preserveBy('lume_projetos_importados_guardas',x=>!deletedProjectSources.has(x.fonte_id)));
  put('conversas_app', [], noteConversations);
  for (const name of ['notetaker_sessoes','notetaker_partes','notetaker_trechos','notetaker_fontes','notetaker_correcoes','eventos',
    'transcricoes','eventos_financeiros','desktop_tarefas_analises','etapas','desktop_vetores','f10_procedencias',
    'lume_ciclo_importacoes','lume_projetos_revisoes','lume_laya_fila','caixas_jobs','wa_recuperacoes','lume_vendas_avaliacoes']) {
    const list = selected.get(name) ?? [];
    if (name === 'eventos' || name === 'notetaker_sessoes' || name === 'notetaker_partes' || name === 'notetaker_trechos' || name === 'notetaker_fontes' || name === 'notetaker_correcoes') put(name,list,[]);
    else if (['f10_procedencias','lume_ciclo_importacoes','caixas_jobs','wa_recuperacoes','lume_vendas_avaliacoes'].includes(name)) put(name,[],list);
    else put(name,list,[]);
  }
  // Empty families remain explicit, so the plan has one stable closed table schema.
  const tabelas=Object.keys(PK_EXCLUSAO).sort().map(name=>{
    const columns=PK_EXCLUSAO[name], chosen=custom.get(name) ?? {remove:selected.get(name)??[],preserve:[]};
    const remover=sortTuples(chosen.remove.map(x=>pkTuple(x,columns)));
    const preservar=sortTuples(chosen.preserve.map(x=>pkTuple(x,columns)));
    const removedKeys=new Set(remover.map(tupleKey));
    if(preservar.some(x=>removedKeys.has(tupleKey(x))))fail();
    return {nome:name,pk:[...columns],remover,preservar};
  });
  return {tabelas,privateExtra:{reboundActions,reboundHistory,externalAssociations}};
}

/** Read-only plan. Caller owns the transaction and its profile lease. */
export function montarPlanoExclusao(db, { sessaoId, ...opcoesPerfil } = {}) {
  if (!db?.isTransaction) fail('CONFLITO');
  if (db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name IN ('d3_eventos','d3_acoes','d3_contextos','d3_sugestoes','d3_projetos','d3_comandos','d3_hashes') LIMIT 1").get()) fail('CONFLITO');
  const savepoint='lume_c0_delete_plan';
  db.exec(`SAVEPOINT ${savepoint}`);
  let settled=false;
  try {
    const base=construirRecorteInterno(db,sessaoId,opcoesPerfil);
    if(base.orcamento.linhas>base.orcamento.maxLinhas||base.orcamento.bytes>base.orcamento.maxBytesTotal)
      throw Object.assign(new Error('Recorte inicial acima do limite.'),{code:'LIMITE'});
    const schemaAssinatura=validarSchemaExclusao(db);
    const {tabelas,privateExtra}=buildTables(db,base);
    const arquivos=(base.rows.notetaker_partes??[]).map(p=>({parteId:p.id,nome:p.caminho,sha256:p.sha256}));
    const conversaMetadataBlocked=(base.rows.conversas_app??[]).length>0;
    const impactos=[...base.mapa.impactos.map(x=>({...x})),...(conversaMetadataBlocked?
      [{classe:'metadado_conversa',efeito:'preservar_conversa_sem_regra_de_exclusao'}]:[])];
    const bloqueios={exportacao:base.mapa.bloqueios.exportacao.map(x=>({...x})),exclusao:[
      ...base.mapa.bloqueios.exclusao.map(x=>({...x})),...(conversaMetadataBlocked?
        [{classe:'nota_sem_regra',motivo:'metadado_conversa_preservado'}]:[])
    ]};
    const assinatura=digest({base:base.mapa.assinatura,privateRows:base.rows,privateAux:base.aux,privateExtra,tabelas,arquivos,impactos,bloqueios,schemaAssinatura});
    const plan=deepFreeze({schema:1,sessaoId,revisao:base.mapa.revisao,assinatura,schemaAssinatura,tabelas,arquivos,impactos,bloqueios});
    db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); settled=true;
    return plan;
  } catch (error) {
    try { if(!settled)db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); } catch {}
    if (['ENTRADA','FECHADO','DIREITO','AUSENTE','CONFLITO','INTEGRIDADE','LIMITE'].includes(error?.code)) throw error;
    fail();
  }
}
