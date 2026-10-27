import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {FilaLaya} from '../src/laya/fila.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';

test('extractor receives the exact source and author metadata',async t=>{
  const f=ambiente(t);f.acoes.autorizar({conversa:'dm',permitida:true});
  const eventId=f.inserir('dm','own','Vou preparar a minuta.');
  f.db.prepare('UPDATE eventos SET autor_e_dono=1,autor_id=? WHERE id=?').run('local:owner',eventId);
  const seen=[];
  f.fila.laya.extrairAcoes=async input=>{seen.push(input);return {candidatas:[]};};
  assert.equal(await f.fila.passo(),true);
  assert.deepEqual(seen,[{texto:'Vou preparar a minuta.',fonte:'E'+eventId,canal:'dm',autor:'proprio',autorId:'local:owner'}]);
});

test('group forward is recorded as abstained without calling the extractor',async t=>{
  const f=ambiente(t);f.acoes.autorizar({conversa:'grupo@g.us',permitida:true});
  const eventId=f.inserir('grupo@g.us','forwarded','Fabrício, confirme a data.');
  const bruto=JSON.stringify({mensagem:{message:{extendedTextMessage:{text:'Fabrício, confirme a data.',contextInfo:{isForwarded:true}}}}});
  f.db.prepare('UPDATE eventos SET bruto=? WHERE id=?').run(bruto,eventId);
  const seen=[];
  f.fila.laya.extrairAcoes=async input=>{seen.push(input);return {candidatas:[]};};
  assert.equal(await f.fila.passo(),true);
  assert.equal(seen.length,0);
  assert.equal(f.db.prepare('SELECT motivo FROM lume_laya_fila WHERE evento_id=?').get(eventId).motivo,'fonte_terceiro');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
});

