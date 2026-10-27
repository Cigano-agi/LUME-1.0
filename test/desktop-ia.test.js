import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { recorte, recuperar } from '../src/recuperacao.js';
import { chamarGemini, conferirResposta } from '../src/gemini-desktop.js';

const agora = () => new Date('2026-09-17T20:00:00Z');
async function setup(t, gerar) {
  const db = abrirBanco(); t.after(() => db.close()); new ContextoApp(db); const desktop = new Desktop(db);
  for (const c of ['grupo-a','grupo-b']) db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(c,c);
  let key = 'chave_sintetica_123456789';
  const segredos = { estado: async () => ({ disponivel: true, configurada: Boolean(key) }), ler: async () => key, gravar: async k => { key = k; }, remover: async () => { key = null; } };
  const calls = [];
  const ia = new DesktopIA(db,{ segredos, agora, gerar: gerar || (async request => {
    calls.push(request); const fonte = JSON.parse(request.pedido.contents[0].parts[0].text).fontes[0];
    return { dados: { insuficiente: false, afirmacoes: [{ texto: 'A proposta está nas fontes.', fonte: fonte.fonte, trecho: fonte.texto }] }, uso: { promptTokenCount: 123, candidatesTokenCount: 25 } };
  }) });
  const inserir = (origem,texto,permissao='minha',conversa='grupo-a',data='2026-09-17T12:00:00Z',projeto=null) => Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,projeto_id) VALUES(?,?,'entrada','texto','{}',?,?,?,?,?)`).run(conversa,origem,texto,data,data.slice(0,10),permissao,projeto).lastInsertRowid);
  const mine = inserir('m1','Proposta orçamento 1200: vou revisar sexta.');
  inserir('secret','Proposta terceiro CONFIDENCIAL','terceiro');
  inserir('unknown','Proposta sem classificação',null);
  inserir('other','Proposta de outro cliente','minha','grupo-b');
  await ia.configurar({ habilitada: true, limiteUSD: 0.50, cienteEnvio: true }); ia.permitir({ conversa:'grupo-a',permitida:true });
  const preparar = extra => ia.preparar({ pergunta:'Qual proposta orçamento?',periodo:'semana',...extra });
  return { db,ia,desktop,inserir,preparar,calls,mine,segredos };
}
test('IA: filtra terceiros, desconhecidos, conversa sem opt-in e nunca envia bruto', async t => {
  const {ia,preparar,calls}=await setup(t); const p=preparar();
  assert.equal(p.fontes.length,1); assert.ok(!JSON.stringify(p).includes('CONFIDENCIAL')); assert.equal(calls.length,0);
  const result=await ia.responder({id:p.id,confirmar:true}); assert.equal(result.afirmacoes.length,1); assert.equal(calls.length,1);
  const prompt=JSON.stringify(calls[0].pedido); assert.ok(!prompt.includes('outro cliente')); assert.ok(!prompt.includes('CONFIDENCIAL')); assert.ok(!prompt.includes('bruto'));
  assert.equal((await ia.estado()).chave,undefined); assert.ok(!JSON.stringify(await ia.estado()).includes('chave_sintetica'));
});
test('IA: revogação entre prévia e envio, expiração e uso único impedem chamadas', async t => {
  const {ia,preparar,calls}=await setup(t);
  let p=preparar(); ia.permitir({conversa:'grupo-a',permitida:false}); await assert.rejects(ia.responder({id:p.id,confirmar:true}),/Prévia/);
  ia.permitir({conversa:'grupo-a',permitida:true}); p=preparar(); ia.agora=()=>new Date('2026-09-17T20:06:00Z'); await assert.rejects(ia.responder({id:p.id,confirmar:true}),/expirou/);
  ia.agora=agora; p=preparar(); await ia.responder({id:p.id,confirmar:true}); await assert.rejects(ia.responder({id:p.id,confirmar:true}),/Prévia/); assert.equal(calls.length,1);
});
test('IA: redução de leitura e exclusão/mudança de fonte invalidam prévia', async t => {
  const {db,ia,desktop,preparar,mine,calls}=await setup(t);
  desktop.politica({conversa:'grupo-a',politica:'tudo'}); let p=preparar(); assert.equal(p.fontes.length,2);
  assert.ok(!p.fontes.some(f=>f.permissao===null));
  desktop.politica({conversa:'grupo-a',politica:'so-minhas'}); await assert.rejects(ia.responder({id:p.id,confirmar:true}),/revogada/);
  p=preparar(); db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Mudança de texto',mine); await assert.rejects(ia.responder({id:p.id,confirmar:true}),/mudou/); assert.equal(calls.length,0);
});
test('IA: revogação durante a rede cancela e suprime resposta', async t => {
  let release,signal;
  const f=await setup(t, async req=>{ signal=req.signal; await new Promise(r=>release=r); return { dados:{insuficiente:false,afirmacoes:[{texto:'Resultado',fonte:'E1',trecho:'Proposta orçamento 1200: vou revisar sexta.'}]} }; });
  const p=f.preparar(), promise=f.ia.responder({id:p.id,confirmar:true});
  await new Promise(r=>setImmediate(r)); assert.ok(release); f.ia.permitir({conversa:'grupo-a',permitida:false}); assert.equal(signal.aborted,true); release();
  await assert.rejects(promise,/permissão/); assert.equal(f.db.prepare('SELECT estado FROM desktop_ia_gastos').get().estado,'incerto'); assert.ok(f.ia.gasto()>0);
});
test('IA: orçamento atômico impede dois pedidos; reserva persiste em nova instância', async t => {
  const {db,ia,preparar,calls,segredos}=await setup(t); const a=preparar(); const micros=Math.round(a.reservaUSD*1e6);
  await ia.configurar({habilitada:true,limiteUSD:(micros+1)/1e6,cienteEnvio:true});
  const b=preparar(),c=preparar(); const r=await Promise.allSettled([ia.responder({id:b.id,confirmar:true}),ia.responder({id:c.id,confirmar:true})]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1); assert.equal(calls.length,1);
  const restart=new DesktopIA(db,{segredos,agora}); assert.equal(restart.gasto(),micros);
  assert.throws(()=>restart.preparar({pergunta:'proposta',periodo:'semana'}),/limite/);
});
test('IA: falha não reenvia nem devolve crédito incerto; chave removida desativa', async t => {
  let count=0;const {ia,preparar}=await setup(t,async()=>{count++;throw new Error('Indisponível');}); const p=preparar();
  await assert.rejects(ia.responder({id:p.id,confirmar:true}),/Indisponível/); assert.equal(count,1); assert.ok(ia.gasto()>0);
  await ia.removerChave(); assert.equal((await ia.estado()).habilitada,false); assert.equal((await ia.estado()).chaveConfigurada,false);
});
test('IA: fonte inventada ou trecho ausente é recusado; abstenção não atribui fontes',()=>{
  const fontes=[{fonte:'E1',texto:'Uma proposta ainda não aprovada.'}];
  assert.throws(()=>conferirResposta({insuficiente:false,afirmacoes:[{texto:'Aprovada',fonte:'E2',trecho:'Uma proposta'}]},fontes),/conferir/);
  assert.throws(()=>conferirResposta({insuficiente:false,afirmacoes:[{texto:'Aprovada',fonte:'E1',trecho:'Está aprovada sim'}]},fontes),/conferir/);
  assert.deepEqual(conferirResposta({insuficiente:true,afirmacoes:[]},fontes).afirmacoes,[]);
});
test('recuperação: período em Brasília, filtro de projeto, acentos e manutenção após edição/exclusão',async t=>{
  const {db,ia,inserir,preparar}=await setup(t);
  assert.equal(recorte({pergunta:'hoje',periodo:'hoje'},new Date('2026-09-18T01:00:00Z')).desde,'2026-09-17');
  assert.equal(recorte({pergunta:'semana',periodo:'semana'},agora()).desde,'2026-09-14');
  db.prepare('INSERT INTO projetos VALUES(?,?,?,?,?)').run('p1','cliente','Projeto','/tmp','2026-09-17');
  const id=inserir('projeto','Proposta única projeto limão','minha','grupo-a','2026-09-17T10:00:00Z','p1');
  assert.equal(preparar({projeto:'p1'}).fontes.length,1);
  assert.equal(recuperar(db,recorte({pergunta:'limao',periodo:'tudo'},agora()))[0].id,id);
  db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte editada outra palavra',id);
  assert.equal(ia.preparar({pergunta:'limao',periodo:'tudo'}).insuficiente,true);
  db.prepare('DELETE FROM eventos WHERE id=?').run(id);
  assert.equal(ia.preparar({pergunta:'editada',periodo:'tudo'}).insuficiente,true);
  inserir('velha','Orçamento passado','minha','grupo-a','2026-08-01T12:00:00Z');
  assert.ok(!preparar().fontes.some(f=>f.origem_id==='velha'));
});
test('Gemini: endpoint fixo, sem chave em URL e sem ferramentas/fallback; erros não ecoam segredo',async()=>{
  const chave='chave_sintetica_123456789';let count=0;
  const result=await chamarGemini({chave,pedido:{contents:[]},fetchFn:async(url,opts)=>{count++;assert.ok(url.endsWith('gemini-3.1-flash-lite:generateContent'));assert.ok(!url.includes(chave));assert.equal(opts.headers['x-goog-api-key'],chave);return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"insuficiente":true,"afirmacoes":[]}' }]}}]}));}});
  assert.equal(count,1); assert.equal(result.dados.insuficiente,true);
  await assert.rejects(chamarGemini({chave,pedido:{},fetchFn:async()=>new Response(chave,{status:403})}),e=>!e.message.includes(chave));
});
test('IA: sem opt-in não prepara; configuração sem aceite e tabela vencida falham fechadas',async t=>{
  const {ia,preparar,calls}=await setup(t); ia.permitir({conversa:'grupo-a',permitida:false}); assert.equal(preparar().insuficiente,true); assert.equal(calls.length,0);
  await assert.rejects(ia.configurar({habilitada:true,limiteUSD:1}),/Confirme/);
  ia.agora=()=>new Date('2027-01-01T12:00:00Z'); assert.throws(()=>preparar(),/preços/);
});
