import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {prepararEsquemaTranscricao} from '../src/transcricao.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';

const agora=()=>new Date('2026-09-25T19:00:00Z');
function fixture(t){
  const db=abrirBanco();t.after(()=>db.close());prepararEsquemaTranscricao(db);
  return {db,service:new ProjetosComerciais(db,{agora}),evento:(texto,op={})=>evento(db,texto,op)};
}
function evento(db,texto,{conversa='conversa-sintetica',permissao='dirigida',tipo='texto',origem='msg-'+crypto.randomUUID()}={}){
  return Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada','pessoa-sintetica',0,?,'{}',?,'2026-09-25T18:00:00Z','2026-09-25',?)`).run(conversa,origem,tipo,texto,permissao).lastInsertRowid);
}

test('CYCLE-04: projeto nasce sem pasta, sem grants e somente de fonte explícita legível',t=>{
  const f=fixture(t),id=f.evento('Vamos preparar a proposta para a reforma.');
  assert.throws(()=>f.service.criarRascunho({nome:'Reforma',fontes:[]}),/inválidos/);
  const p=f.service.criarRascunho({nome:'Reforma',fontes:[{eventoId:id}]});
  assert.equal(p.estado,'rascunho');assert.equal(p.acordoVerificado,false);assert.equal(p.fontes[0].eventoId,id);
  for(const table of ['projetos','conversa_projetos','autorizacoes','politicas_conversa'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(f.service.obter(p.id).id,p.id);assert.deepEqual(f.service.listar().map(p=>p.id),[p.id]);
  assert.throws(()=>f.service.criarRascunho({nome:'Inventado',fontes:[{eventoId:id,trecho:'Aprovado o orçamento.'}]}),/ausente/);
  assert.equal(f.service.listar().length,1);
});

test('CYCLE-04: dois projetos na mesma conversa usam eventos e trechos exatos sem herdar outras mensagens',t=>{
  const f=fixture(t),a='Proposta para o site.',b='Proposta para a reforma.',id=f.evento(a+' '+b);
  f.evento('Segredo de outro projeto da mesma pessoa.');
  const site=f.service.criarRascunho({nome:'Site',fontes:[{eventoId:id,trecho:a}]}),reforma=f.service.criarRascunho({nome:'Reforma',fontes:[{eventoId:id,trecho:b}]});
  assert.equal(site.fontes[0].trecho,a);assert.equal(reforma.fontes[0].trecho,b);
  assert.notEqual(site.fontes[0].id,reforma.fontes[0].id);
  assert(!JSON.stringify(f.service.obter(site.id)).includes(b));assert(!JSON.stringify(f.service.listar()).includes('Segredo'));
  const externo=f.evento('Detalhe solicitado para o site.',{conversa:'outra-conversa'});
  const link=f.service.vincularFonte({id:site.id,eventoId:externo});
  assert.equal(f.service.obter(site.id).fontes.length,2);assert.equal(f.service.obter(reforma.id).fontes.length,1);
  assert.throws(()=>f.service.desvincularFonte({id:reforma.id,fonteId:link.fonteId}),/inexistente/);
});

test('CYCLE-04: trecho repetido precisa de posição literal; operação inválida não deixa escrita parcial',t=>{
  const f=fixture(t),trecho='Enviar proposta.',id=f.evento(trecho+' '+trecho);
  assert.throws(()=>f.service.criarRascunho({nome:'Teste',fontes:[{eventoId:id,trecho}]}),/repetido/);
  const p=f.service.criarRascunho({nome:'Teste',fontes:[{eventoId:id,trecho,inicio:trecho.length+1}]});
  assert.equal(p.fontes[0].inicio,trecho.length+1);
  assert.throws(()=>f.service.criarRascunho({nome:'Parcial',fontes:[{eventoId:id},{eventoId:99999}]}),/indisponível/);
  assert.throws(()=>f.service.criarRascunho({nome:'Duplicado',fontes:[{eventoId:id},{eventoId:id}]}),/repetida/);
  assert.equal(f.service.listar().length,1);
});

test('CYCLE-04: idempotência preserva revisão, detecta colisão e mantém projetos distintos sobre a mesma fonte',t=>{
  const f=fixture(t),id=f.evento('Podemos discutir a proposta?'),pedido={nome:'Proposta',natureza:'proposta',fontes:[{eventoId:id}],chave:'gesto-1'};
  const p=f.service.criarRascunho(pedido);f.service.confirmar({id:p.id,confirmar:true});
  const repetido=f.service.criarRascunho(pedido);assert.equal(repetido.id,p.id);assert.equal(repetido.criado,false);assert.equal(repetido.estado,'confirmado');
  assert.throws(()=>f.service.criarRascunho({...pedido,nome:'Outro'}),/idempotência/);
  assert.notEqual(f.service.criarRascunho({...pedido,chave:'gesto-2'}).id,p.id);
  const automatico=f.service.criarRascunho({...pedido,chave:undefined});
  assert.equal(f.service.criarRascunho({...pedido,chave:undefined}).id,automatico.id);
});

test('CYCLE-04: confirmação organiza projeto mas nunca transforma proposta em acordo verificado',t=>{
  const f=fixture(t),id=f.evento('Talvez possamos fechar em outubro.');
  const p=f.service.criarRascunho({nome:'Possibilidade',natureza:'proposta',fontes:[{eventoId:id}]});
  assert.throws(()=>f.service.confirmar({id:p.id}),/explícita/);
  const confirmado=f.service.confirmar({id:p.id,confirmar:true});
  assert.equal(confirmado.natureza,'proposta');assert.equal(confirmado.acordoVerificado,false);
  assert.equal(f.service.confirmar({id:p.id,confirmar:true}).alterado,false);
  assert.equal(f.service.arquivar({id:p.id}).estado,'arquivado');
  assert.throws(()=>f.service.confirmar({id:p.id,confirmar:true}),/Transição/);
  assert.equal(f.service.restaurar({id:p.id}).estado,'rascunho');
  assert.equal(f.service.obter(p.id).acordoVerificado,false);
  assert.deepEqual(f.service.timeline({id:p.id}).map(x=>x.tipo),['restaurado','arquivado','confirmado','criado','fonte_vinculada']);
});

test('CYCLE-04: remoção de vínculo é idempotente e reversível sem ampliar a conversa',t=>{
  const f=fixture(t),a=f.evento('Base do projeto.'),b=f.evento('Próximo passo selecionado.'),p=f.service.criarRascunho({nome:'Projeto',fontes:[{eventoId:a}]});
  const link=f.service.vincularFonte({id:p.id,eventoId:b});
  assert.equal(f.service.vincularFonte({id:p.id,eventoId:b}).fonteId,link.fonteId);
  assert.equal(f.service.desvincularFonte({id:p.id,fonteId:link.fonteId}).alterado,true);
  assert.equal(f.service.desvincularFonte({id:p.id,fonteId:link.fonteId}).alterado,false);
  assert.equal(f.service.obter(p.id).fontes.length,1);assert(!JSON.stringify(f.service.timeline({id:p.id})).includes('Próximo passo'));
  assert.throws(()=>f.service.desvincularFonte({id:p.id,fonteId:p.fontes[0].id}),/arquive/);
  f.service.vincularFonte({id:p.id,eventoId:b});assert.equal(f.service.obter(p.id).fontes.length,2);
});

test('CYCLE-04: revogação de política é exata e persistente mesmo se permissão voltar antes da leitura',t=>{
  const f=fixture(t),id=f.evento('Trecho autorizado de terceiro.',{permissao:'terceiro',conversa:'grupo'});
  assert.throws(()=>f.service.criarRascunho({nome:'Grupo',fontes:[{eventoId:id}]}),/permissão/);
  f.db.prepare("INSERT INTO politicas_conversa VALUES('grupo','tudo',?)").run(agora().toISOString());
  const p=f.service.criarRascunho({nome:'Nome também sensível',fontes:[{eventoId:id}]});
  const outro=f.service.criarRascunho({nome:'Outro',fontes:[{eventoId:f.evento('Mensagem dirigida permitida.')} ]});
  f.db.exec("UPDATE politicas_conversa SET politica='so-minhas' WHERE conversa_id='grupo'; UPDATE politicas_conversa SET politica='tudo' WHERE conversa_id='grupo'");
  assert.equal(f.service.obter(p.id),null);assert.deepEqual(f.service.timeline({id:p.id}),[]);
  assert.deepEqual(f.service.listar().map(p=>p.id),[outro.id]);
  assert.throws(()=>f.service.confirmar({id:p.id,confirmar:true}),/indisponível/);
});

test('CYCLE-04: alteração e exclusão da fonte eliminam o conteúdo derivado; fonte adicional não derruba base válida',t=>{
  const f=fixture(t),id=f.evento('Fonte base A.'),extra=f.evento('Detalhe reservado.'),p=f.service.criarRascunho({nome:'Projeto A',fontes:[{eventoId:id}]});
  f.service.vincularFonte({id:p.id,eventoId:extra});
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto mudou.',extra);
  assert.equal(f.service.obter(p.id).fontes.length,1);assert.equal(f.service.obter(p.id).fontesIndisponiveis,1);
  assert(!JSON.stringify(f.service.timeline({id:p.id})).includes('reservado'));
  f.db.prepare('DELETE FROM eventos WHERE id=?').run(extra);assert.equal(f.service.obter(p.id).fontes.length,1);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Base mudou.',id);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte base A.',id);
  assert.equal(f.service.obter(p.id),null);
  f.db.prepare('DELETE FROM eventos WHERE id=?').run(id);
  for(const table of ['lume_projetos_comerciais','lume_projetos_fontes','lume_projetos_historico'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});

test('CYCLE-04: contribuição compartilhada autoriza apenas evento exato e revogação não ressuscita vínculo',t=>{
  const f=fixture(t),id=f.evento('Contribuição autorizada.',{permissao:'compartilhado'});
  const oculto=f.evento('Outra mensagem do grupo.',{permissao:'terceiro'});
  f.db.prepare('INSERT INTO f10_projetos VALUES(?,?,?)').run('contexto-teste','Contexto sintético',agora().toISOString());
  f.db.prepare('INSERT INTO f10_origens VALUES(?,?,?,?)').run('origem-teste','Pessoa sintética','Máquina de teste','chave-pública-sintética');
  const autorizar=()=>f.db.prepare(`INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em)
    VALUES(?,'origem-teste','pacote-teste','contexto-teste',?,?)`).run(id,agora().toISOString(),agora().toISOString());
  autorizar();const p=f.service.criarRascunho({nome:'Compartilhado',fontes:[{eventoId:id}]});
  assert.throws(()=>f.service.vincularFonte({id:p.id,eventoId:oculto}),/permissão/);
  f.db.prepare('DELETE FROM f10_procedencias WHERE evento_id=?').run(id);autorizar();
  assert.equal(f.service.obter(p.id),null);assert.deepEqual(f.service.timeline({id:p.id}),[]);
});

test('CYCLE-04: áudio usa desktop_fontes e revisão da transcrição invalida evidência',t=>{
  const f=fixture(t),id=f.evento(null,{tipo:'audio',origem:'audio-1'});
  assert.throws(()=>f.service.criarRascunho({nome:'Áudio',fontes:[{eventoId:id}]}),/indisponível/);
  f.db.prepare(`INSERT INTO transcricoes(conversa_id,origem_id,texto,estado,criado_em) VALUES('conversa-sintetica','audio-1',?,'transcrito',?)`).run('Podemos preparar um orçamento.',agora().toISOString());
  const p=f.service.criarRascunho({nome:'Áudio',fontes:[{eventoId:id,trecho:'preparar um orçamento'}]});
  assert.equal(p.fontes[0].transcricao,true);assert.equal(p.fontes[0].trecho,'preparar um orçamento');
  f.db.exec("UPDATE transcricoes SET estado='erro',texto=NULL WHERE origem_id='audio-1'");
  assert.equal(f.service.obter(p.id),null);
});

test('CYCLE-04: paginação da timeline e limites não vazam fontes não vinculadas',t=>{
  const f=fixture(t),id=f.evento('Fonte de criação.'),p=f.service.criarRascunho({nome:'Linha do tempo',fontes:[{eventoId:id}]});
  f.service.confirmar({id:p.id,confirmar:true});f.service.arquivar({id:p.id});
  const page=f.service.timeline({id:p.id,limite:2});assert.equal(page.length,2);
  const next=f.service.timeline({id:p.id,limite:2,antes:page.at(-1).id});assert.equal(next.length,2);assert(next[0].id<page.at(-1).id);
  assert.equal(next[1].fonte.trecho,'Fonte de criação.');
  assert.throws(()=>f.service.listar({limite:-1}),/limite/);assert.throws(()=>f.service.timeline({id:p.id,antes:'1 OR 1=1'}),/Paginação/);
  assert.equal(f.service.obter('inexistente'),null);assert.deepEqual(f.service.timeline({id:'inexistente'}),[]);
});

test('CYCLE-04: projeto e idempotência persistem após fechar e reabrir banco temporário',t=>{
  const pasta=mkdtempSync(join(tmpdir(),'lume-pc-'));
  const caminho=join(pasta,'teste.sqlite');let db=abrirBanco(caminho),service=new ProjetosComerciais(db,{agora});
  const id=evento(db,'Preparar o projeto após revisar a proposta.'),pedido={nome:'Persistente',fontes:[{eventoId:id}],chave:'pedido-persistente'};
  const p=service.criarRascunho(pedido);service.confirmar({id:p.id,confirmar:true});db.close();
  db=abrirBanco(caminho);t.after(()=>{db.close();rmSync(pasta,{recursive:true,force:true});});service=new ProjetosComerciais(db,{agora});
  assert.equal(service.obter(p.id).estado,'confirmado');assert.equal(service.criarRascunho(pedido).id,p.id);
  assert.equal(service.timeline({id:p.id}).length,3);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
});
