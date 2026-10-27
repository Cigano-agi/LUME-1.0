import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { prepararEsquemaTranscricao } from '../src/transcricao.js';
import { definirPolitica } from '../src/permissao.js';
import { VendasJev } from '../src/vendas/servico.js';
import { avaliarComJev, CRITERIOS_ETAPA, CRITERIOS_TEMPERATURA } from '../src/vendas/jev.js';

const CONVERSA='teste-recorte@s.whatsapp.net';
const OUTRA='outra-conversa@s.whatsapp.net';
const GRUPO='teste-recorte@g.us';
const INICIO=Date.parse('2026-09-25T10:00:00Z');
const hash=valor=>createHash('sha256').update(JSON.stringify(valor)).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const resultado=()=>({temperatura:'quente',etapa:'proposta',confianca:.9,origem:'jev',criterio:'Critério sintético'});
const preparar=(f,fonte_ids,conversa_id=CONVERSA)=>f.service.preparar({conversa_id,...(fonte_ids===undefined?{}:{fonte_ids})});
const enviar=(f,p)=>f.service.avaliar({previa_id:p.id,confirmar:true});
const obter=(f,conversa_id=CONVERSA)=>f.service.obter({conversa_id});
const quantidade=f=>f.db.prepare('SELECT COUNT(*) n FROM lume_vendas_avaliacoes').get().n;

function fixture(t,{avaliar,ler,quantas=3,arquivo=false}={}) {
  const pasta=arquivo?mkdtempSync(join(tmpdir(),'lume-jev-recorte-')):null;
  const caminho=pasta?join(pasta,'teste.sqlite'):':memory:';
  let db,contexto,service,seq=0,agora=INICIO,chamadas=0,leituras=0;
  const enviados=[];
  function abrir() {
    db=abrirBanco(caminho);contexto=new ContextoApp(db);new Desktop(db);prepararEsquemaTranscricao(db);
    service=new VendasJev(db,{agora:()=>new Date(agora),segredos:{ler:async()=>{leituras++;return ler?ler():'credencial-ficticia-sem-validade';}},
      avaliar:async args=>{chamadas++;enviados.push(structuredClone(args.fontes));return avaliar?avaliar(args):resultado();}});
  }
  abrir();
  const f={get db(){return db;},get service(){return service;},get chamadas(){return chamadas;},get leituras(){return leituras;},enviados,
    avancar:ms=>{agora+=ms;},
    reiniciar(){db.close();abrir();},
    inserir(texto='Mensagem comercial sintética.',{conversa=CONVERSA,fromMe=false,quando}={}) {
      const origem='sintetica-'+ ++seq;
      contexto.receber({type:'notify',messages:[{key:{id:origem,remoteJid:conversa,fromMe},
        messageTimestamp:quando??INICIO/1000+seq,message:{conversation:texto}}]});
      return db.prepare('SELECT id FROM eventos WHERE conversa_id=? AND origem_id=?').get(conversa,origem).id;
    }};
  for(let i=0;i<quantas;i++)f.inserir(`Mensagem sintética ${i+1}.`,{fromMe:i%2===0});
  t.after(()=>{db.close();if(pasta)rmSync(pasta,{recursive:true,force:true});});
  return f;
}

