import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {registrarPessoa} from '../src/pessoas.js';
import {criarNomeVisivel,nomeWhatsappValido,salvarNomesWhatsapp,recuperarNomesWhatsapp} from '../src/nomes-conversa.js';
import {chaveConversa,chaveExclusao} from '../src/exclusoes.js';

test('nomes: consulta viva recupera nome recebido depois do primeiro acesso',t=>{
  const db=abrirBanco();t.after(()=>db.close());perfilGrafo(db);
  const nome=criarNomeVisivel(db),id='123456789@lid';
  assert.equal(nome(id,id),'Contato sem nome');
  registrarPessoa(db,{identificador:id,nomeCru:'Contato Fixture'});
  assert.equal(nome(id,id),'Contato Fixture');
});

const lid='123456789@lid',pn='5511000000000@s.whatsapp.net',grupo='120000000000@g.us';
function ambiente(t){const db=abrirBanco();t.after(()=>db.close());return {db,...perfilGrafo(db)};}

test('nomes: payload de histórico persiste contato, alias explícito e grupo no mesmo banco reaberto',t=>{
  const pasta=mkdtempSync(join(tmpdir(),'lume-historico-nomes-')),arquivo=join(pasta,'fixture.sqlite');
  t.after(()=>rmSync(pasta,{recursive:true,force:true}));let db=abrirBanco(arquivo);
  try{
    const e=perfilGrafo(db);e.conversa(lid);e.conversa(pn);e.conversa(grupo);e.evento(lid,lid);e.evento(pn,pn);e.evento(grupo,lid);
    const r=salvarNomesWhatsapp(db,{contacts:[{id:lid,name:'Contato Fixture',phoneNumber:pn}],chats:[{id:grupo,name:'Grupo Fixture'}]});
    assert.equal(r.aliases,1);assert.equal(r.conflitos,0);
    const identidades=db.prepare('SELECT pessoa_id FROM pessoa_identificadores ORDER BY identificador').all();
    assert.equal(identidades.length,2);assert.equal(identidades[0].pessoa_id,identidades[1].pessoa_id);
    const permissoes=db.prepare('SELECT id,permissao FROM eventos').all();
    db.close();db=abrirBanco(arquivo);const reaberto=perfilGrafo(db);
    assert.equal(reaberto.desktop.carteira({q:'Contato Fixture'}).pagina.total,2);
    assert.equal(reaberto.desktop.conversaDetalhe({conversa:grupo}).nome,'Grupo Fixture');
    assert.equal(reaberto.desktop.contatos().pagina.total,1);
    assert.deepEqual(db.prepare('SELECT id,permissao FROM eventos').all(),permissoes);
    assert.equal(db.prepare('SELECT count(*) n FROM politicas_conversa').get().n,0);
  }finally{db.close();}
});

test('nomes: par conflitante não move identidade existente nem infere alias por número ou nome',t=>{
  const e=ambiente(t);salvarNomesWhatsapp(e.db,{contacts:[{id:lid,name:'Mesmo Nome'},{id:pn,name:'Mesmo Nome'},{id:'123456789@s.whatsapp.net',name:'Outra Pessoa'}]});
  const antes=e.db.prepare('SELECT identificador,pessoa_id FROM pessoa_identificadores ORDER BY identificador').all();
  const r=salvarNomesWhatsapp(e.db,{lidPnMappings:[{lid,pn}]});
  assert.equal(r.conflitos,1);assert.equal(r.aliases,0);
  assert.deepEqual(e.db.prepare('SELECT identificador,pessoa_id FROM pessoa_identificadores ORDER BY identificador').all(),antes);
  assert.equal(new Set(antes.map(p=>p.pessoa_id)).size,3);
  assert.equal(criarNomeVisivel(e.db)(null,'123456789'),'Contato sem nome');
});

test('nomes: não reativa alias desativado nem aceita segundo telefone para um LID',t=>{
  const e=ambiente(t);salvarNomesWhatsapp(e.db,{contacts:[{id:lid,name:'Contato Fixture',phoneNumber:pn}]});
  assert.equal(salvarNomesWhatsapp(e.db,{lidPnMappings:[{lid,pn:'5522000000000@s.whatsapp.net'}]}).aliases,0);
  assert.equal(e.db.prepare('SELECT count(*) n FROM pessoa_identificadores').get().n,2);
  e.db.prepare('UPDATE pessoa_identificadores SET ativo=0 WHERE identificador=?').run(pn);
  salvarNomesWhatsapp(e.db,{contacts:[{id:pn,name:'Outro Nome',lid}]});
  assert.equal(e.db.prepare('SELECT ativo FROM pessoa_identificadores WHERE identificador=?').get(pn).ativo,0);
  assert.equal(criarNomeVisivel(e.db)(null,lid),'Contato Fixture');
});

