// Independent adversarial review. Synthetic sources, in-memory SQLite, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO} from '../src/pessoal/organizador.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';
import {CATALOGO_V9} from '../src/backup-acervo-catalogo.js';
import {resumoAcoesLume} from '../src/acoes-lume.js';
import {LumeMcpReadService} from '../src/mcp/read-service.js';
import {Privacidade} from '../src/privacidade.js';
import {prepararExecucoes} from '../src/execucao/esquema.js';
import {comLeituraOrganizacao,fonteOrganizacao} from '../src/pessoal/organizacao-validade.js';
const GROUP='550000007001@g.us',MODEL='independent-synthetic';
const blank=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]});
function fixture(t,{realQueue=false}={}){
 const db=abrirBanco(),context=new ContextoApp(db),now=new Date('2026-10-28T12:00:00Z');let seq=0,receiptSeq=0,handler=()=>blank();
 new Desktop(db).aceitar({nome:'Independent synthetic review',aceito:true,versao:VERSAO_TERMOS});
 const org=new OrganizadorConversas(db,{agora:()=>now,chatgpt:{estado:async()=>({connected:true,planEnabled:true,paused:false,model:MODEL}),responder:async r=>({completed:true,model:MODEL,requestId:'synthetic-'+(++receiptSeq),text:JSON.stringify(await handler(JSON.parse(r.input[0].content),r))})}});
 db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(GROUP,'Synthetic review group');org.configurarEscopo({escopo:'todas',confirmar:true});
 org.aprovarAvaliacao({modelo:MODEL,total:100,acertos:100,criticos:20,errosCriticos:0,contrato:CONTRATO_ORGANIZACAO,evidencia:'SYNTHETIC TEST ONLY',revisor:'independent fixture'});org.configurar({acao:'retomar'});
 t.after(async()=>{await org.encerrar();db.close();});
 return {db,org,handler(fn){handler=fn;},add(text,permission='dirigida'){
  // Security cases isolate one runnable target while retaining real authorized
  // context. Queue-order cases opt out and exercise the untouched scheduler.
  if(!realQueue&&seq){org.capturar();db.prepare("UPDATE etapas SET proxima_tentativa_em='2026-10-29T12:00:00Z' WHERE etapa='organizacao_chatgpt' AND estado IN('pendente','falha')").run();}
  return context._registrarEvento({conversaId:GROUP,origemId:'synthetic-'+(++seq),autorId:'550000007099@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:now},permission).id;
 },project(id,text,name='Aurora'){return org.projetos.criarRascunho({nome:name,natureza:'incerto',fontes:[{eventoId:id,trecho:text}]}).id;}};
}
test('review: schema de projetos conserva contrato fechado do backup',t=>{
 const f=fixture(t),actual=f.db.prepare('PRAGMA table_info(lume_projetos_fontes)').all().map(x=>x.name).sort();
 assert.deepEqual(actual,[...CATALOGO_V9.find(x=>x.nome==='lume_projetos_fontes').colunas].sort());
});
test('review: revogar contexto oculta compromissos derivados também na timeline',async t=>{
 const f=fixture(t),prior=f.add('Projeto Aurora: o cliente quer um catálogo de peças.'),target=f.add('Prepare a versão combinada até amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo de peças do projeto Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);assert.ok(f.org.sugestoes(target));
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(prior);assert.equal(f.org.sugestoes(target),null);
 assert.deepEqual(f.org.timeline({conversa:GROUP}).itens.find(x=>x.fonte.eventoId===target).compromissos,[]);
});
test('review: revogar contexto oculta projeto derivado também na timeline',async t=>{
 const f=fixture(t),prior=f.add('O catálogo de peças é para a divisão industrial.'),target=f.add('Projeto Aurora: preparar o catálogo solicitado.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);assert.ok(f.org.sugestoes(target));
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(prior);assert.equal(f.org.sugestoes(target),null);
 assert.deepEqual(f.org.timeline({conversa:GROUP}).itens.find(x=>x.fonte.eventoId===target).projetos,[]);
});
test('review: homônimo sem evidência de continuidade não funde projeto por nome sozinho',async t=>{
 const f=fixture(t),oldText='Projeto Aurora do cliente Alfa: produzir o catálogo.',old=f.add(oldText),oldId=f.project(old,oldText);
 const target=f.add('Outro cliente, Beta, trouxe seu projeto Aurora: desenvolver uma loja virtual independente.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);
 assert.notEqual(f.org.sugestoes(target).vinculos[0]?.projetoId,oldId);
});
test('review: candidato futuro não entra no contexto de mensagem anterior',async t=>{
 const f=fixture(t),target=f.add('Vamos rever a proposta que discutimos ontem.'),futureText='Projeto Aurora: a proposta futura foi criada hoje.',future=f.add(futureText);f.project(future,futureText);
 f.handler(i=>{assert.equal(i.contexto.some(x=>x.eventoId>target),false);assert.equal(i.projetos.length,0);return blank();});
 await f.org.avaliarFonte(target);
});
test('review: desvincular evidência candidata durante chamada invalida resultado',async t=>{
 const f=fixture(t),baseText='Projeto Aurora: preparar o catálogo.',base=f.add(baseText),p=f.project(base,baseText),linkText='A loja virtual agora pertence ao projeto Aurora.',link=f.add(linkText);
 const linked=f.org.projetos.vincularFonte({id:p,eventoId:link,trecho:linkText});const target=f.add('Prepare a loja virtual combinada para amanhã.');
 f.handler((i,r)=>{assert.equal(r.validar(),true);f.org.projetos.desvincularFonte({id:p,fonteId:linked.fonteId});assert.equal(r.validar(),false);return blank();});
 await assert.rejects(f.org.avaliarFonte(target),e=>e.code==='FONTE_ALTERADA');
});
test('review: projeto local de terceiro não se torna legível pelo serviço padrão',t=>{
 const f=fixture(t),text='Projeto Boreal: documentação sintética.',id=f.add(text,'terceiro'),p=f.project(id,text,'Boreal');
 assert.ok(f.org.projetos.obter(p));assert.equal(new ProjetosComerciais(f.db).obter(p),null);
});
test('review: resumo derivado inválido não atravessa serviço direto de ações',async t=>{
 const f=fixture(t),prior=f.add('Projeto Aurora: material confidencial sintético de catálogo.'),target=f.add('Prepare o documento combinado até amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar material de catálogo do projeto Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);const action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(target);
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(prior);assert.equal(f.org.sugestoes(target),null);
 assert.equal(f.org.contexto.acoes.obter(action.id),null);
});
test('review: evidência de outro trecho do mesmo evento não comprova candidato',async t=>{
 const f=fixture(t),a='Projeto Aurora: criar o catálogo.',b='Projeto Boreal: criar a loja virtual.',source=f.add(a+' '+b),p=f.project(source,a),target=f.add('Prepare a loja virtual que combinamos.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',projetoId:p,trecho:i.texto,confianca:.98,evidencias:[{eventoId:source,trecho:b}]}]}));
 const result=await f.org.avaliarFonte(target);assert.deepEqual(result.vinculos,[]);
});
test('review: correção na mensagem-alvo invalida snapshot em voo',async t=>{
 const f=fixture(t),a='Projeto Aurora: catálogo.',base=f.add(a),p=f.project(base,a),target=f.add('Vamos preparar aquele catálogo combinado.');
 f.handler((i,r)=>{assert.equal(r.validar(),true);f.org.corrigirVinculo({eventoId:target,trecho:i.texto,projetoId:p});assert.equal(r.validar(),false);return blank();});
 await assert.rejects(f.org.avaliarFonte(target),e=>e.code==='FONTE_ALTERADA');
});
test('review: revogar e restaurar política não ressuscita projeto de descendente em outra conversa',t=>{
 const f=fixture(t),source=f.add('Fonte sintética de terceiro.','terceiro'),derived=f.add('Nota derivada sintética: projeto Boreal.');
 f.db.prepare('UPDATE eventos SET conversa_id=? WHERE id=?').run('550000007002@g.us',derived);
 f.db.prepare('INSERT INTO priv_vinculos VALUES(?,?)').run(source,derived);
 f.db.prepare('INSERT INTO politicas_conversa VALUES(?,?,?)').run(GROUP,'tudo','2026-10-28T12:00:00Z');
 const service=new ProjetosComerciais(f.db),p=service.criarRascunho({nome:'Boreal',fontes:[{eventoId:derived}]});
 f.db.prepare('UPDATE politicas_conversa SET politica=? WHERE conversa_id=?').run('so-minhas',GROUP);assert.equal(service.obter(p.id),null);
 f.db.prepare('UPDATE politicas_conversa SET politica=? WHERE conversa_id=?').run('tudo',GROUP);assert.equal(service.obter(p.id),null);
});
test('review: arquivar e restaurar candidato em voo não ressuscita snapshot antigo',async t=>{
 const f=fixture(t),text='Projeto Aurora: preparar o catálogo.',base=f.add(text),p=f.project(base,text),target=f.add('Vamos revisar aquele catálogo amanhã.');
 f.handler((i,r)=>{assert.equal(r.validar(),true);f.org.projetos.arquivar({id:p});f.org.projetos.restaurar({id:p});assert.equal(r.validar(),false);return blank();});
 await assert.rejects(f.org.avaliarFonte(target),e=>e.code==='FONTE_ALTERADA');
});
test('review: SQL reentrante lista/resumo/MCP esconde a mesma derivação contextual revogada',async t=>{
 const f=fixture(t),prior=f.add('Projeto Aurora: preparar catálogo de peças.'),target=f.add('Prepare o documento combinado amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo do projeto Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);
 const mcp=new LumeMcpReadService(f.db),query={scope:{kind:'all'},state:'aberto',limit:20};
 assert.equal(mcp.pendencias(query).rows.length,1);assert.equal(f.org.contexto.acoes.listar({estado:'ativos'}).length,1);assert.equal(resumoAcoesLume(f.db).total,1);
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(prior);
 assert.equal(mcp.pendencias(query).rows.length,0);assert.equal(f.org.contexto.acoes.listar({estado:'ativos'}).length,0);assert.equal(resumoAcoesLume(f.db).total,0);
});
test('review: reprocessamento com abstenção não revalida resumo antigo do contexto revogado',async t=>{
 const f=fixture(t),prior=f.add('Projeto Aurora: catálogo confidencial sintético.'),target=f.add('Prepare o documento combinado amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo confidencial do projeto Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);const action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(target);
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(prior);assert.equal(f.org.contexto.acoes.obter(action.id),null);
 f.handler(()=>blank());assert.equal(await f.org.passo(),true);assert.ok(f.org.sugestoes(target));
 assert.equal(f.org.contexto.acoes.obter(action.id),null);
});
test('review: ação legada cujo resumo foi substituído pelo organizador recebe guarda contextual',async t=>{
 const f=fixture(t),prior=f.add('Projeto Aurora: catálogo confidencial sintético.'),targetText='Prepare o documento combinado amanhã.',target=f.add(targetText);
 f.org.contexto.acoes.registrar({eventoId:target,candidatas:[{fonte:'E'+target,tipo:'pendencia',resumo:'Preparar documento citado',trecho:targetText,prazo_citado:''}]});
 const action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(target);
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo confidencial do projeto Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);assert.match(f.org.contexto.acoes.obter(action.id).resumo,/confidencial/);
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(prior);assert.equal(f.org.contexto.acoes.obter(action.id),null);
});
test('review: contexto corrigido permite reprocessar projeto sem conflito permanente de idempotência',async t=>{
 const f=fixture(t),prior=f.add('O catálogo será destinado ao cliente sintético Alfa.'),target=f.add('Projeto Aurora: preparar o catálogo combinado.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);const original=f.org.sugestoes(target).vinculos[0].projetoId;
 f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Correção: o catálogo será destinado ao cliente sintético Beta.',prior);
 assert.equal(f.org.sugestoes(target),null);assert.equal(await f.org.passo(),true,'reprocessing must complete, not fail forever using the old project key');
 assert.ok(f.org.sugestoes(target)?.vinculos[0].projetoId);
 assert.equal(f.org.projetos.listar().length,1,'only the current derivation may remain visible');
});
test('review: consentimento ChatGPT não exporta contexto pessoal de terceiro por ação MCP',async t=>{
 const f=fixture(t),prior=f.add('Detalhe sintético reservado: catálogo industrial Aurora.','terceiro'),target=f.add('Prepare o documento combinado amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo industrial Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);assert.ok(f.org.sugestoes(target));assert.equal(f.org.contexto.acoes.listar({estado:'ativos'}).length,1);
 const mcp=new LumeMcpReadService(f.db);
 assert.equal(mcp.pendencias({scope:{kind:'all'},state:'aberto',limit:20}).rows.length,0,'MCP must require external reading for every contextual source, not only the target');
});
test('review: serviço padrão de projetos exige leitura externa de todas as fontes contextuais',async t=>{
 const f=fixture(t);f.add('Projeto Aurora trata de um cliente sintético reservado.','terceiro');const target=f.add('Projeto Aurora: preparar o catálogo combinado.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);const p=f.org.sugestoes(target).vinculos[0].projetoId;
 assert.ok(f.org.projetos.obter(p));assert.equal(new ProjetosComerciais(f.db).obter(p),null);
});
test('review: MCP today não retorna nem revalida resumo que depende de contexto de ontem',async t=>{
 const f=fixture(t),prior=f.add('Projeto Aurora: o catálogo foi combinado ontem.'),target=f.add('Prepare o documento combinado amanhã.');
 f.db.prepare('UPDATE eventos SET dia_local=? WHERE id=?').run('2026-10-27',prior);
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo Aurora',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);const mcp=new LumeMcpReadService(f.db),query={state:'aberto',limit:20};
 const unrestricted=mcp.pendencias({...query,scope:{kind:'all'}}).rows;assert.equal(unrestricted.length,1);
 assert.equal(mcp.revalidar(unrestricted[0],{kind:'all'}),true);
 const today={kind:'today',date:'2026-10-28'};
 assert.equal(mcp.pendencias({...query,scope:today}).rows.length,0);assert.equal(mcp.revalidar(unrestricted[0],today),false);
});
test('review: MCP projects exige escopo de ambos projetos no contexto e preserva SQL literal',async t=>{
 const f=fixture(t),prior=f.add('Projeto Aurora: contexto pertence ao projeto legado A.'),target=f.add('Prepare o documento combinado amanhã.');
 for(const id of ['synthetic-A','synthetic-B'])f.db.prepare('INSERT INTO projetos(id,cliente,nome,raiz,criado_em) VALUES(?,?,?,?,?)').run(id,'Synthetic',id,'synthetic-only','2026-10-28T12:00:00Z');
 f.db.prepare('UPDATE eventos SET projeto_id=? WHERE id=?').run('synthetic-A',prior);f.db.prepare('UPDATE eventos SET projeto_id=? WHERE id=?').run('synthetic-B',target);
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo Aurora',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);
 const mcp=new LumeMcpReadService(f.db),query={state:'aberto',limit:20};
 const all={kind:'projects',ids:['synthetic-A','synthetic-B']},partial={kind:'projects',ids:['synthetic-B']};
 const rows=mcp.pendencias({...query,scope:all}).rows;assert.equal(rows.length,1);assert.equal(mcp.revalidar(rows[0],all),true);
 assert.equal(mcp.pendencias({...query,scope:partial}).rows.length,0);assert.equal(mcp.revalidar(rows[0],partial),false);
 assert.equal(mcp.pendencias({...query,scope:{kind:'projects',ids:["synthetic-B' OR 1=1 --"]}}).rows.length,0);
});
test('review: MCP conversations mantém escopo exato de conversa da derivação',async t=>{
 const f=fixture(t);f.add('Projeto Aurora: contexto sintético.');f.add('Prepare o documento combinado amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo Aurora',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);
 const mcp=new LumeMcpReadService(f.db),query={state:'aberto',limit:20},scope={kind:'conversations',ids:[GROUP]};
 const rows=mcp.pendencias({...query,scope}).rows;assert.equal(rows.length,1);assert.equal(mcp.revalidar(rows[0],scope),true);
 assert.equal(mcp.pendencias({...query,scope:{kind:'conversations',ids:['550000007002@g.us']}}).rows.length,0);
});
test('review: exportação sem ocultas não inclui resumo de contexto pessoal excluído do pacote',async t=>{
 const f=fixture(t),prior=f.add('Detalhe sintético reservado: catálogo industrial Aurora.','terceiro'),target=f.add('Prepare o documento combinado amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo industrial Aurora',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);
 const exported=new Privacidade(f.db).exportar({conversa:GROUP,confirmar:true,incluirOcultas:false}).conteudo;
 assert.equal(exported.eventos.some(e=>e.id===prior),false);assert.equal(exported.eventos.some(e=>e.id===target),true);
 assert.deepEqual(exported.derivados.lume_acoes,[]);
});
test('review: exportação sem ocultas não inclui projeto derivado de contexto ausente',async t=>{
 const f=fixture(t);f.add('Detalhe sintético reservado: cliente do projeto Aurora.','terceiro');f.add('Projeto Aurora: preparar o catálogo combinado.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);
 const exported=new Privacidade(f.db).exportar({conversa:GROUP,confirmar:true,incluirOcultas:false}).conteudo;
 assert.deepEqual(exported.derivados.lume_projetos_comerciais,[]);
});
test('review: excluir fonte contextual remove derivação persistida sem apagar mensagem-alvo original',async t=>{
 const f=fixture(t),prior=f.add('Detalhe sintético reservado: catálogo industrial Aurora.'),target=f.add('Prepare o documento combinado amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo industrial Aurora',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);
 const action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(target),privacy=new Privacidade(f.db),plan=privacy.preparar({fonte:prior});
 privacy.excluir({id:plan.id,confirmar:'APAGAR'});
 assert.ok(f.db.prepare('SELECT id FROM eventos WHERE id=?').get(target),'independent original target survives');
 assert.equal(f.db.prepare('SELECT id FROM lume_acoes WHERE id=?').get(action.id),undefined,'the context-derived summary is physically removed, not merely hidden');
 assert.equal(f.db.prepare("SELECT resultado FROM etapas WHERE evento_id=? AND etapa='organizacao_chatgpt'").get(target)?.resultado??null,null);
});
test('review: revogar contexto de vínculo adicional conserva projeto-base e remove associação na timeline do alvo',async t=>{
 const f=fixture(t),baseText='Projeto Aurora: catálogo de peças.',base=f.add(baseText),p=f.project(base,baseText),context=f.add('A loja virtual combinada também faz parte do projeto Aurora.'),target=f.add('Prepare a loja virtual combinada amanhã.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',projetoId:p,trecho:i.texto,confianca:.98,evidencias:[{eventoId:base,trecho:baseText}]}]}));
 assert.equal(await f.org.passo(),true);assert.ok(f.org.projetos.obter(p).fontes.some(x=>x.eventoId===target));
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(context);
 assert.ok(f.org.projetos.obter(p),'independent project base remains valid');
 assert.equal(f.org.projetos.obter(p).fontes.some(x=>x.eventoId===target),false);
 assert.deepEqual(f.org.timeline({conversa:GROUP}).itens.find(x=>x.fonte.eventoId===target).projetos,[]);
});
test('review: exclusão contextual apaga projeto e payload de execução, preservando os originais',async t=>{
 const f=fixture(t),prior=f.add('Cliente sintético reservado pediu catálogo industrial.'),target=f.add('Projeto Aurora: prepare o catálogo combinado amanhã.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98}],compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo industrial reservado',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);
 const p=f.org.sugestoes(target).vinculos[0].projetoId,a=f.db.prepare('SELECT * FROM lume_acoes WHERE evento_id=?').get(target);
 prepararExecucoes(f.db);const now='2026-10-28T12:00:00Z';
 f.db.prepare('INSERT INTO lume_execucao_contextos VALUES(?,?,?,?,?,?)').run('synthetic-context',a.id,JSON.stringify({resumo:a.resumo}),JSON.stringify({fonte:a.fonte_assinatura}),now,'2026-10-29T12:00:00Z');
 f.db.prepare('INSERT INTO lume_execucoes VALUES(?,?,?,?,?,?,?,?,?)').run('synthetic-execution','synthetic-context','codex','synthetic-client','aguardando_assistente','synthetic-key','synthetic-hash',now,now);
 f.db.prepare('INSERT INTO lume_execucao_eventos(execucao_id,chave,assinatura,tipo,ator,dados,criado_em) VALUES(?,?,?,?,?,?,?)').run('synthetic-execution','synthetic-event','synthetic-hash','preparado','synthetic',JSON.stringify({resumo:a.resumo}),now);
 const privacy=new Privacidade(f.db),plan=privacy.preparar({fonte:prior});assert.equal(plan.contagens.lume_acoes,1);assert.equal(plan.contagens.lume_execucao_contextos,1);assert.equal(plan.contagens.lume_projetos_comerciais,1);
 privacy.excluir({id:plan.id,confirmar:'APAGAR'});assert.ok(f.db.prepare('SELECT id FROM eventos WHERE id=?').get(target));
 for(const table of ['lume_acoes','lume_execucao_contextos','lume_execucoes','lume_execucao_eventos','lume_projetos_comerciais','lume_projetos_fontes','lume_projetos_historico'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
 assert.equal(f.org.config('projeto-inferido:'+p),null);assert.equal(f.org.config('acao-inferida:'+a.id),null);
 assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('review: exclusão de contexto de vínculo adicional apaga só vínculo, preserva projeto e alvos',async t=>{
 const f=fixture(t),baseText='Projeto Aurora: catálogo de peças.',base=f.add(baseText),p=f.project(base,baseText),prior=f.add('A loja virtual será parte do catálogo.'),target=f.add('Prepare a loja virtual combinada amanhã.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',projetoId:p,trecho:i.texto,confianca:.98,evidencias:[{eventoId:base,trecho:baseText}]}]}));assert.equal(await f.org.passo(),true);
 const link=f.db.prepare('SELECT id FROM lume_projetos_fontes WHERE projeto_id=? AND evento_id=?').get(p,target),privacy=new Privacidade(f.db),plan=privacy.preparar({fonte:prior});
 assert.equal(plan.contagens.lume_projetos_comerciais,0);assert.equal(plan.contagens.lume_projetos_fontes,1);privacy.excluir({id:plan.id,confirmar:'APAGAR'});
 assert.ok(f.org.projetos.obter(p));for(const id of [base,target])assert.ok(f.db.prepare('SELECT id FROM eventos WHERE id=?').get(id));
 assert.equal(f.db.prepare('SELECT id FROM lume_projetos_fontes WHERE id=?').get(link.id),undefined);assert.equal(f.org.config('vinculo-inferido:'+link.id),null);
});
test('review: prévia contextual detecta mudança de payload antes de excluir',async t=>{
 const f=fixture(t),prior=f.add('Cliente sintético pediu o catálogo industrial.'),target=f.add('Prepare o documento combinado amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo industrial',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);
 const a=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(target),privacy=new Privacidade(f.db),plan=privacy.preparar({fonte:prior});
 f.org.contexto.acoes.corrigir({id:a.id,resumo:'Descrição sintética corrigida antes da exclusão'});
 assert.throws(()=>privacy.excluir({id:plan.id,confirmar:'APAGAR'}),/mudaram/);for(const id of [prior,target])assert.ok(f.db.prepare('SELECT id FROM eventos WHERE id=?').get(id));
 assert.ok(f.db.prepare('SELECT id FROM lume_acoes WHERE id=?').get(a.id));
});
test('review: exclusão alcança linhagem contextual fora das oito mensagens imediatas',async t=>{
 const f=fixture(t),prior=f.add('O cliente sintético reservado solicitou um catálogo industrial.'),base=f.add('Projeto Aurora: preparar o catálogo combinado.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);const p=f.org.sugestoes(base).vinculos[0].projetoId;
 for(let n=0;n<10;n++)f.add('Mensagem sintética incidental de conversa '+n+'.');const target=f.add('Prepare a revisão final combinada amanhã.');
 f.handler(i=>({...blank(),compromissos:[{tipo:'pendencia',resumo:'Revisar catálogo industrial do cliente reservado',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);
 assert.ok(f.org.sugestoes(target).contexto.fontes.some(g=>g.eventoId===prior),'older candidate lineage is tracked even outside immediate messages');
 const a=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(target),privacy=new Privacidade(f.db),plan=privacy.preparar({fonte:prior});privacy.excluir({id:plan.id,confirmar:'APAGAR'});
 assert.equal(f.db.prepare('SELECT id FROM lume_acoes WHERE id=?').get(a.id),undefined);assert.equal(f.db.prepare('SELECT id FROM lume_projetos_comerciais WHERE id=?').get(p),undefined);
 for(const id of [base,target])assert.ok(f.db.prepare('SELECT id FROM eventos WHERE id=?').get(id));
});
test('review: duas mensagens ainda não processadas do mesmo projeto conservam identidade pela fila real',async t=>{
 const f=fixture(t,{realQueue:true}),first=f.add('Projeto Aurora: preparar o catálogo da equipe.'),second=f.add('Projeto Aurora: revisar o mesmo catálogo e apresentar a versão final.');
 f.handler(i=>{const p=i.projetos.find(p=>p.nome==='Aurora');return {...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98,...(p?{projetoId:p.id,evidencias:[{eventoId:p.fontes[0].eventoId,trecho:p.fontes[0].trecho}]}:{})}]};});
 assert.equal(await f.org.passo(),true);assert.equal(await f.org.passo(),true);
 const a=f.org.sugestoes(first),b=f.org.sugestoes(second);assert.ok(a);assert.ok(b);
 assert.equal(a.vinculos[0].projetoId,b.vinculos[0].projetoId,'queue ordering cannot fragment a clear continuity into two projects');
 assert.equal(f.org.projetos.listar().length,1);assert.equal(f.org.projetos.obter(a.vinculos[0].projetoId).fontes.length,2);
});
test('review: captura recente atravessa janelas limitadas em ordem cronológica sem saltar para o fim',async t=>{
 const f=fixture(t,{realQueue:true}),ids=Array.from({length:75},(_,n)=>f.add('Projeto Aurora: revisar a etapa sintética '+String(n).padStart(2,'0')+' do mesmo catálogo.'));
 f.org.capturar({limite:3});
 const queued=f.db.prepare("SELECT evento_id FROM etapas WHERE etapa='organizacao_chatgpt' ORDER BY evento_id").all().map(x=>x.evento_id);
 assert.equal(queued.includes(ids.at(-1)),false,'the first bounded recent capture starts at the beginning, not the newest source');
 const processed=[];f.handler(i=>{processed.push(i.eventoId);const p=i.projetos.find(p=>p.nome==='Aurora');return {...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98,...(p?{projetoId:p.id,evidencias:[{eventoId:p.fontes[0].eventoId,trecho:p.fontes[0].trecho}]}:{})}]};});
 for(let n=0;n<ids.length;n++)assert.equal(await f.org.passo(),true,'each pending synthetic source completes');
 assert.deepEqual(processed,ids.flatMap(id=>[id,id]));assert.equal(new Set(ids.map(id=>f.org.sugestoes(id)?.vinculos[0]?.projetoId)).size,1);
 assert.equal(f.org.projetos.listar().length,1);
});
test('review: cache de leitura não sobrevive a erro, retorno ou rollback do chamador',t=>{
 const f=fixture(t),id=f.add('Fonte sintética para guarda de leitura.'),failure=new Error('synthetic read failure');
 assert.throws(()=>comLeituraOrganizacao(f.db,()=>{assert.ok(fonteOrganizacao(f.db,id));throw failure;}),e=>e===failure);
 assert.equal(f.db.isTransaction,false);f.db.exec('BEGIN');f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);
 assert.equal(comLeituraOrganizacao(f.db,()=>fonteOrganizacao(f.db,id)),null);assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');
 assert.ok(comLeituraOrganizacao(f.db,()=>fonteOrganizacao(f.db,id)));
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);assert.equal(comLeituraOrganizacao(f.db,()=>fonteOrganizacao(f.db,id)),null);
 assert.equal(f.db.isTransaction,false);
});
test('review: projeções síncronas guardadas não gravam durante snapshot de leitura',async t=>{
 const f=fixture(t),target=f.add('Projeto Aurora: preparar o catálogo amanhã.');
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98}],compromissos:[{tipo:'pendencia',resumo:'Preparar catálogo',trecho:i.texto,confianca:.98}]}));assert.equal(await f.org.passo(),true);
 const action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(target),p=f.org.sugestoes(target).vinculos[0].projetoId,mcp=new LumeMcpReadService(f.db);
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 f.org.timeline({conversa:GROUP});f.org.projetos.obter(p);f.org.projetos.listar();f.org.contexto.acoes.obter(action.id);f.org.contexto.acoes.listar();resumoAcoesLume(f.db);mcp.pendencias({scope:{kind:'all'},state:'aberto',limit:20});
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.db.isTransaction,false);
});
test('review: backfill com ID novo e data antiga conserva continuidade cronológica',async t=>{
 const f=fixture(t,{realQueue:true}),later=f.add('Projeto Aurora: revisar o mesmo catálogo combinado.'),earlier=f.add('Projeto Aurora: preparar o catálogo inicial.');
 f.db.prepare('UPDATE eventos SET recebido_em=? WHERE id=?').run('2026-10-28T12:00:00Z',later);
 f.db.prepare('UPDATE eventos SET recebido_em=? WHERE id=?').run('2026-10-28T11:00:00Z',earlier);
 const processed=[];f.handler(i=>{processed.push(i.eventoId);const p=i.projetos.find(p=>p.nome==='Aurora');return {...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:i.texto,confianca:.98,...(p?{projetoId:p.id,evidencias:[{eventoId:p.fontes[0].eventoId,trecho:p.fontes[0].trecho}]}:{})}]};});
 assert.equal(await f.org.passo(),true);assert.equal(await f.org.passo(),true);assert.deepEqual(processed,[earlier,earlier,later,later]);
 assert.equal(f.org.sugestoes(earlier).vinculos[0].projetoId,f.org.sugestoes(later).vinculos[0].projetoId);
});