test('seleção efetiva: datas/autor intactos, ordem canônica, hash e só IDs escolhidos no adaptador',async t=>{
  const f=fixture(t),p=preparar(f,[3,1]);
  assert.deepEqual(p.fonte_ids,[1,3]);assert.deepEqual(p.fontes.map(x=>x.id),[1,3]);
  assert.equal(p.total,3);assert.equal(p.selecionadas,2);assert.equal(p.apto,true);
  assert.equal(p.assinatura_recorte,hash(p.fontes));assert.equal(p.candidatas.length,3);
  assert.match(p.aviso,/OpenRouter.*TypeSafe/);assert.match(p.aviso,/omitidas.*contexto/);
  const r=await enviar(f,p);
  assert.deepEqual(f.enviados,[p.fontes]);assert.deepEqual(r.fontes,[1,3]);
  assert.equal(r.consentimento.assinatura_recorte,p.assinatura_recorte);
  assert.equal(r.recorte.contexto_omitido,true);assert.equal(r.recorte.inicio_em,p.fontes[0].recebido_em);
  assert.equal(r.recorte.fim_em,p.fontes[1].recebido_em);assert.equal(r.recorte.escopo,'mensagens_selecionadas');
  assert.equal(obter(f).id,r.id);assert.equal(obter(f).desatualizada,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desktop_negocios').get().n,0);
});

test('sem fonte_ids mantém seleção legada e ordem temporal desempata por id',async t=>{
  const f=fixture(t,{quantas:0});
  f.inserir('Primeira',{quando:INICIO/1000+2});f.inserir('Anterior',{quando:INICIO/1000+1});f.inserir('Empate',{quando:INICIO/1000+2});
  const p=preparar(f);assert.deepEqual(p.fonte_ids,[2,1,3]);
  await enviar(f,p);assert.deepEqual(f.enviados[0].map(x=>x.id),[2,1,3]);
});

test('seleção rejeita lista vazia, duplicada, tipo inválido, IDs inseguros e excesso',t=>{
  const f=fixture(t);
  for(const ids of [null,{},'1',[1,'2'],[1,1],[],[0],[-1],[1.2],[NaN],[Infinity],[Number.MAX_SAFE_INTEGER+1],Array.from({length:21},(_,i)=>i+1)])
    assert.throws(()=>preparar(f,ids),{code:'JEV_SELECAO_INVALIDA'});
  assert.equal(f.chamadas,0);assert.equal(f.leituras,0);
});

test('IDs inexistentes, de outro chat, não legíveis e fora das últimas 20 são rejeitados',t=>{
  const f=fixture(t,{quantas:22});
  const deOutro=f.inserir('De outra conversa',{conversa:OUTRA});
  const oculto=f.inserir('Sem leitura');f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(oculto);
  const p=preparar(f);assert.equal(p.total,20);assert.deepEqual(p.fonte_ids,Array.from({length:20},(_,i)=>i+3));
  for(const id of [9999,deOutro,oculto,1,2])assert.throws(()=>preparar(f,[id]),{code:'JEV_SELECAO_INVALIDA'});
  assert.equal(f.chamadas,0);
});

test('fontes de grupo só entram com leitura permitida; revogadas deixam a seleção',t=>{
  const f=fixture(t,{quantas:0});const id=f.inserir('Terceiro do grupo',{conversa:GRUPO});
  assert.throws(()=>preparar(f,[id],GRUPO),{code:'JEV_SEM_FONTES'});
  definirPolitica(f.db,{conversaId:GRUPO,politica:'tudo'});assert.deepEqual(preparar(f,[id],GRUPO).fonte_ids,[id]);
  definirPolitica(f.db,{conversaId:GRUPO,politica:'so-minhas'});
  assert.throws(()=>preparar(f,[id],GRUPO),{code:'JEV_SEM_FONTES'});assert.equal(f.chamadas,0);
});

test('janela acima de 24 KB permite reduzir sem cortar conteúdo; seleção longa não ganha token',async t=>{
  const f=fixture(t,{quantas:0});const grande=f.inserir('á'.repeat(13000)),pequena=f.inserir('Vamos avançar.');
  const p=preparar(f);assert.equal(p.apto,false);assert.equal(p.id,null);assert.equal(p.expira_em,null);
  assert.equal(p.motivo,'JEV_CONTEXTO_LONGO');assert.equal(p.total,2);assert.equal(p.candidatas[0].texto.length,13000);
  assert.equal(preparar(f,[grande]).id,null);
  await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.leituras,0);
  const final=preparar(f,[pequena]);assert.equal(final.apto,true);await enviar(f,final);
  assert.deepEqual(f.enviados[0],final.fontes);assert.equal(f.enviados[0].length,1);
});

