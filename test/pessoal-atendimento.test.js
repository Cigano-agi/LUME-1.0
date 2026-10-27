import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {pessoalPost} from '../src/pessoal/http.js';
const DM='551100001111@s.whatsapp.net',GROUP='12000001111@g.us';
test('busca de atendimento usa nome persistido, remove placeholders e conserva identidade',async t=>{
 const f=await fixture(t);
 const {salvarNomesWhatsapp}=await import('../src/nomes-conversa.js');
 salvarNomesWhatsapp(f.db,{contacts:[{id:DM,name:'Vitória Pereira'}]});
 f.db.prepare('UPDATE conversas_app SET nome=? WHERE id=?').run(DM,DM);
 f.db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('999999999@lid','...');
 const before=f.s.politica.assinatura(DM);
 const found=f.s.buscarConversas({busca:'vitoria'});
 assert.equal(found.total,1);assert.equal(found.conversas[0].conversaId,DM);
 assert.equal(found.conversas[0].nome,'Vitória Pereira');
 assert.equal(f.s.buscarConversas({busca:'999999999'}).conversas[0].nome,'Contato sem nome');
 assert.equal((await f.s.estado()).conversas.find(c=>c.conversaId===DM).nome,'Vitória Pereira');
 assert.equal(f.s.politica.assinatura(DM),before);
});
async function fixture(t){
 const db=abrirBanco();let now=new Date('2026-10-26T15:00:00Z'),sent=[];
 const contexto=new ContextoApp(db),desktop=new Desktop(db);desktop.aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
 const s=new LumePessoal(db,{desktop,agora:()=>now,chatgpt:{estado:async()=>({}),encerrar(){},responder:async()=>assert.fail('Nenhum modelo deve processar o backlog')},
  telegram:{estado:async()=>({}),agendar:()=>true},conexao:{estado:()=>({estado:'conectada'}),enviarTexto:async(jid,corpo,id)=>{sent.push(corpo);if(sent.length===1) s.configurarAtendimento({conversaId:DM,acao:'excluir'});return id;}}});
 t.after(async()=>{await s.encerrar();db.close();});
 db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(DM,'Pessoa teste');db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(GROUP,'Grupo teste');
 await s.configurar({enabled:true});s.configurarConversa({conversaId:DM,categoria:'lead',modo:'rascunhar',remoto:true});
 const control=(acao,extra={})=>s.configurarAtendimento({conversaId:DM,acao,...extra});
 const receive=(tipo='notify',fromMe=false)=>{contexto.receber({type:tipo,messages:[{key:{id:'id'+Math.random(),remoteJid:DM,fromMe},messageTimestamp:Math.floor(now/1000),message:{conversation:'Confira este relatório antes de responder.'}}]});return db.prepare('SELECT * FROM eventos ORDER BY id DESC LIMIT 1').get();};
 return {db,s,control,receive,sent,time:x=>now=new Date(x)};
}
test('controle persistido: exclusão sobrevive configuração e reabertura de política; grupo/família não ativam',async t=>{
 const f=await fixture(t);f.control('excluir');f.s.configurarConversa({conversaId:DM,categoria:'lead',modo:'atender',remoto:true});
 assert.equal(f.s.politica.podeEnviar(DM).permitido,false);assert.throws(()=>f.control('ativar'));
 const {PoliticaPessoal}=await import('../src/pessoal/politica.js');assert.equal(new PoliticaPessoal(f.db).regra(DM).atendimento.excluida,true);
 assert.throws(()=>f.s.configurarAtendimento({conversaId:GROUP,acao:'ativar'}));f.control('incluir');
 assert.equal(f.s.politica.regra(DM).pausada,true,'Retirar exclusão não retoma sozinho');
 f.s.configurarConversa({conversaId:DM,categoria:'family',modo:'rascunhar',remoto:true});assert.throws(()=>f.control('ativar'));
});
test('pausa temporária expira sem remover intervenção manual; retomada precisa ser explícita',async t=>{
 const f=await fixture(t);f.control('ativar');f.control('pausar',{minutos:60});assert.equal(f.s.politica.podeEnviar(DM).permitido,false);
 f.s.politica.pausar(DM);f.time('2026-10-26T17:00:00Z');assert.equal(f.s.politica.podeEnviar(DM).permitido,false);
 f.control('ativar');assert.equal(f.s.politica.regra(DM).pausada,true,'Ativar não limpa pausa manual');
 f.control('retomar');assert.equal(f.s.politica.podeEnviar(DM).permitido,true);
});
test('janela diária São Paulo aceita cruzamento de meia noite e exige intervalo válido',async t=>{
 const f=await fixture(t);f.control('horario',{inicio:'22:00',fim:'06:00'});assert.equal(f.s.politica.podeEnviar(DM).permitido,false);
 f.time('2026-10-27T02:00:00Z');assert.equal(f.s.politica.podeEnviar(DM).permitido,true);
 f.time('2026-10-27T09:00:00Z');assert.equal(f.s.politica.podeEnviar(DM).permitido,false);
 for(const extra of [{inicio:'22:00',fim:'22:00'},{inicio:'25:00',fim:'06:00'},{inicio:null,fim:'06:00'}])assert.throws(()=>f.control('horario',extra));
 f.control('horario',{inicio:null,fim:null});assert.equal(f.s.politica.podeEnviar(DM).permitido,true);
});
test('ativar não processa entrada anterior, notify atrasado nem histórico; preserva memória',async t=>{
 const f=await fixture(t);const old=f.receive();f.time(Date.now()+3600000);f.control('ativar');
 await f.s.tick();assert.equal(f.db.prepare("SELECT estado FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(old.id).estado,'desistida');
 const rule=f.s.politica.regra(DM);assert.equal(f.s.politica.entradaAtual({...old,id:old.id+1}),false);
 assert.equal(f.s.politica.entradaAtual({...old,id:old.id+1,recebido_em:new Date(Date.now()+7200000).toISOString()}),true);
 assert.ok(rule.atendimento.ativadaEm);assert.ok(f.db.prepare('SELECT 1 FROM eventos WHERE id=?').get(old.id));
 const historical=f.receive('history');assert.equal(f.db.prepare("SELECT 1 FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(historical.id),undefined);
});
test('exclusão entre balões invalida imediatamente proposta e não despacha segundo balão',async t=>{
 const f=await fixture(t);f.receive('history');const p=f.s.prepararMensagemDono({conversaId:DM,motivo:'Pedido explícito do dono para teste.',baloes:['Lume, assistente do Fabrício.','Segundo balão não autorizado.']});
 f.s.aprovar(p.id,p.versao,'local:owner');await f.s.tick();assert.equal(f.sent.length,1);assert.equal(f.s.proposta(p.id).estado,'cancelada');
});
test('HTTP rejeita campos e ações inválidas sem mudar regra',async t=>{
 const f=await fixture(t),before=f.s.politica.assinatura(DM);
 for(const data of [{conversaId:DM,acao:'ativar',qualquer:true},{conversaId:DM,acao:'pausar',minutos:0},{conversaId:'*',acao:'ativar'},{conversaId:DM,acao:'horario',inicio:'09:00',fim:'18:00',fuso:'UTC'}])await assert.rejects(pessoalPost(f.s,'/api/v3/pessoal/atendimento',data));
 assert.equal(f.s.politica.assinatura(DM),before);
});
