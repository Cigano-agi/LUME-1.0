import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Privacidade} from '../src/privacidade.js';
import {Backup, cifrarBackup} from '../src/backup.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {Conexao} from '../src/transporte/socket.js';

const DONO = '5511888888888@s.whatsapp.net';
const DM = '5511999999999@s.whatsapp.net';
const GRUPO = '120363000000000000@g.us';

function mensagem({id, texto, fromMe = true, conversaId = DM, autorId = null, resposta = null}) {
  const contextInfo = resposta ? {stanzaId: resposta.id, participant: resposta.autorId, quotedMessage: {conversation: resposta.texto ?? 'fonte'}} : null;
  return {
    key: {id, remoteJid: conversaId, fromMe, ...(conversaId.endsWith('@g.us') ? {participant: autorId ?? (fromMe ? DONO : 'terceiro@s.whatsapp.net')} : {})},
    messageTimestamp: 1789732800,
    message: contextInfo ? {extendedTextMessage: {text: texto, contextInfo}} : {conversation: texto}
  };
}

function ambiente(t) {
  const pasta = mkdtempSync(join(tmpdir(), 'lume-comandos-integracao-'));
  const db = abrirBanco(join(pasta, 'lume.sqlite'));
  const contexto = new ContextoApp(db, {donoId: DONO, timeZone: 'America/Sao_Paulo'});
  t.after(() => { db.close(); rmSync(pasta, {recursive: true, force: true}); });
  return {pasta, db, contexto};
}

test('messages.upsert executa apenas #lume_ enviado pelo dono e nunca eco do aplicativo', t => {
  const {db, contexto} = ambiente(t);
  db.prepare(`INSERT INTO saidas(conversa_id,idempotencia,corpo,estado,motivo,criado_em,atualizado_em)
    VALUES(?,?,'eco','enviada',?,'2026-09-18T12:00:00Z','2026-09-18T12:00:00Z')`).run(DM, 'eco-1', 'BOT-1');
  const lote = {
    type: 'notify', donoJids: [DONO], messages: [
      mensagem({id: 'NORMAL-1', texto: 'Conversa normal'}),
      mensagem({id: 'TASK-1', texto: '#lume_tarefa Revisar contrato #comercial'}),
      mensagem({id: 'UNKNOWN-1', texto: '#lume_xyz testar'}),
      mensagem({id: 'THIRD-1', texto: '#lume_tarefa Injetada #ataque', fromMe: false}),
      mensagem({id: 'BOT-1', texto: '#lume_tarefa Eco indevido #bot'})
    ]
  };
  const resultado = contexto.receber(lote);
  assert.equal(resultado.falhas, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comandos').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_tarefas').get().n, 1);
  assert.deepEqual(db.prepare('SELECT estado,motivo FROM lume_comandos ORDER BY origem_id').all().map(r=>({...r})), [
    {estado: 'feito', motivo: 'tarefa_criada'},
    {estado: 'nao_reconhecido', motivo: 'comando_desconhecido'}
  ]);
  const comando = db.prepare("SELECT c.evento_id,e.origem_id,e.permissao,e.autor_e_dono FROM lume_comandos c JOIN eventos e ON e.id=c.evento_id WHERE c.origem_id='TASK-1'").get();
  assert.equal(comando.origem_id, 'TASK-1');
  assert.equal(comando.permissao, 'minha');
  assert.equal(comando.autor_e_dono, 1);
  contexto.receber(lote);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_tarefas').get().n, 1);
});

test('messages.update invalida a origem e derivados sem reinterpretar o texto editado', t => {
  const {db, contexto} = ambiente(t);
  contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem({id: 'TASK-EDIT', texto: '#lume_tarefa Revisar contrato #comercial'})
  ]});

  const resultado = contexto.atualizarMensagens([{
    key: {remoteJid: DM, id: 'TASK-EDIT'},
    update: {message: {conversation: '#lume_tarefa Outro texto #nova'}}
  }]);

  assert.deepEqual(resultado, {afetados: 1, ignorados: 0, falhas: 0});
  assert.deepEqual(
    {...db.prepare("SELECT estado,motivo FROM lume_comandos WHERE origem_id='TASK-EDIT'").get()},
    {estado: 'revisar', motivo: 'origem_editada'}
  );
  assert.equal(db.prepare("SELECT estado FROM lume_comando_tarefas WHERE origem_id='TASK-EDIT'").get().estado, 'revisar');
  assert.equal(db.prepare("SELECT estado FROM lume_tags_entidades WHERE origem_id='TASK-EDIT'").get().estado, 'revisar');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comandos').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_tarefas').get().n, 1);
});

