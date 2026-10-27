import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {PoliticaPessoal} from '../src/pessoal/politica.js';
import {prepararPessoal} from '../src/pessoal/esquema.js';
import {pessoalPost} from '../src/pessoal/http.js';
import {salvarNomesWhatsapp,criarNomeVisivel} from '../src/nomes-conversa.js';
import {prepararMidiasCiclo} from '../src/ciclo-midia-worker.js';
import {prepararEsquemaTranscricao,gravarTranscricao} from '../src/transcricao.js';
import {criarServidor} from '../src/painel/servidor.js';

const DM='551100001234@s.whatsapp.net',GROUP='120000001234@g.us',OWNER='123456789';
const TEXT='Confira o relatório sintético antes de responder.';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{transcrever,onSend}={}){
  const db=abrirBanco(':memory:'),contexto=new ContextoApp(db),desktop=new Desktop(db);
  prepararMidiasCiclo(db);prepararEsquemaTranscricao(db);
  desktop.aceitar({nome:'Revisão sintética',aceito:true,versao:VERSAO_TERMOS});
  let now=new Date('2026-10-26T15:00:00Z'),sequence=0;
  const f={db,contexto,desktop,calls:[],sent:[],alerts:[]};
  f.s=new LumePessoal(db,{desktop,agora:()=>now,transcrever:transcrever?(id,opts)=>transcrever(f,id,opts):null,
    chatgpt:{estado:async()=>({}),encerrar(){},responder:async input=>{f.calls.push(input);return {text:JSON.stringify({decisao:'passivo',resumo:''})};}},
    telegram:{estado:async()=>({}),agendar:(...args)=>{f.alerts.push(args);return true;}},
    conexao:{estado:()=>({estado:'conectada'}),enviarTexto:async(jid,text,id)=>{f.sent.push({jid,text,id});await onSend?.(f);return id;},
      sendPresenceUpdate:()=>assert.fail('No automatic typing'),readMessages:()=>assert.fail('No automatic read receipt')},
    fetchImpl:async()=>assert.fail('No external network')});
  t.after(async()=>{await f.s.encerrar();db.close();});
  for(const [id,nome]of [[DM,'Contato de teste'],[GROUP,'Grupo de teste']])db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,nome);
  await f.s.configurar({enabled:true});
  f.s.configurarConversa({conversaId:DM,categoria:'lead',modo:'rascunhar',remoto:true});
  f.time=value=>now=new Date(value);
  f.control=(acao,extra={})=>f.s.configurarAtendimento({conversaId:DM,acao,...extra});
  f.receive=({at=now,type='notify',audio=false,fromMe=false}={})=>{
    const origemId='review-'+(++sequence);
    const result=contexto.receber({type,messages:[{key:{id:origemId,remoteJid:DM,fromMe},messageTimestamp:Math.floor(new Date(at).getTime()/1000),
      message:audio?{audioMessage:{mimetype:'audio/ogg',seconds:1,ptt:true}}:{conversation:TEXT}}]});
    assert.equal(result.falhas,0);
    const e=db.prepare('SELECT * FROM eventos WHERE origem_id=? AND conversa_id=?').get(origemId,DM);
    db.prepare("UPDATE etapas SET proxima_tentativa_em='2000-01-01T00:00:00Z' WHERE evento_id=? AND etapa='assistencia'").run(e.id);
    return e;
  };
  return f;
}

test('review: identical saved-address-book observation still promotes provenance over pushName',t=>{
  const db=abrirBanco(':memory:');new ContextoApp(db);t.after(()=>db.close());
  const quando='2026-10-26T15:00:00Z';
  salvarNomesWhatsapp(db,{contacts:[{id:DM,notify:'Alice Agenda'}]},{quando});
  salvarNomesWhatsapp(db,{contacts:[{id:DM,name:'Alice Agenda'}]},{quando});
  salvarNomesWhatsapp(db,{messages:[{key:{id:'later',remoteJid:DM},pushName:'Nome fraco alterado'}]},{quando:'2026-10-26T15:01:00Z'});
  assert.equal(criarNomeVisivel(db)(null,DM),'Alice Agenda','dedup must not discard a stronger origin');
  assert.equal(db.prepare('SELECT origem FROM pessoa_identificadores WHERE identificador=?').get(DM).origem,'usync');
});

