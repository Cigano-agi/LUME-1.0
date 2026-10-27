import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {diaLocal} from '../src/relogio.js';
import {CONTEXTO_PROXIMO} from '../src/contexto-recuperacao.js';
const agora=()=>new Date('2026-09-18T15:00:00Z');
function env(t,{gerar,ler=async()=>'synthetic_key'}={}){
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);new Desktop(db);const calls=[];
  const ia=new DesktopIA(db,{agora,segredos:{ler},gerar:async request=>{calls.push(request);return gerar?gerar(request):{dados:{insuficiente:true,afirmacoes:[]}};}});
  db.exec('UPDATE desktop_ia_config SET habilitada=1,limite_micros=20000000');
  function conversa(id,allowed=true){db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(id,id);ia.permitir({conversa:id,permitida:allowed});}
  conversa('a');let n=0;
  function insert(text,{at='2026-09-18T12:00:00Z',conversa='a',permissao='minha',projeto=null}={}){
    return Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,projeto_id) VALUES(?,?,'entrada','texto','{}',?,?,?,?,?)`).run(conversa,'c'+(++n),text,at,diaLocal(new Date(at)),permissao,projeto).lastInsertRowid);
  }
  const preparar=extra=>ia.preparar({pergunta:'orçamento Neblina',periodo:'hoje',conversa:'a',...extra});
  return {db,ia,calls,insert,conversa,preparar};
}
test('contexto: anterior/posterior permitidos, semente preservada, vizinho privado não escolhe o recorte',t=>{
  const e=env(t);e.conversa('b');e.conversa('sem',false);
  const before=e.insert('Vamos revisar o assunto.',{at:'2026-09-18T11:50:00Z'});
  const seed=e.insert('Orçamento Neblina: proponho R$ 6100.');
  e.insert('SEGREDO quase no mesmo instante.',{at:'2026-09-18T12:00:01Z',permissao:'terceiro'});
  const after=e.insert('Retiro o valor anterior. Aguarde.',{at:'2026-09-18T12:03:00Z'});
  e.insert('Não pertence ao mesmo grupo.',{conversa:'b',at:'2026-09-18T12:00:01Z'});
  e.insert('Orçamento Neblina SEGREDO sem opt-in.',{conversa:'sem'});
  const p=e.preparar();assert.deepEqual(p.fontes.map(f=>f.id),[seed,before,after]);assert.equal(p.contexto.adicionadas,2);
  assert.deepEqual(p.fontes[2].contextoProximo,{fonte:'E'+seed,posicao:'depois',intervaloSegundos:180});assert.ok(!JSON.stringify(p).includes('SEGREDO'));
  assert.equal(p.fontes.some(f=>Object.hasOwn(f,'bruto')),false);
});
test('contexto: respeita projeto e dia local, inclusive virada de meia-noite e offsets equivalentes',t=>{
  const e=env(t);e.db.exec("INSERT INTO projetos VALUES('p','cliente','P','/synthetic','2026-09-18'); INSERT INTO projetos VALUES('outro','cliente','Outro','/synthetic','2026-09-18')");
  const seed=e.insert('Orçamento Neblina ainda não aprovado.',{projeto:'p',at:'2026-09-17T23:58:00-03:00'});
  e.insert('De outro projeto.',{projeto:'outro',at:'2026-09-17T23:58:10-03:00'});
  const same=e.insert('Confirmação pendente.',{projeto:'p',at:'2026-09-18T02:59:00Z'});
  e.insert('Mudou de dia.',{projeto:'p',at:'2026-09-18T00:01:00-03:00'});
  assert.deepEqual(e.preparar({periodo:'ontem',projeto:'p'}).fontes.map(f=>f.id),[seed,same]);
});
test('contexto: F10 autoriza apenas a contribuição e o projeto exatos',t=>{
  const e=env(t),seed=e.insert('Orçamento Neblina em análise.');
  const accepted=e.insert('Aguardaremos a revisão.',{permissao:'compartilhado',at:'2026-09-18T12:01:00Z'});
  e.insert('Contribuição não recebida.',{permissao:'compartilhado',at:'2026-09-18T12:00:10Z'});
  e.db.exec(`INSERT INTO f10_projetos VALUES('p','P','2026-09-18'); INSERT INTO f10_conversas VALUES('p','a'); INSERT INTO f10_origens VALUES('f','Pessoa','máquina','chave'); INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em) VALUES(${accepted},'f','pacote','p','2026-09-18','2026-09-18')`);
  assert.deepEqual(e.preparar({projeto:'p'}).fontes.map(f=>f.id),[seed,accepted]);e.db.exec('DELETE FROM f10_procedencias');
  assert.deepEqual(e.preparar({projeto:'p'}).fontes.map(f=>f.id),[seed]);
});
test('contexto: limite de 15 minutos, primeiras quatro sementes, até oito extras e deduplicação',t=>{
  const e=env(t);for(let i=0;i<12;i++){const c='g'+i;e.conversa(c);e.insert('Antes.',{conversa:c,at:'2026-09-18T11:45:00Z'});e.insert('Orçamento Neblina.',{conversa:c});e.insert('Depois.',{conversa:c,at:'2026-09-18T12:15:00Z'});e.insert('Fora.',{conversa:c,at:'2026-09-18T12:15:01Z'});}
  const p=e.preparar({conversa:''});assert.equal(p.fontes.length,20);assert.equal(p.contexto.adicionadas,CONTEXTO_PROXIMO.maxExtras);assert.equal(new Set(p.fontes.map(f=>f.id)).size,20);assert.ok(!p.fontes.some(f=>f.texto==='Fora.'));
  const q=e.preparar({conversa:'',contextoProximo:false});assert.equal(q.fontes.length,12);assert.equal(q.contexto.ativado,false);assert.ok(p.reservaUSD>q.reservaUSD);
  for(const v of ['sim',1,null])assert.throws(()=>e.preparar({contextoProximo:v}),/mensagens próximas/);
});
test('contexto: fonte extra alterada ou revogada invalida envio; conteúdo completo faz parte do hash',async t=>{
  const e=env(t);e.insert('Orçamento Neblina: minuta.');const extra=e.insert('Texto de contexto '.repeat(200)+'fim',{at:'2026-09-18T12:01:00Z'});
  let p=e.preparar();assert.ok(p.fontes.find(f=>f.id===extra).truncada);e.db.prepare("UPDATE eventos SET texto=texto||' alterado' WHERE id=?").run(extra);
  await assert.rejects(e.ia.responder({id:p.id,confirmar:true}),/mudou/);assert.equal(e.calls.length,0);
  p=e.preparar();e.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(extra);
  await assert.rejects(e.ia.responder({id:p.id,confirmar:true}),/revogada/);assert.equal(e.ia.gasto(),0);
});
test('contexto: nova mensagem próxima antes da confirmação invalida a prévia sem gastar',async t=>{
  const e=env(t);e.insert('Orçamento Neblina: envio autorizado.');const p=e.preparar();
  e.insert('Retiro a autorização.',{at:'2026-09-18T12:00:02Z'});
  await assert.rejects(e.ia.responder({id:p.id,confirmar:true}),/próximas mudaram/);assert.equal(e.calls.length,0);assert.equal(e.ia.gasto(),0);
  assert.equal(e.preparar().contexto.adicionadas,1);
});
test('contexto: inserção privada não invalida nem é enviada; pedido contém exatamente a prévia confirmada',async t=>{
  const e=env(t);e.insert('Orçamento Neblina: aguardar.');e.insert('Ainda sem confirmação.',{at:'2026-09-18T12:01:00Z'});const p=e.preparar();
  e.insert('SEGREDO não pode interferir.',{permissao:'terceiro',at:'2026-09-18T12:00:01Z'});
  const answer=await e.ia.responder({id:p.id,confirmar:true});assert.equal(answer.insuficiente,true);assert.deepEqual(answer.afirmacoes,[]);
  assert.deepEqual(JSON.parse(e.calls[0].pedido.contents[0].parts[0].text).fontes,p.fontes);assert.ok(!JSON.stringify(e.calls).includes('SEGREDO'));assert.equal(e.calls[0].pedido.tools,undefined);
});
test('contexto: nova evidência durante a chamada impede aplicar resultado e mantém reserva',async t=>{
  let entered,finish;const started=new Promise(r=>entered=r),held=new Promise(r=>finish=r);
  const e=env(t,{gerar:async()=>{entered();await held;return {dados:{insuficiente:true,afirmacoes:[]}};}});
  e.insert('Orçamento Neblina: conclusão anterior.');const p=e.preparar(),response=e.ia.responder({id:p.id,confirmar:true});await started;
  e.insert('Ainda falta uma conferência.',{at:'2026-09-18T12:01:00Z'});finish();
  await assert.rejects(response,/próximas mudaram/);assert.ok(e.ia.gasto()>0);assert.equal(e.db.prepare('SELECT estado FROM desktop_ia_gastos').get().estado,'incerto');
});
test('contexto: insuficiência local faz zero chamadas e não reserva orçamento; sem fonte não amplia',t=>{
  const e=env(t);e.insert('Sem registro do assunto procurado.');const p=e.preparar();assert.equal(p.insuficiente,true);assert.deepEqual(p.fontes,[]);assert.equal(e.calls.length,0);assert.equal(e.ia.previas.size,0);assert.equal(e.ia.gasto(),0);
});
test('consulta: retirar conversa do projeto invalida até prévia sem extras, mesmo sem mudar o texto',async t=>{
  const e=env(t);e.insert('Orçamento Neblina: conteúdo nativo.');
  e.db.exec("INSERT INTO f10_projetos VALUES('p','P','2026-09-18'); INSERT INTO f10_conversas VALUES('p','a')");
  const p=e.preparar({projeto:'p',contextoProximo:false});assert.equal(p.fontes.length,1);
  e.db.exec('DELETE FROM f10_conversas');await assert.rejects(e.ia.responder({id:p.id,confirmar:true}),/recorte de fontes mudou/);assert.equal(e.calls.length,0);assert.equal(e.ia.gasto(),0);
});
