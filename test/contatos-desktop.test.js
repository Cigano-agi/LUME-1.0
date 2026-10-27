import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {registrarPessoa,fundirPessoas} from '../src/pessoas.js';
import {NegociosDesktop} from '../src/negocios-desktop.js';
import {prepararEsquemaTranscricao,gravarTranscricao} from '../src/transcricao.js';

function env(t){
  const db=abrirBanco();t.after(()=>db.close());const e={db,...perfilGrafo(db)};e.n=new NegociosDesktop(db);
  e.pessoa=(id,nome='Ana Silva')=>{registrarPessoa(db,{identificador:id,nomeCru:nome});return db.prepare('SELECT pessoa_id FROM pessoa_identificadores WHERE identificador=?').get(id).pessoa_id;};
  e.propria=(c)=>{const id=e.evento(c,'eu');db.prepare('UPDATE eventos SET autor_e_dono=1 WHERE id=?').run(id);return id;};
  e.negocio=(fonte,titulo='Site de teste')=>e.n.salvar({previa:e.n.preparar({fonte}).id,confirmar:true,titulo,etapa:'proposta'});
  e.ficha=(contato,opcoes={})=>e.desktop.contatoDetalhe({contato,...opcoes});
  return e;
}

test('contatos: nomes e prefixos iguais não unem identidades',t=>{
  const e=env(t);e.conversa('grupo@g.us');
  for(const id of ['5511','5511@lid','5511@s.whatsapp.net']){e.pessoa(id);e.evento('grupo@g.us',id);}
  const lista=e.desktop.contatos();assert.equal(lista.pagina.total,3);assert.equal(new Set(lista.contatos.map(c=>c.id)).size,3);
  for(const c of lista.contatos){const d=e.ficha(c.id);assert.equal(d.identificadores.length,1);assert.equal(d.paginaMensagens.total,1);}
});

test('contatos: vínculos ativos e cadeias reúnem fontes sem duplicar a DM',t=>{
  const e=env(t),a=e.pessoa('111@lid','Ana antiga'),b=e.pessoa('222@s.whatsapp.net','Ana intermediária'),c=e.pessoa('333@lid','Ana Silva');
  fundirPessoas(e.db,{deId:a,paraId:b});fundirPessoas(e.db,{deId:b,paraId:c});
  e.conversa('111@lid');e.conversa('grupo@g.us');e.evento('111@lid','111@lid');e.propria('111@lid');e.evento('grupo@g.us','222@s.whatsapp.net');
  const lista=e.desktop.contatos();assert.equal(lista.pagina.total,1);assert.equal(lista.contatos[0].id,'p:'+c);assert.equal(lista.contatos[0].mensagens,3);
  const d=e.ficha('p:'+c);assert.equal(d.nome,'Ana Silva');assert.equal(d.paginaMensagens.total,3);assert.equal(d.mensagens.length,3);assert.equal(d.conversas.length,2);
  assert.deepEqual(d.identificadores,['111@lid','222@s.whatsapp.net']);assert.ok(!JSON.stringify(d).includes('333@lid'));
  e.db.prepare("UPDATE pessoa_identificadores SET ativo=0 WHERE identificador='222@s.whatsapp.net'").run();assert.equal(e.desktop.contatos().pagina.total,2);
});

test('contatos: ciclos ou destino inválido mantêm cada identificador separado',t=>{
  const e=env(t),a=e.pessoa('a'),b=e.pessoa('b');e.conversa('g@g.us');e.evento('g@g.us','a');e.evento('g@g.us','b');
  e.db.prepare('UPDATE pessoas SET fundida_em=? WHERE id=?').run(b,a);e.db.prepare('UPDATE pessoas SET fundida_em=? WHERE id=?').run(a,b);
  const contatos=e.desktop.contatos().contatos;assert.equal(contatos.length,2);assert.ok(contatos.every(c=>c.id.startsWith('a:')));
  e.db.exec('PRAGMA foreign_keys=OFF');e.db.prepare('UPDATE pessoas SET fundida_em=999 WHERE id=?').run(b);
  assert.equal(e.desktop.contatos().pagina.total,2);
});

