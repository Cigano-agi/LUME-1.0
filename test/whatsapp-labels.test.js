import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {abrirBanco} from '../src/banco.js';
import {Conexao} from '../src/transporte/socket.js';
import {criarServidor} from '../src/painel/servidor.js';
import {TABELAS_WHATSAPP_LABELS,WhatsAppLabels} from '../src/whatsapp-labels.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {Privacidade} from '../src/privacidade.js';
import {Backup,cifrarBackup} from '../src/backup.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const socketFalso=(id='5511999999999:4@s.whatsapp.net')=>({ev:new EventEmitter(),user:{id},end(){}});
const chamar=async(server,path,{method='GET',token,body}={})=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{...(token?{'X-Assessor-Token':token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
};
const iniciarServidor=async(db,opcoes={})=>{
  const server=criarServidor(db,{desktop:true,contexto:new ContextoApp(db),conexao:opcoes.conexao,whatsappLabels:opcoes.whatsappLabels,segredos:{estado:async()=>({disponivel:true,configurada:false})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));server.unref();
  const sessao=await chamar(server,'/api/sessao');
  await chamar(server,'/api/v3/aceite',{method:'POST',token:sessao.body.token,body:{nome:'Teste',aceito:true,versao:VERSAO_TERMOS}});
  return {server,token:sessao.body.token};
};

test('associacao entra somente depois do opt-in da conta, geracao e sessao desktop ativas',async t=>{
  const db=abrirBanco(':memory:');
  const labels=new WhatsAppLabels(db),socket=socketFalso();
  const conexao=new Conexao({authDir:'teste',aoLote:async()=>{},criarSocket:async()=>socket,whatsappLabels:labels});
  await conexao.iniciar();socket.ev.emit('connection.update',{connection:'open'});await tick();
  const api=await iniciarServidor(db,{conexao,whatsappLabels:labels});t.after(async()=>{await conexao.parar();api.server.closeAllConnections();await new Promise(resolve=>api.server.close(resolve));db.close();});
  socket.ev.emit('labels.association',{association:{type:'label_jid',chatId:'5511888888888@s.whatsapp.net',labelId:'1'},type:'add'});await tick();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_label_observacoes').get().n,0);
  assert.equal((await chamar(api.server,'/api/v3/whatsapp-labels',{token:api.token})).status,200);
  assert.equal((await chamar(api.server,'/api/v3/whatsapp-labels',{method:'POST',token:api.token,body:{leitura:true}})).status,200);
  socket.ev.emit('labels.edit',{id:'1',name:'Cliente <script>',color:2,deleted:false});
  socket.ev.emit('labels.association',{association:{type:'label_jid',chatId:'5511888888888@s.whatsapp.net',labelId:'1'},type:'add'});await tick();await tick();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_label_observacoes').get().n,2);
  assert.equal(db.prepare('SELECT message_id FROM whatsapp_label_associacoes').get().message_id,'');
  socket.ev.emit('labels.edit',{id:'2',name:'Invalida',color:99,deleted:false});socket.ev.emit('labels.association',{association:{type:'label_message',chatId:'chat@s.whatsapp.net',labelId:'2'},type:'add'});await tick();assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_label_observacoes').get().n,2);
  const estado=await chamar(api.server,'/api/v3/whatsapp-labels',{token:api.token});assert.equal(estado.status,200);assert.ok(!JSON.stringify(estado.body).includes('5511999999999@s.whatsapp.net'));assert.match(estado.body.contaMascarada,/••••/);
});

test('API fecha o corpo, exige sessao e nao deixa o cliente escolher conta',async t=>{
  const db=abrirBanco(':memory:');const labels=new WhatsAppLabels(db);
  const api=await iniciarServidor(db,{conexao:{estado:()=>({estado:'desconectada'}),sessaoLabels:()=>null,parar:async()=>{}},whatsappLabels:labels});t.after(async()=>{api.server.closeAllConnections();await new Promise(resolve=>api.server.close(resolve));db.close();});
  assert.equal((await chamar(api.server,'/api/v3/whatsapp-labels')).status,403);
  assert.equal((await chamar(api.server,'/api/v3/whatsapp-labels',{method:'POST',token:api.token,body:{leitura:true,contaId:'fraude@s.whatsapp.net'}})).status,400);
  assert.equal((await chamar(api.server,'/api/v3/whatsapp-labels',{method:'POST',token:api.token,body:{leitura:true}})).status,409);
});

test('entrypoint bin permanece sem o laboratorio e servidor sem servico responde 404',async t=>{
  const entry=readFileSync('bin/app.js','utf8');assert.ok(!entry.includes('WhatsAppLabels'));assert.ok(!entry.includes('whatsapp-labels'));
  const db=abrirBanco(':memory:'),contexto=new ContextoApp(db),server=criarServidor(db,{contexto});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));server.unref();t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();});
  const sessao=await chamar(server,'/api/sessao');await chamar(server,'/api/v3/aceite',{method:'POST',token:sessao.body.token,body:{nome:'Teste',aceito:true,versao:VERSAO_TERMOS}});assert.equal((await chamar(server,'/api/v3/whatsapp-labels',{token:sessao.body.token})).status,404);
});

