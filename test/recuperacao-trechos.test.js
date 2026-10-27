import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { recorte, recuperar } from '../src/recuperacao.js';

const now=()=>new Date('2026-09-18T15:00:00Z');
function fixture(t) {
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);new Desktop(db);
  const calls=[];
  const ia=new DesktopIA(db,{agora:now,segredos:{ler:async()=> 'synthetic-key'},gerar:async req=>{calls.push(req);return {dados:{insuficiente:true,afirmacoes:[]}};}});
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('teste','Teste');
  db.prepare('UPDATE desktop_ia_config SET habilitada=1,limite_micros=500000').run();
  ia.permitir({conversa:'teste',permitida:true});
  const insert=(id,text,permission='minha')=>db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('teste',?,'entrada','texto','{}',?,'2026-09-18T12:00:00Z','2026-09-18',?)`).run(id,text,permission);
  return {db,ia,calls,insert};
}

test('recuperação: prévia e pedido preservam decisão no fim de transcrição longa',async t=>{
  const {ia,insert,calls}=fixture(t);
  const decision='Decisão: a cláusula de exclusividade foi retirada; a confidencialidade permanece.';
  const text=('Introdução da reunião, com observações gerais sobre o contrato. ').repeat(70)+decision;
  insert('longa',text);insert('privada',decision+' SEGREDO','terceiro');
  const p=ia.preparar({pergunta:'A cláusula de exclusividade continua no contrato?',periodo:'hoje'});
  assert.equal(p.fontes.length,1);
  assert.ok(p.fontes[0].texto.includes(decision));
  assert.ok(text.includes(p.fontes[0].texto));assert.ok(p.fontes[0].texto.length<=1800);assert.equal(p.fontes[0].truncada,true);
  await ia.responder({id:p.id,confirmar:true});
  const sent=JSON.parse(calls[0].pedido.contents[0].parts[0].text).fontes;
  assert.deepEqual(sent,p.fontes);assert.ok(!JSON.stringify(sent).includes('SEGREDO'));
});

test('recuperação: valores com e sem separador de milhar; sem casar outro valor',t=>{
  const {db,insert}=fixture(t);
  insert('formatado','A proposta custa R$ 1.200,00.');
  insert('sem-separador','Valor anterior: 1200 reais.');
  insert('maior','Outra proposta de R$ 12.000,00.');
  insert('parcial','Somente 200 reais.');
  for(const pergunta of ['1200','1.200']) {
    const rows=recuperar(db,recorte({pergunta,periodo:'hoje'},now()));
    assert.deepEqual(new Set(rows.map(r=>r.origem_id)),new Set(['formatado','sem-separador']));
  }
});

test('recuperação: normalização de acentos conserva trecho literal e posição',t=>{
  const {db,insert}=fixture(t);
  const tail='A cla\u0301usula de exclusividade foi retirada. Confirmação registrada.';
  const text=('🎙️ Contexto inicial sem deliberação. ').repeat(100)+tail;
  insert('unicode',text);
  const [row]=recuperar(db,recorte({pergunta:'clausula exclusividade',periodo:'hoje'},now()));
  assert.ok(row.trecho.includes(tail));assert.equal(text.slice(row.inicio,row.inicio+row.trecho.length),row.trecho);
});

test('recuperação: fonte curta permanece integral e não é indicada como truncada',t=>{
  const {ia,insert}=fixture(t);const text='A decisão sobre o contrato continua pendente.';insert('curta',text);
  const p=ia.preparar({pergunta:'contrato',periodo:'hoje'});
  assert.equal(p.fontes[0].texto,text);assert.equal(p.fontes[0].truncada,false);
});

test('recuperação: mudar texto fora do trecho visível também invalida o envio',async t=>{
  const {db,ia,insert,calls}=fixture(t);
  insert('longa','Contexto introdutório. '.repeat(150)+'A cláusula de exclusividade foi retirada.');
  const p=ia.preparar({pergunta:'cláusula exclusividade',periodo:'hoje'});
  assert.ok(!p.fontes[0].texto.startsWith('Conteúdo modificado'));
  db.prepare("UPDATE eventos SET texto='Conteúdo modificado. ' || texto WHERE origem_id='longa'").run();
  await assert.rejects(ia.responder({id:p.id,confirmar:true}),/mudou/);assert.equal(calls.length,0);
});