test('review: control fresh notify reaches the synthetic model once',async t=>{
  const f=await fixture(t);f.control('ativar');f.time('2026-10-26T15:01:00Z');const e=f.receive();
  await f.s.tick();
  assert.equal(f.calls.length,1,JSON.stringify(f.db.prepare("SELECT * FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(e.id)));
});

test('review: delayed pre-activation notify cannot supersede a valid new pending message',async t=>{
  const f=await fixture(t);f.control('ativar');
  f.time('2026-10-26T15:01:00Z');const fresh=f.receive();
  const delayed=f.receive({at:'2026-10-26T14:00:00Z'});
  assert.equal(f.s.politica.entradaAtual(fresh),true);assert.equal(f.s.politica.entradaAtual(delayed),false);
  await f.s.tick();await f.s.tick();
  assert.equal(f.calls.length,1,'the new message must be interpreted despite a later-arriving historical notify');
  assert.equal(JSON.parse(f.calls[0].input[0].content).mensagemAtual.id,fresh.id);
});

test('review: retomar during audio transcription invalidates that pre-resume entry before inference',async t=>{
  let release,entered;
  const hold=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{transcrever:async(f,id)=>{
    entered();await hold;
    const e=f.db.prepare('SELECT * FROM eventos WHERE id=?').get(id);
    gravarTranscricao(f.db,{conversaId:e.conversa_id,origemId:e.origem_id,quando:e.recebido_em,texto:TEXT,modelo:'fixture-only',duracaoMs:1});
  }});
  f.time('2026-10-26T15:01:00Z');const e=f.receive({audio:true});
  f.db.prepare("DELETE FROM etapas WHERE evento_id=? AND etapa='midia'").run(e.id);
  const pending=f.s.tick();
  let timer;
  try{await Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('transcriber not reached: '+JSON.stringify(f.db.prepare("SELECT * FROM etapas WHERE evento_id=?").all(e.id)))),2000);})]);}
  finally{clearTimeout(timer);}
  f.time('2026-10-26T15:02:00Z');f.control('retomar');
  assert.equal(f.s.politica.entradaAtual(e),false);
  release();await pending;
  assert.equal(f.calls.length,0,'an awaited local transcription must not bypass the new activation watermark');
});