test('eventos opostos conservam observacoes e marcam conflito sem tocar tags locais',()=>{
  const db=abrirBanco(':memory:');new ContextoApp(db);const labels=new WhatsAppLabels(db);try{
    const s={contaId:'5511999999999@s.whatsapp.net',geracao:2,sessaoId:'sessao'};labels.ativarSessao(s);labels.consentir(s,true);
    assert.equal(labels.observarLabel({...s,contaId:'5511000000000@s.whatsapp.net'},{id:'fora',name:'Fora',color:1,deleted:false}),false);assert.equal(labels.observarLabel({...s,geracao:1},{id:'antiga',name:'Antiga',color:1,deleted:false}),false);
    const antes=JSON.stringify({tags:db.prepare('SELECT * FROM lume_tags ORDER BY id').all(),entidades:db.prepare('SELECT * FROM lume_tags_entidades ORDER BY tag_id').all()});
    const evento={association:{type:'label_message',chatId:'chat@s.whatsapp.net',messageId:'m1',labelId:'l1'},type:'add'};
    labels.observarAssociacao(s,evento);labels.observarAssociacao(s,evento);labels.observarAssociacao(s,{...evento,type:'remove'});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_label_observacoes').get().n,2);
    assert.equal(db.prepare('SELECT conflito FROM whatsapp_label_associacoes').get().conflito,1);
    assert.equal(JSON.stringify({tags:db.prepare('SELECT * FROM lume_tags ORDER BY id').all(),entidades:db.prepare('SELECT * FROM lume_tags_entidades ORDER BY tag_id').all()}),antes);
  }finally{db.close();}
});

test('aceita shape exato do Baileys com predefinedId undefined e limita valor definido',()=>{
  const db=abrirBanco(':memory:'),labels=new WhatsAppLabels(db),s={contaId:'5511999999999@s.whatsapp.net',geracao:1,sessaoId:'shape'};
  try{
    labels.ativarSessao(s);labels.consentir(s,true);
    assert.equal(labels.observarLabel(s,{id:'real',name:'Real',color:1,deleted:false,predefinedId:undefined}),true);
    assert.equal(db.prepare('SELECT predefined_id FROM whatsapp_label_observacoes').get().predefined_id,null);
    assert.equal(labels.observarLabel(s,{id:'definida',name:'Definida',color:2,deleted:false,predefinedId:'PRESET'}),true);
    assert.equal(db.prepare("SELECT predefined_id FROM whatsapp_label_observacoes WHERE label_id='definida'").get().predefined_id,'PRESET');
    assert.equal(labels.observarLabel(s,{id:'grande',name:'Grande',color:2,deleted:false,predefinedId:'x'.repeat(201)}),false);
    assert.equal(labels.observarLabel(s,{id:'extra',name:'Extra',color:2,deleted:false,predefinedId:undefined,outro:true}),false);
  }finally{db.close();}
});

test('duplicata libera savepoint e evento seguinte pode ser persistido',()=>{
  const db=abrirBanco(':memory:'),labels=new WhatsAppLabels(db),s={contaId:'5511999999999@s.whatsapp.net',geracao:1,sessaoId:'duplicata'},eventoLabel={id:'um',name:'Um',color:1,deleted:false};
  try{
    labels.ativarSessao(s);labels.consentir(s,true);assert.equal(labels.observarLabel(s,eventoLabel),true);assert.equal(labels.observarLabel(s,eventoLabel),false);assert.equal(db.isTransaction,false);
    assert.equal(labels.observarLabel(s,{id:'dois',name:'Dois',color:2,deleted:false}),true);assert.equal(db.isTransaction,false);assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_label_observacoes').get().n,2);
  }finally{db.close();}
});

