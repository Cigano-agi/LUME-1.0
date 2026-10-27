import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {OrganizacaoPessoal} from '../src/pessoal/organizacao.js';
import {ExperienciaLume} from '../src/experiencia-lume.js';
import {criarServidor} from '../src/painel/servidor.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {pessoalPost} from '../src/pessoal/http.js';

function setup(t,{group=false}={}) {
 const db=abrirBanco(':memory:');t.after(()=>db.close());new ContextoApp(db);const produto=new Desktop(db),org=new OrganizacaoPessoal(db);
 produto.aceitar({nome:'Revisão isolada fictícia',aceito:true,versao:VERSAO_TERMOS});
 const conversa=group?'550000000001@g.us':'550000000001@s.whatsapp.net',texto='Entregar revisão do catálogo na sexta.';
 db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(conversa,'Nome duplicável');
 const evento=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada',?,0,'texto','{}',?,'2026-10-26T12:00:00.000Z','2026-10-26','dirigida')`).run(conversa,'review',conversa,texto).lastInsertRowid);
 const acao=org.contexto.registrarDemanda({eventoId:evento,resumo:'Revisar catálogo',trecho:texto,tipo:'pendencia'}).acaoId;
 const pessoal={ativa:()=>true,politica:org.politica,organizacao:org};
 const service=new ExperienciaLume(db,{acoes:org.acoes,produto,organizacao:org,pessoal});
 return {db,produto,org,service,evento,acao,conversa,pessoal};
}
for(const action of ['permission','delete','exclude','text'])test('review: '+action+' remove lista, detalhe e companhia',t=>{
 const f=setup(t);assert.equal(f.service.obter('acao:'+f.acao).itens.length,1);
 if(action==='permission')f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(f.evento);
 if(action==='delete')f.db.prepare('DELETE FROM eventos WHERE id=?').run(f.evento);
 if(action==='text')f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte substituída',f.evento);
 if(action==='exclude')f.org.politica.controlar({conversaId:f.conversa,acao:'excluir'});
 assert.deepEqual(f.service.listar().itens,[]);assert.deepEqual(f.service.obter('acao:'+f.acao).itens,[]);assert.equal(f.service.companheiro(),null);
});
test('review: grupos preservam leitura sem autorização de envio',t=>{
 const f=setup(t,{group:true});assert.equal(f.service.listar().itens.length,1);
 assert.equal(f.org.politica.podeEnviar(f.conversa).permitido,false);
 assert.throws(()=>f.org.politica.configurar({conversaId:f.conversa,categoria:'vip_client',modo:'atender',remoto:true}));
 assert.ok(f.service.listar().itens[0].acoes.every(a=>['abrir','fonte','acao'].includes(a.tipo)));
});
test('review: renomear pessoa mantém identidade do assunto e não confirma entrega',t=>{
 const f=setup(t),before=f.service.listar().itens[0];f.db.prepare('UPDATE conversas_app SET nome=? WHERE id=?').run('Outro nome',f.conversa);
 const after=f.service.obter(before.id).itens[0];assert.equal(after.id,before.id);assert.equal(after.pessoas[0].nome,'Outro nome');
 assert.equal(after.entrega.enviada,null);assert.equal(after.entrega.aceita,null);assert.equal(after.prazo,null);
});
test('review: acompanhar exige confirmação e fonte vigente; preparar guarda só pendente e revalida pausa',async t=>{
 const f=setup(t),calls=[];
 const forbidden=()=>{calls.push('external');throw Error('Forbidden');};
 const pessoal=new LumePessoal(f.db,{desktop:f.produto,conexao:{enviarTexto:forbidden},chatgpt:{encerrar(){}},fetchImpl:forbidden});
 f.db.prepare('INSERT INTO desktop_config VALUES(?,?)').run('pessoal-enabled','1');
 pessoal.configurarConversa({conversaId:f.conversa,categoria:'vip_client',modo:'rascunhar',remoto:true});
 await assert.rejects(()=>pessoalPost(pessoal,'/api/v3/pessoal/acompanhamento',{acaoId:f.acao,confirmar:false}));
 await assert.rejects(()=>pessoalPost(pessoal,'/api/v3/pessoal/acompanhamento',{acaoId:f.acao,confirmar:true,enviar:true}));
 const follow=await pessoalPost(pessoal,'/api/v3/pessoal/acompanhamento',{acaoId:f.acao,confirmar:true});assert.equal(follow.registrado,true);
 const data={conversaId:f.conversa,baloes:['Sou Lume, assistente. Resposta fictícia para revisão.'],motivo:'Texto redigido pelo dono para testar o fluxo isolado.'};
 const prepared=await pessoalPost(pessoal,'/api/v3/pessoal/mensagem/preparar',data);assert.equal(prepared.estado,'pendente');
 assert.equal(f.db.prepare('SELECT aprovada_em FROM pessoal_propostas WHERE id=?').get(prepared.id).aprovada_em,null);assert.deepEqual(calls,[]);
 pessoal.configurarAtendimento({conversaId:f.conversa,acao:'pausar',minutos:60});
 await assert.rejects(()=>pessoalPost(pessoal,'/api/v3/pessoal/mensagem/preparar',data));
 assert.equal(f.db.prepare('SELECT estado FROM pessoal_propostas WHERE id=?').get(prepared.id).estado,'cancelada');
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(f.evento);
 await assert.rejects(()=>pessoalPost(pessoal,'/api/v3/pessoal/acompanhamento',{acaoId:f.acao,confirmar:true}));assert.deepEqual(calls,[]);
 await pessoal.encerrar();
});
test('review: rota nova não inicia acompanhamento de pessoa excluída da projeção',async t=>{
 const f=setup(t),pessoal=new LumePessoal(f.db,{desktop:f.produto,chatgpt:{encerrar(){}}});
 pessoal.configurarConversa({conversaId:f.conversa,categoria:'vip_client',modo:'rascunhar',remoto:true});
 pessoal.configurarAtendimento({conversaId:f.conversa,acao:'excluir'});
 assert.equal(pessoal.politica.regra(f.conversa).atendimento.excluida,true);
 const projection=new ExperienciaLume(f.db,{acoes:pessoal.contexto.acoes,produto:f.produto,organizacao:pessoal.organizacao,pessoal});
 assert.deepEqual(projection.listar().itens,[]);
 await assert.rejects(()=>pessoalPost(pessoal,'/api/v3/pessoal/acompanhamento',{acaoId:f.acao,confirmar:true}));
 assert.equal(f.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get('pessoal-acompanhamento:'+f.acao),undefined);
 await pessoal.encerrar();
});
for(const timing of ['before','during','source-revoked','source-edited'])test('review: acompanhamento registrado revalida '+timing+' da consulta e resumo',async t=>{
 const f=setup(t),scheduled=[],reads=[];
 const pessoal=new LumePessoal(f.db,{desktop:f.produto,chatgpt:{encerrar(){},responder:()=>{throw Error('Model forbidden');}},telegram:{agendar:(key,text,meta)=>{scheduled.push({key,text,meta});return true;}}});
 t.after(()=>pessoal.encerrar());
 f.db.prepare('INSERT INTO desktop_config VALUES(?,?)').run('pessoal-enabled','1');
 pessoal.configurarConversa({conversaId:f.conversa,categoria:'vip_client',modo:'rascunhar',remoto:true});
 pessoal.acompanhar(f.acao);
 f.db.prepare('UPDATE desktop_config SET valor=? WHERE chave=?').run(JSON.stringify({proxima:'2000-01-01T00:00:00.000Z',anterior:'different'}),'pessoal-acompanhamento:'+f.acao);
 const exclude=()=>pessoal.configurarAtendimento({conversaId:f.conversa,acao:'excluir'});
 if(timing==='before')exclude();
 pessoal.ferramentas.consultar=async()=>{reads.push(true);if(timing==='during')exclude();
  if(timing==='source-revoked')f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(f.evento);
  if(timing==='source-edited')f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto substituído durante consulta',f.evento);
  return [];};
 await pessoal.tick();
 if(timing==='before')assert.deepEqual(reads,[]);else assert.equal(reads.length,1);
 assert.equal(scheduled.some(s=>s.key.startsWith('acompanhamento:')),false,'invalidated subject must not enter outgoing notification queue');
 assert.ok(scheduled.filter(s=>s.key.startsWith('resumo:')).every(s=>!s.meta.fontes.some(source=>source.id===f.evento)&&!s.text.includes('Revisar catálogo')));
});
test('review: HTTP exige sessão/origem, recusa campos extras e GET funciona com SQLite query_only',async t=>{
 const f=setup(t);const server=criarServidor(f.db,{desktop:true,pessoal:f.pessoal,conexao:{estado:()=>({estado:'desconectada'})}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 try{
  const sessao=await(await fetch(origin+'/api/sessao')).json(),headers={'x-assessor-token':sessao.token};assert.ok(sessao.token);
  assert.equal((await fetch(origin+'/api/v3/experiencia')).status,403);
  assert.equal((await fetch(origin+'/api/v3/experiencia',{headers:{...headers,origin:'https://invalid.example'}})).status,403);
  assert.equal((await fetch(origin+'/api/v3/experiencia?enviar=true',{headers})).status,400);
  f.db.exec('PRAGMA query_only = ON');const before=f.db.prepare('SELECT total_changes() n').get().n;
  for(const path of ['/api/v3/experiencia','/api/v3/experiencia?id=acao:'+f.acao,'/api/v3/busca?pessoa='+encodeURIComponent(f.conversa)]){
   const response=await fetch(origin+path,{headers});assert.equal(response.status,200,path);await response.json();
  }
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 }finally{f.db.exec('PRAGMA query_only = OFF');await server.encerrar();}
});
