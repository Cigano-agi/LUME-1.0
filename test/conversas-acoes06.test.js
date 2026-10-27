import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {AcoesLume,contarAcoesLumePorConversa,resumoAcoesLume} from '../src/acoes-lume.js';
import {VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';

function setup(t,{close=true}={}){
  const db=abrirBanco(':memory:');if(close)t.after(()=>db.close());
  const f=perfilGrafo(db),clock={now:new Date()},acoes=new AcoesLume(db,{agora:()=>clock.now});
  let seq=0;
  function add(conversa='ana',n=2){
    f.conversa(conversa,'Conversa '+conversa);acoes.autorizar({conversa,permitida:true});
    const trechos=Array.from({length:n},()=>`Preparar documento sintético ${++seq}.`);
    const eventoId=f.evento(conversa,'pessoa',{texto:trechos.join(' '),permissao:'dirigida'});
    acoes.registrar({eventoId,candidatas:trechos.map(trecho=>({fonte:'E'+eventoId,tipo:'pendencia',resumo:'Preparar documento',trecho,prazo_citado:''}))});
    return {eventoId,ids:acoes.listar({conversa,limite:100}).filter(a=>a.evento_id===eventoId).map(a=>a.id)};
  }
  function count(conversa,expected){
    const d=f.desktop.conversaDetalhe({conversa});assert.equal(d.acoes06,expected);assert.equal(d.acoes,expected+d.acoesLegadas);
    const row=f.desktop.carteira({q:'Conversa '+conversa}).conversas.find(c=>c.id===conversa);
    assert.equal(row.acoes06,expected);assert.equal(row.acoes,d.acoes);
    assert.equal(acoes.listar({estado:'ativos',conversa,limite:100}).length,Math.min(expected,100));
    assert.equal(contarAcoesLumePorConversa(db,{conversa})[0]?.total||0,expected);
    assert.equal(f.desktop.carteira({filtro:'acoes'}).conversas.some(c=>c.id===conversa),d.acoes>0);
  }
  return {...f,db,acoes,clock,add,count};
}

test('Conversas conta duas ações 0.6 na lista, filtro e detalhe sem itens legados',t=>{
  const f=setup(t);f.add();f.count('ana',2);
  const d=f.desktop.conversaDetalhe({conversa:'ana'});assert.equal(d.acoesLegadas,0);assert.deepEqual(d.tarefas,[]);
  assert.equal(f.desktop.carteira({filtro:'oportunidades'}).pagina.total,0);
  assert.equal(resumoAcoesLume(f.db).total,2);
});

test('mais de 100 ações alheias não consomem limite da conversa exata',t=>{
  const f=setup(t),target=f.add('ana');
  for(let i=0;i<6;i++)f.add('outra-'+i,20);
  f.db.prepare("UPDATE lume_acoes SET atualizada_em='2099-01-01T00:00:00.000Z' WHERE evento_id<>?").run(target.eventoId);
  assert.equal(f.acoes.listar({estado:'ativos',limite:100}).some(a=>a.conversa_id==='ana'),false);
  const selected=f.acoes.listar({estado:'ativos',conversa:'ana',limite:100});
  assert.deepEqual(new Set(selected.map(a=>a.id)),new Set(target.ids));f.count('ana',2);
  assert.equal(f.acoes.listar({estado:'ativos',conversa:'an%',limite:100}).length,0);
  assert.equal(f.acoes.listar({estado:'ativos',conversa:"ana' OR 1=1 --"}).length,0);
  assert.equal(f.acoes.listar({estado:'ativos',conversa:' ANA '}).length,0);
});

test('legado e atuais mantêm identidades distintas mesmo com resumo igual',t=>{
  const f=setup(t),{eventoId}=f.add();
  const origem=f.db.prepare('SELECT origem_id FROM eventos WHERE id=?').get(eventoId).origem_id;
  f.db.prepare("INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em) VALUES('ana',?,'pendencia','Preparar documento','2026-09-26')").run(origem);
  f.count('ana',2);const d=f.desktop.conversaDetalhe({conversa:'ana'});
  assert.equal(d.acoes,3);assert.equal(d.acoesLegadas,1);assert.equal(d.paginaAcoes.total,1);
  assert.equal(d.tarefas[0].resumo,'Preparar documento');assert.equal(new Set(f.acoes.listar().map(a=>a.id)).size,2);
  f.desktop.resolver({id:d.tarefas[0].id});f.count('ana',2);
});

test('sugeridas, confirmadas e estacionadas vencidas usam os mesmos estados da fila',t=>{
  const f=setup(t),{ids}=f.add('ana',6);
  f.acoes.revisar({id:ids[1],acao:'confirmar'});
  f.acoes.revisar({id:ids[2],acao:'confirmar'});f.acoes.revisar({id:ids[2],acao:'resolver'});
  f.acoes.revisar({id:ids[3],acao:'descartar'});
  f.acoes.revisar({id:ids[4],acao:'estacionar',lembrarEm:'2099-01-01T00:00:00.000Z',fuso:'America/Sao_Paulo'});
  f.clock.now=new Date(Date.now()-60000);
  f.acoes.revisar({id:ids[5],acao:'estacionar',lembrarEm:new Date(Date.now()-30000).toISOString(),fuso:'America/Sao_Paulo'});
  f.clock.now=new Date();f.count('ana',3);assert.equal(resumoAcoesLume(f.db).total,3);
  assert.equal(f.acoes.listar({estado:'resolvido',conversa:'ana'}).length,1);
  assert.equal(f.acoes.listar({estado:'estacionado',conversa:'ana'}).length,2);
  f.acoes.definirMinha({id:ids[0],minha:true});assert.equal(f.acoes.listar({estado:'minhas',conversa:'ana'}).length,1);
  f.acoes.revisar({id:ids[2],acao:'reabrir'});f.count('ana',4);
});

test('fonte editada, permissão retirada e nova autorização não expõem derivados antigos',t=>{
  const f=setup(t),{eventoId}=f.add();f.count('ana',2);
  f.db.prepare("UPDATE eventos SET texto='Texto corrigido' WHERE id=?").run(eventoId);f.count('ana',0);
  assert.ok(!JSON.stringify(f.acoes.listar({estado:'ativos',conversa:'ana'})).includes('documento'));
  f.add('ana',1);f.count('ana',1);
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE conversa_id='ana'").run();
  f.count('ana',0);
  assert.ok(f.desktop.carteira().conversas.some(c=>c.id==='ana'),'a conversa local segue legível');
  assert.deepEqual(f.acoes.listar({estado:'ativos',conversa:'ana'}),[],'ações com assinatura antiga não reaparecem');
  f.db.prepare('UPDATE eventos SET permissao=NULL WHERE conversa_id=\'ana\'').run();
  assert.equal(f.desktop.carteira().pagina.total,0);assert.throws(()=>f.desktop.conversaDetalhe({conversa:'ana'}),/indisponível/);
  assert.deepEqual(f.acoes.listar({estado:'ativos',conversa:'ana'}),[]);assert.deepEqual(contarAcoesLumePorConversa(f.db),[]);
  f.acoes.autorizar({conversa:'ana',permitida:false});f.acoes.autorizar({conversa:'ana',permitida:true});
  assert.deepEqual(f.acoes.listar({estado:'ativos',conversa:'ana'}),[]);
  f.db.prepare("UPDATE eventos SET permissao='dirigida' WHERE conversa_id='ana'").run();f.count('ana',0);
  f.add('ana',1);f.count('ana',1);
});

test('procedência compartilhada é obrigatória também para contagens e consulta exata',t=>{
  const f=setup(t),{eventoId}=f.add();
  const candidatas=f.acoes.listar().map(a=>({fonte:'E'+eventoId,tipo:a.tipo,resumo:a.resumo,trecho:a.trecho,prazo_citado:a.prazo_citado}));
  f.db.prepare("UPDATE eventos SET permissao='compartilhado' WHERE id=?").run(eventoId);
  assert.deepEqual(contarAcoesLumePorConversa(f.db),[]);
  f.db.exec(`INSERT INTO f10_projetos VALUES('x','Teste','2026-09-26'); INSERT INTO f10_origens VALUES('f','Teste','m','k');
    INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em) VALUES(${eventoId},'f','p','x','2026-09-26','2026-09-26')`);
  // Mudar permissão também muda a assinatura: os derivados anteriores continuam inválidos.
  f.count('ana',0);f.acoes.registrar({eventoId,candidatas});f.count('ana',2);
  f.db.exec('DELETE FROM f10_procedencias');assert.deepEqual(contarAcoesLumePorConversa(f.db),[]);
  assert.deepEqual(f.acoes.listar({estado:'ativos',conversa:'ana'}),[]);
});

test('mensagem nova não suspende ações nem interpreta cancelamento',t=>{
  const f=setup(t);f.add();f.evento('ana','pessoa',{texto:'Cancelo o projeto anterior.'});f.count('ana',2);
});

test('consulta recusa conversa inválida sem cair para a lista global',t=>{
  const f=setup(t);f.add();
  for(const conversa of ['', ' ',null,7,[],{},'x'.repeat(201)]){
    assert.throws(()=>f.acoes.listar({estado:'ativos',conversa}),/Filtro/);
    assert.throws(()=>contarAcoesLumePorConversa(f.db,{conversa}),/Filtro/);
  }
  assert.throws(()=>f.acoes.listar({estado:''}),/Filtro/);
});

test('HTTP aceita conversa exata e rejeita query inválida/duplicada mantendo sessão',async t=>{
  const f=setup(t,{close:false});f.add();f.add('outra');
  f.desktop.aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
  const server=criarServidor(f.db,{contexto:f.contexto,desktop:true});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));f.db.close();});
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/sessao')).json();
  const headers={'x-assessor-token':token};
  const selected=await fetch(base+'/api/v3/acoes?estado=ativos&conversa=ana',{headers});assert.equal(selected.status,200);
  const value=await selected.json();assert.equal(value.acoes.length,2);assert.ok(value.acoes.every(a=>a.conversa_id==='ana'));
  assert.equal((await fetch(base+'/api/v3/acoes?conversa=ana')).status,403);
  for(const query of ['conversa=','conversa=%20','conversa='+('x'.repeat(201)),'conversa=ana&conversa=outra','conversa=ana&extra=1','estado=','estado=desconhecido','limite=0','limite=101','limite=NaN']){
    const response=await fetch(base+'/api/v3/acoes?'+query,{headers});assert.equal(response.status,400,query);
    const error=await response.json();assert.equal(typeof error.erro,'string');assert.equal(error.acoes,undefined);
  }
  f.acoes.autorizar({conversa:'ana',permitida:false});
  const revoked=await(await fetch(base+'/api/v3/acoes?estado=ativos&conversa=ana',{headers})).json();assert.deepEqual(revoked.acoes,[]);
});