test('deleted como primeiro fato e associacao posterior permanecem em conflito visivel',()=>{
  const db=abrirBanco(':memory:'),ctx=new ContextoApp(db,{donoId:'5511999999999@s.whatsapp.net'}),labels=new WhatsAppLabels(db),s={contaId:'5511999999999@s.whatsapp.net',geracao:1,sessaoId:'apagada'},chat='5511888888888@s.whatsapp.net';
  try{
    evento(ctx,'msg',chat);labels.ativarSessao(s);labels.consentir(s,true);
    assert.equal(labels.observarLabel(s,{id:'apagada',name:'Apagada',color:4,deleted:true}),true);
    assert.equal(labels.observarAssociacao(s,{type:'add',association:{type:'label_message',chatId:chat,messageId:'msg',labelId:'apagada'}}),true);
    const estado=labels.estado(s);assert.equal(estado.conflito,true);assert.equal(estado.labels[0].conflito,1);assert.equal(estado.associacoes[0].conflito,1);
  }finally{db.close();}
});

test('tabelas externas usam contrato canonico e associacao de chat nunca grava NULL',()=>{
  const db=abrirBanco(':memory:');try{new WhatsAppLabels(db);assert.deepEqual(TABELAS_WHATSAPP_LABELS,['whatsapp_labels','whatsapp_label_associacoes','whatsapp_label_observacoes']);for(const tabela of TABELAS_WHATSAPP_LABELS)assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tabela));assert.equal(db.prepare("SELECT [notnull] n FROM pragma_table_info('whatsapp_label_associacoes') WHERE name='message_id'").get().n,1);}finally{db.close();}
});

test('codigo de produto e runtime do socket nao acessam os seis mutadores instalados',async()=>{
  const proibidos=['add'+'Label','add'+'ChatLabel','remove'+'ChatLabel','add'+'MessageLabel','remove'+'MessageLabel','update'+'MemberLabel'];
  const arquivos=[];for(const raiz of ['src','desktop']){const andar=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())andar(p);else if(/\.(?:js|cjs)$/.test(e.name))arquivos.push(p);}};andar(raiz);}
  const produto=arquivos.map(p=>readFileSync(p,'utf8')).join('\n');for(const simbolo of proibidos)assert.equal(produto.includes(simbolo),false,simbolo);
  assert.doesNotMatch(produto,/\/api\/[^'"\s]*labels?[^'"\s]*(?:escrev|cri(?:ar|acao)|associar|remover|write|mutat)/iu);
  assert.doesNotMatch(produto,/(?:label|labels)[A-Za-z_]*(?:writ|mutat|escrit)|(?:writ|mutat|escrit)[A-Za-z_]*(?:label|labels)/iu);
  assert.doesNotMatch(produto,/(?:Criar|Associar|Remover)\s+(?:uma\s+)?label/iu);
  const base=socketFalso(),socket=new Proxy(base,{get(target,key,receiver){if(proibidos.includes(String(key)))throw new Error(`mutador acessado: ${String(key)}`);return Reflect.get(target,key,receiver);}});
  const db=abrirBanco(':memory:');const labels=new WhatsAppLabels(db),conexao=new Conexao({authDir:'teste',aoLote:async()=>{},criarSocket:async()=>socket,whatsappLabels:labels});await conexao.iniciar();socket.ev.emit('connection.update',{connection:'open'});await conexao.parar();db.close();
});

