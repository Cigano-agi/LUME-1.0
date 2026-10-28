// Entirely synthetic sources and identities; in-memory SQLite, no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {OrganizadorConversas} from '../src/pessoal/organizador.js';

const nominal='O da Aurora é a Nara',fullName='Nara Pereira',generic='Vou enviar as páginas';
const span=(texto,trecho=texto)=>({texto,inicio:texto.indexOf(trecho),tamanho:trecho.length});
const evaluate=async args=>(await import('../src/pessoal/organizacao-atribuicao.js')).avaliarAtribuicao(args);
const blocked={elegivel:false,motivo:'evidencia_apenas_nominal'},allowed={elegivel:true,motivo:null};
for(const [name,evidencias] of [
  ['identity statement only',[span(nominal)]],
  ['person name only',[span(fullName)]],
  ['two nominal sources',[span(nominal),span(fullName)]],
  ['evasive quote within nominal sentence',[span(nominal,'Aurora é a Nara')]],
])test('attribution pure: generic action rejects '+name,async()=>{
  assert.deepEqual(await evaluate({alvo:span(generic),evidencias,identidadesUnicas:['Aurora','Nara']}),blocked);
});
test('attribution pure: explicit work artifact supports generic continuation',async()=>{
  assert.deepEqual(await evaluate({alvo:span('Vou revisar algumas copys para ele.'),evidencias:[span('Criativos para o catálogo da Aurora.')],identidadesUnicas:['Aurora']}),allowed);
});
test('attribution pure: uniquely named target recipient supports assignment',async()=>{
  assert.deepEqual(await evaluate({alvo:span('Vou enviar as páginas para Nara Pereira.'),evidencias:[span(nominal),span(fullName)],identidadesUnicas:['Nara Pereira']}),allowed);
});
test('attribution pure: homonym not listed as unique cannot resolve nominal evidence',async()=>{
  assert.deepEqual(await evaluate({alvo:span('Vou enviar as páginas para Nara Pereira.'),evidencias:[span(nominal),span(fullName)],identidadesUnicas:[]}),blocked);
});

function fixture(t){
  const db=abrirBanco(),context=new ContextoApp(db);let serial=0;
  new Desktop(db).aceitar({nome:'Atribuição fictícia',aceito:true,versao:VERSAO_TERMOS});
  const org=new OrganizadorConversas(db,{podeProcessar:()=>false}),group='550000006701@g.us';
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(group,'Grupo sintético de atribuição');org.configurarEscopo({escopo:'todas',confirmar:true});
  const f={db,org,
    add(text){return context._registrarEvento({conversaId:group,origemId:'synthetic-attribution-'+(++serial),autorId:'550000006799@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:new Date(Date.UTC(2026,9,28,12,0,serial))},'terceiro').id;},
    project(name,text){const eventoId=this.add(text),id=org.projetos.criarRascunho({nome:name,natureza:'incerto',chave:'synthetic-attribution-'+serial,fontes:[{eventoId,trecho:text}]}).id;return {id,name,eventoId,text};},
    validate(project,text,evidence=project.text){
      const target=this.add(text),source=org.fonte(target,{remoto:true}),packet=org.contextual.montar(source);
      const raw={assuntos:[{nome:'Envio ou revisão',trecho:text,confianca:.98}],tags:[],vinculos:[{tipo:'projeto',nome:project.name,projetoId:project.id,trecho:text,confianca:.98,evidencias:[{eventoId:project.eventoId,trecho:evidence}]}],oportunidades:[],compromissos:[{tipo:'compromisso',resumo:text,trecho:text,prazo_citado:'',confianca:.98}],acontecimentos:[],perguntas:[]};
      return {target,source,packet,raw,result:org.validarResultado(raw,source,packet)};
    }
  };
  t.after(async()=>{await org.encerrar();for(const table of ['saidas','pessoal_propostas','telegram_saidas'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);db.close();});return f;
}
for(const [name,text,quote] of [['nominal identity',nominal,nominal],['person name',fullName,fullName],['evasive excerpt',nominal,'Aurora é a Nara']])test('attribution integration: blocks '+name+' while preserving commitment',t=>{
  const f=fixture(t),project=f.project('Aurora',text),{result}=f.validate(project,generic,quote);
  assert.equal(result.vinculos.length,0,'nominal evidence must not attach an object-free promise');
  assert.equal(result.compromissos.length,1,'uncertain project does not erase the real promise');assert.equal(result.assuntos.length,1);
});
test('attribution integration: explicit creative work preserves continuation',t=>{
  const f=fixture(t),project=f.project('Aurora','Criativos para o catálogo da Aurora.'),{result}=f.validate(project,'Vou revisar algumas copys para ele.');
  assert.equal(result.vinculos[0]?.projetoId,project.id);assert.equal(result.compromissos.length,1);
});
test('attribution integration: uniquely named project in target remains usable',t=>{
  const f=fixture(t),project=f.project('Aurora',nominal),{result}=f.validate(project,'Vou enviar as páginas para o projeto Aurora.');
  assert.equal(result.vinculos[0]?.projetoId,project.id);
});
test('attribution integration: same project name cannot disambiguate two nominal candidates',t=>{
  const f=fixture(t),a=f.project('Aurora','O da Aurora é a Nara Pereira.'),b=f.project('Aurora','O da Aurora é a Clara Silva.');
  assert.notEqual(a.id,b.id);const {result}=f.validate(a,'Vou enviar as páginas para o projeto Aurora.');
  assert.equal(result.vinculos.length,0,'shared name is not unique evidence of the chosen candidate');
});
test('attribution integration: manual correction survives automatic nominal rejection',t=>{
  const f=fixture(t),project=f.project('Aurora',nominal),v=f.validate(project,generic);
  f.org.corrigirVinculo({eventoId:v.target,projetoId:project.id,trecho:generic});
  f.org.validarResultado(v.raw,v.source,f.org.contextual.montar(v.source));
  assert.equal(f.org.vinculoManual(v.target,0,generic.length)?.projetoId,project.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_fontes WHERE projeto_id=? AND evento_id=? AND removida=0 AND invalidada=0').get(project.id,v.target).n,1);
});