test('nomes: agenda salva e nome manual resistem a pushName, ID e atualização vazia',t=>{
  const e=ambiente(t),nome=criarNomeVisivel(e.db);
  salvarNomesWhatsapp(e.db,{contacts:[{id:lid,name:'Agenda Fixture',phoneNumber:pn}]});
  salvarNomesWhatsapp(e.db,{contacts:[{id:lid,notify:'Apelido Antigo'},{id:lid,name:lid},{id:lid,name:''}]});
  assert.equal(nome(null,lid),'Agenda Fixture');assert.equal(nome(null,pn),'Agenda Fixture');
  registrarPessoa(e.db,{identificador:lid,nomeCru:'Manual Fixture',origem:'manual'});
  salvarNomesWhatsapp(e.db,{contacts:[{id:pn,name:'Agenda Alterada'}]});
  assert.equal(nome(null,lid),'Manual Fixture');assert.equal(nome(null,pn),'Manual Fixture');
  salvarNomesWhatsapp(e.db,{contacts:[{id:'999999999@lid',notify:'Nome Inicial'}]});
  salvarNomesWhatsapp(e.db,{contacts:[{id:'999999999@lid',notify:'Nome Atual'}]});
  assert.equal(nome(null,'999999999@lid'),'Nome Atual');
  salvarNomesWhatsapp(e.db,{contacts:[{id:'999999999@lid',phoneNumber:'5533000000000@s.whatsapp.net'}]});
  salvarNomesWhatsapp(e.db,{contacts:[{id:'5533000000000@s.whatsapp.net',notify:'Nome Mais Atual'}]});
  assert.equal(nome(null,'999999999@lid'),'Nome Mais');
  assert.equal(e.db.prepare('SELECT nome FROM conversas_app WHERE id=?').get('999999999@lid').nome,'Nome Mais');
});

test('nomes: nome conhecido de grupo não é substituído por participante ou ID',t=>{
  const e=ambiente(t);e.contexto.salvarGrupos([{id:grupo,subject:'Grupo Fixture'}]);
  salvarNomesWhatsapp(e.db,{contacts:[{id:grupo,name:grupo}],chats:[{id:grupo,name:'120000000000'}],messages:[
    {key:{id:'grupo',remoteJid:grupo,participant:lid,participantAlt:pn},pushName:'Autor Fixture'},
    {key:{id:'propria',remoteJid:'999999999@lid',fromMe:true},pushName:'Dono Fixture'}
  ]});
  assert.equal(e.db.prepare('SELECT nome FROM grupos_app WHERE id=?').get(grupo).nome,'Grupo Fixture');
  assert.equal(criarNomeVisivel(e.db)(grupo,grupo),'Grupo Fixture');
  assert.equal(criarNomeVisivel(e.db)(null,pn),'Autor Fixture');
  assert.equal(criarNomeVisivel(e.db)(null,'999999999@lid'),'Contato sem nome');
});

test('nomes: exclusão bloqueia metadados tardios, aliases e nome em resolvedor já criado',t=>{
  const e=ambiente(t),nome=criarNomeVisivel(e.db);
  salvarNomesWhatsapp(e.db,{contacts:[{id:lid,name:'Contato Fixture'}]});assert.equal(nome(null,lid),'Contato Fixture');
  for(const id of [lid,grupo])e.db.prepare('INSERT INTO priv_conversas_excluidas VALUES(?,?)').run(chaveConversa(id),'2026-10-26');
  salvarNomesWhatsapp(e.db,{contacts:[{id:lid,name:'Nome Ressuscitado',phoneNumber:pn}],chats:[{id:grupo,name:'Grupo Ressuscitado'}]});
  assert.equal(nome('Nome Ressuscitado',lid),'Contato sem nome');
  assert.equal(nome(null,pn),'Contato sem nome');assert.equal(nome(null,grupo),'Grupo sem nome');
  assert.equal(e.db.prepare('SELECT 1 FROM pessoa_identificadores WHERE identificador=?').get(pn),undefined);
});

test('nomes: recuperação offline é limitada por examinados e não pisa nome atual ou dono',t=>{
  const e=ambiente(t);e.conversa(grupo);
  for(let i=0;i<3;i++){
    const id=e.evento(grupo,lid),mensagem={key:{id:'fixture-'+i,remoteJid:grupo,participant:lid},pushName:'Recuperado Fixture'};
    e.db.prepare('UPDATE eventos SET bruto=? WHERE id=?').run(i===0?'bruto inválido':JSON.stringify({mensagem}),id);
  }
  let r=recuperarNomesWhatsapp(e.db,{limite:1});assert.equal(r.examinados,1);assert.equal(r.nomes,0);assert.equal(r.concluido,false);
  r=recuperarNomesWhatsapp(e.db,{aposId:r.ultimoId,limite:1});assert.equal(r.nomes,1);
  assert.equal(criarNomeVisivel(e.db)(null,lid),'Recuperado Fixture');
  salvarNomesWhatsapp(e.db,{contacts:[{id:lid,name:'Agenda Atual'}]});
  r=recuperarNomesWhatsapp(e.db,{aposId:r.ultimoId,limite:10});assert.equal(r.concluido,true);assert.equal(r.nomes,0);
  assert.equal(criarNomeVisivel(e.db)(null,lid),'Agenda Atual');
  assert.throws(()=>recuperarNomesWhatsapp(e.db,{limite:1001}),/inválido/);
});