test('limite mede state realmente transmitido, incluindo unicode e escapes; 24.000 passa e 24.001 bloqueia',async t=>{
  const choice=(criteria,value)=>({type:'choice',choice:value,confidence:.9,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===value?1:0]))});
  let corpo;
  const f=fixture(t,{quantas:0,avaliar:args=>avaliarComJev({...args,chave:'sk-or-v1-'+'a'.repeat(64),
    fetch:async(_url,options)=>{corpo=JSON.parse(options.body);return Response.json({model:'typesafe/jev-1.14',answers:{
      temperatura:choice(CRITERIOS_TEMPERATURA,'quente'),etapa:choice(CRITERIOS_ETAPA,'proposta')}});}})});
  const id=f.inserir('Prévia 💛 "sim"\n');const inicial=preparar(f);
  const texto=inicial.fontes[0].texto+'x'.repeat(24000-inicial.tamanho_bytes);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(texto,id);
  const exato=preparar(f);assert.equal(exato.tamanho_bytes,24000);assert.equal(exato.apto,true);await enviar(f,exato);
  assert.equal(Buffer.byteLength(JSON.stringify(corpo.state),'utf8'),24000);assert.equal(corpo.state[0].texto,texto);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(texto+'x',id);
  const longo=preparar(f);assert.equal(longo.tamanho_bytes,24001);assert.equal(longo.apto,false);assert.equal(longo.id,null);
});

test('data inválida não produz prévia apta; mensagem sem texto nunca é candidata',t=>{
  const f=fixture(t);f.db.prepare("UPDATE eventos SET recebido_em='data-invalida' WHERE id=1").run();
  f.db.prepare("UPDATE eventos SET texto='   ' WHERE id=2").run();
  const p=preparar(f);assert.equal(p.total,2);assert.equal(p.apto,false);assert.equal(p.motivo,'JEV_CONTEXTO_INVALIDO');
  assert.equal(preparar(f,[3]).apto,true);assert.throws(()=>preparar(f,[2]),{code:'JEV_SELECAO_INVALIDA'});
});

test('sem consentimento literal não acessa cofre nem adaptador e preserva prévia para confirmar',async t=>{
  const f=fixture(t),p=preparar(f,[2]);
  for(const confirmar of [undefined,null,false,1,'true'])await assert.rejects(f.service.avaliar({previa_id:p.id,confirmar}),{code:'JEV_SEM_CONSENTIMENTO'});
  assert.equal(f.leituras,0);assert.equal(f.chamadas,0);await enviar(f,p);assert.equal(f.chamadas,1);
  await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,1);
});

test('nova seleção invalida token anterior e não reexpande o recorte no envio',async t=>{
  const f=fixture(t),anterior=preparar(f),final=preparar(f,[1]);
  await assert.rejects(enviar(f,anterior),{code:'JEV_FONTE_ALTERADA'});await enviar(f,final);
  assert.deepEqual(f.enviados[0].map(x=>x.id),[1]);
});

test('alterar objetos da prévia retornada não altera autorização nem payload',async t=>{
  const f=fixture(t),p=preparar(f,[1]),original=structuredClone(p.fontes);
  p.fontes[0].texto='Texto adulterado';p.fontes.push(p.candidatas[1]);p.candidatas[0].texto='Outro texto';p.fonte_ids.push(3);
  const r=await enviar(f,p);assert.deepEqual(f.enviados[0],original);assert.deepEqual(r.fontes,[1]);
});

test('prévia expira exatamente aos cinco minutos',async t=>{
  const f=fixture(t),p=preparar(f);f.avancar(300000);
  await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.leituras,0);assert.equal(f.chamadas,0);
});

for(const momento of ['cofre','adaptador'])test(`falha em ${momento} consome autorização sem retry externo automático`,async t=>{
  const f=fixture(t,momento==='cofre'?{ler:async()=>{throw Error('Falha fictícia');}}:{avaliar:async()=>{throw Error('Falha fictícia');}});
  const p=preparar(f);await assert.rejects(enviar(f,p),/Falha fictícia/);
  await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,momento==='cofre'?0:1);assert.equal(quantidade(f),0);
});

test('nova mensagem entre prévia e confirmação bloqueia inclusive subset intacto',async t=>{
  const f=fixture(t),p=preparar(f,[1]);f.inserir('Cancelar tudo.');
  await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,0);assert.equal(f.leituras,0);
});

