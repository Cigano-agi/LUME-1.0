import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {prepararEsquemaCrm} from '../src/crm.js';
import {OrganizacaoPessoal} from '../src/pessoal/organizacao.js';
import {lerFontesVendas,hashFontesVendas,revisaoVendas} from '../src/vendas/recorte.js';

const DM='550000000001@s.whatsapp.net',OUTRA='550000000002@s.whatsapp.net';
const TEXTO='Pode preparar o plano de implantação do projeto da loja?';
function fixture(t) {
  const db=abrirBanco();t.after(()=>db.close());prepararEsquemaCrm(db);new ContextoApp(db);
  let now=new Date('2026-10-26T12:00:00Z'),seq=0;
  const org=new OrganizacaoPessoal(db,{agora:()=>now});
  db.exec('CREATE TABLE IF NOT EXISTS desktop_ia_conversas(conversa_id TEXT PRIMARY KEY,permitida INTEGER,decidido_em TEXT)');
  for(const id of [DM,OUTRA]) {
    db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,'Pessoa homônima');
    org.politica.configurar({conversaId:id,categoria:'lead',modo:'rascunhar',remoto:true});
    db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,1,?)').run(id,now.toISOString());
  }
  const evento=(texto=TEXTO,{conversaId=DM,tipoLote='notify',permissao='dirigida',direcao='entrada'}={})=>{
    now=new Date(now.getTime()+1000);
    return Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES(?,?,?,?,0,'texto',?,?,?,'2026-10-26',?)`).run(conversaId,'sintetica-'+(++seq),direcao,conversaId,JSON.stringify({tipoLote}),texto,now.toISOString(),permissao).lastInsertRowid);
  };
  const demanda=(eventoId,{trecho,resumo='Preparar plano de implantação',tipo='pendencia'}={})=>{
    trecho??=db.prepare('SELECT texto FROM eventos WHERE id=?').get(eventoId).texto;
    return org.contexto.registrarDemanda({eventoId,resumo,trecho,tipo}).acaoId;
  };
  const avaliar=(eventoId,{assunto='projeto',andamento='planejado',continuidade='novo_assunto',...extra}={})=>{
    const conversaId=db.prepare('SELECT conversa_id FROM eventos WHERE id=?').get(eventoId).conversa_id;
    const fontes=lerFontesVendas(db,conversaId),assinatura=hashFontesVendas(fontes),id=randomUUID();now=new Date(now.getTime()+1);
    const escolha=valor=>typeof valor==='string'?{valor,confianca:.9}:valor;
    const result={id,eventoId,origem:'jev',modelo:'typesafe/jev-1.14',avaliado_em:now.toISOString(),fontes:fontes.map(f=>f.id),
      temperatura:'quente',etapa:'fechado',assunto:escolha(assunto),andamento:escolha(andamento),
      continuidade:escolha(continuidade),somenteSugestao:true,desatualizada:false,
      recorte:{assinatura_janela:assinatura,revisao:revisaoVendas(db,conversaId)},...extra};
    db.prepare('INSERT INTO lume_vendas_avaliacoes VALUES(?,?,?,?,?)').run(id,conversaId,assinatura,JSON.stringify(result),result.avaliado_em);
    return id;
  };
  const preparar=(options={})=>{const eventoId=evento(options.texto??TEXTO,options),acaoId=demanda(eventoId,options),avaliacaoId=avaliar(eventoId,options);return {acaoId,avaliacaoId,conversaId:options.conversaId??DM};};
  const n=table=>db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  return {db,org,evento,demanda,avaliar,preparar,n,agora:()=>now};
}
const itens=view=>[...view.comercial,...view.tarefas,...view.projetos];

test('demanda e avaliação atuais criam somente rascunho incerto, sem negócio, pasta, grant ou envio',t=>{
  const f=fixture(t),p=f.preparar();
  const antes={politicas:f.db.prepare('SELECT * FROM pessoal_politicas').all(),grants:f.n('autorizacoes'),acoes:f.n('lume_acoes')};
  const r=f.org.organizar(p);
  assert.equal(r.projetoCriado,true);assert.equal(r.item.projeto.estado,'rascunho');assert.equal(r.item.projeto.natureza,'incerto');
  assert.equal(r.item.projeto.acordoVerificado,false);assert.equal(r.item.avaliacao.etapa,'fechado');
  assert.equal(r.item.fonte.trecho,TEXTO);assert.equal(r.item.grupo,'projetos');
  for(const table of ['desktop_negocios','projetos','conversa_projetos','saidas','pessoal_propostas'])assert.equal(f.n(table),0,table);
  assert.equal(f.n('autorizacoes'),antes.grants);assert.equal(f.n('lume_acoes'),antes.acoes);
  assert.deepEqual(f.db.prepare('SELECT * FROM pessoal_politicas').all(),antes.politicas);
  assert.equal(f.org.projetos.obter(r.item.projeto.id).fontes.length,1);
});

test('assunto comercial/tarefa sozinho não cria negócio nem projeto; visão conserva fontes e incerteza',t=>{
  const f=fixture(t),p=f.preparar({assunto:'comercial',continuidade:'incerto'}),r=f.org.organizar(p);
  assert.equal(r.projetoCriado,false);assert.equal(r.item.grupo,'comercial');assert.equal(r.item.negocio,null);
  assert.ok(r.item.incerteza.includes('continuidade_incerta'));assert.equal(f.n('desktop_negocios'),0);assert.equal(f.n('lume_projetos_comerciais'),0);
  const a=f.org.acoes.obter(p.acaoId);p.avaliacaoId=f.avaliar(a.evento_id,{assunto:'tarefa',andamento:'insuficiente'});
  assert.equal(f.org.organizar(p).item.grupo,'tarefas');assert.equal(f.org.listar({conversaId:DM}).tarefas.length,1);
  assert.throws(()=>f.org.organizar({avaliacaoId:p.avaliacaoId,conversaId:DM}));
  assert.throws(()=>f.org.organizar({...p,assunto:'projeto'}),{code:'ORGANIZACAO_INVALIDA'});
  assert.equal(f.n('lume_projetos_comerciais'),0);
});

test('replay, nova instância e revisão humana preservam ID, resumo corrigido e estado arquivado/confirmado',t=>{
  const f=fixture(t),p=f.preparar(),r=f.org.organizar(p),id=r.item.projeto.id;
  f.org.acoes.corrigir({id:p.acaoId,resumo:'Descrição conferida pelo dono'});
  const total=f.n('lume_projetos_historico');
  let replay=new OrganizacaoPessoal(f.db,{agora:f.agora}).organizar(p);
  assert.equal(replay.projetoCriado,false);assert.equal(replay.item.projeto.id,id);assert.equal(replay.item.resumo,'Descrição conferida pelo dono');
  assert.equal(f.n('lume_projetos_historico'),total);
  f.org.projetos.confirmar({id,confirmar:true});replay=f.org.organizar(p);assert.equal(replay.item.projeto.estado,'confirmado');
  f.org.projetos.arquivar({id});replay=f.org.organizar(p);assert.equal(replay.item.projeto.estado,'arquivado');assert.equal(replay.projetoCriado,false);
  assert.equal(f.n('lume_projetos_comerciais'),1);
});

test('homônimos não vinculam projetos; somente ID com vínculo literal existente pode ser reutilizado',t=>{
  const f=fixture(t),a=f.preparar({conversaId:OUTRA}),pa=f.org.organizar(a).item.projeto;
  const b=f.preparar();
  assert.throws(()=>f.org.organizar({...b,projetoId:pa.id}),{code:'PROJETO_INDISPONIVEL'});
  assert.throws(()=>f.org.organizar({...b,projetoId:randomUUID()}),{code:'PROJETO_INDISPONIVEL'});
  assert.throws(()=>f.org.organizar({...b,conversaId:OUTRA}),{code:'DEMANDA_INDISPONIVEL'});
  const pb=f.org.organizar(b).item.projeto;assert.notEqual(pb.id,pa.id);
  assert.equal(f.org.organizar({...b,projetoId:pb.id}).item.projeto.id,pb.id);
  assert.equal(f.org.listar({conversaId:DM}).projetos.length,1);
  assert.ok(itens(f.org.listar({conversaId:DM})).every(x=>x.conversaId===DM));
});

test('avaliação de outra conversa, antiga ou baseada em outra entrada não autoriza organização',t=>{
  const f=fixture(t),a=f.preparar(),b=f.preparar({conversaId:OUTRA});
  assert.throws(()=>f.org.organizar({...a,avaliacaoId:b.avaliacaoId}),{code:'AVALIACAO_INDISPONIVEL'});
  const e=f.org.acoes.obter(a.acaoId).evento_id,current=f.avaliar(e,{assunto:'tarefa'});
  assert.throws(()=>f.org.organizar(a),{code:'AVALIACAO_INDISPONIVEL'});
  assert.equal(f.org.organizar({...a,avaliacaoId:current}).item.grupo,'tarefas');
  const next=f.evento('Outro assunto: pode revisar o contrato novo?');const newest=f.avaliar(next);
  assert.throws(()=>f.org.organizar({...a,avaliacaoId:newest}),{code:'AVALIACAO_INDISPONIVEL'});
  assert.equal(f.n('lume_projetos_comerciais'),0);
});

test('fonte alterada invalida demanda e projeto; nova extração não duplica a mesma origem',t=>{
  const f=fixture(t),p=f.preparar(),r=f.org.organizar(p),id=r.item.eventoId;
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Pode preparar um plano diferente para o projeto da loja?',id);
  assert.throws(()=>f.org.organizar(p),{code:'DEMANDA_INDISPONIVEL'});assert.equal(itens(f.org.listar()).length,0);
  const atual={acaoId:f.demanda(id),avaliacaoId:f.avaliar(id),conversaId:DM},next=f.org.organizar(atual);
  assert.equal(next.projetoCriado,false);assert.equal(next.item.projeto,null);
  assert.equal(next.candidato.motivo,'origem_ja_organizada_requer_revisao');assert.equal(f.n('lume_projetos_comerciais'),1);
  assert.equal(f.org.projetos.obter(r.item.projeto.id),null);
});

test('ausência, revogação e exclusão retiram conteúdo da visão sem reaproveitar avaliação antiga',async t=>{
  for(const modo of ['remover','revogar','excluir'])await t.test(modo,child=>{
    const f=fixture(child),p=f.preparar(),r=f.org.organizar(p);
    if(modo==='remover')f.db.prepare('DELETE FROM eventos WHERE id=?').run(r.item.eventoId);
    if(modo==='revogar')f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(r.item.eventoId);
    if(modo==='excluir')f.org.politica.controlar({conversaId:DM,acao:'excluir'});
    assert.equal(itens(f.org.listar()).length,0);assert.throws(()=>f.org.organizar(p),{code:'DEMANDA_INDISPONIVEL'});
  });
});

test('revogar fonte de contexto ou autorização de IA remove classificação, sem apagar ação local',async t=>{
  for(const modo of ['contexto','remoto','permissao_ia'])await t.test(modo,child=>{
    const f=fixture(child),extra=f.evento('Contexto comercial permitido.'),p=f.preparar({assunto:'comercial'});
    if(modo==='contexto')f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(extra);
    if(modo==='remoto')f.org.politica.configurar({conversaId:DM,categoria:'lead',modo:'rascunhar',remoto:false});
    if(modo==='permissao_ia')f.db.prepare('UPDATE desktop_ia_conversas SET permitida=0 WHERE conversa_id=?').run(DM);
    assert.throws(()=>f.org.organizar(p),{code:'AVALIACAO_INDISPONIVEL'});
    const [item]=itens(f.org.listar());assert.equal(item.acaoId,p.acaoId);assert.equal(item.avaliacao,null);assert.equal(item.grupo,'tarefas');
  });
});

test('literal inexistente ou repetido não pode entrar pela organização mesmo em registro adulterado',async t=>{
  for(const trecho of ['Citação inventada de uma promessa.','preparar'])await t.test(trecho,child=>{
    const f=fixture(child),p=f.preparar({texto:'Pode preparar o plano e preparar a revisão do projeto?'});
    f.db.prepare('UPDATE lume_acoes SET trecho=?,trecho_inicio=0 WHERE id=?').run(trecho,p.acaoId);
    assert.throws(()=>f.org.organizar(p),{code:'DEMANDA_INDISPONIVEL'});
    assert.equal(itens(f.org.listar()).length,0);assert.equal(f.n('lume_projetos_comerciais'),0);
  });
});

test('backlog, pausa manual e nova ativação devolvem candidato sem criar projeto retroativo',async t=>{
  for(const modo of ['historico','pausada','ativada','descartada'])await t.test(modo,child=>{
    const f=fixture(child),p=f.preparar({tipoLote:modo==='historico'?'history':'notify'});
    if(modo==='pausada')f.org.politica.pausar(DM);
    if(modo==='ativada')f.org.politica.controlar({conversaId:DM,acao:'ativar'});
    if(modo==='descartada')f.org.acoes.revisar({id:p.acaoId,acao:'descartar'});
    const r=f.org.organizar(p);assert.equal(r.projetoCriado,false);assert.equal(r.candidato.motivo,'demanda_sem_ativacao_atual');
    assert.equal(f.n('lume_projetos_comerciais'),0);assert.equal(f.n('saidas'),0);
  });
});

test('correção comercial manual substitui avaliação Jev sem promover negócio ou projeto',t=>{
  const f=fixture(t),p=f.preparar({assunto:'comercial'});f.org.organizar(p);
  const manual=f.org.vendas.corrigir({conversa_id:DM,temperatura:'frio',etapa:'encerrado',confirmar:true});
  assert.throws(()=>f.org.organizar(p),{code:'AVALIACAO_INDISPONIVEL'});
  const r=f.org.organizar({...p,avaliacaoId:manual.id});assert.equal(r.item.avaliacao.origem,'manual');assert.equal(r.item.avaliacao.temperatura,'frio');
  assert.equal(r.projetoCriado,false);assert.equal(f.n('desktop_negocios'),0);assert.equal(f.n('lume_projetos_comerciais'),0);
});

test('negócio confirmado permanece separado da sugestão e só aparece para sua fonte exata',t=>{
  const f=fixture(t),p=f.preparar({assunto:'comercial'}),e=f.org.acoes.obter(p.acaoId).evento_id;
  const previa=f.org.negocios.preparar({fonte:e}),saved=f.org.negocios.salvar({previa:previa.id,confirmar:true,titulo:'Revisado',etapa:'proposta'});
  const r=f.org.organizar(p);assert.equal(r.item.avaliacao.etapa,'fechado');assert.equal(r.item.negocio.etapa,'proposta');assert.equal(r.item.negocio.id,saved.id);
  assert.equal(f.org.negocios.listar().negocios[0].etapa,'proposta');
});

test('dois vínculos prévios sobre a fonte exigem escolha exata e nunca agregam por semelhança',t=>{
  const f=fixture(t),p=f.preparar(),eventoId=f.org.acoes.obter(p.acaoId).evento_id;
  const a=f.org.projetos.criarRascunho({nome:'Mesmo nome',fontes:[{eventoId}],chave:'manual-a'});
  f.org.projetos.criarRascunho({nome:'Mesmo nome',fontes:[{eventoId}],chave:'manual-b'});
  const r=f.org.organizar(p);assert.equal(r.candidato.motivo,'vinculo_ambiguo');assert.equal(r.projetoCriado,false);assert.equal(f.n('lume_projetos_comerciais'),2);
  assert.equal(f.org.organizar({...p,projetoId:a.id}).item.projeto.id,a.id);
});

test('listar é leitura: não cria projetos, respeita limite e mantém fonte literal em cada grupo',t=>{
  const f=fixture(t);f.preparar({conversaId:DM});f.preparar({conversaId:OUTRA,assunto:'tarefa'});
  const before=f.db.prepare('SELECT total_changes() n').get().n,view=f.org.listar({limite:1});
  assert.equal(itens(view).length,1);assert.equal(view.truncada,true);assert.equal(f.n('lume_projetos_comerciais'),0);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  assert.throws(()=>f.org.listar({limite:0}));assert.throws(()=>f.org.listar({limite:101}));
});

test('falha durante gravação faz rollback do rascunho inteiro e permite tentativa íntegra',t=>{
  const f=fixture(t),p=f.preparar();
  f.db.exec("CREATE TRIGGER falha_sintetica BEFORE INSERT ON lume_projetos_fontes BEGIN SELECT RAISE(ABORT,'falha de fixture'); END;");
  assert.throws(()=>f.org.organizar(p),/falha de fixture/);assert.equal(f.n('lume_projetos_comerciais'),0);assert.equal(f.n('lume_projetos_historico'),0);
  f.db.exec('DROP TRIGGER falha_sintetica');assert.equal(f.org.organizar(p).projetoCriado,true);
});

test('novo assunto na mesma conversa gera origem separada sem anexar ao projeto anterior',t=>{
  const f=fixture(t),a=f.preparar(),primeiro=f.org.organizar(a).item;
  const b=f.preparar({texto:'Outro assunto: pode planejar o projeto da clínica?',resumo:'Plano da clínica',continuidade:'novo_assunto'}),segundo=f.org.organizar(b).item;
  assert.notEqual(primeiro.projeto.id,segundo.projeto.id);
  assert.deepEqual(f.org.projetos.obter(primeiro.projeto.id).fontes.map(x=>x.eventoId),[primeiro.eventoId]);
  assert.deepEqual(f.org.projetos.obter(segundo.projeto.id).fontes.map(x=>x.eventoId),[segundo.eventoId]);
  assert.equal(itens(f.org.listar({conversaId:DM})).length,2);
});

test('classificação da fonte com duas demandas não escolhe implicitamente a qual assunto pertence',t=>{
  const f=fixture(t),trechoA='Pode preparar o plano do projeto?',trechoB='Pode enviar o recibo da consulta?',id=f.evento(trechoA+' '+trechoB);
  const a=f.demanda(id,{trecho:trechoA}),b=f.demanda(id,{trecho:trechoB,resumo:'Enviar recibo'}),avaliacaoId=f.avaliar(id);
  for(const acaoId of [a,b]) {
    const r=f.org.organizar({acaoId,avaliacaoId,conversaId:DM});
    assert.equal(r.projetoCriado,false);assert.equal(r.candidato.motivo,'escopo_da_demanda_ambiguo');assert.equal(r.item.grupo,'tarefas');
    assert.ok(r.item.incerteza.includes('escopo_da_demanda_ambiguo'));
  }
  assert.equal(f.n('lume_projetos_comerciais'),0);
});

test('restaurar leitura depois de revogação não ressuscita avaliação nem rascunho invalidado',t=>{
  const f=fixture(t),p=f.preparar(),r=f.org.organizar(p),eventoId=r.item.eventoId;
  f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(eventoId);
  f.db.prepare("UPDATE eventos SET permissao='dirigida' WHERE id=?").run(eventoId);
  assert.throws(()=>f.org.organizar(p),{code:'AVALIACAO_INDISPONIVEL'});assert.equal(f.org.projetos.obter(r.item.projeto.id),null);
  const atual=f.org.organizar({...p,avaliacaoId:f.avaliar(eventoId)});
  assert.equal(atual.projetoCriado,false);assert.equal(atual.candidato.motivo,'origem_ja_organizada_requer_revisao');
});

test('correção manual explícita dos critérios aceita confiança nula sem inferência nem promoção',t=>{
  const f=fixture(t),p=f.preparar({assunto:'tarefa'});
  f.org.politica.configurar({conversaId:DM,categoria:'lead',modo:'rascunhar',remoto:false});
  f.db.prepare('UPDATE desktop_ia_conversas SET permitida=0 WHERE conversa_id=?').run(DM);
  const manual=f.org.vendas.corrigir({conversa_id:DM,temperatura:'insuficiente',etapa:'insuficiente',
    assunto:'projeto',andamento:'planejado',continuidade:'novo_assunto',confirmar:true});
  const r=f.org.organizar({...p,avaliacaoId:manual.id});
  assert.equal(r.projetoCriado,true);assert.equal(r.item.avaliacao.assunto.valor,'projeto');assert.equal(r.item.avaliacao.assunto.confianca,null);
  assert.equal(r.item.avaliacao.origem,'manual');assert.equal(r.item.incerteza.includes('revisao_sugerida'),false);
  assert.equal(r.item.projeto.estado,'rascunho');assert.equal(r.item.projeto.natureza,'incerto');
  assert.equal(f.n('desktop_negocios'),0);assert.equal(f.n('saidas'),0);
});

test('confiança nula do modelo não se passa por correção humana nem classifica projeto legado',t=>{
  const f=fixture(t),p=f.preparar({assunto:null}),e=f.org.acoes.obter(p.acaoId).evento_id;
  p.avaliacaoId=f.avaliar(e,{assunto:{valor:'projeto',confianca:null}});
  assert.equal(f.org.organizar(p).projetoCriado,false);assert.equal(f.n('lume_projetos_comerciais'),0);
});