test('nomes: IDs, números formatados e placeholders não viram nome persistido',()=>{
  for(const n of ['123456789@lid','123456789-111','+55 (11) 90000-0000','Contato sem nome','Nome não disponível','',null])assert.equal(nomeWhatsappValido(n),false);
  assert.equal(nomeWhatsappValido('Equipe 26'),true);
});

test('nomes: carteira e busca usam pessoa já persistida após reinício offline',t=>{
  const pasta=mkdtempSync(join(tmpdir(),'lume-nomes-')),arquivo=join(pasta,'fixture.sqlite');
  t.after(()=>rmSync(pasta,{recursive:true,force:true}));
  let db=abrirBanco(arquivo);
  try {
    const e=perfilGrafo(db),id='987654321@lid';
    e.conversa(id);e.evento(id,id);registrarPessoa(db,{identificador:id,nomeCru:'Contato Fixture'});
    db.close();db=abrirBanco(arquivo);
    const reaberto=perfilGrafo(db);
    assert.equal(reaberto.desktop.carteira({q:'Contato Fixture'}).pagina.total,1);
    assert.equal(reaberto.desktop.conversaDetalhe({conversa:id}).nome,'Contato Fixture');
  } finally {db.close();}
});

function fonteNome(e,indice,{nome='Fixture Recuperada',extra='',invalido=false}={}){
  const contato=String(800000000+indice)+'@lid',id=e.evento(contato,contato);
  const bruto=invalido?'JSON inválido':JSON.stringify({mensagem:{key:{id:'nome-'+indice,remoteJid:contato},pushName:nome,message:{conversation:extra}}});
  e.db.prepare('UPDATE eventos SET bruto=? WHERE id=?').run(bruto,id);
  return {id,contato,bytes:Buffer.byteLength(bruto)};
}

test('nomes desempenho: falha na segunda linha reverte todo o lote e permite repetir o cursor',t=>{
  const e=ambiente(t),a=fonteNome(e,1),b=fonteNome(e,2);
  e.db.exec(`CREATE TRIGGER falhar_nome BEFORE INSERT ON conversas_app
    WHEN NEW.id='${b.contato}' BEGIN SELECT RAISE(ABORT,'fixture falha de lote'); END`);
  assert.throws(()=>recuperarNomesWhatsapp(e.db,{limite:20}),/fixture falha/);
  assert.equal(e.db.prepare('SELECT count(*) n FROM pessoas').get().n,0);
  assert.equal(e.db.prepare('SELECT count(*) n FROM pessoa_identificadores').get().n,0);
  assert.equal(e.db.prepare('SELECT count(*) n FROM conversas_app').get().n,0);
  e.db.exec('DROP TRIGGER falhar_nome');
  const r=recuperarNomesWhatsapp(e.db,{limite:20});
  assert.equal(r.examinados,2);assert.equal(r.ultimoId,b.id);assert.equal(r.concluido,true);
  assert.equal(criarNomeVisivel(e.db)(null,a.contato),'Fixture Recuperada');
});

test('nomes desempenho: orçamento por bytes progride por linha inclusive inválida e maior que o lote',t=>{
  const e=ambiente(t),a=fonteNome(e,1,{invalido:true}),b=fonteNome(e,2,{extra:'😀'.repeat(65536)}),c=fonteNome(e,3);
  let r=recuperarNomesWhatsapp(e.db,{limite:200,maxBytes:1,maxMs:60000});
  assert.equal(r.ultimoId,a.id);assert.equal(r.examinados,1);assert.equal(r.bytesLidos,a.bytes);assert.equal(r.concluido,false);
  r=recuperarNomesWhatsapp(e.db,{aposId:r.ultimoId,limite:200,maxBytes:1,maxMs:60000});
  assert.equal(r.ultimoId,b.id);assert.equal(r.examinados,1);assert.equal(r.bytesLidos,b.bytes);assert.equal(r.nomes,1);
  assert.equal(r.concluido,false);assert.equal(criarNomeVisivel(e.db)(null,b.contato),'Fixture Recuperada');
  r=recuperarNomesWhatsapp(e.db,{aposId:r.ultimoId,limite:200,maxBytes:1,maxMs:60000});
  assert.equal(r.ultimoId,c.id);assert.equal(r.examinados,1);assert.equal(r.concluido,true);
});