test('contatos: destinatário da primeira mensagem própria aparece, dono e grupo não',t=>{
  const e=env(t);e.conversa('cliente@lid','Maria Souza');e.conversa('grupo@g.us','Equipe');e.conversa('eu@lid','Eu');
  e.propria('cliente@lid');e.propria('grupo@g.us');e.propria('eu@lid');
  const me=e.pessoa('eu','Dono');registrarPessoa(e.db,{identificador:'eu@lid',nomeCru:'Dono'});const alias=e.db.prepare("SELECT pessoa_id FROM pessoa_identificadores WHERE identificador='eu@lid'").get().pessoa_id;
  fundirPessoas(e.db,{deId:alias,paraId:me});
  const contatos=e.desktop.contatos().contatos;assert.equal(contatos.length,1);assert.equal(contatos[0].nome,'Maria Souza');
  const d=e.ficha(contatos[0].id);assert.deepEqual(d.identificadores,['cliente@lid']);assert.equal(d.paginaMensagens.total,1);assert.equal(d.mensagens[0].autor_e_dono,1);
});

test('contatos: captura real distingue conversa consigo e primeira mensagem para cliente',t=>{
  const e=env(t),mensagem=(id,remoteJid,texto)=>({key:{id,remoteJid,fromMe:true},messageTimestamp:1789718400,message:{conversation:texto}});
  e.contexto.receber({type:'notify',donoJids:['5511999999999@s.whatsapp.net','123456@lid'],messages:[
    mensagem('self','123456@lid','Lembrete para mim'),mensagem('cliente','cliente@lid','Olá, seguem os detalhes')
  ]});
  const contatos=e.desktop.contatos();assert.equal(contatos.pagina.total,1);const d=e.ficha(contatos.contatos[0].id);
  assert.deepEqual(d.identificadores,['cliente@lid']);assert.equal(d.mensagens[0].texto,'Olá, seguem os detalhes');
  assert.equal(e.db.prepare("SELECT autor_id FROM eventos WHERE origem_id='self'").get().autor_id,'123456@lid');
  assert.equal(e.db.prepare("SELECT autor_id FROM eventos WHERE origem_id='cliente'").get().autor_id,'5511999999999@s.whatsapp.net');
});

test('contatos: trecho de áudio informa transcrição e sinais do modelo',t=>{
  const e=env(t);prepararEsquemaTranscricao(e.db);e.conversa('ana@lid','Ana');
  const id=e.evento('ana@lid','ana@lid',{tipo:'audio',texto:null});const fonte=e.db.prepare('SELECT conversa_id,origem_id FROM eventos WHERE id=?').get(id);
  gravarTranscricao(e.db,{conversaId:fonte.conversa_id,origemId:fonte.origem_id,textoOriginal:'Transcrição: proposta para sexta'});
  const contato=e.desktop.contatos().contatos[0],mensagem=e.ficha(contato.id).mensagens[0];
  assert.equal(mensagem.tipo,'audio');assert.equal(mensagem.transcricao.estado,'transcrito');assert.match(mensagem.transcricao.sinais[0],/Preâmbulo/);
});

test('contatos: privacidade precede nomes, filtro, identificadores, totais e detalhes',t=>{
  const e=env(t);e.conversa('g@g.us','Visível');e.conversa('s@g.us','GRUPO_SECRETO');
  const a=e.pessoa('ana@lid');const b=e.pessoa('ALIAS_SECRETO');fundirPessoas(e.db,{deId:b,paraId:a});e.pessoa('OCULTO','NOME_SECRETO');
  e.evento('g@g.us','ana@lid',{permissao:'dirigida'});e.evento('s@g.us','ALIAS_SECRETO',{permissao:'terceiro'});e.evento('s@g.us','OCULTO',{permissao:null});
  assert.equal(e.desktop.contatos({q:'secreto'}).pagina.total,0);let d=e.ficha('p:'+a);assert.equal(d.paginaMensagens.total,2);assert.ok(JSON.stringify(d).includes('ALIAS_SECRETO'));assert.ok(!JSON.stringify(d).includes('NOME_SECRETO'));
  e.desktop.politica({conversa:'s@g.us',politica:'tudo'});assert.equal(e.desktop.contatos().pagina.total,1);assert.equal(e.ficha('p:'+a).paginaMensagens.total,2);
  e.desktop.politica({conversa:'s@g.us',politica:'so-minhas'});assert.equal(e.desktop.contatos().pagina.total,1);
  // Terceiro local continua legível no perfil; NULL revoga e não cria contato.
  assert.equal(e.ficha('p:'+a).paginaMensagens.total,2);
  e.db.prepare("UPDATE eventos SET permissao=NULL WHERE conversa_id='s@g.us' AND autor_id='ALIAS_SECRETO'").run();assert.equal(e.desktop.contatos().pagina.total,1);assert.equal(e.ficha('p:'+a).paginaMensagens.total,1);
});