test('forwarded flag arriving during inference discards the old suggestion',async t=>{
  const f=ambiente(t);f.acoes.autorizar({conversa:'grupo@g.us',permitida:true});
  const eventId=f.inserir('grupo@g.us','changed','Fabrício, confirme a data.');
  let release;const wait=new Promise(resolve=>{release=resolve;});
  let started;const didStart=new Promise(resolve=>{started=resolve;});
  f.fila.laya.extrairAcoes=async()=>{started();await wait;return {candidatas:[{fonte:'E'+eventId,tipo:'pendencia',resumo:'Confirmar data',trecho:'Fabrício, confirme a data.',prazo_citado:''}]};};
  const step=f.fila.passo();await didStart;
  const bruto=JSON.stringify({mensagem:{message:{extendedTextMessage:{text:'Fabrício, confirme a data.',contextInfo:{isForwarded:true}}}}});
  f.db.prepare('UPDATE eventos SET bruto=? WHERE id=?').run(bruto,eventId);
  release();
  assert.equal(await step,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
  assert.equal(await f.fila.passo(),true);
  assert.equal(f.db.prepare('SELECT motivo FROM lume_laya_fila WHERE evento_id=?').get(eventId).motivo,'fonte_terceiro');
});

test('revoked model approval during inference prevents a suggestion',async t=>{
  const f=ambiente(t);f.acoes.autorizar({conversa:'dm',permitida:true});
  const eventId=f.inserir('dm','pending','Prepare a minuta.');
  let release;const wait=new Promise(resolve=>{release=resolve;});
  let started;const didStart=new Promise(resolve=>{started=resolve;});
  let approved=true;
  f.fila.laya.status=()=>({instalado:true,aprovado:approved,avaliacao:approved?'aprovada':'reprovada'});
  f.fila.laya.extrairAcoes=async()=>{started();await wait;return {candidatas:[{fonte:'E'+eventId,tipo:'pendencia',resumo:'Preparar minuta',trecho:'Prepare a minuta.',prazo_citado:''}]};};
  const step=f.fila.passo();await didStart;approved=false;release();
  assert.equal(await step,false);
  assert.equal(f.fila.estado().aguardandoValidacao,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
});

function ambiente(t,{instalado=true,aprovado=instalado,classificar=async()=>({abstencao:true,motivo:'validacao_pendente'})}={}){
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);new Desktop(db);
  for(const id of ['dm','grupo@g.us'])db.prepare('INSERT INTO conversas_app(id,nome) VALUES(?,?)').run(id,id);
  const acoes=new AcoesLume(db),vistas=[];
  const laya={status:()=>({instalado,aprovado,avaliacao:aprovado?'aprovada':'reprovada'}),classificar:async input=>classificar(input),extrairAcoes:async input=>{vistas.push(input.texto);const result=await classificar(input);return {candidatas:result?.candidatas??[]};}};
  const fila=new FilaLaya(db,{laya});
  const inserir=(conversa,origem,texto,permissao='minha')=>Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada','texto','{}',?,'2026-09-25T12:00:00Z','2026-09-25',?)`).run(conversa,origem,texto,permissao).lastInsertRowid);
  return{db,acoes,fila,vistas,inserir};
}

test('fila local inclui conversa nova e histórico anterior ao pedido manual',async t=>{
  const f=ambiente(t),antiga=f.inserir('dm','antiga','Mensagem antes da autorização');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  const nova=f.inserir('dm','nova','Pode preparar o relatório?');
  f.inserir('grupo@g.us','grupo','Pode confirmar o local?');
  assert.equal(f.fila.capturarNovas(),3);
  assert.equal(f.fila.capturarNovas(),0);
  assert.equal(await f.fila.passo(),true);
  assert.equal(await f.fila.passo(),true);
  assert.equal(await f.fila.passo(),true);
  assert.deepEqual(new Set(f.vistas),new Set(['Mensagem antes da autorização','Pode preparar o relatório?','Pode confirmar o local?']));
  assert.equal(f.fila.estado().abstidas,3);
  assert.equal(f.fila.estado().conversas.find(c=>c.id==='dm').abstidas,2);
  assert.equal(f.fila.estado().conversas.find(c=>c.id==='grupo@g.us').abstidas,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
  assert.equal(f.db.prepare('SELECT 1 FROM lume_laya_fila WHERE evento_id=?').get(nova)?.[1],1);
  assert.equal(f.db.prepare('SELECT 1 FROM lume_laya_fila WHERE evento_id=?').get(antiga)?.[1],1);
  assert.notEqual(nova,antiga);
  f.acoes.autorizar({conversa:'dm',permitida:false});
  assert.equal(f.fila.estado().total,1);
});

test('motor aprovado registra duas ações com fonte e reprocessa sem duplicar',async t=>{
  const f=ambiente(t);f.acoes.autorizar({conversa:'dm',permitida:true});
  const evento=f.inserir('dm','duas','Prepare a minuta. Confirme a reunião.');
  f.fila.laya.extrairAcoes=async()=>({candidatas:[
    {fonte:'E'+evento,tipo:'pendencia',resumo:'Preparar minuta',trecho:'Prepare a minuta.',prazo_citado:''},
    {fonte:'E'+evento,tipo:'pendencia',resumo:'Confirmar reunião',trecho:'Confirme a reunião.',prazo_citado:''}
  ]});
  assert.equal(await f.fila.passo(),true);
  assert.equal(f.fila.estado().sugeridas,1);
  assert.equal(f.fila.estado().abstidas,0);
  assert.equal(f.acoes.listar().length,2);
  f.db.prepare("UPDATE lume_laya_fila SET estado='pendente',motivo=NULL WHERE evento_id=?").run(evento);
  assert.equal(await f.fila.passo(),true);
  assert.equal(f.acoes.listar().length,2);
});

test('motor marcado como aprovado sem extrator não conclui análise fictícia',async t=>{
  const f=ambiente(t);f.acoes.autorizar({conversa:'dm',permitida:true});f.inserir('dm','sem-extrator','Prepare a minuta.');
  delete f.fila.laya.extrairAcoes;
  assert.equal(await f.fila.passo(),true);
  assert.equal(f.fila.estado().erros,1);
  assert.equal(f.db.prepare('SELECT motivo FROM lume_laya_fila').get().motivo,'extrator_indisponivel');
  assert.equal(f.acoes.listar().length,0);
});

test('modelo ausente mantém fila visível; reinício retoma item em análise',async t=>{
  const f=ambiente(t,{instalado:false});f.acoes.autorizar({conversa:'dm',permitida:true});f.inserir('dm','m1','Envie o arquivo.');
  f.fila.capturarNovas(); // Fila já descoberta permanece visível com o modelo indisponível.
  assert.equal(await f.fila.passo(),false);
  assert.equal(f.fila.estado().aguardandoModelo,1);
  assert.deepEqual(f.vistas,[]);
  f.db.prepare("UPDATE lume_laya_fila SET estado='analisando' WHERE estado='aguardando_modelo'").run();
  const recuperada=new FilaLaya(f.db,{laya:{status:()=>({instalado:true,aprovado:true,avaliacao:'aprovada'}),classificar:async()=>({abstencao:true,motivo:'validacao_pendente'}),extrairAcoes:async()=>({candidatas:[]})}});
  assert.equal(recuperada.estado().pendentes,1);
  assert.equal(await recuperada.passo(),true);
  assert.equal(recuperada.estado().abstidas,1);
  assert.equal(recuperada.capturarNovas(),0);
});

test('Laya instalado e reprovado não consome CPU na inferência; fila retoma após aprovação',async t=>{
  const f=ambiente(t,{instalado:true,aprovado:false});
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.inserir('dm','qualidade','Pode preparar o relatório?');
  f.fila.capturarNovas();
  assert.equal(await f.fila.passo(),false);
  assert.deepEqual(f.vistas,[]);
  assert.equal(f.fila.estado().aguardandoModelo,0);
  assert.equal(f.fila.estado().aguardandoValidacao,1);
  assert.equal(f.db.prepare('SELECT motivo FROM lume_laya_fila').get().motivo,'qualidade_pendente');
  const vistas=[];
  const aprovada=new FilaLaya(f.db,{laya:{
    status:()=>({instalado:true,aprovado:true,avaliacao:'aprovada'}),
    classificar:async()=>({abstencao:true,motivo:'sem_acao'}),extrairAcoes:async({texto})=>{vistas.push(texto);return{candidatas:[]};}
  }});
  assert.equal(await aprovada.passo(),true);
  assert.deepEqual(vistas,['Pode preparar o relatório?']);
  assert.equal(aprovada.estado().aguardandoValidacao,0);
  assert.equal(aprovada.estado().abstidas,1);
});

test('sinal de captura esvazia uma sequência curta sem esperar o próximo ciclo periódico',async t=>{
  const f=ambiente(t);
  f.fila.intervaloMs=60_000;
  f.acoes.autorizar({conversa:'dm',permitida:true});
  for(let i=0;i<3;i++)f.inserir('dm',`sequencia-${i}`,`Confirme o item ${i}.`);
  f.fila.iniciar();
  try{
    const limite=Date.now()+1000;
    while(f.fila.estado().abstidas<3&&Date.now()<limite)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.fila.estado().abstidas,3);
    assert.equal(f.vistas.length,3);
  }finally{await f.fila.parar();}
});

test('Organizar agora inclui histórico apenas da conversa autorizada e permite cancelar a fila manual',async t=>{
  const f=ambiente(t,{instalado:false});
  const antiga=f.inserir('dm','historica','Confirme a proposta antiga.');
  f.inserir('grupo@g.us','outra','Envie a lista do grupo.');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  assert.throws(()=>f.fila.organizarConversa({conversa:'grupo@g.us',limite:50}),/Autorize/);
  assert.deepEqual(f.fila.organizarConversa({conversa:'dm',limite:50}),{conversa:'dm',selecionadas:1,limite:50});
  assert.equal(f.db.prepare('SELECT evento_id FROM lume_laya_fila').get().evento_id,antiga);
  assert.equal(f.fila.estado().conversas.find(c=>c.id==='dm').manuaisNaFila,1);
  assert.deepEqual(f.fila.cancelarConversa({conversa:'dm'}),{conversa:'dm',canceladas:1});
  assert.equal(f.fila.estado().canceladas,1);
  assert.equal(f.fila.estado().abstidas,0);
  assert.deepEqual(f.vistas,[]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
});

test('cancelar durante a inferência descarta o resultado da análise manual',async t=>{
  let liberar,iniciou;
  const comecou=new Promise(resolve=>{iniciou=resolve;});
  const f=ambiente(t,{classificar:()=>{iniciou();return new Promise(resolve=>{liberar=resolve;});}});
  const evento=f.inserir('dm','historica','Pode preparar o convite?');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.fila.organizarConversa({conversa:'dm',limite:50});
  await comecou;
  assert.equal(f.fila.cancelarConversa({conversa:'dm'}).canceladas,1);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Pode preparar outro convite?',evento);
  liberar({abstencao:true,motivo:'validacao_pendente'});
  await f.fila.rodando;
  assert.equal(f.fila.estado().canceladas,1);
  assert.equal(f.fila.estado().abstidas,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
});

test('perfil da fila anterior ganha modo contínuo sem perder o item pendente',t=>{
  const f=ambiente(t,{instalado:false});
  f.acoes.autorizar({conversa:'dm',permitida:true});
  const id=f.inserir('dm','upgrade','Verifique a pauta.');
  f.db.exec('DROP TABLE lume_laya_fila');
  f.db.exec(`CREATE TABLE lume_laya_fila(
    evento_id INTEGER PRIMARY KEY REFERENCES eventos(id) ON DELETE CASCADE,
    conversa_id TEXT NOT NULL,fonte_assinatura TEXT NOT NULL,
    estado TEXT NOT NULL,motivo TEXT,criada_em TEXT NOT NULL,
    atualizada_em TEXT NOT NULL,duracao_ms INTEGER)`);
  f.db.prepare("INSERT INTO lume_laya_fila(evento_id,conversa_id,fonte_assinatura,estado,criada_em,atualizada_em) VALUES(?,?,'hash','pendente','2026-09-25','2026-09-25')").run(id,'dm');
  const migrada=new FilaLaya(f.db,{laya:{status:()=>({instalado:false}),classificar:async()=>{}}});
  assert.equal(migrada.estado().pendentes,1);
  assert.equal(f.db.prepare('SELECT modo FROM lume_laya_fila WHERE evento_id=?').get(id).modo,'continuo');
});

test('Organizar agora incorpora a inferência contínua já iniciada ao cancelamento manual',async t=>{
  let liberar,iniciou;
  const comecou=new Promise(resolve=>{iniciou=resolve;});
  const f=ambiente(t,{classificar:()=>{iniciou();return new Promise(resolve=>{liberar=resolve;});}});
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.inserir('dm','recente','Pode confirmar o endereço?');
  const pendente=f.fila.passo();await comecou;
  f.fila.organizarConversa({conversa:'dm',limite:50});
  assert.equal(f.db.prepare('SELECT modo FROM lume_laya_fila').get().modo,'manual');
  assert.equal(f.fila.cancelarConversa({conversa:'dm'}).canceladas,1);
  liberar({motivo:'validacao_pendente'});
  assert.equal(await pendente,false);
  assert.equal(f.fila.estado().canceladas,1);
});

test('mensagem nova autorizada passa antes da varredura manual do histórico',async t=>{
  const f=ambiente(t,{instalado:false});
  f.inserir('dm','historica','Prepare o arquivo antigo.');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.fila.organizarConversa({conversa:'dm',limite:50});
  await f.fila.rodando;
  f.inserir('dm','nova','Confirme a data nova.');
  const vistas=[];
  const outra=new FilaLaya(f.db,{laya:{status:()=>({instalado:true,aprovado:true,avaliacao:'aprovada'}),classificar:async()=>({motivo:'validacao_pendente'}),extrairAcoes:async({texto})=>{vistas.push(texto);return{candidatas:[]};}}});
  assert.equal(await outra.passo(),true);
  assert.deepEqual(vistas,['Confirme a data nova.']);
  assert.equal(outra.estado().conversas.find(c=>c.id==='dm').manuaisNaFila,1);
});

test('turnos de histórico alternam conversas sem atrasar a mensagem mais recente',async t=>{
  const f=ambiente(t);
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.acoes.autorizar({conversa:'grupo@g.us',permitida:true});
  for(let i=1;i<=20;i++)f.inserir('dm',`dm-${i}`,`DM ${i}`);
  for(let i=1;i<=20;i++)f.inserir('grupo@g.us',`grupo-${i}`,`Grupo ${i}`);
  for(let i=0;i<20;i++)assert.equal(await f.fila.passo(),true);
  assert.equal(f.vistas[0],'Grupo 20');
  assert.equal(f.vistas[9],'DM 1');
  assert.equal(f.vistas[19],'Grupo 1');
  f.acoes.autorizar({conversa:'grupo@g.us',permitida:false});
  f.fila.estado();
  assert.equal(f.db.prepare("SELECT COUNT(*) total FROM lume_laya_agenda WHERE conversa_id='grupo@g.us'").get().total,0);
});

test('DM recém-chegada supera backlog contínuo de outro grupo',async t=>{
  const f=ambiente(t);
  f.acoes.autorizar({conversa:'grupo@g.us',permitida:true});
  f.acoes.autorizar({conversa:'dm',permitida:true});
  for(let i=1;i<=120;i++)f.inserir('grupo@g.us',`grupo-${i}`,`Grupo ${i}`);
  f.fila.capturarNovas();
  f.inserir('dm','nova','Confirme a data da reunião.');
  assert.equal(await f.fila.passo(),true);
  assert.deepEqual(f.vistas,['Confirme a data da reunião.']);
});

test('Organizar agora não espera esgotar backlog contínuo e preserva turno para mensagem nova',async t=>{
  const f=ambiente(t,{instalado:false});
  f.acoes.autorizar({conversa:'grupo@g.us',permitida:true});
  for(let i=1;i<=30;i++)f.inserir('grupo@g.us',`grupo-${i}`,`Grupo ${i}`);
  f.fila.capturarNovas();
  const historica=f.inserir('dm','manual','Preparar o relatório da reunião.');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.fila.organizarConversa({conversa:'dm',limite:50});
  await f.fila.rodando;
  const vistas=[];
  const aprovada=new FilaLaya(f.db,{laya:{status:()=>({instalado:true,aprovado:true,avaliacao:'aprovada'}),classificar:async()=>({}),extrairAcoes:async({texto})=>{vistas.push(texto);return{candidatas:[]};}}});
  assert.equal(await aprovada.passo(),true);
  assert.equal(await aprovada.passo(),true);
  assert.deepEqual(vistas,['Grupo 30','Preparar o relatório da reunião.']);
  assert.equal(f.db.prepare('SELECT modo FROM lume_laya_fila WHERE evento_id=?').get(historica).modo,'manual');
  assert.equal(aprovada.estado().pendentes,29);
});

test('pedido manual durante inferência é atendido sem esperar o próximo ciclo periódico',async t=>{
  let liberar,iniciou;
  const comecou=new Promise(resolve=>{iniciou=resolve;});
  const vistas=[];
  const f=ambiente(t,{classificar:async({texto})=>{
    vistas.push(texto);
    if(vistas.length===1){iniciou();await new Promise(resolve=>{liberar=resolve;});}
    return{candidatas:[]};
  }});
  f.fila.intervaloMs=60_000;
  f.acoes.autorizar({conversa:'grupo@g.us',permitida:true});
  const historica=f.inserir('dm','historica','Prepare o relatório antigo.');
  f.inserir('grupo@g.us','continua','Confirme a pauta nova.');
  const primeira=f.fila.passo();await comecou;
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.fila.organizarConversa({conversa:'dm',limite:50});
  liberar();await primeira;
  const limite=Date.now()+1000;
  while(vistas.length<2&&Date.now()<limite)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(vistas,['Confirme a pauta nova.','Prepare o relatório antigo.']);
  assert.equal(f.db.prepare('SELECT estado FROM lume_laya_fila WHERE evento_id=?').get(historica).estado,'abstido');
  await f.fila.parar();
});

test('histórico grande não segura mensagem nova e recebe turno periódico',async t=>{
  const f=ambiente(t);
  f.acoes.autorizar({conversa:'dm',permitida:true});
  for(let i=1;i<=150;i++)f.inserir('dm',`m-${i}`,`Mensagem ${i}`);
  assert.equal(f.fila.capturarNovas({limite:10}),10);
  assert.deepEqual(f.db.prepare('SELECT evento_id FROM lume_laya_fila ORDER BY evento_id DESC').all().map(row=>row.evento_id),
    [150,149,148,147,146,5,4,3,2,1]);
  for(let i=0;i<10;i++)assert.equal(await f.fila.passo(),true);
  assert.equal(f.vistas[0],'Mensagem 150');
  assert.equal(f.vistas[9],'Mensagem 1');
  assert.equal(f.fila.estado().abstidas,10);
});

test('fonte editada é reavaliada e permissão de leitura retirada limpa a fila',async t=>{
  const f=ambiente(t),idAntes=f.inserir('dm','m0','Pode revisar o contrato?');
  f.acoes.autorizar({conversa:'dm',permitida:true});
  const id=f.inserir('dm','m1','Pode confirmar o prazo?');
  assert.equal(f.fila.capturarNovas(),2);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Pode confirmar a data?',id);
  assert.equal(await f.fila.passo(),false);
  assert.equal(await f.fila.passo(),true);
  assert.deepEqual(f.vistas,['Pode confirmar a data?']);
  f.db.prepare("UPDATE eventos SET permissao='restrita' WHERE id=?").run(id);
  assert.equal(f.fila.estado().total,1);
  assert.equal(f.db.prepare('SELECT 1 FROM lume_laya_fila WHERE evento_id=?').get(id),undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
  assert.notEqual(id,idAntes);
});

test('revogar durante inferência apaga a fila e impede persistir resultado',async t=>{
  let liberar,iniciou;
  const comecou=new Promise(resolve=>{iniciou=resolve;});
  const f=ambiente(t,{classificar:()=>{iniciou();return new Promise(resolve=>{liberar=resolve;});}});
  f.acoes.autorizar({conversa:'dm',permitida:true});const evento=f.inserir('dm','m1','Pode marcar a reunião?');
  const pendente=f.fila.passo();await comecou;
  f.acoes.autorizar({conversa:'dm',permitida:false});
  liberar({candidatas:[{fonte:'E'+evento,tipo:'pendencia',resumo:'Marcar reunião',trecho:'Pode marcar a reunião?',prazo_citado:''}]});
  assert.equal(await pendente,false);
  assert.equal(f.fila.estado().total,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
});

test('revogar e autorizar de novo invalida inferência da permissão anterior',async t=>{
  let liberar,iniciou;
  const comecou=new Promise(resolve=>{iniciou=resolve;});
  const f=ambiente(t,{classificar:()=>{iniciou();return new Promise(resolve=>{liberar=resolve;});}});
  f.acoes.autorizar({conversa:'dm',permitida:true});
  const evento=f.inserir('dm','revoga-retorna','Pode marcar a reunião?');
  const antiga=f.fila.passo();await comecou;
  f.acoes.autorizar({conversa:'dm',permitida:false});
  f.acoes.autorizar({conversa:'dm',permitida:true});
  f.fila.organizarConversa({conversa:'dm'});
  liberar({candidatas:[{fonte:'E'+evento,tipo:'pendencia',resumo:'Marcar reunião',trecho:'Pode marcar a reunião?',prazo_citado:''}]});
  assert.equal(await antiga,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
  assert.equal(f.db.prepare('SELECT estado FROM lume_laya_fila WHERE evento_id=?').get(evento).estado,'pendente');
});

test('status da fila exige sessão local e não devolve texto da conversa',async t=>{
  const f=ambiente(t,{instalado:false}),desktop=new Desktop(f.db);
  f.acoes.autorizar({conversa:'dm',permitida:true});f.inserir('dm','status','Mensagem privada sentinela.');
  f.fila.capturarNovas();
  await f.fila.passo();
  const server=criarServidor(f.db,{desktop:true,filaLaya:f.fila,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
  const base=`http://127.0.0.1:${server.address().port}`;
  const {token}=await(await fetch(base+'/api/sessao')).json();
  assert.equal((await fetch(base+'/api/v3/acoes/analise')).status,403);
  desktop.aceitar({nome:'Pessoa de teste',aceito:true,versao:VERSAO_TERMOS});
  assert.equal((await fetch(base+'/api/v3/acoes/analise')).status,403);
  const response=await fetch(base+'/api/v3/acoes/analise',{headers:{'x-assessor-token':token}});
  assert.equal(response.status,200);
  const text=await response.text();assert.equal(text.includes('Mensagem privada sentinela'),false);
  assert.equal(JSON.parse(text).aguardandoModelo,1);
  const denied=await fetch(base+'/api/v3/acoes/organizar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversa:'dm',limite:50})});
  assert.equal(denied.status,403);
  const manual=await fetch(base+'/api/v3/acoes/organizar',{method:'POST',headers:{'content-type':'application/json','x-assessor-token':token},body:JSON.stringify({conversa:'dm',limite:50})});
  assert.equal(manual.status,200);
  assert.equal((await manual.json()).selecionadas,1);
  const cancel=await fetch(base+'/api/v3/acoes/cancelar-analise',{method:'POST',headers:{'content-type':'application/json','x-assessor-token':token},body:JSON.stringify({conversa:'dm'})});
  assert.equal(cancel.status,200);
  assert.equal((await cancel.json()).canceladas,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