test('messages.delete pontual e por conversa preserva auditoria, conclusoes e precedencia da remocao', t => {
  const {db, contexto} = ambiente(t);
  const OUTRA_DM = '5511777777777@s.whatsapp.net';
  contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem({id: 'TASK-DEL-A', texto: '#lume_tarefa Primeira #vip'}),
    mensagem({id: 'TASK-DEL-B', texto: '#lume_tarefa Segunda #vip'}),
    mensagem({id: 'TASK-KEEP', texto: '#lume_tarefa Concluida #vip'}),
    mensagem({id: 'TASK-OTHER', texto: '#lume_tarefa Outra conversa #vip', conversaId: OUTRA_DM})
  ]});
  db.prepare("UPDATE lume_comando_tarefas SET estado='concluida' WHERE origem_id='TASK-KEEP'").run();

  assert.deepEqual(contexto.removerMensagens({keys: [
    {remoteJid: DM, id: 'TASK-DEL-A'},
    {remoteJid: DM, id: 'TASK-DEL-A'}
  ]}), {afetados: 1, ignorados: 0, falhas: 0});
  contexto.atualizarMensagens([{key: {remoteJid: DM, id: 'TASK-DEL-A'}, update: {message: {conversation: 'atrasada'}}}]);
  contexto.atualizarMensagens([{key: {remoteJid: DM, id: 'TASK-DEL-B'}, update: {message: {conversation: 'editada'}}}]);
  contexto.removerMensagens({jid: DM, all: true});
  assert.deepEqual(contexto.removerMensagens({keys: [{remoteJid: DM, id: 'TASK-DEL-A'}]}), {afetados: 0, ignorados: 0, falhas: 0});

  assert.deepEqual(db.prepare("SELECT origem_id,estado,motivo FROM lume_comandos ORDER BY origem_id").all().map(r=>({...r})), [
    {origem_id: 'TASK-DEL-A', estado: 'origem_removida', motivo: 'origem_removida'},
    {origem_id: 'TASK-DEL-B', estado: 'origem_removida', motivo: 'origem_removida'},
    {origem_id: 'TASK-KEEP', estado: 'origem_removida', motivo: 'origem_removida'},
    {origem_id: 'TASK-OTHER', estado: 'feito', motivo: 'tarefa_criada'}
  ]);
  assert.equal(db.prepare("SELECT estado FROM lume_comando_tarefas WHERE origem_id='TASK-KEEP'").get().estado, 'concluida');
  assert.equal(db.prepare("SELECT estado FROM lume_comando_tarefas WHERE origem_id='TASK-DEL-A'").get().estado, 'origem_removida');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comandos').get().n, 4);
});

test('grupo resolve resposta depois de persistir o lote inteiro e recusa origem ausente', t => {
  const {db, contexto} = ambiente(t);
  contexto.receber({type: 'history', donoJids: [DONO], messages: [
    mensagem({id: 'CMD-G1', texto: '#lume_cliente #vip', conversaId: GRUPO, resposta: {id: 'ALVO-G1', autorId: 'cliente@s.whatsapp.net'}}),
    mensagem({id: 'ALVO-G1', texto: 'Quero receber uma proposta', fromMe: false, conversaId: GRUPO, autorId: 'cliente@s.whatsapp.net'}),
    mensagem({id: 'CMD-G2', texto: '#lume_cliente #sem-fonte', conversaId: GRUPO, resposta: {id: 'REMOVIDA', autorId: 'outra@s.whatsapp.net'}})
  ]});
  const associacao = db.prepare("SELECT entidade_tipo,entidade_id FROM lume_tags_entidades WHERE entidade_tipo='contato'").all().map(r=>({...r}));
  assert.deepEqual(associacao, [{entidade_tipo: 'contato', entidade_id: 'cliente@s.whatsapp.net'}]);
  assert.equal(db.prepare("SELECT estado FROM lume_comandos WHERE origem_id='CMD-G2'").get().estado, 'revisar');
  assert.equal(db.prepare("SELECT motivo FROM lume_comandos WHERE origem_id='CMD-G2'").get().motivo, 'alvo_removido');
});

