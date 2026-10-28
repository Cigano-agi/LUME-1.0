// Independent synthetic identity-origin tests. No real profiles or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO} from '../src/pessoal/organizador.js';
const GROUP='550000008001@g.us',OTHER='550000008002@g.us',MODEL='synthetic-origin-review';
const blank=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]});
function fixture(t){
 const db=abrirBanco(),context=new ContextoApp(db);let seq=0,receiptSeq=0,handler=()=>blank();
 new Desktop(db).aceitar({nome:'Synthetic origin review',aceito:true,versao:VERSAO_TERMOS});
 const org=new OrganizadorConversas(db,{agora:()=>new Date('2026-10-28T12:00:00Z'),chatgpt:{estado:async()=>({connected:true,planEnabled:true,paused:false,model:MODEL}),responder:async r=>({completed:true,model:MODEL,requestId:'synthetic-origin-receipt-'+(++receiptSeq),text:JSON.stringify(await handler(JSON.parse(r.input[0].content)))})}});
 org.configurarEscopo({escopo:'todas',confirmar:true});org.aprovarAvaliacao({modelo:MODEL,total:100,acertos:100,criticos:20,errosCriticos:0,contrato:CONTRATO_ORGANIZACAO,evidencia:'SYNTHETIC TEST ONLY',revisor:'independent fixture'});org.configurar({acao:'retomar'});
 t.after(async()=>{await org.encerrar();db.close();});
 const add=(text,{group=GROUP,date='2026-10-28T11:00:00Z'}={})=>{
  if(seq){org.capturar();db.prepare("UPDATE etapas SET proxima_tentativa_em='2099-01-01T00:00:00Z' WHERE etapa='organizacao_chatgpt' AND estado IN('pendente','falha')").run();}
  return context._registrarEvento({conversaId:group,origemId:'synthetic-'+(++seq),autorId:'550000008099@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:new Date(date)},'dirigida').id;
 };
 const packet=id=>{const e=org.fonte(id,{remoto:true});return {e,pacote:org.contextual.montar(e)};};
 const validate=(id,item)=>{const {e,pacote}=packet(id);return org.validarResultado({...blank(),vinculos:[item]},e,pacote);};
 return {db,org,add,packet,validate,handler:fn=>handler=fn};
}
const item=(trecho,eventoId,identity)=>({tipo:'projeto',nome:'Aurora',trecho,confianca:.98,origemNome:{eventoId,trecho:identity}});
const targetText='Prepare o catalogo combinado para a proxima reuniao.';

test('origin: context identity materializes both bases with normalized literal provenance',async t=>{
 const f=fixture(t),identity='Cliente Alfa: projeto Aurora, catalogo de pecas.',prior=f.add(identity),target=f.add(targetText);
 f.handler(()=>({...blank(),vinculos:[item(targetText,prior,identity)]}));assert.equal(await f.org.passo(),true);
 const output=f.org.sugestoes(target),link=output.vinculos[0];assert.ok(link,'a named context identity can support an unnamed target');
 assert.deepEqual(link.origemNome,{eventoId:prior,trecho:identity,inicio:0});
 const p=f.org.projetos.obter(link.projetoId);assert.deepEqual(p.fontes.filter(x=>x.base).map(x=>x.eventoId).sort((a,b)=>a-b),[prior,target]);
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(prior);assert.equal(f.org.projetos.obter(p.id),null);assert.equal(f.org.sugestoes(target),null);
});

test('origin: literal multiline identity stays exact',t=>{
 const f=fixture(t),identity='Projeto Aurora:\n\tcatalogo de pecas.',prior=f.add(identity),target=f.add(targetText);
 const output=f.validate(target,item(targetText,prior,identity));assert.equal(output.vinculos.length,1);assert.equal(output.vinculos[0].origemNome.trecho,identity);
});

for(const variant of ['other-conversation','future','outside-context','repeated','name-absent','fabricated-literal'])test('origin: rejects '+variant+' identity source',t=>{
 const f=fixture(t),identity='Projeto Aurora: catalogo de pecas.',prior=f.add(variant==='repeated'?identity+' '+identity:identity,{group:variant==='other-conversation'?OTHER:GROUP,date:variant==='future'?'2026-10-29T12:00:00Z':'2026-10-28T10:00:00Z'});
 if(variant==='outside-context')for(let n=0;n<10;n++)f.add('Mensagem incidental sintetica '+n+'.');
 const target=f.add(targetText),value=item(targetText,prior,variant==='fabricated-literal'?'Projeto Aurora: trecho inexistente.':identity);if(variant==='name-absent')value.nome='Boreal';
 let output;try{output=f.validate(target,value);}catch(error){assert.match(error.code,/FONTE_INVALIDA|RESPOSTA_INVALIDA/);return;}assert.equal(output.vinculos.length,0);
});

test('origin: cannot combine a candidate ID with a different origin assertion',t=>{
 const f=fixture(t),identity='Projeto Aurora: catalogo de pecas.',prior=f.add(identity),p=f.org.projetos.criarRascunho({nome:'Aurora',natureza:'incerto',fontes:[{eventoId:prior,trecho:identity}]}),target=f.add(targetText);
 const value={...item(targetText,prior,identity),projetoId:p.id,evidencias:[{eventoId:prior,trecho:identity}]};
 let output;try{output=f.validate(target,value);}catch(error){assert.match(error.code,/FONTE_INVALIDA|RESPOSTA_INVALIDA/);return;}assert.equal(output.vinculos.length,0);
});

test('origin: revocation during inference cannot persist either base',async t=>{
 const f=fixture(t),identity='Projeto Aurora: catalogo de pecas.',prior=f.add(identity),target=f.add(targetText);
 f.handler(()=>{f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(prior);return {...blank(),vinculos:[item(targetText,prior,identity)]};});
 assert.equal(await f.org.passo(),false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,0);assert.equal(f.org.sugestoes(target),null);
});

test('origin: a distinct identity base is not merged by matching target and name',async t=>{
 const f=fixture(t),a='Cliente Alfa: projeto Aurora para pecas.',b='Cliente Beta: projeto Aurora para alimentos.',first=f.add(a),second=f.add(b),target=f.add(targetText);
 f.handler(()=>({...blank(),vinculos:[item(targetText,first,a)]}));assert.equal(await f.org.passo(),true);const initial=f.org.sugestoes(target)?.vinculos[0]?.projetoId;assert.ok(initial);
 f.db.prepare("UPDATE etapas SET estado='pendente',resultado=NULL,proxima_tentativa_em=NULL WHERE evento_id=? AND etapa='organizacao_chatgpt'").run(target);
 f.handler(()=>({...blank(),vinculos:[item(targetText,second,b)]}));assert.equal(await f.org.passo(),true);const next=f.org.sugestoes(target).vinculos[0].projetoId;
 assert.notEqual(next,initial,'name and target alone cannot override the asserted identity interval');
 assert.ok(f.org.projetos.obter(next).fontes.some(x=>x.base&&x.eventoId===second));
});

test('origin: eight links are allowed while ninth and five unrelated items stay bounded',t=>{
 const f=fixture(t),names=Array.from({length:9},(_,i)=>'Projeto'+i),text=names.join(', ')+' sao trabalhos distintos.',target=f.add(text),{e,pacote}=f.packet(target);
 const links=names.map(nome=>({tipo:'projeto',nome,trecho:text,confianca:.98}));
 assert.equal(f.org.validarResultado({...blank(),vinculos:links.slice(0,8)},e,pacote).vinculos.length,8);
 assert.throws(()=>f.org.validarResultado({...blank(),vinculos:links},e,pacote),error=>error.code==='RESPOSTA_INVALIDA');
 assert.throws(()=>f.org.validarResultado({...blank(),assuntos:Array.from({length:5},()=>({nome:'Catalogo',trecho:text,confianca:.98}))},e,pacote),error=>error.code==='RESPOSTA_INVALIDA');
});

for(const existing of [false,true])test('origin: optional null is absence for '+(existing?'existing candidate':'new literal project'),t=>{
 const f=fixture(t),identity='Projeto Aurora: catalogo de pecas.',prior=f.add(identity),p=existing?f.org.projetos.criarRascunho({nome:'Aurora',natureza:'incerto',fontes:[{eventoId:prior,trecho:identity}]}):null;
 const target=f.add(identity),value={tipo:'projeto',nome:'Aurora',trecho:identity,confianca:.98,origemNome:null,...(p?{projetoId:p.id,evidencias:[{eventoId:prior,trecho:identity}]}:{})};
 const output=f.validate(target,value);assert.equal(output.vinculos.length,1);assert.equal(output.vinculos[0].origemNome,undefined);
 if(p)assert.equal(output.vinculos[0].projetoId,p.id);
});
