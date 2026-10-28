// Synthetic fixtures only. In-memory SQLite; no model, account or live profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {OrganizadorConversas} from '../src/pessoal/organizador.js';

const GROUP='550000006601@g.us';
function fixture(t){
  const db=abrirBanco(),context=new ContextoApp(db);
  new Desktop(db).aceitar({nome:'Orçamento de contexto sintético',aceito:true,versao:VERSAO_TERMOS});
  const org=new OrganizadorConversas(db,{podeProcessar:()=>false});let serial=0,projectSerial=0;
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(GROUP,'Grupo fictício de orçamento');
  org.configurarEscopo({escopo:'todas',confirmar:true});
  const f={db,org,
    add(text){return context._registrarEvento({conversaId:GROUP,origemId:'synthetic-budget-'+(++serial),autorId:'550000006699@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:new Date(Date.UTC(2026,9,28,12,0,serial))},'terceiro').id;},
    project(name,texts=[`Projeto ${name}: preparar material fictício.`]){
      const sources=texts.map(text=>({eventoId:this.add(text),trecho:text.length>300?text.slice(0,80):text}));
      const id=org.projetos.criarRascunho({nome:name,natureza:'incerto',chave:'synthetic-budget-project-'+(++projectSerial),fontes:sources}).id;
      return {id,name,sources};
    },
    noise(n=8){return Array.from({length:n},(_,i)=>this.add(`Aviso administrativo fictício ${i+1}: água disponível na recepção.`));},
    packet(target){return org.contextual.montar(org.fonte(target,{remoto:true}));}
  };
  t.after(async()=>{await org.encerrar();for(const table of ['saidas','pessoal_propostas','telegram_saidas'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);db.close();});
  return f;
}

function withinBudget(packet,target,immediate){
  const ids=[packet.input.eventoId,...packet.input.contexto.map(x=>x.eventoId)];
  assert.equal(packet.input.eventoId,target);
  assert.ok(ids.length<=12,'target and context must stay within twelve sources');
  assert.equal(new Set(ids).size,ids.length,'no repeated source consumes the budget');
  const characters=packet.input.texto.length+packet.input.contexto.reduce((n,x)=>n+x.texto.length,0);
  assert.ok(characters<=16000,'text budget stays at sixteen thousand characters');
  for(const id of immediate)assert.ok(ids.includes(id),'the two immediate sources remain available');
  assert.ok(packet.input.projetos.length<=8,'candidate cap remains eight');
  return {ids,characters};
}

for(const withCandidate of [false,true])test(`context budget: retains exactly eight recent messages when they fit (candidate=${withCandidate})`,t=>{
  const f=fixture(t),project=withCandidate?f.project('Sereno'):null,recent=f.noise(12);
  const target=f.add('Vamos conferir o material fictício disponível.'),packet=f.packet(target);
  const {ids}=withinBudget(packet,target,recent.slice(-2));
  assert.deepEqual(packet.input.contexto.filter(x=>recent.includes(x.eventoId)).map(x=>x.eventoId),recent.slice(-8),'the distant fill preserves the established eight-message window, not eleven');
  if(project)assert.ok(ids.includes(project.sources[0].eventoId),'older candidate base is additional to the recent window when both fit');
});

test('context budget: relevant older project survives eight irrelevant recent messages',t=>{
  const f=fixture(t),original=f.project('Estrela');
  for(const name of ['Bosque','Maré','Ponte'])f.project(name);
  const recent=f.noise(),target=f.add('O trabalho Estrela pertence à cliente fictícia Lia.');
  const packet=f.packet(target),budget=withinBudget(packet,target,recent.slice(-2));
  assert.ok(budget.characters<2000,'reproduction is source-count starvation, not a large text');
  assert.ok(packet.input.projetos.some(p=>p.id===original.id),'original explicitly named project must enter instead of inviting a duplicate');
  assert.ok(budget.ids.includes(original.sources[0].eventoId),'original evidence accompanies the candidate');
});

test('context budget: eight single-base candidates fit with target and two immediate sources',t=>{
  const f=fixture(t),projects=Array.from({length:8},(_,i)=>f.project('Objeto'+i));
  const recent=f.noise(),target=f.add('Vamos conferir os trabalhos fictícios disponíveis.');
  const packet=f.packet(target);withinBudget(packet,target,recent.slice(-2));
  assert.deepEqual(new Set(packet.input.projetos.map(p=>p.id)),new Set(projects.map(p=>p.id)),'all eight candidates fit in eleven sources');
});

test('context budget: target and immediate object references outrank unrelated project recency',t=>{
  const f=fixture(t),targetProject=f.project('Prisma'),immediateProject=f.project('Horizonte');
  for(let i=0;i<9;i++)f.project('Rotina'+i);
  f.noise(6);const immediate=[f.add('O catálogo do Horizonte precisa de revisão.'),f.add('A montagem do Horizonte continua amanhã.')];
  const target=f.add('No Prisma, precisamos revisar o catálogo fictício.');
  const packet=f.packet(target);withinBudget(packet,target,immediate);
  for(const project of [targetProject,immediateProject])assert.ok(packet.input.projetos.some(p=>p.id===project.id),'literal object in target or immediate thread takes priority over unrelated recency');
});

test('context budget: every base of multi-source candidates remains in context and proof',t=>{
  const f=fixture(t),projects=Array.from({length:4},(_,i)=>f.project('Coleção'+i,[`Cliente fictício ${i}: identidade da coleção.`,`Início explícito do trabalho Coleção${i}.`]));
  const recent=f.noise(),target=f.add('Vamos conferir os trabalhos das coleções fictícias.');
  const packet=f.packet(target),budget=withinBudget(packet,target,recent.slice(-2));
  assert.equal(packet.input.projetos.length,4,'four two-base projects fit with the immediate thread');
  for(const project of projects){
    const candidate=packet.input.projetos.find(p=>p.id===project.id);assert.ok(candidate);
    for(const source of project.sources){
      assert.ok(budget.ids.includes(source.eventoId),'never include a candidate without a required base');
      assert.ok(candidate.fontes.some(f=>f.eventoId===source.eventoId));
      const guard=packet.prova.fontes.find(f=>f.eventoId===source.eventoId);
      assert.ok(guard?.assinatura&&guard?.autorizacao,'each base keeps its permission and signature lineage');
    }
  }
});

test('context budget: oversized multi-base candidate is omitted atomically',t=>{
  const f=fixture(t),large=f.project('Gigante',['Identidade do trabalho Gigante no catálogo fictício.','Base extensa do projeto Gigante. '+ 'material fictício '.repeat(1000)]),small=f.project('Compacto');
  const recent=f.noise(),target=f.add('O trabalho Gigante precisa de revisão, junto ao Compacto.');
  const packet=f.packet(target),budget=withinBudget(packet,target,recent.slice(-2));
  assert.ok(!packet.input.projetos.some(p=>p.id===large.id),'cannot truncate away one mandatory base to fit');
  assert.ok(packet.input.projetos.some(p=>p.id===small.id),'one oversized candidate must not block candidates that fit');
  for(const source of large.sources)assert.ok(!budget.ids.includes(source.eventoId),'rejected candidate must not consume a partial base');
});

test('context budget: omission flags block new projects but preserve complete candidates and pending work',t=>{
  const f=fixture(t);
  f.project('Gigante',['Identidade do trabalho Gigante no catálogo fictício.','Base extensa do projeto Gigante. '+ 'material fictício '.repeat(1000)]);
  const small=f.project('Compacto');f.noise();
  const text='Projeto Faísca: preparar páginas. No Compacto, revisar o material.',target=f.add(text),packet=f.packet(target);
  assert.ok(packet.input.limitesContexto?.includes('caracteres'),'omitted oversized base signals capacity, without claiming an omitted identity');
  assert.ok(packet.input.limitesContexto.every(reason=>['fontes','caracteres','candidatos','busca','linhagem'].includes(reason)),'flags contain reasons only, never project names or IDs');
  const result=f.org.validarResultado({assuntos:[{nome:'Preparação de páginas',trecho:text,confianca:.98}],tags:[],
    vinculos:[{tipo:'projeto',nome:'Faísca',trecho:text,confianca:.98},{tipo:'projeto',nome:'Compacto',projetoId:small.id,trecho:text,confianca:.98,evidencias:small.sources}],
    oportunidades:[],compromissos:[{resumo:'Preparar páginas e revisar material.',tipo:'pendencia',prazo_citado:'',trecho:text,confianca:.98}],acontecimentos:[],perguntas:[]},f.org.fonte(target,{remoto:true}),packet);
  assert.deepEqual(result.vinculos.map(p=>p.projetoId),[small.id],'capacity restriction blocks only automatic creation, not complete existing candidates');
  assert.equal(result.assuntos.length,1);assert.equal(result.compromissos.length,1);
});

test('context budget: same-name projects retain distinct identities and their own bases',t=>{
  const f=fixture(t),first=f.project('Aurora',['Projeto Aurora da cliente fictícia Alfa: catálogo.']),second=f.project('Aurora',['Projeto Aurora da cliente fictícia Beta: relatório.']);
  for(const name of ['Cedro','Nuvem','Farol','Lago'])f.project(name);
  const recent=f.noise(),target=f.add('Precisamos esclarecer qual trabalho Aurora está sendo citado.');
  const packet=f.packet(target);withinBudget(packet,target,recent.slice(-2));
  const matches=packet.input.projetos.filter(p=>p.nome==='Aurora');
  assert.deepEqual(new Set(matches.map(p=>p.id)),new Set([first.id,second.id]),'ranking must never merge homonyms');
  for(const project of [first,second])assert.deepEqual(matches.find(p=>p.id===project.id).fontes.map(f=>f.eventoId),project.sources.map(f=>f.eventoId));
});