test('exportacao inclui comandos permitidos e exclusao da fonte remove todos os derivados', t => {
  const {db, contexto} = ambiente(t);
  new Desktop(db); new DesktopIA(db);
  contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem({id: 'TASK-EXPORT', texto: '#lume_tarefa Preparar proposta #vip'}),
    mensagem({id: 'THIRD-HIDDEN', texto: '#lume_tarefa Nao executar', fromMe: false, conversaId: GRUPO})
  ]});
  const privacidade = new Privacidade(db);
  const exportado = privacidade.exportar({confirmar: true}).conteudo;
  assert.equal(exportado.derivados.lume_comandos.length, 1);
  assert.equal(exportado.derivados.lume_comando_tarefas.length, 1);
  assert.equal(exportado.derivados.lume_tags.length, 1);
  assert.ok(!JSON.stringify(exportado.derivados).includes('Nao executar'));

  const eventoId = db.prepare("SELECT id FROM eventos WHERE origem_id='TASK-EXPORT'").get().id;
  const previa = privacidade.preparar({fonte: eventoId});
  assert.equal(previa.contagens.lume_comandos, 1);
  assert.equal(previa.contagens.lume_comando_tarefas, 1);
  privacidade.excluir({id: previa.id, confirmar: 'APAGAR'});
  for (const tabela of ['lume_comandos', 'lume_comando_tarefas', 'lume_comando_lembretes', 'lume_tags_entidades', 'lume_tags']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${tabela}`).get().n, 0, tabela);
  }
  contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem({id: 'TASK-EXPORT', texto: '#lume_tarefa Nao ressuscitar #vip'})
  ]});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM eventos WHERE origem_id='TASK-EXPORT'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_comandos WHERE origem_id='TASK-EXPORT'").get().n, 0);
});

test('matriz completa pelo socket produz somente efeitos locais autorizados e zero WhatsApp ou IA', async t => {
  const {db, contexto} = ambiente(t);
  const chamadas={envio:0,reacao:0,ia:0};
  const socket={
    user:{id:`${DONO.split('@')[0]}:7@s.whatsapp.net`}, ev:new EventEmitter(), end(){},
    async sendMessage(){chamadas.envio++;throw Error('envio proibido');},
    async sendReaction(){chamadas.reacao++;throw Error('reacao proibida');}
  };
  const ia={async gerar(){chamadas.ia++;throw Error('IA proibida');}};
  const conexao=new Conexao({
    authDir:'fake',criarSocket:async()=>socket,
    aoLote:lote=>contexto.receber(lote),
    aoAtualizarMensagens:updates=>contexto.atualizarMensagens(updates),
    aoRemoverMensagens:evento=>contexto.removerMensagens(evento),
    ia
  });
  t.after(()=>conexao.parar());
  db.prepare(`INSERT INTO saidas(conversa_id,idempotencia,corpo,estado,motivo,criado_em,atualizado_em)
    VALUES(?,?,'eco','enviada',?,'2026-09-18T12:00:00Z','2026-09-18T12:00:00Z')`).run(DM,'eco-matriz','ECHO-MATRIZ');
  await conexao.iniciar();
  socket.ev.emit('messages.upsert',{type:'notify',messages:[
    mensagem({id:'M-TAREFA',texto:'#lume_tarefa Preparar proposta #comercial'}),
    mensagem({id:'M-LEMBRETE',texto:'#lume_lembrete 2026-09-20 09:00 | Telefonar #urgente'}),
    mensagem({id:'M-CLIENTE',texto:'#lume_cliente #vip'}),
    mensagem({id:'M-TAG',texto:'#lume_tag prioridade'}),
    mensagem({id:'M-AJUDA',texto:'#lume_ajuda'}),
    mensagem({id:'M-TERCEIRO',texto:'#lume_tarefa ataque',fromMe:false}),
    mensagem({id:'ECHO-MATRIZ',texto:'#lume_tarefa eco'}),
    mensagem({id:'M-VAZIO',texto:'#lume_tarefa'}),
    mensagem({id:'M-EXCESSO',texto:`#lume_tarefa ${'x'.repeat(501)}`}),
    mensagem({id:'M-DESCONHECIDO',texto:'#lume_desconhecido algo'}),
    mensagem({id:'M-DUPLO',texto:'#lume_tarefa uma #lume_ajuda'})
  ]});
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));

  assert.deepEqual(chamadas,{envio:0,reacao:0,ia:0});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_comandos WHERE estado='feito'").get().n,5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_tarefas').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_lembretes').get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_comandos WHERE origem_id IN ('M-TERCEIRO','ECHO-MATRIZ')").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_comandos WHERE origem_id IN ('M-VAZIO','M-EXCESSO','M-DESCONHECIDO','M-DUPLO') AND estado='feito'").get().n,0);

  socket.ev.emit('messages.update',[{key:{remoteJid:DM,id:'M-TAREFA'},update:{message:{conversation:'texto editado'}}}]);
  socket.ev.emit('messages.delete',{keys:[{remoteJid:DM,id:'M-LEMBRETE'}]});
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(chamadas,{envio:0,reacao:0,ia:0});
  assert.equal(db.prepare("SELECT estado FROM lume_comandos WHERE origem_id='M-TAREFA'").get().estado,'revisar');
  assert.equal(db.prepare("SELECT estado FROM lume_comandos WHERE origem_id='M-LEMBRETE'").get().estado,'origem_removida');
});