test('nomes desempenho: tempo finito devolve cursor parcial, sem pular as próximas linhas',t=>{
  const e=ambiente(t),a=fonteNome(e,1),b=fonteNome(e,2);
  const r=recuperarNomesWhatsapp(e.db,{limite:1000,maxMs:Number.MIN_VALUE});
  assert.equal(r.examinados,1);assert.equal(r.ultimoId,a.id);assert.equal(r.concluido,false);
  const fim=recuperarNomesWhatsapp(e.db,{aposId:r.ultimoId,limite:1000});
  assert.equal(fim.ultimoId,b.id);assert.equal(fim.nomes,1);assert.equal(fim.concluido,true);
  for(const options of [{maxBytes:0},{maxBytes:Infinity},{maxMs:0},{maxMs:NaN}])assert.throws(()=>recuperarNomesWhatsapp(e.db,options),/inválido/);
});

test('nomes desempenho: statements por conexão não guardam nomes e repetição idêntica não grava',t=>{
  const e=ambiente(t),lote={contacts:[{id:lid,name:'Fixture Inicial',phoneNumber:pn}]},quando='2026-10-26T12:00:00Z';
  salvarNomesWhatsapp(e.db,lote,{quando});
  const antes=e.db.prepare('SELECT total_changes() n').get().n,preparar=e.db.prepare.bind(e.db);let prepares=0;
  t.mock.method(e.db,'prepare',sql=>{prepares++;return preparar(sql);});
  salvarNomesWhatsapp(e.db,lote,{quando});
  assert.equal(prepares,0,'somente statements são reaproveitados');
  assert.equal(preparar('SELECT total_changes() n').get().n,antes,'payload idêntico não atualiza linhas');
  salvarNomesWhatsapp(e.db,lote,{quando:'2026-10-27T12:00:00Z'});
  assert.equal(preparar('SELECT visto_em FROM pessoa_identificadores WHERE identificador=?').get(lid).visto_em,'2026-10-27T12:00:00Z');
  registrarPessoa(e.db,{identificador:lid,nomeCru:'Fixture Manual',origem:'manual'});
  assert.equal(criarNomeVisivel(e.db)(null,pn),'Fixture Manual');
  const outro=ambiente(t);assert.equal(criarNomeVisivel(outro.db)(null,pn),'Contato sem nome');
});

test('nomes desempenho: rollback interno preserva transação externa do chamador',t=>{
  const e=ambiente(t);fonteNome(e,1);fonteNome(e,2);
  e.db.exec('BEGIN');
  e.db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('fora@g.us','Trabalho anterior');
  recuperarNomesWhatsapp(e.db,{limite:20});
  assert.equal(e.db.prepare('SELECT count(*) n FROM pessoas').get().n,2);
  e.db.exec('ROLLBACK');
  assert.equal(e.db.prepare('SELECT count(*) n FROM pessoas').get().n,0);
  assert.equal(e.db.prepare('SELECT count(*) n FROM conversas_app').get().n,0);
});

test('nomes desempenho: falha do lote não desfaz trabalho anterior da transação externa',t=>{
  const e=ambiente(t);fonteNome(e,1);const b=fonteNome(e,2);
  e.db.exec(`CREATE TRIGGER falhar_nome_externo BEFORE INSERT ON conversas_app
    WHEN NEW.id='${b.contato}' BEGIN SELECT RAISE(ABORT,'fixture falha externa'); END`);
  e.db.exec('BEGIN');e.db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('fora@g.us','Trabalho anterior');
  assert.throws(()=>recuperarNomesWhatsapp(e.db,{limite:20}),/fixture falha externa/);
  assert.equal(e.db.prepare('SELECT count(*) n FROM pessoas').get().n,0);
  assert.equal(e.db.prepare('SELECT nome FROM conversas_app WHERE id=?').get('fora@g.us').nome,'Trabalho anterior');
  e.db.exec('COMMIT');
});

test('nomes desempenho: aquecer consultas não evita exclusão de fonte no backfill seguinte',t=>{
  const e=ambiente(t),a=fonteNome(e,1);recuperarNomesWhatsapp(e.db,{limite:1});
  const b=fonteNome(e,2);
  e.db.prepare('INSERT INTO priv_excluidos VALUES(?,?)').run(chaveExclusao(b.contato,'nome-2'),'2026-10-26');
  const r=recuperarNomesWhatsapp(e.db,{aposId:a.id});
  assert.equal(r.examinados,1);assert.equal(r.ultimoId,b.id);assert.equal(r.nomes,0);
  assert.equal(criarNomeVisivel(e.db)(null,b.contato),'Contato sem nome');
  assert.equal(e.db.prepare('SELECT count(*) n FROM pessoas').get().n,1);
});