test('review: captura limitada com backfill ordena datas antes de despachar a primeira fonte',async t=>{
 const f=fixture(t,{realQueue:true}),ids=Array.from({length:75},(_,n)=>f.add('Mensagem sintetica do catalogo etapa '+n+'.'));
 for(let n=0;n<ids.length;n++)f.db.prepare('UPDATE eventos SET recebido_em=? WHERE id=?').run(new Date(Date.parse('2026-10-28T12:00:00Z')-n*60000).toISOString(),ids[n]);
 const processed=[];f.handler(i=>{processed.push(i.eventoId);return blank();});
 assert.equal(await f.org.passo(),true);
 assert.equal(processed[0],ids.at(-1),'the oldest recent source must be captured before a later source from the first ID window');
 for(let n=1;n<ids.length;n++)assert.equal(await f.org.passo(),true);
 assert.deepEqual(processed,[...ids].reverse().flatMap(id=>[id,id]),'the historical fairness turn must not select a newer recent message ahead of its chronological base');
});


test('review: contexto editado apos fim da captura recente permite reprocessar derivacao dependente',async t=>{
 const f=fixture(t,{realQueue:true}),prior=f.add('Catalogo sintetico inicialmente combinado.'),target=f.add('Prepare o catalogo combinado amanha.');
 f.handler(i=>i.eventoId===prior?blank():({...blank(),compromissos:[{tipo:'pendencia',resumo:'Preparar catalogo combinado',trecho:i.texto,confianca:.98}]}));
 assert.equal(await f.org.passo(),true);assert.equal(await f.org.passo(),true);assert.equal(await f.org.passo(),false);
 assert.ok(f.org.sugestoes(target));f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Catalogo sintetico revisado apos a leitura.',prior);
 assert.equal(f.org.sugestoes(target),null);assert.equal(await f.org.passo(),true);
 let refreshed=false;for(let n=0;n<5;n++){await f.org.passo();if(f.org.sugestoes(target)){refreshed=true;break;}}
 assert.equal(refreshed,true,'a completed recent cursor must not strand an invalidated contextual derivation');
});

for(const kind of ['temperatura','organizacao','vinculo'])test('review: literal multilinha continua corrigivel em '+kind,t=>{
 const f=fixture(t),base='Projeto Aurora: catalogo inicial.',p=f.project(f.add(base),base),trecho='Projeto Aurora:\n\tpreparar o catalogo combinado.',eventoId=f.add(trecho);
 assert.doesNotThrow(()=>kind==='temperatura'?f.org.corrigirTemperatura({eventoId,trecho,temperatura:'morno',etapa:'interesse'}):kind==='organizacao'?f.org.corrigirOrganizacao({eventoId,trecho,nome:'Equipe sintética'}):f.org.corrigirVinculo({eventoId,trecho,projetoId:p}));
});
