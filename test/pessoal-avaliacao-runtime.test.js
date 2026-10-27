import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {abrirBanco} from '../src/banco.js';
import {prepararPessoal} from '../src/pessoal/esquema.js';
import {AvaliacaoPessoal} from '../src/pessoal/avaliacao-runtime.js';
import casos from '../src/pessoal/casos-avaliacao.js';

// A Responses-shaped mock tests the boundary only. No model/provider/account is
// contacted; no approval created here is evidence of real model quality.
const MODELO='modelo-ficticio-de-teste',INSTRUCOES='Contrato fictício da avaliação.';
const row=db=>JSON.parse(db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-avaliacao'").get().valor);
const write=(db,value)=>db.prepare("UPDATE desktop_config SET valor=? WHERE chave='pessoal-avaliacao'").run(JSON.stringify(value));
function fixture(t,opts={}){
  const dir=mkdtempSync(join(tmpdir(),'lume-avaliacao-runtime-')),path=join(dir,'teste.sqlite'),db=abrirBanco(path);prepararPessoal(db);
  t.after(()=>{try{db.close();}catch{}rmSync(dir,{recursive:true,force:true});});
  db.prepare("INSERT INTO desktop_config VALUES('pessoal-chatgpt-model',?)").run(MODELO);
  const pedidos=[];let seq=0;
  const chatgpt={estado:async()=>({connected:true,planEnabled:true,model:MODELO,paused:false}),
    responder:async req=>{pedidos.push(req);return {completed:true,model:MODELO,requestId:'mock-request-'+(++seq),text:'{"decisao":"consultar_dono","baloes":["Rascunho fictício"]}'};},...opts};
  const avaliacao=new AvaliacaoPessoal(db,{chatgpt,instrucoes:INSTRUCOES});
  return {db,path,chatgpt,pedidos,avaliacao};
}
function revisarTudo(f){for(const r of row(f.db).resultados)f.avaliacao.revisar({id:r.id,digest:r.digest,interpretacao:true,fontes:true,resposta:true,criticoAtendido:true,
  revisadoPor:'Revisor fictício do teste',evidencia:'fixture://revisao/'+r.id+' — revisão fabricada, sem evidência de modelo real.'});}
async function executar100(f){await f.avaliacao.iniciar({confirmar:true});for(let i=0;i<100;i++)await f.avaliacao.proximo();}

test('avaliação runtime: corpus100/20 e estado inicial sem liberação',t=>{
  const f=fixture(t);assert.equal(casos.length,100);assert.equal(casos.filter(c=>c.critico).length,20);
  const estado=f.avaliacao.estado();assert.equal(estado.executados,0);assert.equal(estado.liberada,false);assert.equal(estado.aceita,false);
  assert.throws(()=>f.avaliacao.aceitar({confirmar:true}),/pendentes/);
});

test('avaliação runtime: exige confirmação e conta/plano/modelo disponíveis',async t=>{
  const f=fixture(t);await assert.rejects(()=>f.avaliacao.iniciar(),/Confirme/);
  for(const state of [{connected:false,planEnabled:true,model:MODELO},{connected:true,planEnabled:false,model:MODELO},{connected:true,planEnabled:true,model:''},{connected:true,planEnabled:true,model:MODELO,paused:true}]){
    f.chatgpt.estado=async()=>state;await assert.rejects(()=>f.avaliacao.iniciar({confirmar:true}),/Conecte/);
  }
  assert.equal(f.avaliacao.estado().id,null);
});

test('avaliação runtime: resposta concluída grava recibo e digest; não aprova nem revisa sozinha',async t=>{
  const f=fixture(t),responder=f.chatgpt.responder;f.chatgpt.responder=async req=>{assert.equal(req.validar(),true);return responder(req);};
  await f.avaliacao.iniciar({confirmar:true});await f.avaliacao.proximo();const run=row(f.db),r=run.resultados[0];
  assert.equal(r.id,casos[0].id);assert.equal(r.requestId,'mock-request-1');assert.match(r.digest,/^[0-9a-f]{64}$/);
  assert.equal(r.revisao,undefined);assert.equal(f.avaliacao.estado().revisados,0);assert.equal(f.avaliacao.estado().liberada,false);
  const input=JSON.parse(f.pedidos[0].input[0].content);assert.equal(input.mensagemAtual.texto,casos[0].entrada);assert.equal(input.contexto.fontes[1].origemAvaliacao,casos[0].contexto.fontes[0].id);
  assert.equal(f.pedidos[0].validar(),false,'Após concluir, o claim foi liberado e o callback não autoriza uso tardio.');
});

test('avaliação runtime: completion/model/requestId inválidos não contam como caso executado',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});
  for(const output of [{completed:false,model:MODELO,requestId:'mock-x',text:'x'},{completed:true,model:'outro-modelo',requestId:'mock-x',text:'x'},{completed:true,model:MODELO,requestId:null,text:'x'}]){
    f.chatgpt.responder=async()=>output;await assert.rejects(()=>f.avaliacao.proximo(),/comprovante/);assert.equal(row(f.db).resultados.length,0);assert.equal(f.avaliacao.estado().busy,false);
  }
});