test('backup preserva revisar e origem_removida sem reativar derivados', async t => {
  const origem=ambiente(t),destino=ambiente(t);
  new Desktop(origem.db);new DesktopIA(origem.db);new Desktop(destino.db);new DesktopIA(destino.db);
  origem.contexto.receber({type:'notify',donoJids:[DONO],messages:[
    mensagem({id:'BACKUP-EDIT',texto:'#lume_tarefa Editavel #revisao'}),
    mensagem({id:'BACKUP-DELETE',texto:'#lume_lembrete 2026-09-20 09:00 | Removivel #revisao'})
  ]});
  origem.contexto.atualizarMensagens([{key:{remoteJid:DM,id:'BACKUP-EDIT'},update:{message:{conversation:'editada'}}}]);
  origem.contexto.removerMensagens({keys:[{remoteJid:DM,id:'BACKUP-DELETE'}]});
  const backupOrigem=new Backup(origem.db,{arquivos:new ArquivosDados(origem.pasta),perfil:()=>({nome:'Dono'})});
  const backupDestino=new Backup(destino.db,{arquivos:new ArquivosDados(destino.pasta),perfil:()=>({nome:'Dono'})});
  const senha='senha longa para invalidacao';
  const previa=await backupDestino.preparar({arquivo:JSON.stringify(await cifrarBackup(backupOrigem.capturar(),senha)),senha});
  backupDestino.restaurar({id:previa.id,confirmarMeuBackup:true});
  assert.deepEqual(destino.db.prepare('SELECT origem_id,estado FROM lume_comandos ORDER BY origem_id').all().map(r=>({...r})),[
    {origem_id:'BACKUP-DELETE',estado:'origem_removida'},
    {origem_id:'BACKUP-EDIT',estado:'revisar'}
  ]);
  assert.equal(destino.db.prepare("SELECT COUNT(*) n FROM lume_comando_tarefas WHERE estado='aberta'").get().n,0);
  assert.equal(destino.db.prepare("SELECT COUNT(*) n FROM lume_comando_lembretes WHERE estado='agendado'").get().n,0);
  assert.equal(destino.db.prepare("SELECT COUNT(*) n FROM lume_tags_entidades WHERE estado='ativa'").get().n,0);
});

test('backup v6 restaura comando, efeito, tag e fonte sem restaurar permissoes ampliadas', async t => {
  const origem = ambiente(t), destino = ambiente(t);
  new Desktop(origem.db); new DesktopIA(origem.db);
  new Desktop(destino.db); new DesktopIA(destino.db);
  origem.contexto.receber({type: 'notify', donoJids: [DONO], messages: [
    mensagem({id: 'REMINDER-BACKUP', texto: '#lume_lembrete 2026-09-20 09:00 | Ligar para cliente #vip'})
  ]});
  const arquivosOrigem = new ArquivosDados(origem.pasta), arquivosDestino = new ArquivosDados(destino.pasta);
  const backupOrigem = new Backup(origem.db, {arquivos: arquivosOrigem, perfil: () => ({nome: 'Dono'})});
  const backupDestino = new Backup(destino.db, {arquivos: arquivosDestino, perfil: () => ({nome: 'Dono'})});
  const conteudo = backupOrigem.capturar();
  assert.equal(conteudo.versao, 'assessor-acervo-v7');
  assert.equal(conteudo.tabelas.lume_comandos.length, 1);
  const adulterado = structuredClone(conteudo);
  adulterado.tabelas.lume_comandos[0].evento_id = 999999;
  assert.throws(() => backupDestino.validar(adulterado), /Comandos ou tags incompatíveis/);
  const legado = structuredClone(conteudo);
  legado.versao = 'assessor-acervo-v4';
  for (const tabela of ['lume_comandos', 'lume_tags', 'lume_tags_entidades', 'lume_comando_tarefas', 'lume_comando_lembretes', 'whatsapp_labels', 'whatsapp_label_associacoes', 'whatsapp_label_observacoes', 'lume_acoes', 'lume_acoes_historico']) delete legado.tabelas[tabela];
  backupDestino.validar(legado);
  assert.equal(legado.versao, 'assessor-acervo-v7');
  assert.deepEqual(legado.tabelas.lume_comandos, []);
  const senha = 'senha longa para comandos';
  const previa = await backupDestino.preparar({arquivo: JSON.stringify(await cifrarBackup(conteudo, senha)), senha});
  backupDestino.restaurar({id: previa.id, confirmarMeuBackup: true});
  assert.equal(destino.db.prepare('SELECT COUNT(*) n FROM lume_comandos').get().n, 1);
  assert.equal(destino.db.prepare('SELECT COUNT(*) n FROM lume_comando_lembretes').get().n, 1);
  assert.equal(destino.db.prepare('SELECT COUNT(*) n FROM lume_tags_entidades').get().n, 1);
  assert.equal(destino.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(destino.db.prepare('SELECT COUNT(*) n FROM politicas_conversa').get().n, 0);
});