test('nova mensagem durante leitura do cofre bloqueia antes do adaptador',async t=>{
  let liberar;const f=fixture(t,{ler:()=>new Promise(resolve=>{liberar=resolve;})}),p=preparar(f,[1]);
  const pending=enviar(f,p);assert.equal(typeof liberar,'function');f.inserir('Novo combinado.');liberar('ficticia');
  await assert.rejects(pending,{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,0);assert.equal(quantidade(f),0);
});

test('nova mensagem durante avaliação impede persistência e retorno de classificação tardia',async t=>{
  let liberar;const f=fixture(t,{avaliar:()=>new Promise(resolve=>{liberar=resolve;})}),p=preparar(f,[1]);
  const pending=enviar(f,p);await tick();f.inserir('Sem interesse agora.');liberar(resultado());
  await assert.rejects(pending,{code:'JEV_FONTE_ALTERADA'});assert.equal(quantidade(f),0);
});

test('revogar e restaurar permissão durante cofre é detectado mesmo com textos idênticos',async t=>{
  let liberar;const f=fixture(t,{ler:()=>new Promise(resolve=>{liberar=resolve;})}),p=preparar(f,[1]);
  const pending=enviar(f,p);
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=1").run();
  f.db.prepare("UPDATE eventos SET permissao='minha' WHERE id=1").run();liberar('ficticia');
  await assert.rejects(pending,{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,0);
});

test('revogar e restaurar política durante avaliação descarta resultado mesmo com fontes iguais',async t=>{
  let liberar;const f=fixture(t,{quantas:0,avaliar:()=>new Promise(resolve=>{liberar=resolve;})});
  const id=f.inserir('Pode enviar a proposta.',{conversa:GRUPO});definirPolitica(f.db,{conversaId:GRUPO,politica:'tudo'});
  const p=preparar(f,[id],GRUPO),pending=enviar(f,p);await tick();
  definirPolitica(f.db,{conversaId:GRUPO,politica:'so-minhas'});definirPolitica(f.db,{conversaId:GRUPO,politica:'tudo'});liberar(resultado());
  await assert.rejects(pending,{code:'JEV_FONTE_ALTERADA'});assert.equal(quantidade(f),0);
});

test('troca e restauração de texto também invalidam prévia',async t=>{
  const f=fixture(t),p=preparar(f,[1]),texto=p.fontes[0].texto;
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=1').run('Texto corrigido');f.db.prepare('UPDATE eventos SET texto=? WHERE id=1').run(texto);
  await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,0);
});

test('atividade em outra conversa e escrita sem mudança não invalidam seleção',async t=>{
  const f=fixture(t),p=preparar(f,[1]);f.inserir('Outro cliente',{conversa:OUTRA});
  f.db.exec('UPDATE eventos SET texto=texto,permissao=permissao WHERE id=1');
  await enviar(f,p);assert.equal(obter(f).desatualizada,false);
});

test('obter mantém subset válido após reinício SQLite real e token não sobrevive ao processo',async t=>{
  const f=fixture(t,{arquivo:true}),p=preparar(f,[1,3]);const r=await enviar(f,p);const naoEnviado=preparar(f,[2]);
  f.reiniciar();assert.equal(obter(f).id,r.id);assert.equal(obter(f).desatualizada,false);assert.deepEqual(obter(f).fontes,[1,3]);
  await assert.rejects(enviar(f,naoEnviado),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,1);
});

test('obter oculta classificação após nova mensagem e não atribui o resultado à conversa inteira',async t=>{
  const f=fixture(t),r=await enviar(f,preparar(f,[1]));assert.equal(r.recorte.contexto_omitido,true);
  f.inserir('A situação mudou.');const obsoleto=obter(f);
  assert.equal(obsoleto.desatualizada,true);assert.equal(obsoleto.temperatura,'insuficiente');assert.deepEqual(obsoleto.fontes,[]);
  assert.equal(Object.hasOwn(obsoleto,'confianca'),false);assert.equal(Object.hasOwn(obsoleto,'consentimento'),false);
  assert.equal(obsoleto.avaliado_em,r.avaliado_em);assert.match(obsoleto.aviso,/datas.*omitidas/);
});

test('obter verifica a seleção persistida e detecta revogação fora da janela recente',async t=>{
  const f=fixture(t),r=await enviar(f,preparar(f,[1]));
  for(let i=0;i<21;i++)f.inserir('Mensagem posterior.');
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=1").run();
  assert.equal(obter(f).motivo,'fontes_alteradas');assert.equal(quantidade(f),1);
  assert.notEqual(obter(f).temperatura,r.temperatura);
});

test('fonte escolhida apagada remove avaliações e bloqueia prévia pendente',async t=>{
  const f=fixture(t);await enviar(f,preparar(f,[1]));const p=preparar(f,[1]);f.db.prepare('DELETE FROM eventos WHERE id=1').run();
  assert.equal(quantidade(f),0);assert.equal(obter(f),null);await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});
});