test('avaliação runtime: falha preserva casos já concluídos e retomada continua no próximo',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});await f.avaliacao.proximo();const responder=f.chatgpt.responder;
  f.chatgpt.responder=async()=>{throw Error('Falha fictícia de rede');};await assert.rejects(()=>f.avaliacao.proximo(),/Falha fictícia/);assert.equal(row(f.db).resultados.length,1);
  const nova=new AvaliacaoPessoal(f.db,{chatgpt:f.chatgpt,instrucoes:INSTRUCOES});f.chatgpt.responder=responder;await nova.proximo();
  assert.deepEqual(row(f.db).resultados.map(r=>r.id),casos.slice(0,2).map(c=>c.id));
});

test('avaliação runtime: revisar exige digest correto e juízos explícitos',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});await f.avaliacao.proximo();const r=row(f.db).resultados[0];
  const revisao={id:r.id,digest:r.digest,interpretacao:true,fontes:true,resposta:true,criticoAtendido:true,revisadoPor:'Pessoa fictícia',evidencia:'Referência fictícia de revisão suficientemente longa.'};
  assert.throws(()=>f.avaliacao.revisar({...revisao,digest:'errado'}),/alterado/);assert.throws(()=>f.avaliacao.revisar({...revisao,fontes:'true'}),/incompleta/);
  f.avaliacao.revisar(revisao);assert.equal(f.avaliacao.estado().revisados,1);assert.equal(f.avaliacao.estado().liberada,false);
});

test('avaliação runtime:100 revisões e aceite explícito exercitam gate com mock, sem prova real',async t=>{
  const f=fixture(t);await executar100(f);assert.equal(f.pedidos.length,100);assert.equal(f.avaliacao.estado().liberada,false);
  revisarTudo(f);assert.equal(f.avaliacao.estado().avaliacao.criticosAprovados,20);assert.equal(f.avaliacao.estado().liberada,false);
  assert.throws(()=>f.avaliacao.aceitar(),/pendentes/);const aceito=f.avaliacao.aceitar({confirmar:true});assert.equal(aceito.liberada,true);
  const antes=f.pedidos.length;await f.avaliacao.proximo();assert.equal(f.pedidos.length,antes);
  const db2=abrirBanco(f.path);try{const reaberta=new AvaliacaoPessoal(db2,{chatgpt:f.chatgpt,instrucoes:INSTRUCOES});assert.equal(reaberta.estado().liberada,true);}finally{db2.close();}
});

test('avaliação runtime: modelo, instruções ou revisão alterados invalidam liberação anterior',async t=>{
  const f=fixture(t);await executar100(f);revisarTudo(f);f.avaliacao.aceitar({confirmar:true});
  f.db.prepare("UPDATE desktop_config SET valor='modelo-outro' WHERE chave='pessoal-chatgpt-model'").run();assert.equal(f.avaliacao.estado().liberada,false);await assert.rejects(()=>f.avaliacao.proximo(),/modelo atual/);
  f.db.prepare("UPDATE desktop_config SET valor=? WHERE chave='pessoal-chatgpt-model'").run(MODELO);
  const outro=new AvaliacaoPessoal(f.db,{chatgpt:f.chatgpt,instrucoes:'Contrato alterado.'});assert.equal(outro.estado().liberada,false);
  const r=row(f.db).resultados[0];f.avaliacao.revisar({id:r.id,digest:r.digest,interpretacao:false,fontes:true,resposta:true,criticoAtendido:false,revisadoPor:'Revisor fictício',evidencia:'Revisão fictícia identificou erro crítico de interpretação.'});
  assert.equal(f.avaliacao.estado().liberada,false);assert.equal(f.avaliacao.estado().aceita,false);assert.throws(()=>f.avaliacao.aceitar({confirmar:true}),/pendentes/);
});

test('avaliação runtime: mudança do modelo durante await descarta retorno tardio',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});f.chatgpt.responder=async req=>{
    f.db.prepare("UPDATE desktop_config SET valor='modelo-alterado' WHERE chave='pessoal-chatgpt-model'").run();assert.equal(req.validar(),false);
    return {completed:true,model:MODELO,requestId:'mock-atrasado',text:'conteúdo antigo'};
  };
  await assert.rejects(()=>f.avaliacao.proximo(),/alterado/);assert.equal(row(f.db).resultados.length,0);
});

test('avaliação runtime: mesma instância impede execução e revisão concorrentes',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});let liberar;
  f.chatgpt.responder=()=>new Promise(resolve=>{liberar=resolve;});const p=f.avaliacao.proximo();
  await assert.rejects(()=>f.avaliacao.proximo(),/em curso/);assert.throws(()=>f.avaliacao.revisar({}),/Aguarde/);
  liberar({completed:true,model:MODELO,requestId:'mock-lento',text:'resposta fictícia'});await p;
});