test('review: upgrading a legacy policy is additive and idempotent without clearing owner pause',t=>{
  const db=abrirBanco(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE pessoal_politicas(conversa_id TEXT PRIMARY KEY,categoria TEXT NOT NULL DEFAULT 'unknown',remoto INTEGER NOT NULL DEFAULT 0,pausada INTEGER NOT NULL DEFAULT 0,versao INTEGER NOT NULL DEFAULT 1,atualizado_em TEXT NOT NULL)");
  db.prepare('INSERT INTO pessoal_politicas VALUES(?,?,?,?,?,?)').run(DM,'lead',1,1,7,'2026-10-25T00:00:00Z');
  const before=db.prepare('SELECT * FROM pessoal_politicas').get(),policy=new PoliticaPessoal(db);
  prepararPessoal(db);const {atendimento,...after}=db.prepare('SELECT * FROM pessoal_politicas').get();
  assert.deepEqual(after,{...before});assert.equal(atendimento,'{}');assert.equal(policy.regra(DM).pausada,true);
  assert.equal(policy.podeEnviar(DM).permitido,false);
  assert.equal(db.prepare('PRAGMA table_info(pessoal_politicas)').all().filter(c=>c.name==='atendimento').length,1);
});

test('review: Sao Paulo windows use inclusive start and exclusive end across midnight',async t=>{
  const f=await fixture(t);
  for(const [inicio,fim,cases]of [
    ['09:00','18:00',[['11:59:00',false],['12:00:00',true],['20:59:59',true],['21:00:00',false]]],
    ['22:00','06:00',[['00:59:00',false],['01:00:00',true],['03:00:00',true],['08:59:59',true],['09:00:00',false]]]
  ]){
    f.control('horario',{inicio,fim});
    for(const [utc,expected]of cases){f.time('2026-10-27T'+utc+'Z');assert.equal(f.s.politica.podeEnviar(DM).permitido,expected,`${inicio}-${fim} at ${utc}Z`);}
  }
  f.control('horario',{inicio:null,fim:null});f.time('2026-10-27T12:00:00Z');f.control('pausar',{minutos:60});
  f.time('2026-10-27T12:59:59Z');assert.equal(f.s.politica.podeEnviar(DM).permitido,false);
  f.time('2026-10-27T13:00:00Z');assert.equal(f.s.politica.podeEnviar(DM).permitido,true);
  f.s.politica.pausar(DM);f.time('2026-10-28T13:00:00Z');assert.equal(f.s.politica.podeEnviar(DM).permitido,false);
});

test('review: crossing the daily end between balloons blocks the next send',async t=>{
  const f=await fixture(t,{onSend:f=>f.time('2026-10-26T21:00:00Z')});
  f.control('horario',{inicio:'09:00',fim:'18:00'});f.time('2026-10-26T20:59:59Z');f.receive({type:'history'});
  const p=f.s.prepararMensagemDono({conversaId:DM,motivo:'Pedido explícito sintético para revisar a janela.',baloes:['Lume, assistente do Fabrício.','Este segundo balão deve ser bloqueado.']});
  f.s.aprovar(p.id,p.versao,'local:owner');await f.s.tick();await f.s.tick();
  assert.equal(f.sent.length,1);assert.equal(f.s.proposta(p.id).estado,'cancelada');
});

test('review: Telegram resume requires exact owner, cannot undo exclusion and resets the input watermark',async t=>{
  const f=await fixture(t),diario={donoId:OWNER};f.control('excluir');
  const update=(extra={})=>({update_id:1,message:{text:'retomar '+DM,chat:{id:OWNER,type:'private'},from:{id:OWNER,is_bot:false},...extra}});
  const signature=f.s.politica.assinatura(DM);
  for(const extra of [{chat:{id:OWNER,type:'group'}},{from:{id:'987654321'}},{chat:{id:'987654321',type:'private'}},{from:{id:OWNER,is_bot:true}}]){
    assert.equal(await f.s.conversar(update(extra),{diario,signal:new AbortController().signal}),null);
    assert.equal(f.s.politica.assinatura(DM),signature);
  }
  assert.match((await f.s.conversar(update(),{diario,signal:new AbortController().signal})).text,/excluída/);
  assert.equal(f.s.politica.assinatura(DM),signature);
  f.control('incluir');const old=f.receive();f.time('2026-10-26T16:00:00Z');
  assert.match((await f.s.conversar(update(),{diario,signal:new AbortController().signal})).text,/retomada/);
  assert.equal(f.s.politica.regra(DM).pausada,false);assert.equal(f.s.politica.entradaAtual(old),false);assert.equal(f.calls.length,0);
});

test('review: extra or action-incompatible fields never mutate a policy',async t=>{
  const f=await fixture(t),before=f.s.politica.assinatura(DM);
  const invalid=[null,[],{conversaId:DM,acao:'ativar',remoto:true},{conversaId:DM,acao:'ativar',ator:'telegram:forged'},
    {conversaId:DM,acao:'retomar',minutos:60},{conversaId:DM,acao:'pausar',minutos:'60'},
    {conversaId:DM,acao:'desativar',inicio:null,fim:null},{conversaId:DM,acao:'horario',inicio:'9:00',fim:'18:00'},
    {conversaId:DM,acao:'horario',inicio:'09:00',fim:'18:00',fuso:'UTC'},
    JSON.parse('{"conversaId":"'+DM+'","acao":"ativar","__proto__":{"excluida":false}}')];
  for(const body of invalid){await assert.rejects(pessoalPost(f.s,'/api/v3/pessoal/atendimento',body));assert.equal(f.s.politica.assinatura(DM),before);}
  for(const categoria of ['family','unknown','friend','supplier']){
    f.s.configurarConversa({conversaId:DM,categoria,modo:'rascunhar',remoto:true});
    assert.throws(()=>f.control('ativar'));assert.throws(()=>f.control('retomar'));assert.equal(f.s.politica.podeEnviar(DM).permitido,false);
  }
});

test('review: paged conversation search escapes LIKE and retains exact IDs beyond the legacy 1000 cap',async t=>{
  const f=await fixture(t),insert=f.db.prepare('INSERT INTO conversas_app VALUES(?,?)');
  f.db.exec('BEGIN');for(let i=0;i<1005;i++)insert.run(`${551200000000+i}@s.whatsapp.net`,'Contato '+String(i).padStart(4,'0'));f.db.exec('COMMIT');
  insert.run('559900001111@s.whatsapp.net','Zé Último');insert.run('559900001112@s.whatsapp.net','Literal %_\\ pessoa');
  const found=f.s.buscarConversas({busca:'ze ultimo',tipo:'dm'});assert.equal(found.total,1);assert.equal(found.conversas[0].conversaId,'559900001111@s.whatsapp.net');
  assert.equal(f.s.buscarConversas({busca:'%_\\',tipo:'all'}).total,1);
  const ids=[];let pagina=0,result;
  do{result=f.s.buscarConversas({pagina:pagina++,tipo:'all'});assert.ok(result.conversas.length<=100);ids.push(...result.conversas.map(c=>c.conversaId));}while(result.mais);
  assert.equal(ids.length,result.total);assert.equal(new Set(ids).size,ids.length);
  assert.ok(f.s.buscarConversas({tipo:'group'}).conversas.every(c=>c.conversaId.endsWith('@g.us')));
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});

test('review: attendance and new metadata search enforce HTTP origin, token, readOnly and strict query',async t=>{
  const f=await fixture(t),server=criarServidor(f.db,{desktop:true,pessoal:f.s,contexto:f.contexto,conexao:{estado:()=>({estado:'desconectada'})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,token=(await(await fetch(origin+'/api/sessao')).json()).token;
  const call=(path,{body,headers={},auth=true}={})=>fetch(origin+'/api/v3/pessoal'+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{'x-assessor-token':token}:{}),'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try{
    for(const headers of [{origin:'https://untrusted.invalid'},{'sec-fetch-site':'cross-site'},{'x-assessor-token':'wrong'}]){
      assert.equal((await call('/atendimento',{headers,body:{conversaId:DM,acao:'excluir'}})).status,403);
      assert.equal((await call('/conversas',{headers})).status,403);
    }
    assert.equal((await call('/conversas',{auth:false})).status,403);
    assert.equal(f.s.politica.regra(DM).atendimento.excluida,false);
    for(const query of ['?extra=1','?pagina=-1','?pagina=NaN','?tipo=anything','?tipo=dm&tipo=group'])assert.equal((await call('/conversas'+query)).status,400);
    const ok=await call('/conversas?busca=Contato&tipo=dm&pagina=0');assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store');
    assert.equal((await ok.json()).conversas[0].conversaId,DM);
  }finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
  const ro=criarServidor(f.db,{desktop:true,readOnly:true,pessoal:f.s,contexto:f.contexto,conexao:{estado:()=>({estado:'desconectada'})}});
  await new Promise(resolve=>ro.listen(0,'127.0.0.1',resolve));const roOrigin=`http://127.0.0.1:${ro.address().port}`;
  try{
    const roToken=(await(await fetch(roOrigin+'/api/sessao')).json()).token;
    assert.equal((await fetch(roOrigin+'/api/v3/pessoal/atendimento',{method:'POST',headers:{'x-assessor-token':roToken,'content-type':'application/json'},body:JSON.stringify({conversaId:DM,acao:'excluir'})})).status,403);
    assert.equal((await fetch(roOrigin+'/api/v3/pessoal/conversas',{headers:{'x-assessor-token':roToken}})).status,200);
    assert.equal(f.s.politica.regra(DM).atendimento.excluida,false);
  }finally{await new Promise(resolve=>{ro.close(resolve);ro.closeAllConnections();});}
});