test('revogar/restaurar depois de avaliar permanece desatualizado após reinício',async t=>{
  const f=fixture(t,{arquivo:true});await enviar(f,preparar(f,[1]));
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=1").run();f.db.prepare("UPDATE eventos SET permissao='minha' WHERE id=1").run();
  f.reiniciar();assert.equal(obter(f).desatualizada,true);assert.equal(obter(f).temperatura,'insuficiente');
});

test('procedência compartilhada revogada/restaurada não restaura consentimento',async t=>{
  const f=fixture(t,{quantas:0});const id=f.inserir('Contribuição sintética',{conversa:GRUPO});
  f.db.exec("INSERT INTO f10_projetos VALUES('teste','Teste','2026-09-25');INSERT INTO f10_origens VALUES('ficticia','Pessoa fictícia','Máquina fictícia','chave pública fictícia')");
  const inserir=()=>f.db.prepare("INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em) VALUES(?,'ficticia','pacote','teste','2026-09-25','2026-09-25')").run(id);
  inserir();const p=preparar(f,[id],GRUPO);f.db.prepare('DELETE FROM f10_procedencias WHERE evento_id=?').run(id);inserir();
  await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,0);
});

test('mudança/restauro de transcrição é detectada e nunca envia texto substituto',async t=>{
  const f=fixture(t,{quantas:0});const id=f.inserir('<anexado: audio.opus>');
  const e=f.db.prepare('SELECT origem_id FROM eventos WHERE id=?').get(id);
  f.db.prepare("INSERT INTO transcricoes(conversa_id,origem_id,texto,estado,criado_em) VALUES(?,?,'Texto transcrito','transcrito','2026-09-25')").run(CONVERSA,e.origem_id);
  const p=preparar(f,[id]);assert.equal(p.fontes[0].texto,'Texto transcrito');
  f.db.exec("UPDATE transcricoes SET texto='Texto alterado';UPDATE transcricoes SET texto='Texto transcrito'");
  await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,0);
});

test('tabela de transcrição criada depois do serviço ganha revisão antes da prévia',async t=>{
  const db=abrirBanco();t.after(()=>db.close());const contexto=new ContextoApp(db);new Desktop(db);
  let chamadas=0;const service=new VendasJev(db,{segredos:{ler:async()=>''},avaliar:async()=>{chamadas++;return resultado();}});
  prepararEsquemaTranscricao(db);
  contexto.receber({type:'notify',messages:[{key:{id:'audio-tardio',remoteJid:CONVERSA,fromMe:false},messageTimestamp:INICIO/1000,message:{conversation:'<anexado: audio.opus>'}}]});
  db.prepare("INSERT INTO transcricoes(conversa_id,origem_id,texto,estado,criado_em) VALUES(?,'audio-tardio','Original','transcrito','2026-09-25')").run(CONVERSA);
  const p=service.preparar({conversa_id:CONVERSA});
  db.exec("UPDATE transcricoes SET texto='Mudança';UPDATE transcricoes SET texto='Original'");
  await assert.rejects(service.avaliar({previa_id:p.id,confirmar:true}),{code:'JEV_FONTE_ALTERADA'});assert.equal(chamadas,0);
});

test('correção manual local funciona sem cofre, sem limite externo e persiste no reinício',t=>{
  const f=fixture(t,{arquivo:true,quantas:0,ler:()=>assert.fail('Não ler cofre')});f.inserir('a'.repeat(25000));
  assert.equal(preparar(f).apto,false);
  const r=f.service.corrigir({conversa_id:CONVERSA,temperatura:'morno',etapa:'interesse',confirmar:true});
  assert.equal(r.origem,'manual');assert.equal(r.confianca,null);assert.equal(r.consentimento,undefined);
  f.reiniciar();assert.equal(obter(f).id,r.id);assert.equal(f.chamadas,0);assert.equal(f.leituras,0);
});