test('close, parada e nova geracao invalidam consentimento sem callback antigo afetar sessao nova',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const db=abrirBanco(':memory:');new ContextoApp(db);const labels=new WhatsAppLabels(db),sockets=[];
  const contas=['5511999999999:4@s.whatsapp.net','5511999999999:7@s.whatsapp.net','5511666666666:2@s.whatsapp.net'];const conexao=new Conexao({authDir:'teste',aoLote:async()=>{},whatsappLabels:labels,criarSocket:async()=>{const s=socketFalso(contas[sockets.length]);sockets.push(s);return s;}});
  await conexao.iniciar();sockets[0].ev.emit('connection.update',{connection:'open'});const primeira=conexao.sessaoLabels();labels.consentir(primeira,true);assert.equal(labels.estado(primeira).leitura,true);
  sockets[0].ev.emit('connection.update',{connection:'close'});assert.equal(labels.estado(primeira).leitura,false);t.mock.timers.tick(1000);await tick();
  sockets[1].ev.emit('connection.update',{connection:'open'});const segunda=conexao.sessaoLabels();assert.notEqual(segunda.geracao,primeira.geracao);assert.notEqual(segunda.sessaoId,primeira.sessaoId);assert.equal(labels.estado(segunda).leitura,false);
  labels.consentir(segunda,true);sockets[0].ev.emit('connection.update',{connection:'close'});assert.equal(labels.estado(segunda).leitura,true);
  sockets[1].ev.emit('connection.update',{connection:'close'});t.mock.timers.tick(1000);await tick();sockets[2].ev.emit('connection.update',{connection:'open'});const terceira=conexao.sessaoLabels();assert.notEqual(terceira.contaId,segunda.contaId);assert.equal(labels.estado(terceira).leitura,false);
  await conexao.parar();assert.equal(labels.estado(terceira).leitura,false);db.close();
});

test('evento aceito na fila mas executado depois do close e descartado na transacao',async()=>{
  const db=abrirBanco(':memory:'),labels=new WhatsAppLabels(db),socket=socketFalso();let liberar;const bloqueio=new Promise(resolve=>liberar=resolve);
  const conexao=new Conexao({authDir:'teste',whatsappLabels:labels,criarSocket:async()=>socket,aoLote:async()=>bloqueio});await conexao.iniciar();socket.ev.emit('connection.update',{connection:'open'});const sessao=conexao.sessaoLabels();labels.consentir(sessao,true);
  socket.ev.emit('messages.upsert',{messages:[{key:{id:'bloqueio'}}],type:'notify'});await tick();socket.ev.emit('labels.edit',{id:'tardia',name:'Tardia',color:1,deleted:false});socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});liberar();await tick();await tick();assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_label_observacoes').get().n,0);await conexao.parar();db.close();
});

function evento(ctx,id,chatId,texto='fonte'){
  ctx.receber({type:'notify',donoJids:['5511999999999@s.whatsapp.net'],messages:[{key:{id,remoteJid:chatId,fromMe:true},messageTimestamp:1789819200,message:{conversation:texto}}]});
  return ctx.db.prepare('SELECT id FROM eventos WHERE conversa_id=? AND origem_id=?').get(chatId,id).id;
}

test('exportacao e exclusao aplicam o recorte de leitura e podam definicao somente quando orfa',()=>{
  const db=abrirBanco(':memory:'),ctx=new ContextoApp(db,{donoId:'5511999999999@s.whatsapp.net'});new Desktop(db);new DesktopIA(db);const labels=new WhatsAppLabels(db),privacidade=new Privacidade(db);
  try{
    const visivel='5511888888888@s.whatsapp.net',oculta='5511777777777@s.whatsapp.net',fonte=evento(ctx,'m-visivel',visivel),fonteOculta=evento(ctx,'m-oculta',oculta);db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(fonteOculta);
    const s={contaId:'5511999999999@s.whatsapp.net',geracao:1,sessaoId:'dados'};labels.ativarSessao(s);labels.consentir(s,true);
    for(const [id,nome,chatId,messageId] of [['l1','Visivel',visivel,'m-visivel'],['l2','Oculta',oculta,'m-oculta']]){labels.observarLabel(s,{id,name:nome,color:1,deleted:false});labels.observarAssociacao(s,{type:'add',association:{type:'label_message',chatId,messageId,labelId:id}});}
    const exportado=privacidade.exportar({confirmar:true});assert.deepEqual(exportado.conteudo.derivados.whatsapp_labels.map(x=>x.label_id),['l1']);assert.deepEqual(exportado.conteudo.derivados.whatsapp_label_associacoes.map(x=>x.label_id),['l1']);
    const previa=privacidade.preparar({fonte});assert.equal(previa.contagens.whatsapp_label_associacoes,1);privacidade.excluir({id:previa.id,confirmar:'APAGAR'});
    assert.deepEqual(db.prepare('SELECT label_id FROM whatsapp_labels ORDER BY label_id').all().map(x=>x.label_id),['l2']);assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_label_observacoes WHERE label_id=?').get('l1').n,0);
    const tudo=privacidade.preparar({tudo:true});privacidade.excluir({id:tudo.id,confirmar:'APAGAR'});for(const table of TABELAS_WHATSAPP_LABELS)assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  }finally{db.close();}
});

