import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {AcoesLume,conferirCandidatasAcoes,resumoAcoesLume} from '../src/acoes-lume.js';
import {Backup,cifrarBackup} from '../src/backup.js';
import {Privacidade} from '../src/privacidade.js';
import {criarServidor} from '../src/painel/servidor.js';

function setup(t){
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);new Desktop(db);
  for(const id of ['dm','grupo'])db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,id);
  const agora=()=>new Date('2026-09-24T18:00:00Z'),acoes=new AcoesLume(db,{agora});
  const inserir=(conversa,origem,texto,permissao='minha')=>Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_id)
    VALUES(?,?,'entrada','texto','{}',?,'2026-09-24T17:00:00Z','2026-09-24',?,'autor-exato')`).run(conversa,origem,texto,permissao).lastInsertRowid);
  const candidata=(id,trecho,resumo)=>({fonte:'E'+id,tipo:'pendencia',resumo,trecho,prazo_citado:''});
  return {db,acoes,inserir,candidata};
}

test('0.6: duas pendências do mesmo tipo na mesma mensagem têm IDs próprios e reprocessamento idempotente',t=>{
  const f=setup(t),texto='Preparar o relatório para a reunião. Confirmar a data com Rafa.';
  const id=f.inserir('dm','duas',texto),itens=[f.candidata(id,'Preparar o relatório para a reunião.','Preparar relatório'),f.candidata(id,'Confirmar a data com Rafa.','Confirmar data')];
  assert.deepEqual(f.acoes.registrar({eventoId:id,candidatas:itens}),{novos:2,total:2});
  const primeira=f.acoes.listar();assert.equal(primeira.length,2);assert.equal(new Set(primeira.map(a=>a.id)).size,2);
  assert.deepEqual(f.acoes.registrar({eventoId:id,candidatas:[{...itens[0],resumo:'Relatório da reunião'},{...itens[1],resumo:'Confirmar a data'}]}),{novos:0,total:2});
  const outra=new AcoesLume(f.db),segunda=outra.listar();assert.deepEqual(new Set(segunda.map(a=>a.id)),new Set(primeira.map(a=>a.id)));
  assert.equal(segunda.find(a=>a.trecho===itens[0].trecho).resumo,'Relatório da reunião');
});

test('0.6: revogação é exata por conversa; fonte alterada não permanece acionável',t=>{
  const f=setup(t),id=f.inserir('dm','m1','Pode enviar o contrato assinado?'),grupo=f.inserir('grupo','m2','Pode confirmar a data da reunião?');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  const compartilhada=f.inserir('grupo','shared-m2','Confirm meeting date?','compartilhado');
  assert.throws(()=>f.acoes.registrar({eventoId:compartilhada,candidatas:[f.candidata(compartilhada,'Confirm meeting date?','Confirm date')]}),/ausente/);
  f.acoes.registrar({eventoId:id,candidatas:[f.candidata(id,'Pode enviar o contrato assinado?','Enviar contrato')]});
  assert.equal(f.acoes.listar().length,1);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('O contrato já foi enviado.',id);
  assert.equal(f.acoes.listar().length,0);
  f.acoes.autorizar({conversa:'dm',permitida:false});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_conversas').get().n,0);
});

test('0.6: candidatos exigem trecho único e distinto; nenhum item parcial entra no banco',t=>{
  const f=setup(t),id=f.inserir('dm','repetida','Enviar o contrato. Enviar o contrato.');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  const fonte=f.db.prepare('SELECT * FROM desktop_fontes WHERE id=?').get(id);
  assert.throws(()=>conferirCandidatasAcoes([f.candidata(id,'Enviar o contrato.','Enviar')],fonte),/repetido/);
  assert.throws(()=>f.acoes.registrar({eventoId:id,candidatas:[f.candidata(id,'Texto inventado no grupo.','Inválido')]}),/ausente/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
});

test('0.6: revisão humana estaciona e resolve com histórico persistente',t=>{
  const f=setup(t),id=f.inserir('dm','revisao','Preparar o relatório até amanhã. Confirmar a data com Rafa.');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.acoes.registrar({eventoId:id,candidatas:[f.candidata(id,'Preparar o relatório até amanhã.','Preparar relatório'),f.candidata(id,'Confirmar a data com Rafa.','Confirmar data')]});
  const [a,b]=f.acoes.listar();
  assert.throws(()=>f.acoes.revisar({id:a.id,acao:'resolver'}),/transição/);
  assert.throws(()=>f.acoes.revisar({id:a.id,acao:'estacionar',lembrarEm:'2026-09-25T10:00:00.000Z',fuso:'fuso-inexistente'}),/Fuso/);
  assert.deepEqual(f.acoes.revisar({id:a.id,acao:'estacionar',lembrarEm:'2026-09-25T10:00:00.000Z',fuso:'America/Sao_Paulo'}),{id:a.id,estado:'estacionado',lembrarEm:'2026-09-25T10:00:00.000Z'});
  assert.equal(f.acoes.revisar({id:a.id,acao:'resolver',motivo:'Conferido pela pessoa'}).estado,'resolvido');
  assert.equal(f.acoes.revisar({id:a.id,acao:'reabrir'}).estado,'confirmado');
  assert.equal(f.acoes.listar({estado:'sugerido'}).length,1);
  assert.equal(f.acoes.listar({estado:'confirmado'}).length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_historico WHERE acao_id=?').get(a.id).n,3);
  assert.equal(new AcoesLume(f.db).listar({estado:'sugerido'})[0].id,b.id);
});

test('0.6: correção humana mantém fonte, registra antes/depois e sobrevive à reanálise e ao backup',async t=>{
  const f=setup(t),id=f.inserir('dm','correcao','Rafa, confirme a data da reunião para amanhã.');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  const original=f.candidata(id,'Rafa, confirme a data da reunião para amanhã.','Enviar data da reunião');
  f.acoes.registrar({eventoId:id,candidatas:[original]});
  const acao=f.acoes.listar()[0];
  assert.throws(()=>f.acoes.corrigir({id:acao.id,resumo:'  '}),/descrição/);
  assert.throws(()=>f.acoes.revisar({id:acao.id,acao:'confirmar',motivo:'{"tipo":"correcao_resumo","falso":true}'}),/Revisão/);
  assert.deepEqual(f.acoes.corrigir({id:acao.id,resumo:'  Cobrar confirmação de Rafa  '}),{id:acao.id,resumo:'Cobrar confirmação de Rafa',alterado:true});
  assert.equal(f.acoes.corrigir({id:acao.id,resumo:'Cobrar confirmação de Rafa'}).alterado,false);
  const historico=f.db.prepare('SELECT * FROM lume_acoes_historico WHERE acao_id=?').all(acao.id);
  assert.equal(historico.length,1);
  assert.deepEqual(JSON.parse(historico[0].motivo),{tipo:'correcao_resumo',anterior:'Enviar data da reunião',novo:'Cobrar confirmação de Rafa'});
  assert.equal(historico[0].estado_anterior,historico[0].estado_novo);
  f.acoes.registrar({eventoId:id,candidatas:[{...original,resumo:'Outro resumo da análise'}]});
  assert.equal(f.acoes.obter(acao.id).resumo,'Cobrar confirmação de Rafa');
  const backup=new Backup(f.db),pacote=backup.capturar();backup.validar(pacote);
  assert.equal(pacote.tabelas.lume_acoes[0].resumo,'Cobrar confirmação de Rafa');
  const destino=abrirBanco();t.after(()=>destino.close());new ContextoApp(destino);new Desktop(destino);new DesktopIA(destino);
  const restaurador=new Backup(destino),senha='senha-sintetica-segura';
  const previa=await restaurador.preparar({arquivo:JSON.stringify(await cifrarBackup(pacote,senha)),senha});
  restaurador.restaurar({id:previa.id,confirmarMeuBackup:true});
  const restauradas=new AcoesLume(destino);restauradas.autorizar({conversa:'dm',permitida:true});
  assert.equal(restauradas.obter(acao.id).resumo,'Cobrar confirmação de Rafa');
  assert.deepEqual(JSON.parse(destino.prepare('SELECT motivo FROM lume_acoes_historico WHERE acao_id=?').get(acao.id).motivo),JSON.parse(historico[0].motivo));
  const corrompido=structuredClone(pacote);corrompido.tabelas.lume_acoes_historico[0].motivo='{"tipo":"correcao_resumo","novo":"sem anterior"}';
  assert.throws(()=>backup.validar(corrompido),/Ações da 0.6/);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('A reunião foi cancelada.',id);
  assert.throws(()=>f.acoes.corrigir({id:acao.id,resumo:'Ação cancelada'}),/fonte mudou/);
});

test('B02/B03: group message creates local action without manual conversation setup',t=>{
  const f=setup(t),id=f.inserir('grupo','responsabilidade','Confirm the meeting date with the client.','terceiro');
  const candidata=f.candidata(id,'Confirm the meeting date with the client.','Confirmar data');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_conversas').get().n,0);
  f.acoes.registrar({eventoId:id,candidatas:[candidata]});
  const acao=f.acoes.listar()[0];
  assert.ok(acao,'mensagem de terceiro no grupo aparece na lista pessoal');
  assert.equal(f.acoes.obter(acao.id).evento_id,id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_conversas').get().n,0,
    'a captura local does not create a grant de conversa para executor/MCP');
  const externo=f.inserir('grupo','compartilhada','Revisar a proposta com cuidado.','compartilhado');
  assert.throws(()=>f.acoes.registrar({eventoId:externo,candidatas:[f.candidata(externo,'Revisar a proposta com cuidado.','Revisar proposta')]}),/ausente|permiss?o/);
  assert.equal(acao.autor_id,'autor-exato');
  assert.equal(acao.responsavel_id,null);
  assert.deepEqual(f.acoes.listar({estado:'minhas'}),[]);
  assert.equal(f.acoes.definirMinha({id:acao.id,minha:true}).alterado,true);
  assert.equal(f.acoes.definirMinha({id:acao.id,minha:true}).alterado,false);
  assert.equal(f.acoes.listar({estado:'minhas'})[0].id,acao.id);
  assert.equal(f.acoes.obter(acao.id).autor_id,'autor-exato');
  f.acoes.registrar({eventoId:id,candidatas:[candidata]});
  assert.equal(f.acoes.obter(acao.id).responsavel_id,'local:owner');
  const h=f.db.prepare('SELECT * FROM lume_acoes_historico WHERE acao_id=?').all(acao.id);
  assert.equal(h.length,1);
  assert.deepEqual(JSON.parse(h[0].motivo),{tipo:'responsabilidade',anterior:null,novo:'local:owner'});
  const pacote=new Backup(f.db); pacote.validar(pacote.capturar());
  assert.equal(f.acoes.definirMinha({id:acao.id,minha:false}).alterado,true);
  assert.deepEqual(f.acoes.listar({estado:'minhas'}),[]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_historico WHERE acao_id=?').get(acao.id).n,2);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('The meeting was cancelled.',id);
  assert.throws(()=>f.acoes.definirMinha({id:acao.id,minha:true}),/fonte mudou/);
  f.db.prepare('DELETE FROM eventos WHERE id=?').run(id);
  assert.equal(f.acoes.listar().length,0,'excluir a fonte remove the derived action');
});

test('B05: páginas de ações cobrem a lista inteira sem repetir nem cortar demandas',t=>{
  const f=setup(t);
  for(let n=0;n<7;n++){
    const trecho=`Preparar o material ${n} para o cliente.`;
    const id=f.inserir('dm',`paginacao-${n}`,trecho);
    f.acoes.registrar({eventoId:id,candidatas:[f.candidata(id,trecho,`Preparar material ${n}`)]});
  }
  assert.equal(f.acoes.contar({estado:'sugerido'}),7);
  const paginas=[1,2,3,4].map(pagina=>f.acoes.listar({estado:'sugerido',limite:2,pagina}));
  assert.deepEqual(paginas.map(p=>p.length),[2,2,2,1]);
  assert.equal(new Set(paginas.flat().map(x=>x.id)).size,7);
  assert.throws(()=>f.acoes.listar({estado:'sugerido',limite:2,pagina:0}),/inválido/);
});
test('0.6: fila Agora mantém confirmadas e só retoma lembretes vencidos',t=>{
  const f=setup(t),id=f.inserir('dm','agora','Enviar a proposta. Confirmar a reunião.');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.acoes.registrar({eventoId:id,candidatas:[f.candidata(id,'Enviar a proposta.','Enviar proposta'),f.candidata(id,'Confirmar a reunião.','Confirmar reunião')]});
  const [first,second]=f.acoes.listar();
  f.acoes.revisar({id:first.id,acao:'confirmar'});
  f.acoes.revisar({id:second.id,acao:'estacionar',lembrarEm:'2026-09-25T10:00:00.000Z',fuso:'America/Sao_Paulo'});
  assert.deepEqual(f.acoes.listar({estado:'ativos'}).map(a=>a.id),[first.id]);
  assert.equal(f.acoes.listar({estado:'estacionado'}).length,1);
  const depois=new AcoesLume(f.db,{agora:()=>new Date('2026-09-25T10:01:00Z')});
  assert.deepEqual(new Set(depois.listar({estado:'ativos'}).map(a=>a.id)),new Set([first.id,second.id]));
  depois.revisar({id:first.id,acao:'resolver'});
  assert.deepEqual(depois.listar({estado:'ativos'}).map(a=>a.id),[second.id]);
});

test('0.6: fonte editada impede revisão e revogação apaga histórico derivado',t=>{
  const f=setup(t),id=f.inserir('dm','revogacao','Pode revisar a minuta assinada?');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.acoes.registrar({eventoId:id,candidatas:[f.candidata(id,'Pode revisar a minuta assinada?','Revisar minuta')]});
  const a=f.acoes.listar()[0];f.acoes.revisar({id:a.id,acao:'confirmar'});
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('A minuta foi cancelada.',id);
  assert.throws(()=>f.acoes.revisar({id:a.id,acao:'resolver'}),/fonte mudou/);
  f.acoes.autorizar({conversa:'dm',permitida:false});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_historico').get().n,0);
});

test('0.6: backup v7 conserva ações e histórico sem restaurar permissão local',async t=>{
  const f=setup(t),id=f.inserir('dm','backup-acao','Enviar o contrato assinado amanhã.');
  f.acoes.autorizar({conversa:'dm',permitida:true});f.acoes.registrar({eventoId:id,candidatas:[f.candidata(id,'Enviar o contrato assinado amanhã.','Enviar contrato')]});
  const original=f.acoes.listar()[0];f.acoes.revisar({id:original.id,acao:'confirmar'});
  const origemBackup=new Backup(f.db),pacote=origemBackup.capturar();assert.equal(pacote.versao,'assessor-acervo-v7');assert.equal(pacote.tabelas.lume_acoes.length,1);assert.equal(pacote.tabelas.lume_acoes_historico.length,1);
  const adulterado=structuredClone(pacote);adulterado.tabelas.lume_acoes[0].evento_id=999999;assert.throws(()=>origemBackup.validar(adulterado),/Ações da 0.6/);
  const dest=abrirBanco();t.after(()=>dest.close());new ContextoApp(dest);new Desktop(dest);new DesktopIA(dest);const restaurador=new Backup(dest),senha='senha-sintetica-segura';
  const previa=await restaurador.preparar({arquivo:JSON.stringify(await cifrarBackup(pacote,senha)),senha});restaurador.restaurar({id:previa.id,confirmarMeuBackup:true});
  const acoes=new AcoesLume(dest);assert.equal(acoes.listar({estado:'confirmado'})[0].id,original.id,
    'restore preserves local visibility without manual conversation grant');
  assert.equal(dest.prepare('SELECT COUNT(*) n FROM lume_acoes_historico').get().n,1);
});

test('0.6: exportação e exclusão por fonte incluem ação e histórico',t=>{
  const f=setup(t),id=f.inserir('dm','direitos-acao','Confirmar a reunião com a equipe.');
  f.acoes.autorizar({conversa:'dm',permitida:true});f.acoes.registrar({eventoId:id,candidatas:[f.candidata(id,'Confirmar a reunião com a equipe.','Confirmar reunião')]});
  f.acoes.revisar({id:f.acoes.listar()[0].id,acao:'confirmar'});
  const priv=new Privacidade(f.db),exportado=priv.exportar({conversa:'dm',confirmar:true}).conteudo;
  assert.equal(exportado.derivados.lume_acoes.length,1);assert.equal(exportado.derivados.lume_acoes_historico.length,1);
  const previa=priv.preparar({fonte:id});assert.equal(previa.contagens.lume_acoes,1);assert.equal(previa.contagens.lume_acoes_historico,1);
  priv.excluir({id:previa.id,confirmar:'APAGAR'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_historico').get().n,0);
});

test('0.6: backup fechado v6 migra para v7 sem criar ação fictícia',t=>{
  const f=setup(t),backup=new Backup(f.db),antigo=backup.capturar();
  antigo.versao='assessor-acervo-v6';delete antigo.tabelas.lume_acoes;delete antigo.tabelas.lume_acoes_historico;
  backup.validar(antigo);
  assert.equal(antigo.versao,'assessor-acervo-v7');
  assert.deepEqual(antigo.tabelas.lume_acoes,[]);
  assert.deepEqual(antigo.tabelas.lume_acoes_historico,[]);
});

test('0.6: resumo do dia conta ações atuais, omite as estacionadas no futuro e revogadas',t=>{
  const f=setup(t),id=f.inserir('dm','resumo06','Enviar a minuta. Confirmar a data com a equipe.');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.acoes.registrar({eventoId:id,candidatas:[f.candidata(id,'Enviar a minuta.','Enviar minuta'),f.candidata(id,'Confirmar a data com a equipe.','Confirmar data')]});
  const agora=new Date('2026-09-24T18:00:00Z');
  assert.equal(resumoAcoesLume(f.db,{agora}).total,2);
  const a=f.acoes.listar()[0];f.acoes.revisar({id:a.id,acao:'estacionar',lembrarEm:'2026-09-25T10:00:00.000Z',fuso:'America/Sao_Paulo'});
  assert.equal(resumoAcoesLume(f.db,{agora}).total,1);
  assert.equal(resumoAcoesLume(f.db,{agora:new Date('2026-09-25T11:00:00Z')}).total,2);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('As duas tarefas foram canceladas.',id);
  assert.equal(resumoAcoesLume(f.db,{agora}).total,0);
});

test('0.6: API desktop exige sessão e aceite para permissão e revisão; não aceita candidato pela rede',async t=>{
  const db=abrirBanco();new ContextoApp(db);const desktop=new Desktop(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('dm','DM de teste');
  const servidor=criarServidor(db,{desktop:true,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
  await new Promise(resolve=>servidor.listen(0,'127.0.0.1',resolve));t.after(()=>{servidor.closeAllConnections();return new Promise(resolve=>servidor.close(()=>{db.close();resolve();}));});
  const base=`http://127.0.0.1:${servidor.address().port}`;
  const {token}=await(await fetch(base+'/api/sessao')).json();
  const post=(route,body,autorizado=true)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(autorizado?{'x-assessor-token':token}:{})},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/v3/acoes')).status,403);
  desktop.aceitar({nome:'Pessoa de teste',aceito:true,versao:VERSAO_TERMOS});
  assert.equal((await fetch(base+'/api/v3/acoes')).status,403);
  assert.equal((await post('/api/v3/acoes/autorizar',{conversa:'dm',permitida:true},false)).status,403);
  assert.equal((await post('/api/v3/acoes/autorizar',{conversa:'dm',permitida:true})).status,200);
  assert.equal((await fetch(base+'/api/v3/acoes/conversas')).status,403);
  assert.equal((await fetch(base+'/api/v3/acoes/estado')).status,403);
  const avisos=await(await fetch(base+'/api/v3/acoes/estado',{headers:{'x-assessor-token':token}})).json();assert.equal(avisos.disponivel,false);assert.equal(avisos.som,true);
  assert.equal((await post('/api/v3/acoes/som',{som:false},false)).status,403);
  assert.equal((await post('/api/v3/acoes/som',{som:'não'})).status,400);
  assert.equal((await post('/api/v3/acoes/som',{som:false,extra:true})).status,400);
  assert.equal((await post('/api/v3/acoes/som',{som:false})).status,200);
  const semSom=await(await fetch(base+'/api/v3/acoes/estado',{headers:{'x-assessor-token':token}})).json();assert.equal(semSom.som,false);
  const permitidas=await(await fetch(base+'/api/v3/acoes/conversas?busca=DM',{headers:{'x-assessor-token':token}})).json();
  assert.equal(permitidas.conversas[0].autorizada,1);
  const id=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('dm','api-1','entrada','texto','{}','Pode enviar a minuta?','2026-09-24T17:00:00Z','2026-09-24','minha')`).run().lastInsertRowid);
  const acoes=new AcoesLume(db);acoes.registrar({eventoId:id,candidatas:[{fonte:'E'+id,tipo:'pendencia',resumo:'Enviar minuta',trecho:'Pode enviar a minuta?',prazo_citado:''}]});
  const pagina=await(await fetch(base+'/api/v3/acoes',{headers:{'x-assessor-token':token}})).json();assert.equal(pagina.acoes.length,1);
  const itemPath='/api/v3/acoes/item?id='+encodeURIComponent(pagina.acoes[0].id);
  assert.equal((await fetch(base+itemPath)).status,403);
  assert.equal((await fetch(base+'/api/v3/acoes/item?id=%3Cscript%3E',{headers:{'x-assessor-token':token}})).status,400);
  const ficha=await(await fetch(base+itemPath,{headers:{'x-assessor-token':token}})).json();assert.equal(ficha.acao.evento_id,id);
  db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte alterada',id);
  assert.equal((await fetch(base+itemPath,{headers:{'x-assessor-token':token}})).status,404);
  db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Pode enviar a minuta?',id);
  assert.equal((await post('/api/v3/acoes/registrar',{eventoId:id,candidatas:[]})).status,404);
  assert.equal((await post('/api/v3/acoes/corrigir',{id:pagina.acoes[0].id,resumo:'Minuta correta'},false)).status,403);
  assert.equal((await post('/api/v3/acoes/corrigir',{id:pagina.acoes[0].id,resumo:'Minuta correta',extra:true})).status,400);
  assert.equal((await post('/api/v3/acoes/corrigir',{id:pagina.acoes[0].id,resumo:'Revisar a minuta correta'})).status,200);
  assert.equal(acoes.obter(pagina.acoes[0].id).resumo,'Revisar a minuta correta');
  assert.equal((await post('/api/v3/acoes/minha',{id:pagina.acoes[0].id,minha:true},false)).status,403);
  assert.equal((await post('/api/v3/acoes/minha',{id:pagina.acoes[0].id,minha:true,extra:true})).status,400);
  assert.equal((await post('/api/v3/acoes/minha',{id:pagina.acoes[0].id,minha:true})).status,200);
  const minhas=await(await fetch(base+'/api/v3/acoes?estado=minhas',{headers:{'x-assessor-token':token}})).json();assert.equal(minhas.acoes[0].id,pagina.acoes[0].id);
  assert.equal((await post('/api/v3/acoes/revisar',{id:pagina.acoes[0].id,acao:'confirmar'})).status,200);
  const confirmado=await(await fetch(base+'/api/v3/acoes?estado=confirmado',{headers:{'x-assessor-token':token}})).json();assert.equal(confirmado.acoes.length,1);
  acoes.autorizar({conversa:'dm',permitida:false});
  assert.equal((await fetch(base+itemPath,{headers:{'x-assessor-token':token}})).status,404);
});