test('correção manual cancela avaliação em voo sem sobrescrever a decisão local',async t=>{
  let liberar,signal;const f=fixture(t,{avaliar:args=>{signal=args.signal;return new Promise(resolve=>{liberar=resolve;});}});
  const pending=enviar(f,preparar(f,[1]));await tick();
  const manual=f.service.corrigir({conversa_id:CONVERSA,temperatura:'frio',etapa:'encerrado',confirmar:true});
  assert.equal(signal.aborted,true);liberar(resultado());await assert.rejects(pending,{code:'JEV_CANCELADO'});
  assert.equal(quantidade(f),1);assert.equal(obter(f).id,manual.id);
});

test('consentimentos concorrentes não iniciam dois envios e remoção cancela retorno tardio',async t=>{
  let liberar,signal;const f=fixture(t,{avaliar:args=>{signal=args.signal;return new Promise(resolve=>{liberar=resolve;});}});
  const p=preparar(f),pending=enviar(f,p);await tick();
  await assert.rejects(enviar(f,p),{code:'JEV_OCUPADO'});assert.equal(f.chamadas,1);
  await f.service.remover();assert.equal(signal.aborted,true);liberar(resultado());await assert.rejects(pending,{code:'JEV_CANCELADO'});assert.equal(quantidade(f),0);
});

test('avaliações legadas válidas continuam legíveis; importadas ficam fechadas mesmo com hash igual',async t=>{
  const f=fixture(t),p=preparar(f),r=await enviar(f,p);
  const antigo={...r};delete antigo.recorte;delete antigo.aviso;
  f.db.prepare('UPDATE lume_vendas_avaliacoes SET resultado=? WHERE id=?').run(JSON.stringify(antigo),r.id);
  // Perfil anterior à migração não possuía revisões; a ausência é null.
  f.db.exec('DELETE FROM lume_vendas_revisoes');assert.equal(obter(f).id,r.id);
  for(const importado of [{...antigo,desatualizada:true},{...antigo,importacao:{consentimento_transferido:false}}]) {
    f.db.prepare('UPDATE lume_vendas_avaliacoes SET resultado=? WHERE id=?').run(JSON.stringify(importado),r.id);
    const leitura=obter(f);assert.equal(leitura.desatualizada,true);assert.equal(leitura.temperatura,'insuficiente');assert.deepEqual(leitura.fontes,[]);
  }
});

test('última fonte excluída remove JID da revisão; recriar mesmo id/texto não restaura prévia',async t=>{
  const f=fixture(t,{quantas:1});const p=preparar(f),original=f.db.prepare('SELECT * FROM eventos WHERE id=1').get();
  const anterior=f.db.prepare('SELECT revisao FROM lume_vendas_revisoes WHERE conversa_id=?').get(CONVERSA).revisao;
  assert.match(anterior,/^[a-f0-9]{64}$/);
  f.db.prepare('DELETE FROM eventos WHERE id=1').run();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_vendas_revisoes').get().n,0);
  definirPolitica(f.db,{conversaId:CONVERSA,politica:'so-minhas'});
  f.db.prepare("INSERT INTO transcricoes(conversa_id,origem_id,texto,estado,criado_em) VALUES(?,?,'Órfã','transcrito','2026-09-25')").run(CONVERSA,original.origem_id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_vendas_revisoes').get().n,0);
  f.db.prepare(`INSERT INTO eventos(${Object.keys(original).join(',')}) VALUES(${Object.keys(original).map(()=>'?').join(',')})`).run(...Object.values(original));
  const nova=f.db.prepare('SELECT revisao FROM lume_vendas_revisoes WHERE conversa_id=?').get(CONVERSA).revisao;
  assert.match(nova,/^[a-f0-9]{64}$/);assert.notEqual(nova,anterior);
  await assert.rejects(enviar(f,p),{code:'JEV_FONTE_ALTERADA'});assert.equal(f.chamadas,0);
});