test('contatos: negócios seguem a fonte atual, sem atribuir grupo a cada participante',t=>{
  const e=env(t),a=e.pessoa('ana@lid'),b=e.pessoa('bia@lid');e.conversa('g@g.us');e.conversa('ana@lid');
  const fa=e.evento('g@g.us','ana@lid'),fb=e.evento('g@g.us','bia@lid'),propria=e.propria('g@g.us'),dm=e.propria('ana@lid');
  e.negocio(fa,'Mensagem da Ana');e.negocio(fb,'Mensagem da Bia');e.negocio(propria,'Meu recado no grupo');e.negocio(dm,'Conversa direta');
  let d=e.ficha('p:'+a);assert.equal(d.negocios.length,2);assert.deepEqual(new Set(d.negocios.map(n=>n.evento_id)),new Set([fa,dm]));assert.equal(e.ficha('p:'+b).negocios.length,1);
  e.db.prepare("UPDATE eventos SET texto='Mudou' WHERE id=?").run(fa);d=e.ficha('p:'+a);assert.equal(d.paginaNegocios.total,1);assert.ok(!JSON.stringify(d.negocios).includes('Mensagem da Ana'));
  e.db.prepare('DELETE FROM eventos WHERE id=?').run(dm);assert.equal(e.ficha('p:'+a).paginaNegocios.total,0);
});

test('contatos: F10 exige procedência e revoga fontes e ficha',t=>{
  const e=env(t);e.conversa('g@g.us');const id=e.evento('g@g.us','ana',{permissao:'compartilhado'});e.evento('g@g.us','SEGREDO',{permissao:'compartilhado'});
  e.db.exec(`INSERT INTO f10_projetos VALUES('x','Teste','2026-09-17'); INSERT INTO f10_origens VALUES('f','Teste','m','k');
    INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em) VALUES(${id},'f','p','x','2026-09-17','2026-09-17')`);
  const lista=e.desktop.contatos();assert.equal(lista.pagina.total,1);const key=lista.contatos[0].id;assert.equal(e.ficha(key).mensagens[0].id,id);assert.ok(!JSON.stringify(e.ficha(key)).includes('SEGREDO'));
  e.db.exec('DELETE FROM f10_procedencias');assert.equal(e.desktop.contatos().pagina.total,0);assert.throws(()=>e.ficha(key),/indisponível/);
});

test('contatos: páginas alcançam todos os contatos, conversas, mensagens e negócios',t=>{
  const e=env(t),ana=e.pessoa('ana','Ána Silva');for(let i=0;i<27;i++){e.conversa('g'+i+'@g.us');const id=e.evento('g'+i+'@g.us','ana');e.negocio(id);e.evento('g'+i+'@g.us','p'+i);}
  const ids=[];for(let pagina=1;pagina<=3;pagina++)ids.push(...e.desktop.contatos({pagina}).contatos.map(c=>c.id));assert.equal(ids.length,28);assert.equal(new Set(ids).size,28);assert.equal(e.desktop.contatos({q:'ana'}).pagina.total,1);
  const mensagens=[],conversas=[],negocios=[];
  for(let pagina=1;pagina<=5;pagina++){const d=e.ficha('p:'+ana,{paginaConversas:pagina,paginaMensagens:pagina,paginaNegocios:pagina});if(pagina<=4)mensagens.push(...d.mensagens.map(m=>m.id));conversas.push(...d.conversas.map(c=>c.id));negocios.push(...d.negocios.map(n=>n.id));}
  for(const lista of [mensagens,conversas,negocios]){assert.equal(lista.length,27);assert.equal(new Set(lista).size,27);}
  assert.equal(e.ficha('p:'+ana,{paginaMensagens:999}).paginaMensagens.numero,4);
});

test('contatos: consultas vazias não escrevem e recusam parâmetros inválidos',t=>{
  const e=env(t);const antes=e.db.prepare('SELECT total_changes() n').get().n;assert.equal(e.desktop.contatos().pagina.total,0);assert.equal(e.db.prepare('SELECT total_changes() n').get().n,antes);
  for(const filtro of [{q:3},{q:'x'.repeat(201)},{pagina:NaN},{pagina:0},{pagina:1.5}])assert.throws(()=>e.desktop.contatos(filtro));
  for(const filtro of [{},{contato:'a'},{contato:'p:1',paginaMensagens:0},{contato:'p:1',paginaConversas:1.2},{contato:'p:1',paginaNegocios:Infinity}])assert.throws(()=>e.desktop.contatoDetalhe(filtro));
});
