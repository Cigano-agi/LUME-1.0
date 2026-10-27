// 03A34 RED: projeto na ficha só nasce de fonte atual e identidade exata.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';
import {registrarPessoa,fundirPessoas} from '../src/pessoas.js';
import {VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';

const agora=new Date('2026-09-27T18:00:00Z');
function ambiente(t){
  const db=abrirBanco(':memory:');t.after(()=>db.close());
  const f={db,...perfilGrafo(db)};
  f.projetos=new ProjetosComerciais(db,{agora:()=>agora});
  f.mensagem=(conversa,autor,texto='Fonte literal sintética')=>{
    f.conversa(conversa);
    return f.evento(conversa,autor,{dia:'2026-09-27',texto});
  };
  f.projeto=(eventoId,nome,{confirmar=true}={})=>{
    const projeto=f.projetos.criarRascunho({nome,fontes:[{eventoId,trecho:'Fonte literal'}]});
    if(confirmar)f.projetos.confirmar({id:projeto.id,confirmar:true});
    return projeto.id;
  };
  f.lista=(opcoes={})=>f.desktop.contatos({agora,projetosComerciais:f.projetos,...opcoes});
  f.detalhe=contato=>f.desktop.contatoDetalhe({contato,projetosComerciais:f.projetos});
  f.pessoa=(jid,nome)=>{
    registrarPessoa(db,{identificador:jid,nomeCru:nome});
    return db.prepare('SELECT pessoa_id FROM pessoa_identificadores WHERE identificador=?').get(jid).pessoa_id;
  };
  return f;
}
const contato=(f,nome)=>f.lista().contatos.find(c=>c.nome===nome);
const projetoDe=(f,nome)=>contato(f,nome)?.projetoComprovado;

test('03A34 RED: DM e autor de grupo provam só a própria relação; resumo não vaza texto',t=>{
  const f=ambiente(t);
  f.pessoa('ana@lid','Ana');f.pessoa('bia@lid','Bia');
  const dm=f.mensagem('ana@lid','dono@lid','Fonte literal na DM de Ana');
  const grupo=f.mensagem('equipe@g.us','bia@lid','Fonte literal escrita por Bia');
  f.mensagem('equipe@g.us','ana@lid','Outra mensagem de Ana');
  const propria=f.mensagem('equipe@g.us','dono@lid','Fonte literal escrita pelo dono');
  f.db.prepare('UPDATE eventos SET autor_e_dono=1 WHERE id=?').run(propria);
  const ana=f.projeto(dm,'Projeto Ana'),bia=f.projeto(grupo,'Projeto Bia');
  f.projeto(propria,'Projeto só do dono');
  assert.deepEqual(projetoDe(f,'Ana'),{id:ana,nome:'Projeto Ana',fonteId:dm});
  assert.deepEqual(projetoDe(f,'Bia'),{id:bia,nome:'Projeto Bia',fonteId:grupo});
  assert.deepEqual(f.detalhe(contato(f,'Ana').id).projetoComprovado,{id:ana,nome:'Projeto Ana',fonteId:dm});
  assert.equal(JSON.stringify(f.lista()).includes('Fonte literal na DM de Ana'),false);
  assert.equal(JSON.stringify(f.lista()).includes('Projeto só do dono'),false);
});

test('03A34 RED: fonte alterada ou leitura revogada oculta nome mesmo após restaurar texto/permissão',t=>{
  const f=ambiente(t);f.pessoa('ana@lid','Ana');
  f.mensagem('ana@lid','ana@lid','Mensagem visível independente');
  const origem=f.mensagem('ana@lid','ana@lid','Fonte literal privada');
  const id=f.projeto(origem,'NOME_PRIVADO_03A34');
  assert.equal(projetoDe(f,'Ana')?.id,id);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto alterado',origem);
  assert.equal(projetoDe(f,'Ana'),undefined);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte literal privada',origem);
  assert.equal(JSON.stringify(f.lista()).includes('NOME_PRIVADO_03A34'),false);
  const outra=f.mensagem('ana@lid','ana@lid','Fonte literal revogável');
  const revogado=f.projeto(outra,'OUTRO_NOME_PRIVADO_03A34');
  assert.equal(projetoDe(f,'Ana')?.id,revogado);
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(outra);
  assert.equal(JSON.stringify(f.lista()).includes('OUTRO_NOME_PRIVADO_03A34'),false);
  f.db.prepare("UPDATE eventos SET permissao='minha' WHERE id=?").run(outra);
  assert.equal(JSON.stringify(f.lista()).includes('OUTRO_NOME_PRIVADO_03A34'),false);
});

test('03A34 RED: homônimos, projeto sem vínculo e fonte removida não atribuem projeto',t=>{
  const f=ambiente(t);
  f.pessoa('ana1@lid','Ana Igual');f.pessoa('ana2@lid','Ana Igual');
  const origem=f.mensagem('ana1@lid','ana1@lid','Fonte literal da primeira');
  f.mensagem('ana2@lid','ana2@lid','Mensagem da segunda');
  const id=f.projeto(origem,'Projeto da primeira');
  const lista=f.lista().contatos.filter(c=>c.nome==='Ana Igual');
  assert.equal(lista.length,2);
  assert.equal(lista.filter(c=>c.projetoComprovado?.id===id).length,1);
  assert.equal(lista.filter(c=>!c.projetoComprovado).length,1);
  const extra=f.mensagem('ana2@lid','ana2@lid','Fonte literal complementar');
  const link=f.projetos.vincularFonte({id,eventoId:extra,trecho:'Fonte literal'});
  assert.equal(f.lista().contatos.filter(c=>c.projetoComprovado?.id===id).length,2);
  f.projetos.desvincularFonte({id,fonteId:link.fonteId});
  assert.equal(f.lista().contatos.filter(c=>c.projetoComprovado?.id===id).length,1);
  const somenteOutro=f.projeto(f.mensagem('outra@lid','outra@lid','Fonte literal alheia'),'Projeto sem vínculo');
  assert.ok(!f.lista().contatos.filter(c=>c.nome==='Ana Igual').some(c=>c.projetoComprovado?.id===somenteOutro));
});

test('03A34 RED: fusão explícita compartilha ficha, rascunho e arquivado não aparecem',t=>{
  const f=ambiente(t),a=f.pessoa('ana1@lid','Ana antiga'),b=f.pessoa('ana2@lid','Ana atual');
  fundirPessoas(f.db,{deId:a,paraId:b});
  const origem=f.mensagem('ana1@lid','ana1@lid','Fonte literal antiga');
  f.mensagem('ana2@lid','ana2@lid','Mensagem atual');
  const id=f.projeto(origem,'Projeto fundido');
  assert.equal(f.lista().pagina.total,1);
  assert.deepEqual(f.lista().contatos[0].projetoComprovado,{id,nome:'Projeto fundido',fonteId:origem});
  const rascunho=f.projeto(f.mensagem('ana2@lid','ana2@lid','Fonte literal rascunho'),'Rascunho oculto',{confirmar:false});
  const arquivado=f.projeto(f.mensagem('ana2@lid','ana2@lid','Fonte literal arquivo'),'Arquivo oculto');
  f.projetos.arquivar({id:arquivado});
  const texto=JSON.stringify(f.lista());
  assert.ok(!texto.includes(rascunho));assert.ok(!texto.includes(arquivado));
});

test('03A34 RED: página e ordem F18 não mudam; só 12 fichas são enviadas ao adaptador',t=>{
  const f=ambiente(t);
  for(let n=1;n<=13;n++){
    const jid=`p${String(n).padStart(2,'0')}@lid`;
    f.pessoa(jid,`Pessoa ${String(n).padStart(2,'0')}`);
    f.mensagem(jid,jid,'Fonte literal da pessoa');
  }
  const semProjeto=f.desktop.contatos({agora,pagina:1}).contatos.map(c=>c.id);
  const calls=[];
  const spy={resumosConfirmadosPorContatos:rows=>{calls.push(rows);return new Map();}};
  const primeira=f.desktop.contatos({agora,pagina:1,projetosComerciais:spy});
  const segunda=f.desktop.contatos({agora,pagina:2,projetosComerciais:spy});
  assert.deepEqual(primeira.contatos.map(c=>c.id),semProjeto);
  assert.equal(primeira.pagina.total,13);assert.equal(primeira.contatos.length,12);
  assert.equal(segunda.contatos.length,1);
  assert.deepEqual(calls.map(c=>c.length),[12,1]);
  assert.ok(calls.every(page=>page.every(c=>Array.isArray(c.identificadores)&&c.identificadores.length<=32)));
});

test('03A34 RED: adaptador rejeita identidade forjada e omite fonte não autorizada',t=>{
  const f=ambiente(t),ana=f.pessoa('ana@lid','Ana'),bia=f.pessoa('bia@lid','Bia');
  const origem=f.mensagem('ana@lid','ana@lid','Fonte literal exclusiva');
  f.mensagem('bia@lid','bia@lid','Mensagem da Bia');
  const id=f.projeto(origem,'PROJETO_EXCLUSIVO_03A34');
  const falso=f.projetos.resumosConfirmadosPorContatos([{id:'p:'+bia,identificadores:['ana@lid']}]);
  assert.equal(falso.size,0);
  const verdadeiro=f.projetos.resumosConfirmadosPorContatos([{id:'p:'+ana,identificadores:['ana@lid']}]);
  assert.deepEqual(verdadeiro.get('p:'+ana),{id,nome:'PROJETO_EXCLUSIVO_03A34',fonteId:origem});
});

test('03A34: descoberta limita candidatos e falha do serviço omite só projeto',t=>{
  const f=ambiente(t),ana=f.pessoa('ana@lid','Ana');
  for(let n=0;n<7;n++)f.projeto(f.mensagem('ana@lid','ana@lid',`Fonte literal ${n}`),`Projeto ${n}`);
  const obter=f.projetos.obter.bind(f.projetos);let leituras=0,linksCarregados=0;
  f.projetos.obter=id=>{
    leituras++;
    linksCarregados+=f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_fontes WHERE projeto_id=?').get(id).n;
    return obter(id);
  };
  const resumo=f.projetos.resumosConfirmadosPorContatos([{id:'p:'+ana,identificadores:['ana@lid']}]);
  assert.equal(resumo.size,1);
  assert.ok(leituras<=4&&leituras<=48,`foram ${leituras} validações; limite é 4 por ficha e 48 por página`);
  assert.ok(linksCarregados<=512,`foram ${linksCarregados} links carregados; limite é 512 por página`);
  const lista=f.desktop.contatos({agora,projetosComerciais:{resumosConfirmadosPorContatos(){throw Error('Indisponível');}}});
  assert.equal(lista.pagina.total,1);assert.equal(lista.contatos[0].projetoComprovado,undefined);
});

test('03A34: escolhe projeto atualizado mais recente e fonte válida mais recente',t=>{
  const f=ambiente(t),ana=f.pessoa('ana@lid','Ana');
  const origemAntiga=f.mensagem('ana@lid','ana@lid','Fonte literal antiga');
  const origemNova=f.mensagem('ana@lid','ana@lid','Fonte literal nova');
  const opcional=f.mensagem('ana@lid','ana@lid','Fonte literal opcional');
  const antigo=f.projeto(origemAntiga,'Projeto antigo');
  const novo=f.projeto(origemNova,'Projeto novo');
  f.projetos.vincularFonte({id:novo,eventoId:opcional,trecho:'Fonte literal'});
  f.db.prepare('UPDATE lume_projetos_comerciais SET atualizado_em=? WHERE id=?').run('2026-09-26T00:00:00Z',antigo);
  f.db.prepare('UPDATE lume_projetos_comerciais SET atualizado_em=? WHERE id=?').run('2026-09-27T00:00:00Z',novo);
  assert.deepEqual(f.projetos.resumosConfirmadosPorContatos([{id:'p:'+ana,identificadores:['ana@lid']}]).get('p:'+ana),
    {id:novo,nome:'Projeto novo',fonteId:opcional});
});

test('03A34 RED: detalhe de Pessoas exige sessão mesmo com perfil aceito e ID válido',async t=>{
  const f=ambiente(t);
  f.pessoa('ana@lid','Ana');const source=f.mensagem('ana@lid','ana@lid','Fonte literal permitida');
  const projetoId=f.projeto(source,'Projeto autorizado');
  f.desktop.aceitar({nome:'Pessoa sintética',aceito:true,versao:VERSAO_TERMOS});
  const id=f.desktop.contatos({agora}).contatos[0].id;
  const server=criarServidor(f.db,{desktop:true,contexto:f.contexto,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    const {token}=await (await fetch(origin+'/api/sessao')).json();
    const path='/api/v3/contatos/detalhe?contato='+encodeURIComponent(id);
    assert.equal((await fetch(origin+'/api/v3/contatos')).status,403);
    const headers={'x-assessor-token':token};
    const list=await (await fetch(origin+'/api/v3/contatos',{headers})).json();
    assert.deepEqual(list.contatos[0].projetoComprovado,{id:projetoId,nome:'Projeto autorizado',fonteId:source});
    const detalhe=await fetch(origin+path,{headers});
    assert.equal(detalhe.status,200);
    assert.deepEqual((await detalhe.json()).projetoComprovado,{id:projetoId,nome:'Projeto autorizado',fonteId:source});
    assert.equal((await fetch(origin+path)).status,403);
    assert.equal((await fetch(origin+path,{headers:{'x-assessor-token':'invalido'}})).status,403);
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('03A34 RED: origem exige sessão e continua negada após revogar leitura',async t=>{
  const f=ambiente(t);
  f.pessoa('ana@lid','Ana');
  const source=f.mensagem('ana@lid','ana@lid','Fonte literal privada 03A34');
  f.desktop.aceitar({nome:'Pessoa sintética',aceito:true,versao:VERSAO_TERMOS});
  const server=criarServidor(f.db,{desktop:true,contexto:f.contexto,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,path='/api/v3/fonte?id='+source;
  try{
    const {token}=await (await fetch(origin+'/api/sessao')).json();
    const autenticada=await fetch(origin+path,{headers:{'x-assessor-token':token}});
    assert.equal(autenticada.status,200);
    assert.ok(JSON.stringify(await autenticada.json()).includes('Fonte literal privada 03A34'));
    const semSessao=(await fetch(origin+path)).status;
    const sessaoInvalida=(await fetch(origin+path,{headers:{'x-assessor-token':'invalido'}})).status;
    f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(source);
    assert.equal((await fetch(origin+path,{headers:{'x-assessor-token':token}})).status,200);
    f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(source);
    assert.equal((await fetch(origin+path,{headers:{'x-assessor-token':token}})).status,404);
    assert.equal(semSessao,403);
    assert.equal(sessaoInvalida,403);
    assert.equal((await fetch(origin+path)).status,403);
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