test('avaliação runtime: digest deve ser recalculado se conteúdo persistido mudar',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});await f.avaliacao.proximo();const run=row(f.db),r=run.resultados[0];r.output='Conteúdo substituído depois da execução';write(f.db,run);
  assert.throws(()=>f.avaliacao.revisar({id:r.id,digest:r.digest,interpretacao:true,fontes:true,resposta:true,criticoAtendido:true,revisadoPor:'Revisor fictício',evidencia:'Evidência antiga vinculada ao digest anterior à alteração.'}),/alterado|inválid|integridade/);
});

test('avaliação runtime: duas conexões SQLite não devem executar e sobrescrever o mesmo caso',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});const db2=abrirBanco(f.path);
  try{
    const outra=new AvaliacaoPessoal(db2,{chatgpt:f.chatgpt,instrucoes:INSTRUCOES});let chamadas=0,liberar;
    const gate=new Promise(resolve=>{liberar=resolve;});f.chatgpt.responder=async()=>{const id=++chamadas;await gate;return {completed:true,model:MODELO,requestId:'mock-concorrente-'+id,text:'resposta '+id};};
    const primeira=f.avaliacao.proximo(),segunda=outra.proximo();const settled=Promise.allSettled([primeira,segunda]);liberar();const resultados=await settled;
    assert.equal(resultados.filter(r=>r.status==='fulfilled').length,1,'Só um executor deve obter posse do caso.');assert.equal(chamadas,1,'Não consumir duas chamadas para depois sobrescrever recibo.');
  }finally{db2.close();}
});

test('avaliação runtime: requestId repetido não serve como comprovante de outro caso',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});f.chatgpt.responder=async()=>({completed:true,model:MODELO,requestId:'mock-mesmo-id',text:'resposta repetida'});await f.avaliacao.proximo();
  await assert.rejects(()=>f.avaliacao.proximo(),/comprovante|duplic|repetid/);assert.equal(row(f.db).resultados.length,1);
});

test('avaliação runtime: retorno de proximo informa busy encerrado',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});const r=await f.avaliacao.proximo();assert.equal(r.busy,false);assert.equal(f.avaliacao.estado().busy,false);
});

test('avaliação runtime: registro malformado falha fechado sem derrubar consulta de estado',t=>{
  const f=fixture(t);f.db.prepare("INSERT INTO desktop_config VALUES('pessoal-avaliacao',?)").run(JSON.stringify({modelo:MODELO,resultados:{invalido:true}}));
  assert.doesNotThrow(()=>f.avaliacao.estado());assert.equal(f.avaliacao.estado().liberada,false);
});

test('avaliação runtime: claim persistido sobrevive à reabertura e impede replay enquanto lease vigora',async t=>{
  const f=fixture(t);await f.avaliacao.iniciar({confirmar:true});let liberar;
  f.chatgpt.responder=()=>new Promise(resolve=>{liberar=resolve;});const pendente=f.avaliacao.proximo(),db2=abrirBanco(f.path);
  try{
    const nova=new AvaliacaoPessoal(db2,{chatgpt:f.chatgpt,instrucoes:INSTRUCOES});assert.equal(nova.estado().busy,true);
    await assert.rejects(()=>nova.proximo(),/em curso/);assert.ok(row(db2).lease.token);
  }finally{db2.close();liberar({completed:true,model:MODELO,requestId:'mock-claim-persistido',text:'resultado fictício'});await pendente;}
});

test('avaliação runtime: lease expirado não autoriza resposta antiga a apagar revisão nova',async t=>{
  const f=fixture(t);let agora=Date.parse('2026-10-26T10:00:00Z');
  f.avaliacao=new AvaliacaoPessoal(f.db,{chatgpt:f.chatgpt,instrucoes:INSTRUCOES,agora:()=>new Date(agora)});
  await f.avaliacao.iniciar({confirmar:true});await f.avaliacao.proximo();let liberar;
  f.chatgpt.responder=()=>new Promise(resolve=>{liberar=resolve;});const pendente=f.avaliacao.proximo(),conclusao=pendente.then(()=>({ok:true}),error=>({ok:false,error}));
  const db2=abrirBanco(f.path);
  try{
    agora+=180001;const outra=new AvaliacaoPessoal(db2,{chatgpt:f.chatgpt,instrucoes:INSTRUCOES,agora:()=>new Date(agora)});
    const r=row(db2).resultados[0];outra.revisar({id:r.id,digest:r.digest,interpretacao:true,fontes:true,resposta:true,criticoAtendido:true,revisadoPor:'Revisor fictício',evidencia:'Revisão nova feita após expiração do lease do outro processo.'});
    liberar({completed:true,model:MODELO,requestId:'mock-resposta-antiga',text:'Retorno antigo após expiração'});await conclusao;
    assert.ok(row(db2).resultados[0].revisao,'Resposta antiga não pode apagar uma revisão persistida após expiração.');
  }finally{db2.close();}
});
