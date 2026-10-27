import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {DesktopTarefas} from '../src/desktop-tarefas.js';
import {assinaturaFonte} from '../src/tarefas-esquema.js';
import {conferirTarefas} from '../src/tarefas-contrato.js';
import {Privacidade} from '../src/privacidade.js';
import {Backup,cifrarBackup} from '../src/backup.js';
import {TAREFAS_BACKUP} from '../src/tarefas-esquema.js';
import {reservarMicros} from '../src/gemini-desktop.js';

const item=f=>({tipo:'compromisso',resumo:'Revisar a proposta.',fonte:f.fonte,trecho:f.texto,prazo_citado:''});
async function setup(t,provider){
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);const desktop=new Desktop(db);
  for(const c of ['a','b'])db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(c,c);
  let time=new Date('2026-09-18T15:00:00Z'),consent=true;
  const agora=()=>time,calls=[];
  const segredos={estado:async()=>({disponivel:true,configurada:true}),ler:async()=>'synthetic_key_not_a_credential'};
  const ia=new DesktopIA(db,{agora,segredos,gerar:async req=>{
    calls.push(req);const fs=JSON.parse(req.pedido.contents[0].parts[0].text).fontes;
    return provider?provider(req,fs):{dados:{itens:fs.filter(f=>f.analisar).slice(0,12).map(item)}};
  }});
  await ia.configurar({habilitada:true,limiteUSD:1,cienteEnvio:true});ia.permitir({conversa:'a',permitida:true});
  const tarefas=new DesktopTarefas(db,{ia,agora,perfil:()=>({aceito:consent})});
  const inserir=(origem,texto='Vou revisar a proposta amanhã.',permissao='minha',conversa='a')=>Number(db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada','texto','{}',?,?,?,?)").run(conversa,origem,texto,time.toISOString(),time.toISOString().slice(0,10),permissao).lastInsertRowid);
  const preparar=()=>tarefas.preparar({conversa:'a',periodo:'30dias'});
  const gerar=()=>tarefas.gerar({id:preparar().id,confirmar:true});
  const ativar=extra=>tarefas.configurar({ativa:true,conversas:['a'],cienteEnvioAutomatico:true,maxLotesDia:2,...extra});
  return{db,desktop,ia,tarefas,inserir,preparar,gerar,ativar,calls,segredos,agora,avancar:ms=>{time=new Date(time.getTime()+ms);},consentir:v=>{consent=v;}};
}

