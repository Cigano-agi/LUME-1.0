import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';

test('lote persiste, deduplica e permite recuperar texto sem autorizar envio', () => {
  const db = abrirBanco(); const app = new ContextoApp(db);
  const lote = {type:'notify',messages:[{key:{remoteJid:'a@s.whatsapp.net',id:'1'},pushName:'Ana',message:{conversation:'Contrato especial'},messageTimestamp:1788794100}]};
  assert.equal(app.receber(lote).novas,1);
  assert.equal(app.receber(lote).novas,0);
  assert.equal(app.conversas('especial')[0].nome,'Ana');
  assert.equal(app.mensagens('a@s.whatsapp.net').mensagens[0].texto,'Contrato especial');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM autorizacoes').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM saidas').get().n,0);
  db.close();
});
test('paginação, busca literal, conversa isolada e notas persistidas', () => {
  const db = abrirBanco(); const app = new ContextoApp(db);
  for(let i=0;i<65;i++) app.receber({messages:[{key:{remoteJid:'a@s.whatsapp.net',id:String(i)},message:{conversation:'texto '+i}}]});
  app.receber({messages:[{key:{remoteJid:'b@g.us',id:'1'},message:{conversation:'outro'}}]});
  const page=app.mensagens('a@s.whatsapp.net');
  assert.equal(page.mensagens.length,50); assert.ok(page.proximoAntes);
  assert.equal(app.mensagens('a@s.whatsapp.net',{antes:page.proximoAntes}).mensagens.length,15);
  assert.equal(app.conversas('%').length,0);
  const nota=app.nota({texto:'Contexto manual',titulo:'Briefing'});
  assert.ok(nota.id); assert.equal(app.conversas('Briefing').length,1);
  assert.equal(app.estado().total,67); assert.equal(app.estado().notas,1);
  assert.throws(()=>app.nota({texto:'  '})); db.close();
});
test('consulta legada não devolve nota nem fonte revogada',()=>{
  const db=abrirBanco(),app=new ContextoApp(db);
  const fonte=app.nota({texto:'MARCADOR_REVOGADO',titulo:'Fonte antiga'});
  const derivada=app.nota({texto:'MARCADOR_DERIVADO',titulo:'Resumo antigo',fontes:[fonte.id]});
  const origem=db.prepare('SELECT conversa_id FROM eventos WHERE id=?').get(fonte.id).conversa_id;
  const destino=db.prepare('SELECT conversa_id FROM eventos WHERE id=?').get(derivada.id).conversa_id;
  db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(fonte.id);
  assert.deepEqual(app.mensagens(origem).mensagens,[]);
  assert.deepEqual(app.mensagens(destino).mensagens,[]);
  assert.deepEqual(app.conversas('MARCADOR_REVOGADO'),[]);
  assert.deepEqual(app.conversas('Resumo antigo'),[]);
  db.close();
});
test('mensagem encapsulada e bigint persistem; mensagem inválida fica durável sem perder vizinhas',()=>{
  const db=abrirBanco(); const app=new ContextoApp(db);
  app.receber({messages:[{key:{remoteJid:'a@s.whatsapp.net',id:'wrap'},messageTimestamp:1788794100n,message:{ephemeralMessage:{message:{conversation:'Encapsulada'}}}}]});
  assert.equal(app.mensagens('a@s.whatsapp.net').mensagens[0].texto,'Encapsulada');
  const r=app.receber({messages:[{key:{remoteJid:'a',id:'ok'},message:{conversation:'ok'}},{key:{remoteJid:'a',id:'bad'},message:{conversation:'bad'},messageTimestamp:'invalid'}]});
  assert.equal(r.falhas,1);assert.equal(app.estado().total,2);
  assert.equal(app.pendencias().ingestao,1);
  assert.match(db.prepare('SELECT bruto FROM falhas_ingestao').get().bruto,/bad/);db.close();
});
test('histórico recebido depois não esconde mensagem recente e cursor não cruza conversas',()=>{
  const db=abrirBanco();const app=new ContextoApp(db);
  app.receber({messages:[{key:{remoteJid:'a',id:'agora'},messageTimestamp:1788794100,message:{conversation:'recente'}}]});
  for(let i=0;i<60;i++)app.receber({messages:[{key:{remoteJid:'a',id:String(i)},messageTimestamp:1788794000+i,message:{conversation:'antigo'}}]});
  const page=app.mensagens('a');assert.equal(page.mensagens.at(-1).texto,'recente');
  assert.equal(app.mensagens('a',{antes:page.proximoAntes}).mensagens.length,11);
  assert.equal(app.mensagens('b',{antes:page.proximoAntes}).mensagens.length,0);db.close();
});
test('sincronização de grupos persiste metadados, participantes, administradores e atualiza conversas', () => {
  const db = abrirBanco(); const app = new ContextoApp(db);
  const grupos = [
    {
      id: '120363000@g.us',
      subject: 'Projeto Alfa Core',
      desc: 'Diretrizes e entregas do Alfa',
      owner: '5511999990000@s.whatsapp.net',
      creation: 1788790000,
      participants: [
        { id: '5511999990000@s.whatsapp.net', admin: 'superadmin' },
        { id: '5511999991111@s.whatsapp.net', admin: 'admin' },
        { id: '5511999992222@s.whatsapp.net', admin: null }
      ]
    }
  ];
  const r = app.salvarGrupos(grupos);
  assert.equal(r.atualizados, 1);
  assert.equal(app.conversas('Alfa')[0].nome, 'Projeto Alfa Core');
  const lista = app.grupos('Alfa');
  assert.equal(lista.length, 1);
  assert.equal(lista[0].nome, 'Projeto Alfa Core');
  assert.equal(lista[0].tamanho, 3);
  assert.equal(lista[0].admins.length, 2);
  const detalhe = app.grupo('120363000@g.us');
  assert.equal(detalhe.nome, 'Projeto Alfa Core');
  assert.equal(detalhe.descricao, 'Diretrizes e entregas do Alfa');
  assert.equal(detalhe.participantes[0].papel, 'superadmin');
  assert.equal(detalhe.participantes[1].papel, 'admin');
  assert.equal(detalhe.participantes[2].papel, 'membro');
  db.close();
});
test('atualização parcial de grupo preserva dados e aceita alterações sem subject',()=>{
 const db=abrirBanco(); const app=new ContextoApp(db);
 app.salvarGrupos([{id:'g@g.us',subject:'Grupo',desc:'Descrição',owner:'dono',creation:1788790000,participants:[{id:'a',admin:'admin'}],restrict:true}]);
 app.salvarGrupos([{id:'g@g.us',subject:'Novo'}]);
 assert.equal(app.grupo('g@g.us').descricao,'Descrição');assert.equal(app.grupo('g@g.us').tamanho,1);assert.equal(app.grupo('g@g.us').restrito,1);
 app.salvarGrupos([{id:'g@g.us',desc:'Atualizada',restrict:false}]);
 assert.equal(app.grupo('g@g.us').descricao,'Atualizada');assert.equal(app.grupo('g@g.us').restrito,0);db.close();
});
