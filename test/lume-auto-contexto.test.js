// All people, groups, messages, model receipts and quality attestations below
// are SYNTHETIC. In-memory SQLite only; no external inference or live profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ExperienciaLume} from '../src/experiencia-lume.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO,ETAPA_ORGANIZACAO} from '../src/pessoal/organizador.js';

const GROUP='550000009801@g.us',OTHER='550000009802@g.us';
const MODEL='synthetic-auto-context-review';
const blank=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]});

function fixture(t,{commercial=false}={}) {
  const db=abrirBanco(),context=new ContextoApp(db),product=new Desktop(db);
  const now=new Date('2026-10-28T09:00:00Z');let serial=0;
  product.aceitar({nome:'Fixture sintética de contexto',aceito:true,versao:VERSAO_TERMOS});
  const calls=[],state={connected:true,planEnabled:true,paused:false,model:MODEL};
  const chatgpt={estado:async()=>({...state}),responder:async request=>{
    assert.equal(request.validar(),true,'fixture dispatch remains authorized');
    const input=JSON.parse(request.input[0].content);calls.push(input);
    const trecho=input.texto;
    // Continuity is a model decision backed by the authorized candidate and an
    // exact source excerpt, never an automatic merge based on name equality.
    const candidate=input.projetos?.find(project=>project.nome==='Aurora');
    const evidence=candidate?.fontes?.[0];
    const continuation=candidate?{projetoId:candidate.id,nome:candidate.nome,
      evidencias:[{eventoId:evidence.eventoId,trecho:evidence.trecho}]}:{};
    const response={...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho,confianca:.98,...continuation}]};
    if(commercial){
      response.oportunidades=[{resumo:'Avançar com a proposta do projeto Aurora',trecho,confianca:.98,temperatura:'quente',etapa:'proposta',motivo:'O comprador aceitou avançar e solicitou a proposta.'}];
      response.compromissos=[{tipo:'pendencia',resumo:'Preparar a proposta aceita',trecho,prazo_citado:'',confianca:.98}];
    }
    return {completed:true,model:MODEL,requestId:'synthetic-auto-'+calls.length,text:JSON.stringify(response)};
  }};
  const org=new OrganizadorConversas(db,{chatgpt,agora:()=>now});
  for(const id of [GROUP,OTHER]){
    db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,'Grupo fictício de teste');
    org.politica.configurar({conversaId:id,categoria:'team',modo:'observar',remoto:true});
    db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,1,?)').run(id,now.toISOString());
  }
  org.aprovarAvaliacao({modelo:MODEL,total:100,acertos:100,criticos:20,errosCriticos:0,
    evidencia:'SYNTHETIC TEST ONLY; never product quality approval',revisor:'synthetic-fixture',contrato:CONTRATO_ORGANIZACAO});
  org.configurar({acao:'retomar'});
  const experience=new ExperienciaLume(db,{acoes:org.contexto.acoes,produto:product,pessoal:{organizador:org,politica:org.politica},agora:()=>now});
  const f={db,org,calls,experience,
    add(text,conversation=GROUP){return context._registrarEvento({conversaId:conversation,origemId:'synthetic-auto-'+(++serial),autorId:'550000009899@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:now},'dirigida').id;},
    async process(event){assert.equal(await org.passo(),true,'organizer must complete the synthetic source');assert.equal(db.prepare('SELECT estado FROM etapas WHERE evento_id=? AND etapa=?').get(event,ETAPA_ORGANIZACAO).estado,'concluida');return org.sugestoes(event);}
  };
  t.after(async()=>{await org.encerrar();for(const table of ['saidas','pessoal_propostas','telegram_saidas'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,'organizing must not send or prepare replies');db.close();});
  return f;
}

test('auto contexto: mesmo projeto explícito em duas fontes da mesma conversa conserva identidade e ambas as fontes',async t=>{
  const f=fixture(t);
  const first=f.add('Projeto Aurora: preparar o relatório da equipe.');
  const firstResult=await f.process(first),projectId=firstResult.vinculos[0].projetoId;
  const second=f.add('Projeto Aurora: revisar o relatório e apresentar a versão final.');
  const secondResult=await f.process(second);
  assert.equal(secondResult.vinculos[0].projetoId,projectId,'a second explicit mention must extend the existing conversation project, not create a duplicate');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,1);
  const project=f.org.projetos.obter(projectId);
  assert.deepEqual(project.fontes.map(x=>x.eventoId).sort((a,b)=>a-b),[first,second]);
  const cards=f.experience.listar().itens.filter(x=>x.projetoId===projectId);
  assert.equal(cards.filter(x=>x.id==='projeto:'+projectId).length,1,'one project card represents the source-backed project');
});

test('auto contexto: nome homônimo em outra conversa não funde identidades',async t=>{
  const f=fixture(t),first=f.add('Projeto Aurora: organizar o catálogo fictício.');
  const a=await f.process(first),second=f.add('Projeto Aurora: organizar o catálogo fictício.',OTHER),b=await f.process(second);
  assert.notEqual(a.vinculos[0].projetoId,b.vinculos[0].projetoId);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,2);
});

test('auto contexto: temperatura comercial do ChatGPT chega à projeção com origem e fonte',async t=>{
  const f=fixture(t,{commercial:true}),id=f.add('Projeto Aurora: aceitamos avançar; envie a proposta para aprovarmos o pedido.');
  await f.process(id);
  const action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(id);assert.ok(action,'synthetic commercial source created an action');
  const view=f.experience.obter('acao:'+action.id).itens[0];assert.ok(view);
  assert.equal(view.categoria,'comercial');
  assert.equal(view.avaliacao?.temperatura,'quente','accepted model classification must not vanish between extraction and UI projection');
  assert.equal(view.avaliacao?.etapa,'proposta');
  assert.equal(view.avaliacao?.origem,'chatgpt');
  assert.equal(view.fonte.eventoId??view.fonte.id,id,'classification remains attached to its authorized source');
});