test('tarefas: prévia isolada, consentimento por pedido e revisão explícita antes do CRM',async t=>{
  const f=await setup(t),id=f.inserir('m1');f.inserir('secret','CONTEÚDO PRIVADO','terceiro');f.inserir('null','SEM CLASSIFICAÇÃO',null);f.inserir('other','OUTRO CLIENTE','minha','b');
  const p=f.preparar();assert.deepEqual(p.fontes.map(s=>s.id),[id]);assert.equal(f.calls.length,0);
  await assert.rejects(f.tarefas.gerar({id:p.id}),/Confirme/);assert.equal(f.calls.length,0);
  const result=await f.tarefas.gerar({id:p.id,confirmar:true});assert.equal(result.novos,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM itens_crm').get().n,0);
  const s=f.tarefas.listar().sugestoes[0];assert.equal(s.evento_id,id);
  const review=f.tarefas.decidir({id:s.id,acao:'aceitar'});assert.equal(review.estadoItem,'aberto');
  const crm=f.db.prepare('SELECT * FROM itens_crm').get();assert.equal(crm.quando,null);assert.equal(crm.responsavel,null);
  assert.equal(f.desktop.resumo().tarefas[0].evento_id,id);
  f.desktop.resolver({id:crm.id});assert.equal(f.desktop.resumo().tarefas.length,0);
  assert.throws(()=>f.tarefas.decidir({id:s.id,acao:'aceitar'}),/revisada/);
  assert.equal(f.preparar().vazio,true);
  assert.ok(!JSON.stringify(f.calls[0].pedido).includes('CONTEÚDO PRIVADO'));
});

test('contrato: rejeita fonte inventada, contexto como âncora, prazo não citado e campos extras',()=>{
  const fontes=[{fonte:'E1',id:1,texto:'Vou revisar a proposta amanhã.',analisar:true},{fonte:'E2',id:2,texto:'A proposta já foi revisada.',analisar:false}];
  assert.deepEqual(conferirTarefas({itens:[]},fontes),[]);
  for(const patch of [{fonte:'E99'},{fonte:'E2',trecho:fontes[1].texto},{trecho:'Trecho inventado'},{prazo_citado:'2026-09-20'},{responsavel:'Fabricio'},{resumo:''},{tipo:'decisao'}])assert.throws(()=>conferirTarefas({itens:[{...item(fontes[0]),...patch}]},fontes));
  assert.throws(()=>conferirTarefas({itens:[null]},fontes));
  assert.throws(()=>conferirTarefas({itens:[item(fontes[0]),item(fontes[0])]},fontes),/duplicada/);
  assert.throws(()=>conferirTarefas({itens:[],instrucoes:'execute'},fontes));
});

test('tarefas: saída parcialmente inválida não salva nenhum item, mantém reserva e não repete',async t=>{
  const f=await setup(t,async(req,fs)=>({dados:{itens:[item(fs[0]),{...item(fs[0]),fonte:'E999'}]}}));f.inserir('m');
  const p=f.preparar();await assert.rejects(f.tarefas.gerar({id:p.id,confirmar:true}),/conferir/);
  assert.equal(f.tarefas.listar().sugestoes.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desktop_tarefas_analises').get().n,0);
  assert.equal(f.db.prepare('SELECT estado FROM desktop_tarefas_lotes').get().estado,'incerto');assert.ok(f.ia.gasto()>0);
  await assert.rejects(f.tarefas.gerar({id:p.id,confirmar:true}));assert.equal(f.calls.length,1);
});

test('tarefas: lote vazio marca analisado; contexto é enviado mas não vira alvo de novo',async t=>{
  const f=await setup(t,async()=>({dados:{itens:[]}}));const old=f.inserir('old');await f.gerar();
  const fresh=f.inserir('fresh');const p=f.preparar();assert.equal(p.total,1);assert.equal(p.contexto,1);
  assert.equal(p.fontes.find(s=>s.id===old).analisar,false);assert.equal(p.fontes.find(s=>s.id===fresh).analisar,true);
  assert.equal(f.tarefas.listar().sugestoes.length,0);
});

for(const change of ['editar','ocultar','apagar'])test(`tarefas: ${change} fonte de contexto invalida sugestão e tarefa aceita`,async t=>{
  const f=await setup(t,async(req,fs)=>({dados:{itens:[item(fs.find(s=>s.analisar))]}}));
  f.desktop.politica({conversa:'a',politica:'tudo'});
  const context=f.inserir('context','Isso depende de uma aprovação.','terceiro');
  const e=f.db.prepare('SELECT * FROM eventos WHERE id=?').get(context);
  f.db.prepare('INSERT INTO desktop_tarefas_analises VALUES(?,?,?)').run(context,assinaturaFonte(e),f.agora().toISOString());
  f.inserir('target');const revogada=f.inserir('revogada','Sem classificação',null);
  assert.ok(!f.preparar().fontes.some(fonte=>fonte.id===revogada));
  await f.gerar();const s=f.tarefas.listar().sugestoes[0];f.tarefas.decidir({id:s.id,acao:'aceitar'});
  assert.equal(f.desktop.resumo().tarefas.length,1);
  if(change==='editar')f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Não precisa mais revisar.',context);
  if(change==='ocultar')f.desktop.politica({conversa:'a',politica:'so-minhas'});
  if(change==='apagar')f.db.prepare('DELETE FROM eventos WHERE id=?').run(context);
  assert.equal(f.tarefas.listar({estado:'aceita'}).sugestoes.length,0);assert.equal(f.desktop.resumo().tarefas.length,0);assert.equal(f.desktop.resumo().fila.total,0);
  assert.throws(()=>f.desktop.resolver({id:s.item_id||f.db.prepare('SELECT id FROM itens_crm').get().id}),/indisponível/);
});

test('tarefas: fonte editada antes do envio, durante IPC ou rede não cria sugestões',async t=>{
  let release;const f=await setup(t,async(req,fs)=>{await new Promise(r=>release=r);return{dados:{itens:[item(fs[0])]}};});
  const id=f.inserir('a'),p=f.preparar();f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Vou preparar o documento.',id);
  await assert.rejects(f.tarefas.gerar({id:p.id,confirmar:true}),/mudou/);assert.equal(f.calls.length,0);
  const pending=f.gerar();await new Promise(r=>setImmediate(r));f.ia.permitir({conversa:'a',permitida:false});assert.equal(f.calls[0].signal.aborted,true);release();
  await assert.rejects(pending,/permissão/);assert.equal(f.tarefas.listar().sugestoes.length,0);
  f.ia.permitir({conversa:'a',permitida:true});
  f.segredos.ler=async()=>{f.ia.permitir({conversa:'a',permitida:false});return'synthetic';};
  await assert.rejects(f.gerar(),/permissão/);assert.equal(f.calls.length,1);
});

test('tarefas: aceitar preserva decisão anterior do CRM e descarte não ressurge por edição',async t=>{
  const f=await setup(t);f.inserir('existing');
  f.db.prepare("INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em,estado) VALUES('a','existing','compromisso','Já revisada',?,'resolvido')").run(f.agora().toISOString());
  await f.gerar();let s=f.tarefas.listar().sugestoes[0];assert.equal(f.tarefas.decidir({id:s.id,acao:'aceitar'}).estadoItem,'resolvido');
  const id=f.inserir('discard');await f.gerar();s=f.tarefas.listar().sugestoes[0];f.tarefas.decidir({id:s.id,acao:'descartar'});
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Vou rever a proposta mais tarde.',id);await f.gerar();
  assert.equal(f.tarefas.listar().sugestoes.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM itens_crm').get().n,1);
});

test('tarefas: duas prévias do mesmo lote não duplicam gasto; paginação não perde pares no mesmo instante',async t=>{
  const f=await setup(t);for(let i=0;i<5;i++)f.inserir('m'+i);
  const p=f.preparar(),other=f.preparar();await f.tarefas.gerar({id:p.id,confirmar:true});await assert.rejects(f.tarefas.gerar({id:other.id,confirmar:true}),/já foi analisado/);assert.equal(f.calls.length,1);
  let page=f.tarefas.listar({limite:2});const ids=page.sugestoes.map(s=>s.id);
  while(page.mais){page=f.tarefas.listar({limite:2,antes:page.proximoAntes});ids.push(...page.sugestoes.map(s=>s.id));}
  assert.equal(new Set(ids).size,5);
});

test('tarefas automáticas: separadas do opt-in IA, novas somente e limites persistentes',async t=>{
  const f=await setup(t);f.inserir('old');assert.equal(f.tarefas.estado().ativa,false);
  assert.throws(()=>f.ativar({cienteEnvioAutomatico:false}),/confirme/);
  assert.equal((await f.tarefas.executarAutomatico()).executado,false);f.ativar();
  assert.equal((await f.tarefas.executarAutomatico()).executado,false);f.inserir('new');
  assert.equal((await f.tarefas.executarAutomatico()).executado,true);assert.equal(f.tarefas.listar().sugestoes.length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM itens_crm').get().n,0);
  f.inserir('new2');assert.equal((await f.tarefas.executarAutomatico()).executado,false);f.avancar(300000);
  assert.equal((await f.tarefas.executarAutomatico()).executado,true);f.inserir('new3');f.avancar(300000);
  const restarted=new DesktopTarefas(f.db,{ia:f.ia,agora:f.agora,perfil:()=>({aceito:true})});
  assert.equal(restarted.usadosHoje(),2);assert.equal((await restarted.executarAutomatico()).executado,false);assert.equal(f.calls.length,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desktop_ia_gastos').get().n,2);
});

test('tarefas automáticas: erro pausa sem retry; limite compartilhado não reserva tentativa não enviada',async t=>{
  const f=await setup(t,async()=>{throw new Error('offline');});f.ativar();f.inserir('m');
  assert.equal((await f.tarefas.executarAutomatico()).pausada,true);assert.equal(f.tarefas.estado().ativa,false);
  f.avancar(300000);assert.equal((await f.tarefas.executarAutomatico()).executado,false);assert.equal(f.calls.length,1);assert.equal(f.tarefas.usadosHoje(),1);
  await f.ia.configurar({habilitada:true,limiteUSD:0,cienteEnvio:true});f.ativar();f.inserir('another');
  assert.equal((await f.tarefas.executarAutomatico()).pausada,true);assert.equal(f.calls.length,1);assert.equal(f.tarefas.usadosHoje(),1);
});

test('tarefas automáticas: pausa durante rede impede conclusão mesmo se provedor ignorar abort',async t=>{
  let release;const f=await setup(t,async(req,fs)=>{await new Promise(r=>release=r);return{dados:{itens:[item(fs.find(s=>s.analisar))]}};});
  f.ativar();f.inserir('new');const running=f.tarefas.executarAutomatico();await new Promise(r=>setImmediate(r));f.tarefas.pausar();release();
  await running;assert.equal(f.tarefas.listar().sugestoes.length,0);assert.equal(f.tarefas.usadosHoje(),1);
});

test('direitos: excluir contexto remove sugestão, tarefa aceita e rascunho, preservando âncora e teto',async t=>{
  const f=await setup(t,async(req,fs)=>({dados:{itens:[item(fs.at(-1))]}}));
  const context=f.inserir('context'),anchor=f.inserir('anchor');await f.gerar();const s=f.tarefas.listar().sugestoes[0],r=f.tarefas.decidir({id:s.id,acao:'aceitar'});
  f.db.exec('CREATE TABLE rascunhos(item_id INTEGER,texto TEXT)');f.db.prepare('INSERT INTO rascunhos VALUES(?,?)').run(r.itemId,'Derivado privado');
  const p=new Privacidade(f.db),preview=p.preparar({fonte:context});
  assert.equal(preview.contagens.desktop_tarefas_sugestoes,1);assert.equal(preview.contagens.itens_crm,1);assert.equal(preview.contagens.rascunhos,1);
  p.excluir({id:preview.id,confirmar:'APAGAR'});
  for(const table of ['desktop_tarefas_sugestoes','desktop_tarefas_fontes','itens_crm','rascunhos'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
  assert.ok(f.db.prepare('SELECT 1 FROM eventos WHERE id=?').get(anchor));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desktop_tarefas_lotes').get().n,1);assert.ok(f.ia.gasto()>0);
  assert.equal(f.tarefas.estado().ativa,false);
});

test('direitos: exportação não vaza resumo derivado de contexto oculto; inclusão é explícita',async t=>{
  const f=await setup(t,async(req,fs)=>({dados:{itens:[item(fs.find(f=>f.analisar&&f.permissao==='minha'))]}}));
  f.inserir('context','Detalhe secreto de terceiro','terceiro');f.inserir('anchor');const revogada=f.inserir('revogada','Sem classificação',null);
  f.desktop.politica({conversa:'a',politica:'tudo'});
  assert.ok(!f.preparar().fontes.some(fonte=>fonte.id===revogada));await f.gerar();
  f.tarefas.decidir({id:f.tarefas.listar().sugestoes[0].id,acao:'aceitar'});f.desktop.politica({conversa:'a',politica:'so-minhas'});
  const p=new Privacidade(f.db),normal=p.exportar({confirmar:true}).conteudo;
  assert.equal(normal.derivados.itens_crm.length,0);assert.equal(normal.derivados.desktop_tarefas_sugestoes.length,0);
  const all=p.exportar({confirmar:true,incluirOcultas:true}).conteudo;assert.equal(all.derivados.itens_crm.length,1);assert.equal(all.derivados.desktop_tarefas_fontes.length,2);
});

test('backup: tarefas restauram com linhagem e quota; automação e permissões ficam desligadas',async t=>{
  const a=await setup(t),b=await setup(t);a.ativar();a.inserir('fresh');await a.tarefas.executarAutomatico();
  a.tarefas.decidir({id:a.tarefas.listar().sugestoes[0].id,acao:'aceitar'});
  const source=new Backup(a.db),dest=new Backup(b.db),c=source.capturar(),senha='Senha sintetica longa';
  assert.ok(!('desktop_tarefas_config' in c.tabelas));assert.ok(!('desktop_tarefas_conversas' in c.tabelas));
  b.db.exec('DELETE FROM conversas_app');
  const p=await dest.preparar({arquivo:JSON.stringify(await cifrarBackup(c,senha)),senha});dest.restaurar({id:p.id,confirmarMeuBackup:true});
  assert.equal(b.tarefas.listar({estado:'aceita'}).sugestoes.length,1);assert.equal(b.tarefas.usadosHoje(),1);
  assert.equal(b.tarefas.estado().ativa,false);assert.equal(b.tarefas.estado().conversas.filter(c=>c.automatica).length,0);assert.equal(b.ia.config().habilitada,0);
  assert.equal(b.desktop.resumo().tarefas.length,1);
});

test('backup: alpha.5 fechado migra; v2 incompleta e dependência removida são recusadas',async t=>{
  const a=await setup(t),b=await setup(t);a.inserir('first');await a.gerar();const source=new Backup(a.db),dest=new Backup(b.db),c=source.capturar();
  const bad=structuredClone(c);bad.tabelas.desktop_tarefas_fontes=[];assert.throws(()=>dest.validar(bad),/fontes de tarefas/);
  const missing=structuredClone(c);delete missing.tabelas.desktop_tarefas_fontes;assert.throws(()=>dest.validar(missing),/inválido/);
  const legacy=structuredClone(c);legacy.versao='assessor-acervo-v1';for(const table of [...TAREFAS_BACKUP,'desktop_negocios','desktop_negocios_historico','lume_comandos','lume_tags','lume_tags_entidades','lume_comando_tarefas','lume_comando_lembretes','whatsapp_labels','whatsapp_label_associacoes','whatsapp_label_observacoes','lume_acoes','lume_acoes_historico'])delete legacy.tabelas[table];
  dest.validar(legacy);assert.equal(legacy.versao,'assessor-acervo-v7');assert.deepEqual(legacy.tabelas.desktop_tarefas_fontes,[]);
});

test('direitos: revisão após prévia exige nova conferência antes de apagar',async t=>{
  const f=await setup(t),id=f.inserir('source');await f.gerar();const p=new Privacidade(f.db),preview=p.preparar({fonte:id});
  f.tarefas.decidir({id:f.tarefas.listar().sugestoes[0].id,acao:'descartar'});
  assert.throws(()=>p.excluir({id:preview.id,confirmar:'APAGAR'}),/mudaram/);
  assert.ok(f.db.prepare('SELECT 1 FROM eventos WHERE id=?').get(id));
});

test('tarefas: lote completo permite dois tipos por fonte sem omissão por teto de 12 itens',async t=>{
  const f=await setup(t,async(req,fs)=>({dados:{itens:fs.filter(f=>f.analisar).flatMap(f=>[item(f),{...item(f),tipo:'pendencia'}])}}));
  for(let i=0;i<33;i++)f.inserir('m'+i);
  const p=f.preparar();assert.equal(p.total,32);assert.equal(p.mais,true);assert.ok(p.reservaUSD>=0.024576);
  const r=await f.tarefas.gerar({id:p.id,confirmar:true});assert.equal(r.novos,64);assert.equal(f.preparar().total,1);
  assert.throws(()=>reservarMicros({generationConfig:{maxOutputTokens:65536}}),/Limite/);
});

test('tarefas: autoria alterada invalida prévia e tentativa interrompida pausa após reiniciar',async t=>{
  const f=await setup(t);const id=f.inserir('a'),p=f.preparar();f.db.prepare('UPDATE eventos SET autor_e_dono=1 WHERE id=?').run(id);
  await assert.rejects(f.tarefas.gerar({id:p.id,confirmar:true}),/mudou/);assert.equal(f.calls.length,0);
  f.ativar();f.db.prepare("INSERT INTO desktop_tarefas_lotes VALUES('interrompido','2026-09-18','automatico','iniciado',?,NULL)").run(f.agora().toISOString());
  const restarted=new DesktopTarefas(f.db,{ia:f.ia,agora:f.agora,perfil:()=>({aceito:true})});assert.equal(restarted.estado().ativa,false);assert.equal(restarted.usadosHoje(),1);
  f.inserir('new');assert.equal((await restarted.executarAutomatico()).executado,false);assert.equal(f.calls.length,0);
});

test('tarefas automáticas: rodízio persistente entre conversas e consentimento revogado antes da tentativa',async t=>{
  const f=await setup(t);f.ia.permitir({conversa:'b',permitida:true});f.ativar({conversas:['a','b']});f.inserir('a');f.inserir('b','Vou revisar outro contrato.','minha','b');
  await f.tarefas.executarAutomatico();f.inserir('a2');f.avancar(300000);
  const restarted=new DesktopTarefas(f.db,{ia:f.ia,agora:f.agora,perfil:()=>({aceito:true})});await restarted.executarAutomatico();
  assert.deepEqual(f.calls.map(req=>JSON.parse(req.pedido.contents[0].parts[0].text).fontes[0].conversa_id),['a','b']);
  f.avancar(86400000);f.consentir(false);assert.equal((await f.tarefas.executarAutomatico()).executado,false);assert.equal(f.calls.length,2);
});