test('backup v7 restaura somente observacoes, valida fatos/projecoes e migra v5 vazio com consentimento desligado',async()=>{
  const origem=abrirBanco(':memory:'),ctx=new ContextoApp(origem,{donoId:'5511999999999@s.whatsapp.net'});new Desktop(origem);new DesktopIA(origem);const labelsOrigem=new WhatsAppLabels(origem);evento(ctx,'m1','5511888888888@s.whatsapp.net');
  const s={contaId:'5511999999999@s.whatsapp.net',geracao:1,sessaoId:'sessao-efemera-nao-exportar'};labelsOrigem.ativarSessao(s);labelsOrigem.consentir(s,true);labelsOrigem.observarLabel(s,{id:'l1',name:'Cliente',color:3,deleted:false,predefinedId:'PRESET'});labelsOrigem.observarAssociacao(s,{type:'add',association:{type:'label_message',chatId:'5511888888888@s.whatsapp.net',messageId:'m1',labelId:'l1'}});
  const backupOrigem=new Backup(origem),conteudo=backupOrigem.capturar();assert.equal(conteudo.versao,'assessor-acervo-v7');assert.equal(conteudo.tabelas.whatsapp_label_observacoes.length,2);assert.equal(conteudo.tabelas.whatsapp_label_observacoes[0].predefined_id,'PRESET');assert.ok(!JSON.stringify(conteudo).includes('sessao-efemera-nao-exportar'));assert.ok(!JSON.stringify(conteudo).includes('sessaoId'));
  for(const alterar of [
    c=>c.tabelas.whatsapp_labels[0].nome='Forjada',
    c=>c.tabelas.whatsapp_labels[0].cor=4,
    c=>c.tabelas.whatsapp_labels[0].predefined_id='OUTRA',
    c=>c.tabelas.whatsapp_label_observacoes[0].nome='Fato forjado',
    c=>c.tabelas.whatsapp_label_observacoes[0].cor=4,
    c=>c.tabelas.whatsapp_label_observacoes[0].predefined_id='OUTRA',
    c=>c.tabelas.whatsapp_label_observacoes[0].assinatura='0'.repeat(64),
    c=>c.tabelas.whatsapp_labels[0].ultima_observacao_id=999999,
    c=>c.tabelas.whatsapp_label_associacoes[0].primeira_observacao_id=999999
  ]){const adulterado=structuredClone(conteudo);alterar(adulterado);assert.throws(()=>backupOrigem.validar(adulterado),/label|Observacoes|associacao/u);}
  const destino=abrirBanco(':memory:');new ContextoApp(destino);new Desktop(destino);new DesktopIA(destino);const labelsDestino=new WhatsAppLabels(destino),backup=new Backup(destino);const ativa={contaId:'5511666666666@s.whatsapp.net',geracao:7,sessaoId:'destino'};labelsDestino.ativarSessao(ativa);labelsDestino.consentir(ativa,true);
  const pacote=JSON.stringify(await cifrarBackup(conteudo,'senha-de-teste-segura')),previa=await backup.preparar({arquivo:pacote,senha:'senha-de-teste-segura'});backup.restaurar({id:previa.id,confirmarMeuBackup:true});assert.equal(destino.prepare('SELECT COUNT(*) n FROM whatsapp_label_observacoes').get().n,2);assert.equal(labelsDestino.estado(ativa).leitura,false);
  const legado=structuredClone(conteudo);legado.versao='assessor-acervo-v5';for(const tabela of [...TABELAS_WHATSAPP_LABELS,'lume_acoes','lume_acoes_historico'])delete legado.tabelas[tabela];backup.validar(legado);assert.equal(legado.versao,'assessor-acervo-v7');for(const tabela of TABELAS_WHATSAPP_LABELS)assert.deepEqual(legado.tabelas[tabela],[]);
  origem.close();destino.close();
});
