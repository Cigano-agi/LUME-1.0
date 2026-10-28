// Independent attribution/read-boundary review. Synthetic in-memory data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO} from '../src/pessoal/organizador.js';
import {assinaturaFonte} from '../src/tarefas-esquema.js';
import {avaliarAtribuicao} from '../src/pessoal/organizacao-atribuicao.js';
const GROUP='550000008801@g.us',MODEL='synthetic-attribution-review';
const blank=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]});
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const span=texto=>({texto,inicio:0,tamanho:texto.length});
function fixture(t){
 const db=abrirBanco(),context=new ContextoApp(db);let seq=0,request=0,handler=()=>blank();
 new Desktop(db).aceitar({nome:'Synthetic attribution reviewer',aceito:true,versao:VERSAO_TERMOS});
 const org=new OrganizadorConversas(db,{agora:()=>new Date('2026-10-28T12:00:00Z'),chatgpt:{estado:async()=>({connected:true,planEnabled:true,paused:false,model:MODEL,account:{id:'synthetic'}}),responder:async r=>({completed:true,model:MODEL,requestId:'synthetic-'+(++request),text:JSON.stringify(await handler(JSON.parse(r.input[0].content)))})}});
 org.configurarEscopo({escopo:'todas',confirmar:true});org.aprovarAvaliacao({modelo:MODEL,total:100,acertos:100,criticos:20,errosCriticos:0,contrato:CONTRATO_ORGANIZACAO,evidencia:'SYNTHETIC ONLY',revisor:'independent fixture'});org.configurar({acao:'retomar'});
 t.after(async()=>{await org.encerrar();db.close();});
 const add=texto=>context._registrarEvento({conversaId:GROUP,origemId:'synthetic-'+(++seq),autorId:'550000008899@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto,recebidoEm:new Date(Date.UTC(2026,9,28,11,0,seq))},'dirigida').id;
 const project=(text='O da Aurora é a Nara.',name='Aurora')=>{const source=add(text),p=org.projetos.criarRascunho({nome:name,natureza:'incerto',fontes:[{eventoId:source,trecho:text}]});return {id:p.id,source,text,name};};
 const link=(p,text,{modern=false,quote=p.text}={})=>{
  const target=add(text),e=org.fonte(target,{remoto:true}),packet=org.contextual.montar(e);
  const proof={eventoId:target,assinatura:assinaturaFonte(e),autorizacao:digest(org.autorizacao(GROUP)),contexto:packet.prova,contrato:CONTRATO_ORGANIZACAO};
  const l=org.projetos.vincularFonte({id:p.id,eventoId:target,trecho:text});
  if(modern)proof.evidenciasVinculo={projetoId:p.id,alvo:{eventoId:target,inicio:0,tamanho:text.length},limitado:false,fontes:[{eventoId:p.source,inicio:p.text.indexOf(quote),tamanho:quote.length}]};
  org.config('vinculo-inferido:'+l.fonteId,proof);return {id:l.fonteId,target,proof,text};
 };
 const visible=(p,l)=>Boolean(org.projetos.obter(p.id)?.fontes.some(x=>x.id===l.id));
 const step=async id=>{org.capturar();db.prepare("UPDATE etapas SET proxima_tentativa_em='2099-01-01T00:00:00Z' WHERE etapa='organizacao_chatgpt' AND evento_id<>? AND estado IN('pendente','falha')").run(id);return org.passo();};
 return {db,org,add,project,link,visible,step,handler:fn=>handler=fn};
}

test('attribution review: legacy generic link without selected evidence is hidden without deleting original',t=>{
 const f=fixture(t),p=f.project('Preparar catálogo para Aurora.'),l=f.link(p,'Vou enviar as páginas.');
 assert.equal(f.visible(p,l),false);assert.ok(f.org.projetos.obter(p.id));
 assert.deepEqual(f.org.timeline({conversa:GROUP}).itens.find(x=>x.fonte.eventoId===l.target).projetos,[]);
 assert.equal(f.db.prepare('SELECT texto FROM eventos WHERE id=?').get(l.target).texto,l.text);
});
test('attribution review: legacy link naming unique project remains visible',t=>{
 const f=fixture(t),p=f.project(),l=f.link(p,'Vou enviar as páginas para Aurora.');assert.equal(f.visible(p,l),true);
});
test('attribution review: legacy homonym is not uniquely identified',t=>{
 const f=fixture(t),p=f.project();f.project('O da Aurora é a Clara.');const l=f.link(p,'Vou enviar as páginas para Aurora.');assert.equal(f.visible(p,l),false);
});
test('attribution review: modern nominal evidence cannot survive by taking a subspan',t=>{
 const f=fixture(t),p=f.project(),l=f.link(p,'Vou enviar as páginas.',{modern:true,quote:'Aurora é a Nara'});assert.equal(f.visible(p,l),false);
});
for(const mutation of ['outside','target','other-project','different-target-range'])test('attribution review: malformed exact evidence marker fails closed — '+mutation,t=>{
 const f=fixture(t),p=f.project('Preparar catálogo para Aurora.'),l=f.link(p,'Vou enviar as páginas.',{modern:true});assert.equal(f.visible(p,l),true);
 const proof=structuredClone(l.proof),m=proof.evidenciasVinculo;
 if(mutation==='outside')m.fontes[0].tamanho++;
 if(mutation==='target')m.fontes[0].eventoId=l.target;
 if(mutation==='other-project')m.projetoId='synthetic-unknown';
 if(mutation==='different-target-range')m.alvo.inicio=1;
 f.org.config('vinculo-inferido:'+l.id,proof);assert.equal(f.visible(p,l),false);
});
test('attribution review: source edits revoke a previously visible modern association',t=>{
 const f=fixture(t),p=f.project('Preparar catálogo para Aurora.'),l=f.link(p,'Vou enviar as páginas.',{modern:true});assert.equal(f.visible(p,l),true);
 f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto alterado, outra fonte.',p.source);assert.equal(f.visible(p,l),false);
});
test('attribution review: manual correction survives nominal guard but source permission remains mandatory',t=>{
 const f=fixture(t),p=f.project(),l=f.link(p,'Vou enviar as páginas.',{modern:true});assert.equal(f.visible(p,l),false);
 f.org.corrigirVinculo({eventoId:l.target,projetoId:p.id,trecho:l.text});assert.equal(f.visible(p,l),true);
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(l.target);assert.equal(f.visible(p,l),false);
});
test('attribution review: applied output records chosen reference rather than all project sources',async t=>{
 const f=fixture(t),p=f.project('Preparar catálogo para Aurora.'),text='Vou revisar o catálogo combinado.',target=f.add(text);
 f.handler(()=>({...blank(),vinculos:[{tipo:'projeto',nome:p.name,projetoId:p.id,trecho:text,confianca:.98,evidencias:[{eventoId:p.source,trecho:p.text}]}]}));
 assert.equal(await f.step(target),true);
 const row=f.db.prepare('SELECT id FROM lume_projetos_fontes WHERE projeto_id=? AND evento_id=?').get(p.id,target);assert.ok(row);
 const marker=f.org.config('vinculo-inferido:'+row.id);assert.deepEqual(marker.evidenciasVinculo.fontes,[{eventoId:p.source,inicio:0,tamanho:p.text.length}]);assert.equal(f.visible(p,{id:row.id}),true);
});
test('attribution review: explicit artifact title is not a person just because title-cased',()=>{
 assert.equal(avaliarAtribuicao({alvo:span('Vou revisar as copys.'),evidencias:[span('Landing Page')]}).elegivel,true);
});
test('attribution review: lowercase identity predicate still does not attribute a generic action',()=>{
 assert.equal(avaliarAtribuicao({alvo:span('Vou enviar as páginas.'),evidencias:[span('O da Aurora é a nara')]}).elegivel,false);
});
test('attribution review: courtesy appended to identity is not evidence of work',()=>{
 assert.equal(avaliarAtribuicao({alvo:span('Vou enviar as páginas.'),evidencias:[span('O da Aurora é a Nara. Obrigado.')]}).elegivel,false);
});
test('attribution review: lowercase courtesy cannot make nominal evidence affirmative work',()=>{
 assert.equal(avaliarAtribuicao({alvo:span('Vou enviar as páginas.'),evidencias:[span('O da Aurora é a Nara. obrigado.')]}).elegivel,false);
});
test('attribution review: rejected nominal assignment cannot remain in free commitment summary',t=>{
 const f=fixture(t),p=f.project(),text='Vou enviar as páginas.',target=f.add(text),e=f.org.fonte(target,{remoto:true}),packet=f.org.contextual.montar(e);
 const raw={...blank(),vinculos:[{tipo:'projeto',nome:p.name,projetoId:p.id,trecho:text,confianca:.98,evidencias:[{eventoId:p.source,trecho:p.text}]}],compromissos:[{tipo:'compromisso',resumo:'Enviar as páginas do projeto Aurora.',trecho:text,prazo_citado:'',confianca:.98}]};
 const result=f.org.validarResultado(raw,e,packet);assert.equal(result.vinculos.length,0);assert.equal(result.compromissos.length,1);
 assert.equal(result.compromissos[0].resumo.includes('Aurora'),false,'rejected project identity must not leak into materialized action prose');
});
test('attribution review: neutralization covers every summary but preserves independent source interval',t=>{
 const f=fixture(t),p=f.project(),generic='Vou enviar as páginas.',independent='Projeto Boreal foi concluído.',text=generic+' '+independent,target=f.add(text),e=f.org.fonte(target,{remoto:true}),packet=f.org.contextual.montar(e);
 const result=f.org.validarResultado({...blank(),vinculos:[{tipo:'projeto',nome:p.name,projetoId:p.id,trecho:generic,confianca:.98,evidencias:[{eventoId:p.source,trecho:p.text}]}],assuntos:[{nome:'Envio para Aurora',trecho:generic,confianca:.98}],oportunidades:[{resumo:'Venda Aurora',motivo:'Pedido Aurora',temperatura:'morno',etapa:'interesse',trecho:generic,confianca:.98}],acontecimentos:[{tipo:'resultado',resumo:'Aurora recebe páginas',trecho:generic,confianca:.98},{tipo:'resultado',resumo:'Projeto Boreal foi concluído.',trecho:independent,confianca:.98}]},e,packet);
 assert.equal(result.assuntos[0].nome.includes('Aurora'),false);assert.equal(result.oportunidades[0].resumo,generic);assert.equal(result.oportunidades[0].motivo,generic);assert.equal(result.acontecimentos[0].resumo,generic);assert.equal(result.acontecimentos[1].resumo,independent);
});
test('attribution review: second pass omission cannot resurrect first pass rejected identity in summary',t=>{
 const f=fixture(t),p=f.project(),text='Vou enviar as páginas.',target=f.add(text),e=f.org.fonte(target,{remoto:true}),packet=f.org.contextual.montar(e);
 const compromisso={tipo:'compromisso',resumo:'Enviar as páginas do projeto Aurora.',trecho:text,prazo_citado:'',confianca:.98};
 const first=f.org.validarResultado({...blank(),vinculos:[{tipo:'projeto',nome:p.name,projetoId:p.id,trecho:text,confianca:.98,evidencias:[{eventoId:p.source,trecho:p.text}]}],compromissos:[compromisso]},e,packet);
 const second=f.org.validarResultado({...blank(),compromissos:[compromisso]},e,packet);
 const final=f.org.conciliar(first,second,e,packet);assert.equal(final.vinculos.length,0);assert.equal(final.compromissos.length,1);assert.equal(final.compromissos[0].resumo.includes('Aurora'),false);
});
