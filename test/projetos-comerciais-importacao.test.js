import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';
import {Backup,cifrarBackup} from '../src/backup.js';
import {Privacidade,CICLO_TABELAS} from '../src/privacidade.js';
import {fingerprint} from '../src/compartilhamento.js';
import {prepararEsquemaTranscricao,gravarTranscricao} from '../src/transcricao.js';

const data='2026-09-25T21:00:00.000Z',senha='senha inteiramente sintetica';
const codigo=c=>e=>e.codigo===c;
function perfil(t){
  const dir=mkdtempSync(join(tmpdir(),'lume-importados-')),caminho=join(dir,'teste.sqlite');
  const f={caminho,tempo:Date.parse(data)};
  f.abrir=()=>{
    f.db=abrirBanco(caminho);new ContextoApp(f.db);new Desktop(f.db);new DesktopIA(f.db);
    f.service=new ProjetosComerciais(f.db,{agora:()=>new Date(f.tempo)});
    f.b=new Backup(f.db,{perfil:()=>({nome:'Perfil de teste'})});f.p=new Privacidade(f.db);
  };
  f.abrir();f.reabrir=()=>{f.db.close();f.abrir();};
  t.after(()=>{f.db.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true});});
  return f;
}
function evento(f,texto,{conversa='conversa-a',permissao='dirigida',origem=randomUUID()}={}){
  f.db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(conversa,'Contato sintético');
  return Number(f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada','pessoa-sintetica',0,'texto','{}',?,'2026-09-25T20:00:00Z','2026-09-25',?)`).run(conversa,origem,texto,permissao).lastInsertRowid);
}
function semear(f,{duas=false,terceiro=false}={}){
  f.a=evento(f,'Preparar a proposta do site. Nota reservada de outro projeto.',{permissao:terceiro?'terceiro':'dirigida'});
  if(terceiro)f.db.prepare("INSERT INTO politicas_conversa VALUES('conversa-a','tudo',?)").run(data);
  f.z=evento(f,'Conferir o cronograma.',{conversa:'conversa-b'});
  f.oculto=evento(f,'NÃO EXIBIR outra conversa do mesmo contato.',{conversa:'conversa-c',permissao:'terceiro'});
  f.projeto=f.service.criarRascunho({nome:'Projeto sintético com nome derivado',natureza:'proposta',fontes:[
    {eventoId:f.a,trecho:'Preparar a proposta do site.'},...(duas?[{eventoId:f.z}]:[])]});
  f.service.confirmar({id:f.projeto.id,confirmar:true});
  return f;
}
async function restaurar(a,b,conteudo){
  const pacote=conteudo?await cifrarBackup(conteudo,senha):(await a.b.criar({senha,confirmar:true})).pacote;
  const previa=await b.b.preparar({arquivo:JSON.stringify(pacote),senha});
  return b.b.restaurar({id:previa.id,confirmarMeuBackup:true});
}
const revisar=(f,id)=>f.service.revalidarImportado({previaId:f.service.prepararImportado({id}).previaId,confirmar:true});
const decisoes=f=>f.db.prepare("SELECT * FROM lume_projetos_historico WHERE tipo='importado_revisado'").all();
function semGrants(f){
  for(const tabela of ['projetos','conversa_projetos','autorizacoes','politicas_conversa','desktop_ia_conversas','desktop_tarefas_conversas','lume_acoes_conversas','lume_execucao_contexto_grants']){
    if(!f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tabela))continue;
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${tabela}`).get().n,0,tabela);
  }
}

test('importados: backup real em dois perfis, duas conversas, gesto explícito e zero grants',async t=>{
  const a=semear(perfil(t),{duas:true}),b=perfil(t);const antes=a.service.timeline({id:a.projeto.id});
  await restaurar(a,b);assert.deepEqual(b.service.listar(),[]);semGrants(b);
  const lista=b.service.listarImportados();assert.equal(lista.length,1);assert.equal(lista[0].estado,'rascunho');
  assert.equal(lista[0].importacao.estadoOriginal,'confirmado');assert.equal(lista[0].importacao.revisaoNecessaria,true);
  assert.ok(!JSON.stringify(lista).includes('Nota reservada'));assert.ok(!JSON.stringify(lista).includes('NÃO EXIBIR'));
  const previa=b.service.prepararImportado({id:a.projeto.id});
  assert.deepEqual(previa.fontes,previa.projeto.fontes);assert.match(previa.aviso,/organização local como rascunho/);
  assert.ok(previa.fontes.every(f=>f.importacao.backupSha256===lista[0].importacao.backupSha256));
  assert.throws(()=>b.service.revalidarImportado({previaId:previa.previaId}),codigo('CONFIRMACAO_NECESSARIA'));
  const p=b.service.revalidarImportado({previaId:previa.previaId,confirmar:true});
  assert.equal(p.id,a.projeto.id);assert.equal(p.estado,'rascunho');assert.equal(p.acordoVerificado,false);
  assert.equal(p.revalidado,true);assert.equal(p.alterado,true);assert.equal(p.fontes.length,2);
  assert.equal(b.service.timeline({id:p.id}).length,antes.length+1);
  assert.equal(b.service.timeline({id:p.id})[0].tipo,'importado_revisado');
  assert.deepEqual(b.service.listarImportados(),[]);semGrants(b);
  assert.equal(b.service.revalidarImportado({previaId:previa.previaId,confirmar:true}).alterado,false);
  assert.equal(decisoes(b).length,1);assert.deepEqual(b.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('importados: rebackup pendente e revisado preserva identidade e exige novo gesto no destino',async t=>{
  const a=semear(perfil(t)),b=perfil(t),c=perfil(t),d=perfil(t);await restaurar(a,b);await restaurar(b,c);
  assert.equal(c.service.listarImportados().length,1);revisar(b,a.projeto.id);await restaurar(b,d);
  assert.equal(d.service.listarImportados().length,1);assert.deepEqual(d.service.listar(),[]);
  assert.equal(revisar(d,a.projeto.id).id,a.projeto.id);assert.equal(decisoes(d).length,2);semGrants(d);
});

test('importados: base sem leitura oculta nome, trechos e prévia até permissão atual explícita',async t=>{
  const a=semear(perfil(t),{terceiro:true}),b=perfil(t);await restaurar(a,b);
  assert.deepEqual(b.service.listarImportados(),[]);assert.deepEqual(b.service.listar(),[]);
  assert.throws(()=>b.service.prepararImportado({id:a.projeto.id}),codigo('PROJETO_IMPORTADO_INDISPONIVEL'));
  b.db.prepare("INSERT INTO politicas_conversa VALUES('conversa-a','tudo',?)").run(data);
  assert.equal(b.service.listarImportados().length,1);assert.equal(revisar(b,a.projeto.id).fontes.length,1);
});

test('importados: uma das duas bases sem leitura oculta o projeto inteiro',async t=>{
  const a=semear(perfil(t),{duas:true}),b=perfil(t);await restaurar(a,b);
  b.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(a.z);
  assert.deepEqual(b.service.listarImportados(),[]);assert.throws(()=>revisar(b,a.projeto.id),codigo('PROJETO_IMPORTADO_INDISPONIVEL'));
});

test('importados: fonte removida ou invalidada na origem nunca volta na revisão',async t=>{
  const a=semear(perfil(t)),b=perfil(t);
  const removida=a.service.vincularFonte({id:a.projeto.id,eventoId:a.z});a.service.desvincularFonte({id:a.projeto.id,fonteId:removida.fonteId});
  const e=evento(a,'Detalhe que mudou.'),invalida=a.service.vincularFonte({id:a.projeto.id,eventoId:e});
  a.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Detalhe alterado.',e);
  a.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Detalhe que mudou.',e);
  await restaurar(a,b);const p=revisar(b,a.projeto.id);assert.equal(p.fontes.length,1);
  for(const id of [removida.fonteId,invalida.fonteId])assert.equal(b.db.prepare('SELECT invalidada FROM lume_projetos_fontes WHERE id=?').get(id).invalidada,1);
  assert.equal(b.db.prepare('SELECT removida FROM lume_projetos_fontes WHERE id=?').get(removida.fonteId).removida,1);
  assert.ok(!JSON.stringify(b.service.timeline({id:p.id})).includes('Detalhe que mudou'));
});

test('importados: base já inválida na origem permanece indisponível mesmo com texto igual',async t=>{
  const a=semear(perfil(t)),b=perfil(t),texto=a.db.prepare('SELECT texto FROM eventos WHERE id=?').get(a.a).texto;
  a.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto alterado.',a.a);
  a.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(texto,a.a);
  await restaurar(a,b);assert.deepEqual(b.service.listarImportados(),[]);
});

test('importados: procedência legada null ou ausente não é adivinhada nem recuperada por nome',async t=>{
  const a=semear(perfil(t)),b=perfil(t),c=perfil(t);await restaurar(a,b);
  b.db.prepare("UPDATE lume_ciclo_importacoes SET estado_original=NULL WHERE tabela='lume_projetos_fontes'").run();
  assert.deepEqual(b.service.listarImportados(),[]);await restaurar(b,c);assert.deepEqual(c.service.listarImportados(),[]);
  b.db.prepare("DELETE FROM lume_ciclo_importacoes WHERE tabela='lume_projetos_fontes'").run();
  evento(b,'Preparar a proposta do site. Nota reservada de outro projeto.',{conversa:'homonimo'});
  assert.deepEqual(b.service.listarImportados(),[]);
});

test('importados: fonte idêntica em outra identidade e seleção de evento parcial não conferem autoridade',async t=>{
  const a=semear(perfil(t)),b=perfil(t);await restaurar(a,b);
  const original=b.db.prepare('SELECT * FROM eventos WHERE id=?').get(a.a);
  b.db.prepare('UPDATE eventos SET origem_id=? WHERE id=?').run(randomUUID(),a.a);
  assert.deepEqual(b.service.listarImportados(),[]);
  b.db.prepare('UPDATE eventos SET origem_id=? WHERE id=?').run(original.origem_id,a.a);
  assert.deepEqual(b.service.listarImportados(),[]);
  const c=perfil(t),conteudo=a.b.capturar();const f=conteudo.tabelas.lume_projetos_fontes[0];f.selecao='evento';
  await restaurar(a,c,conteudo);assert.deepEqual(c.service.listarImportados(),[]);
});

test('importados: expiração, replay, parâmetros desconhecidos e limite não concedem nova decisão',async t=>{
  const a=semear(perfil(t)),b=perfil(t);await restaurar(a,b);
  assert.throws(()=>b.service.listarImportados({limite:0}),codigo('PROJETO_INVALIDO'));
  assert.throws(()=>b.service.prepararImportado({id:a.projeto.id,pasta:'inventada'}),codigo('PROJETO_INVALIDO'));
  let p=b.service.prepararImportado({id:a.projeto.id});b.tempo+=300000;
  assert.throws(()=>b.service.revalidarImportado({previaId:p.previaId,confirmar:true}),codigo('PREVIA_EXPIRADA'));
  p=b.service.prepararImportado({id:a.projeto.id});
  assert.throws(()=>b.service.revalidarImportado({previaId:p.previaId,confirmar:true,estado:'confirmado'}),codigo('PROJETO_INVALIDO'));
  b.service.revalidarImportado({previaId:p.previaId,confirmar:true});
  b.service.confirmar({id:a.projeto.id,confirmar:true});
  assert.throws(()=>b.service.revalidarImportado({previaId:p.previaId,confirmar:true}),codigo('PREVIA_DESATUALIZADA'));
  assert.equal(b.service.obter(a.projeto.id).estado,'confirmado');assert.equal(decisoes(b).length,1);
});

test('importados: reinício invalida prévia, preserva decisão salva e histórico sem duplicação',async t=>{
  const a=semear(perfil(t)),b=perfil(t);await restaurar(a,b);const p=b.service.prepararImportado({id:a.projeto.id});
  b.reabrir();assert.throws(()=>b.service.revalidarImportado({previaId:p.previaId,confirmar:true}),codigo('PREVIA_EXPIRADA'));
  revisar(b,a.projeto.id);b.reabrir();assert.equal(b.service.obter(a.projeto.id).estado,'rascunho');
  assert.deepEqual(b.service.listarImportados(),[]);assert.equal(decisoes(b).length,1);
});

for(const tipo of ['edicao','revogacao'])test(`importados: ${tipo} ABA por outra conexão invalida prévia e sobrevive reinício/rebackup`,async t=>{
  const a=semear(perfil(t),{terceiro:tipo==='revogacao'}),b=perfil(t),c=perfil(t);await restaurar(a,b);
  if(tipo==='revogacao')b.db.prepare("INSERT INTO politicas_conversa VALUES('conversa-a','tudo',?)").run(data);
  const p=b.service.prepararImportado({id:a.projeto.id});const outra=abrirBanco(b.caminho);
  try{
    if(tipo==='edicao'){
      const texto=outra.prepare('SELECT texto FROM eventos WHERE id=?').get(a.a).texto;
      outra.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Conteúdo alterado.',a.a);
      outra.prepare('UPDATE eventos SET texto=? WHERE id=?').run(texto,a.a);
    }else outra.exec("DELETE FROM politicas_conversa WHERE conversa_id='conversa-a'; INSERT INTO politicas_conversa VALUES('conversa-a','tudo','2026-09-25T21:00:00Z')");
  }finally{outra.close();}
  assert.throws(()=>b.service.revalidarImportado({previaId:p.previaId,confirmar:true}),codigo('PREVIA_DESATUALIZADA'));
  b.reabrir();assert.deepEqual(b.service.listarImportados(),[]);await restaurar(b,c);
  if(tipo==='revogacao')c.db.prepare("INSERT INTO politicas_conversa VALUES('conversa-a','tudo',?)").run(data);
  assert.deepEqual(c.service.listarImportados(),[]);
});

test('importados: revogação após revisão também não se perde em rebackup',async t=>{
  const a=semear(perfil(t),{terceiro:true}),b=perfil(t),c=perfil(t);await restaurar(a,b);
  b.db.prepare("INSERT INTO politicas_conversa VALUES('conversa-a','tudo',?)").run(data);revisar(b,a.projeto.id);
  b.db.exec("DELETE FROM politicas_conversa WHERE conversa_id='conversa-a'");await restaurar(b,c);
  c.db.prepare("INSERT INTO politicas_conversa VALUES('conversa-a','tudo',?)").run(data);
  assert.deepEqual(c.service.listarImportados(),[]);assert.deepEqual(c.service.listar(),[]);
});

test('importados: revogação antes da primeira prévia não ressuscita após reinício',async t=>{
  const a=semear(perfil(t),{terceiro:true}),b=perfil(t);await restaurar(a,b);
  b.db.prepare("INSERT INTO politicas_conversa VALUES('conversa-a','tudo',?)").run(data);
  b.db.exec("UPDATE politicas_conversa SET politica='so-minhas'; UPDATE politicas_conversa SET politica='tudo'");
  b.reabrir();assert.deepEqual(b.service.listarImportados(),[]);
});

test('importados: mudança durante escrita reverte todos os vínculos e a decisão',async t=>{
  const a=semear(perfil(t),{duas:true}),b=perfil(t);await restaurar(a,b);
  const p=b.service.prepararImportado({id:a.projeto.id}),registrar=b.service._registrar.bind(b.service);
  b.service._registrar=(...args)=>{registrar(...args);b.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Alteração concorrente simulada.',a.a);};
  assert.throws(()=>b.service.revalidarImportado({previaId:p.previaId,confirmar:true}),codigo('PREVIA_DESATUALIZADA'));
  assert.ok(b.db.prepare('SELECT invalidada FROM lume_projetos_fontes').all().every(f=>f.invalidada===1));
  assert.equal(decisoes(b).length,0);assert.equal(b.service.listarImportados().length,1);
  b.service._registrar=registrar;assert.equal(revisar(b,a.projeto.id).fontes.length,2);
});

test('importados: restauro ABA com mesmos IDs/hash não reaproveita a prévia antiga',async t=>{
  const a=semear(perfil(t)),b=perfil(t);await restaurar(a,b);const p=b.service.prepararImportado({id:a.projeto.id});
  // Simula descarte de perfil sem tombstones, seguido do mesmo backup real.
  b.db.exec('DELETE FROM eventos;DELETE FROM conversas_app;');
  for(const tabela of [...CICLO_TABELAS].reverse())b.db.exec(`DELETE FROM ${tabela}`);
  await restaurar(a,b);assert.equal(b.service.listarImportados().length,1);
  assert.throws(()=>b.service.revalidarImportado({previaId:p.previaId,confirmar:true}),codigo('PREVIA_DESATUALIZADA'));
  b.reabrir();assert.throws(()=>b.service.revalidarImportado({previaId:p.previaId,confirmar:true}),codigo('PREVIA_EXPIRADA'));
});

test('importados: exportação parcial exige todas as bases e exclusão apaga guardas/histórico/procedências',async t=>{
  const a=semear(perfil(t),{duas:true}),b=perfil(t);await restaurar(a,b);
  assert.equal(b.p.dadosCiclo([a.a,a.z],{exportacao:true}).lume_projetos_comerciais.length,0);
  revisar(b,a.projeto.id);assert.equal(b.p.dadosCiclo([a.a],{exportacao:true}).lume_projetos_comerciais.length,0);
  const exp=b.p.dadosCiclo([a.a,a.z],{exportacao:true});assert.equal(exp.lume_projetos_comerciais.length,1);
  assert.equal(exp.lume_projetos_historico.filter(h=>h.tipo==='importado_revisado').length,1);
  const p=b.p.preparar({fonte:a.a});b.p.excluir({id:p.id,confirmar:'APAGAR'});
  for(const tabela of ['lume_projetos_comerciais','lume_projetos_fontes','lume_projetos_historico','lume_projetos_importados_guardas'])
    assert.equal(b.db.prepare(`SELECT count(*) n FROM ${tabela}`).get().n,0,tabela);
  assert.equal(b.db.prepare("SELECT count(*) n FROM lume_ciclo_importacoes WHERE tabela LIKE 'lume_projetos_%'").get().n,0);
  assert.deepEqual(b.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('importados: upgrade de perfil legado preserva IDs/seq/histórico e não ativa importados sem guarda',async t=>{
  const a=semear(perfil(t)),b=perfil(t);await restaurar(a,b);
  const rows=b.db.prepare('SELECT * FROM lume_projetos_historico ORDER BY id').all();
  const sql=b.db.prepare("SELECT sql FROM sqlite_master WHERE name='lume_projetos_historico'").get().sql;
  b.db.exec(sql.replace('lume_projetos_historico','historico_legado').replace(",'importado_revisado'",''));
  b.db.exec('INSERT INTO historico_legado SELECT * FROM lume_projetos_historico;DROP TABLE lume_projetos_historico;ALTER TABLE historico_legado RENAME TO lume_projetos_historico;DELETE FROM lume_projetos_importados_guardas;');
  b.reabrir();assert.deepEqual(b.db.prepare('SELECT * FROM lume_projetos_historico ORDER BY id').all(),rows);
  assert.deepEqual(b.service.listarImportados(),[]);assert.deepEqual(b.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('importados: atividade não relacionada preserva prévia e cache não entra no backup',async t=>{
  const a=semear(perfil(t)),b=perfil(t);await restaurar(a,b);const p=b.service.prepararImportado({id:a.projeto.id});
  const outra=evento(b,'Outro assunto.',{conversa:'independente'});b.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Outro assunto atualizado.',outra);
  b.db.prepare("INSERT INTO desktop_config VALUES('preferencia_visual_sintetica','1')").run();
  assert.equal(b.service.revalidarImportado({previaId:p.previaId,confirmar:true}).alterado,true);
  const backup=b.b.capturar();assert.equal(Object.hasOwn(backup.tabelas,'lume_projetos_importados_guardas'),false);
  assert.equal(Object.hasOwn(backup.tabelas,'lume_projetos_revisoes'),false);
});

test('importados: áudio transcrito tem procedência, seleção literal e alteração ABA invalida',async t=>{
  const a=perfil(t),b=perfil(t);prepararEsquemaTranscricao(a.db);
  const e=evento(a,null,{origem:'audio-sintetico'});a.db.prepare("UPDATE eventos SET tipo='audio' WHERE id=?").run(e);
  gravarTranscricao(a.db,{conversaId:'conversa-a',origemId:'audio-sintetico',textoOriginal:'Vamos preparar a proposta.'});
  a.service=new ProjetosComerciais(a.db);const p=a.service.criarRascunho({nome:'Áudio sintético',fontes:[{eventoId:e,trecho:'preparar a proposta'}]});
  await restaurar(a,b);const previa=b.service.prepararImportado({id:p.id});
  assert.equal(previa.fontes[0].transcricao,true);assert.equal(previa.fontes[0].trecho,'preparar a proposta');
  const original=b.db.prepare("SELECT texto FROM transcricoes WHERE origem_id='audio-sintetico'").get().texto;
  b.db.prepare("UPDATE transcricoes SET texto=? WHERE origem_id='audio-sintetico'").run('Correção da transcrição.');
  b.db.prepare("UPDATE transcricoes SET texto=? WHERE origem_id='audio-sintetico'").run(original);
  assert.throws(()=>b.service.revalidarImportado({previaId:previa.previaId,confirmar:true}),codigo('PREVIA_DESATUALIZADA'));
  b.reabrir();assert.deepEqual(b.service.listarImportados(),[]);
});

test('importados: contribuição F10 exata revogada/reposta bloqueia somente seu projeto',async t=>{
  const a=semear(perfil(t)),b=perfil(t),chaves=generateKeyPairSync('ed25519'),fp=fingerprint(chaves.publicKey),projeto=randomUUID();
  const e=evento(a,'Contribuição compartilhada exata.',{permissao:'compartilhado',origem:'legado:contribuicao-sintetica'});
  a.db.prepare('INSERT INTO f10_projetos VALUES(?,?,?)').run(projeto,'Compartilhamento sintético',data);
  a.db.prepare('INSERT INTO f10_origens VALUES(?,?,?,?)').run(fp,'Pessoa sintética','Máquina sintética',chaves.publicKey.export({type:'spki',format:'pem'}));
  a.db.prepare('INSERT INTO f10_procedencias VALUES(?,?,?,?,?,?,?,?)').run(e,fp,randomUUID(),projeto,data,data,null,null);
  const p=a.service.criarRascunho({nome:'Compartilhado sintético',fontes:[{eventoId:e}]});await restaurar(a,b);
  const previa=b.service.prepararImportado({id:p.id}),outra=b.service.prepararImportado({id:a.projeto.id});
  const r=b.db.prepare('SELECT * FROM f10_procedencias WHERE evento_id=?').get(e);
  b.db.prepare('DELETE FROM f10_procedencias WHERE evento_id=?').run(e);
  b.db.prepare(`INSERT INTO f10_procedencias(${Object.keys(r).join(',')}) VALUES(${Object.keys(r).map(()=>'?').join(',')})`).run(...Object.values(r));
  assert.throws(()=>b.service.revalidarImportado({previaId:previa.previaId,confirmar:true}),codigo('PREVIA_DESATUALIZADA'));
  assert.equal(b.service.revalidarImportado({previaId:outra.previaId,confirmar:true}).id,a.projeto.id);
});

test('importados: vínculo adicional válido é revisado, exclusão dele preserva base e não deixa órfãos',async t=>{
  const a=semear(perfil(t)),b=perfil(t);a.service.vincularFonte({id:a.projeto.id,eventoId:a.z});await restaurar(a,b);
  const p=revisar(b,a.projeto.id);assert.equal(p.fontes.length,2);assert.equal(p.fontes.filter(f=>f.base).length,1);
  const previa=b.p.preparar({fonte:a.z});b.p.excluir({id:previa.id,confirmar:'APAGAR'});
  assert.equal(b.service.obter(p.id).fontes.length,1);
  assert.equal(b.db.prepare('SELECT count(*) n FROM lume_projetos_importados_guardas').get().n,1);
  assert.deepEqual(b.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('importados: backup com prefixo assessor-acervo-v7 permanece aceito sem inventar projetos',async t=>{
  const a=semear(perfil(t)),b=perfil(t),conteudo=a.b.capturar();conteudo.versao='assessor-acervo-v7';
  for(const tabela of CICLO_TABELAS)delete conteudo.tabelas[tabela];
  await restaurar(a,b,conteudo);assert.equal(b.db.prepare('SELECT count(*) n FROM eventos').get().n,3);
  assert.deepEqual(b.service.listarImportados(),[]);assert.deepEqual(b.service.listar(),[]);semGrants(b);
});
