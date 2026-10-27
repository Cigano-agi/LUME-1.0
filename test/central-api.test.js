import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { criarHandlerCentral } from '../api/central.js';
import { criarRepositorioNeon } from '../api/_central/repositorio-neon.js';
import {codificarCursorFeedback,TAMANHO_PAGINA_FEEDBACK} from '../src/feedback-paginacao.js';

const ORIGEM='https://lume.example.test';
const ADMIN='segredo-administrativo-com-mais-de-trinta-e-dois';
const PEPPER='pepper-independente-com-mais-de-trinta-e-dois';
const CRON='segredo-cron-independente-com-mais-de-trinta-e-dois';
const INSTALACAO='b84c33d7-35c6-4a89-bf3f-7f9dc7c8b133';
const env={
  NODE_ENV:'test',
  DATABASE_URL:'postgresql://usuario:senha@db.example.test/lume',
  LUME_ADMIN_SECRET:ADMIN,
  LUME_TOKEN_PEPPER:PEPPER,
  CRON_SECRET:CRON,
  LUME_BETA_VERSION:'3.1.0-beta.1',
  LUME_PUBLIC_ORIGIN:ORIGEM,
  LUME_RETENTION_DAYS:'90'
};
const registroBase={instalacaoId:INSTALACAO,versao:'3.1.0-beta.1',canal:'beta',plataforma:'win32',arquitetura:'x64'};

function repositorioEmMemoria(){
  const convites=new Map(),instalacoes=new Map(),feedbacks=new Map();
  return {
    convites,instalacoes,feedbacks,
    async verificarSchema(){return {ok:true,banco:'pronto',schema:'005-pulso-confirmado'};},
    async criarConvite(item){convites.set(item.codigoHash,{...item});},
    async revogarConvite(id,agora){const item=[...convites.values()].find(valor=>valor.id===id&&!valor.usadoEm&&!valor.revogadoEm);if(!item)return false;item.revogadoEm=agora;return true;},
    async consumirConvite({conviteHash,instalacaoId,tokenHash,dados,agora}){
      const convite=convites.get(conviteHash);
      if(!convite||convite.revogadoEm||(convite.usadoEm&&convite.usadoPor!==instalacaoId))return null;
      convite.usadoEm=agora;convite.usadoPor=instalacaoId;
      const item={id:instalacaoId,rotulo:convite.rotulo,tokenHash,plataforma:dados.plataforma,arquitetura:dados.arquitetura,canal:dados.canal,versao:dados.versao,estadoAtualizacao:'em_dia',codigoErro:null,whatsappEstado:'nao_informado',criadoEm:agora,ultimoContatoEm:agora,ultimoPulsoEm:null,revogadoEm:null};
      instalacoes.set(item.id,item);return item;
    },
    async registrarPulso({tokenHash,dados,agora}){const item=[...instalacoes.values()].find(valor=>valor.tokenHash===tokenHash&&!valor.revogadoEm);if(!item)return null;Object.assign(item,dados,{ultimoContatoEm:agora,ultimoPulsoEm:agora});return item;},
    async listarInstalacoes(){return [...instalacoes.values()].map(({tokenHash,...item})=>({...item}));},
    async revogarInstalacao(id,agora){const item=instalacoes.get(id);if(!item||item.revogadoEm)return false;item.revogadoEm=agora;return true;},
    async salvarFeedback({tokenHash,dados,conteudoHash,id,agora}){
      const instalacao=[...instalacoes.values()].find(item=>item.tokenHash===tokenHash&&!item.revogadoEm);if(!instalacao)return null;
      const chave=`${instalacao.id}:${dados.chaveCliente}`,anterior=feedbacks.get(chave);
      if(anterior)return anterior.conteudoHash===conteudoHash&&!anterior.excluidoEm?{id:anterior.id,criadoEm:anterior.criadoEm}:{conflito:true};
      const item={id,instalacaoId:instalacao.id,rotulo:instalacao.rotulo,...dados,conteudoHash,versao:instalacao.versao,plataforma:instalacao.plataforma,estado:'novo',severidade:'media',criadoEm:agora,atualizadoEm:agora,excluidoEm:null};
      feedbacks.set(chave,item);return {id,criadoEm:agora};
    },
    async listarFeedback(filtros){
      const all=[...feedbacks.values()].filter(item=>!item.excluidoEm),versoes=[...new Set(all.map(item=>item.versao))].sort().reverse();
      const filtered=all.filter(item=>['etapa','severidade','estado','versao','plataforma'].every(key=>!filtros[key]||item[key]===filtros[key])).sort((a,b)=>b.criadoEm.localeCompare(a.criadoEm)||b.id.localeCompare(a.id));
      const page=filtered.filter(item=>!filtros.cursor||item.criadoEm<filtros.cursor.em||item.criadoEm===filtros.cursor.em&&item.id<filtros.cursor.id).slice(0,TAMANHO_PAGINA_FEEDBACK+1);
      const itens=page.slice(0,TAMANHO_PAGINA_FEEDBACK).map(({chaveCliente,conteudoHash,excluidoEm,...item})=>item);
      return {itens,total:filtered.length,tamanhoPagina:TAMANHO_PAGINA_FEEDBACK,versoes,proximoCursor:page.length>TAMANHO_PAGINA_FEEDBACK?codificarCursorFeedback(itens.at(-1)):null};
    },
    async revisarFeedback(id,estado,severidade,agora){const item=[...feedbacks.values()].find(row=>row.id===id&&!row.excluidoEm);if(!item)return null;item.estado=estado;item.severidade=severidade;item.atualizadoEm=agora;return item;},
    async excluirFeedback(id,agora){const item=[...feedbacks.values()].find(row=>row.id===id&&!row.excluidoEm);if(!item)return false;item.relato='[excluído]';item.conteudoHash='0'.repeat(64);item.excluidoEm=agora;return true;},
    async aplicarRetencao(){return {convites:0,instalacoes:0,feedback:0};}
  };
}

function resposta(){
  return {
    headers:{},statusCode:null,body:null,
    setHeader(nome,valor){this.headers[nome.toLowerCase()]=valor;},
    status(statusCode){this.statusCode=statusCode;return this;},
    json(body){this.body=body;return this;}
  };
}

async function chamar(handler,{action,method='GET',headers={},body,query={}}={}){
  const res=resposta();
  await handler({method,headers,body,query:{action,...query}},res);
  return res;
}

function fixture({repositorio=repositorioEmMemoria(),ambiente=env}={}){
  const conexoes=[];
  const handler=criarHandlerCentral({env:ambiente,criarRepositorio:databaseUrl=>{conexoes.push(databaseUrl);return repositorio;}});
  return {handler,repositorio,conexoes};
}

async function autenticar(handler){
  const login=await chamar(handler,{action:'sessao',method:'POST',headers:{origin:ORIGEM},body:{senha:ADMIN}});
  assert.equal(login.statusCode,200);
  return login.headers['set-cookie'].split(';',1)[0];
}

test('handler real informa saude pelo repositorio injetado e aplica cabecalhos seguros',async()=>{
  const {handler,conexoes}=fixture();
  const res=await chamar(handler,{action:'saude'});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body,{ok:true,banco:'pronto',schema:'005-pulso-confirmado'});
  assert.deepEqual(conexoes,[env.DATABASE_URL]);
  assert.equal(res.headers['cache-control'],'no-store');
  assert.equal(res.headers['x-content-type-options'],'nosniff');
  assert.equal(res.headers['referrer-policy'],'no-referrer');
});

test('saude distingue Central nao configurada, banco indisponivel e schema incompleto',async()=>{
  const semConfig=await chamar(criarHandlerCentral({env:{},criarRepositorio:()=>{throw new Error('nao deveria abrir banco');}}),{action:'saude'});
  assert.deepEqual([semConfig.statusCode,semConfig.body],[503,{erro:'CENTRAL_NAO_CONFIGURADA'}]);

  const segredo='postgresql://usuario:senha-nao-pode-vazar@db.example.test/lume';
  const falhaAoCriar=await chamar(criarHandlerCentral({env,criarRepositorio:url=>criarRepositorioNeon(url,{criarCliente:()=>{throw new Error(`cliente falhou em ${segredo}`);}})}),{action:'saude'});
  assert.deepEqual([falhaAoCriar.statusCode,falhaAoCriar.body],[503,{erro:'CENTRAL_INDISPONIVEL'}]);
  const indisponivel=criarRepositorioNeon(env.DATABASE_URL,{criarCliente:()=>async()=>{throw new Error(`falha em ${segredo}`);}});
  const falha=await chamar(fixture({repositorio:indisponivel}).handler,{action:'saude'});
  assert.deepEqual([falha.statusCode,falha.body],[503,{erro:'CENTRAL_INDISPONIVEL'}]);
  assert.equal(JSON.stringify(falha.body).includes('senha-nao-pode-vazar'),false);

  const incompleto=criarRepositorioNeon(env.DATABASE_URL,{criarCliente:()=>async()=>[{convites:true,instalacoes:false,controle:true}]});
  const schema=await chamar(fixture({repositorio:incompleto}).handler,{action:'saude'});
  assert.deepEqual([schema.statusCode,schema.body],[503,{erro:'SCHEMA_INCOMPLETO'}]);
  for(const resposta of [semConfig,falhaAoCriar,falha,schema])assert.equal(resposta.headers['cache-control'],'no-store');
});

test('sessao administrativa exige origem exata, senha valida e encerra com cookie expirado',async()=>{
  const {handler}=fixture();
  const semOrigem=await chamar(handler,{action:'sessao',method:'POST',body:{senha:ADMIN}});
  assert.deepEqual([semOrigem.statusCode,semOrigem.body],[403,{erro:'ORIGEM_NAO_PERMITIDA'}]);
  const senhaErrada=await chamar(handler,{action:'sessao',method:'POST',headers:{origin:ORIGEM},body:{senha:'segredo incorreto'}});
  assert.deepEqual([senhaErrada.statusCode,senhaErrada.body],[401,{erro:'NAO_AUTORIZADO'}]);
  const cookie=await autenticar(handler);
  assert.match(cookie,/^lume_admin=[^.]+\.[A-Za-z0-9_-]+$/);
  const logout=await chamar(handler,{action:'sessao',method:'DELETE',headers:{origin:ORIGEM}});
  assert.equal(logout.statusCode,200);assert.deepEqual(logout.body,{encerrada:true});
  assert.match(logout.headers['set-cookie'],/Max-Age=0/);
});

test('fluxo completo cria convite, registra, recebe pulso e lista somente metadados',async()=>{
  const {handler}=fixture();const cookie=await autenticar(handler);
  const convite=await chamar(handler,{action:'convite',method:'POST',headers:{origin:ORIGEM,cookie},body:{rotulo:'Diogo Kaleo'}});
  assert.equal(convite.statusCode,201);assert.match(convite.body.codigo,/^LUME-[A-F0-9]{24}$/);
  const registro=await chamar(handler,{action:'registrar',method:'POST',body:{convite:convite.body.codigo,...registroBase}});
  assert.equal(registro.statusCode,201);assert.equal(registro.body.instalacaoId,INSTALACAO);assert.ok(registro.body.token.length>30);
  const pulso=await chamar(handler,{action:'pulso',method:'POST',headers:{authorization:`Bearer ${registro.body.token}`},body:{versao:'3.1.0-beta.1',canal:'beta',plataforma:'win32',arquitetura:'x64',estadoAtualizacao:'em_dia',whatsappEstado:'conectado'}});
  assert.equal(pulso.statusCode,200);assert.equal(pulso.body.recebido,true);
  const lista=await chamar(handler,{action:'listar',headers:{cookie}});
  assert.equal(lista.statusCode,200);assert.equal(lista.body.versaoAtual,'3.1.0-beta.1');assert.equal(lista.body.instalacoes.length,1);
  assert.equal(lista.body.instalacoes[0].rotulo,'Diogo Kaleo');assert.equal(lista.body.instalacoes[0].whatsappEstado,'conectado');
  assert.equal('token' in lista.body.instalacoes[0],false);assert.equal('tokenHash' in lista.body.instalacoes[0],false);
});

test('administrador revoga convite e instalacao pelas rotas reais',async()=>{
  const {handler}=fixture();const cookie=await autenticar(handler);const headers={origin:ORIGEM,cookie};
  const conviteRevogavel=await chamar(handler,{action:'convite',method:'POST',headers,body:{rotulo:'Rafael Yorik'}});
  const conviteRevogado=await chamar(handler,{action:'revogar-convite',method:'POST',headers,query:{id:conviteRevogavel.body.id}});
  assert.deepEqual([conviteRevogado.statusCode,conviteRevogado.body],[200,{revogado:true}]);
  const convite=await chamar(handler,{action:'convite',method:'POST',headers,body:{rotulo:'Guilherme Aroxo'}});
  const registro=await chamar(handler,{action:'registrar',method:'POST',body:{convite:convite.body.codigo,...registroBase}});
  assert.equal(registro.statusCode,201);
  const revogada=await chamar(handler,{action:'revogar',method:'POST',headers,query:{id:INSTALACAO}});
  assert.deepEqual([revogada.statusCode,revogada.body],[200,{revogada:true}]);
  const pulso=await chamar(handler,{action:'pulso',method:'POST',headers:{authorization:`Bearer ${registro.body.token}`},body:{versao:'3.1.0-beta.1',canal:'beta',plataforma:'win32',arquitetura:'x64',estadoAtualizacao:'em_dia'}});
  assert.deepEqual([pulso.statusCode,pulso.body],[401,{erro:'TOKEN_INVALIDO'}]);
});

test('cron diário de retenção exige segredo próprio e não publica conteúdo',async()=>{
  const {handler}=fixture();
  const sem=await chamar(handler,{action:'retencao'});
  assert.deepEqual([sem.statusCode,sem.body],[401,{erro:'NAO_AUTORIZADO'}]);
  const errado=await chamar(handler,{action:'retencao',headers:{authorization:`Bearer ${ADMIN}`}});
  assert.deepEqual([errado.statusCode,errado.body],[401,{erro:'NAO_AUTORIZADO'}]);
  const certo=await chamar(handler,{action:'retencao',headers:{authorization:`Bearer ${CRON}`}});
  assert.equal(certo.statusCode,200);assert.deepEqual(certo.body.removidos,{convites:0,instalacoes:0,feedback:0});
  assert.equal(certo.body.aplicado,true);assert.equal(JSON.stringify(certo.body).includes(CRON),false);
  const semConfig=await chamar(fixture({ambiente:{...env,CRON_SECRET:''}}).handler,{action:'retencao',headers:{authorization:`Bearer ${CRON}`}});
  assert.deepEqual([semConfig.statusCode,semConfig.body],[503,{erro:'RETENCAO_NAO_CONFIGURADA'}]);
});

test('feedback: token da instalação, recibo idempotente, triagem privada e exclusão',async()=>{
  const {handler,repositorio}=fixture();const cookie=await autenticar(handler);
  const convite=await chamar(handler,{action:'convite',method:'POST',headers:{origin:ORIGEM,cookie},body:{rotulo:'Tester autorizado'}});
  const registro=await chamar(handler,{action:'registrar',method:'POST',body:{convite:convite.body.codigo,...registroBase}});
  const chaveCliente='14d10888-d8f2-4464-b178-f8fb9c999efe';
  const relato='A conexão parou na etapa do QR, sem mostrar uma próxima ação.';
  const body={chaveCliente,categoria:'erro',etapa:'conexao',relato,utilidade:'parcial',contatoAutorizado:true};
  const semToken=await chamar(handler,{action:'feedback',method:'POST',body});
  assert.deepEqual([semToken.statusCode,semToken.body],[401,{erro:'TOKEN_INVALIDO'}]);
  const headers={authorization:`Bearer ${registro.body.token}`};
  const primeiro=await chamar(handler,{action:'feedback',method:'POST',headers,body});
  assert.equal(primeiro.statusCode,201);assert.match(primeiro.body.id,/^[0-9a-f-]{36}$/);
  const repetido=await chamar(handler,{action:'feedback',method:'POST',headers,body});
  assert.deepEqual(repetido.body,primeiro.body);assert.equal(repositorio.feedbacks.size,1);
  const conflito=await chamar(handler,{action:'feedback',method:'POST',headers,body:{...body,relato:'Outro texto para a mesma chave.'}});
  assert.deepEqual([conflito.statusCode,conflito.body],[409,{erro:'CHAVE_FEEDBACK_REUTILIZADA'}]);
  const campoExtra=await chamar(handler,{action:'feedback',method:'POST',headers,body:{...body,conversa:'conteúdo privado'}});
  assert.deepEqual([campoExtra.statusCode,campoExtra.body],[400,{erro:'CAMPOS_INVALIDOS'}]);
  const contatoInvalido=await chamar(handler,{action:'feedback',method:'POST',headers,body:{...body,contatoAutorizado:'sim'}});
  assert.deepEqual([contatoInvalido.statusCode,contatoInvalido.body],[400,{erro:'CONTATO_INVALIDO'}]);
  const semAdmin=await chamar(handler,{action:'listar-feedback'});
  assert.deepEqual([semAdmin.statusCode,semAdmin.body],[401,{erro:'NAO_AUTORIZADO'}]);
  const lista=await chamar(handler,{action:'listar-feedback',headers:{cookie}});
  assert.equal(lista.statusCode,200);assert.equal(lista.body.itens.length,1);
  assert.equal(lista.body.itens[0].relato,relato);
  assert.equal(lista.body.itens[0].contatoAutorizado,true);
  assert.equal('token' in lista.body.itens[0],false);
  const revisar=await chamar(handler,{action:'revisar-feedback',method:'POST',headers:{origin:ORIGEM,cookie},query:{id:primeiro.body.id},body:{estado:'em_analise',severidade:'alta'}});
  assert.deepEqual(revisar.body,{id:primeiro.body.id,estado:'em_analise',severidade:'alta'});
  const excluir=await chamar(handler,{action:'excluir-feedback',method:'POST',headers:{origin:ORIGEM,cookie},query:{id:primeiro.body.id}});
  assert.deepEqual(excluir.body,{excluido:true});
  assert.deepEqual((await chamar(handler,{action:'listar-feedback',headers:{cookie}})).body.itens,[]);
  assert.equal(JSON.stringify([...repositorio.feedbacks.values()]).includes(relato),false);
});

test('feedback: API pagina sem repetir IDs, filtra em todas as páginas e rejeita cursor inválido',async()=>{
  const {handler,repositorio}=fixture(),cookie=await autenticar(handler),base=Date.parse('2026-09-25T12:00:00.000Z');
  for(let i=0;i<115;i++){
    const id=`00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`,created=new Date(base-i*1000).toISOString();
    repositorio.feedbacks.set(id,{id,instalacaoId:INSTALACAO,rotulo:'Pessoa teste',categoria:'ideia',etapa:i%2?'hoje':'conexao',relato:`Relato ${i}`,utilidade:null,contatoAutorizado:false,versao:'3.2.0-beta.6',plataforma:'win32',estado:'novo',severidade:'media',criadoEm:created,atualizadoEm:created,excluidoEm:null});
  }
  const ids=new Set();let cursor=null,pages=0;
  do{
    const res=await chamar(handler,{action:'listar-feedback',headers:{cookie},query:cursor?{cursor}:{}});
    assert.equal(res.statusCode,200);assert.equal(res.body.total,115);
    for(const item of res.body.itens){assert.equal(ids.has(item.id),false);ids.add(item.id);}
    cursor=res.body.proximoCursor;pages++;
  }while(cursor);
  assert.equal(pages,6);assert.equal(ids.size,115);
  const filtro=await chamar(handler,{action:'listar-feedback',headers:{cookie},query:{etapa:'hoje'}});
  assert.equal(filtro.body.total,57);assert.ok(filtro.body.itens.every(item=>item.etapa==='hoje'));
  const bad=await chamar(handler,{action:'listar-feedback',headers:{cookie},query:{cursor:'invalid'}});
  assert.deepEqual([bad.statusCode,bad.body],[400,{erro:'FILTRO_FEEDBACK_INVALIDO'}]);
});

test('rotas administrativas recusam ausencia de sessao, origem indevida e campos extras',async()=>{
  const {handler}=fixture();
  const semSessao=await chamar(handler,{action:'listar'});
  assert.deepEqual([semSessao.statusCode,semSessao.body],[401,{erro:'NAO_AUTORIZADO'}]);
  const cookie=await autenticar(handler);
  const origemIndevida=await chamar(handler,{action:'convite',method:'POST',headers:{origin:'https://malicioso.example',cookie},body:{rotulo:'Tester'}});
  assert.deepEqual([origemIndevida.statusCode,origemIndevida.body],[403,{erro:'ORIGEM_NAO_PERMITIDA'}]);
  const campoExtra=await chamar(handler,{action:'convite',method:'POST',headers:{origin:ORIGEM,cookie},body:{rotulo:'Tester',admin:ADMIN}});
  assert.deepEqual([campoExtra.statusCode,campoExtra.body],[400,{erro:'CAMPOS_INVALIDOS'}]);
});

test('metodo, corpo, rota e falhas internas retornam apenas codigos fechados',async()=>{
  const {handler}=fixture();
  const metodo=await chamar(handler,{action:'saude',method:'POST'});
  assert.deepEqual([metodo.statusCode,metodo.body],[405,{erro:'METODO_NAO_PERMITIDO'}]);
  const corpo=await chamar(handler,{action:'registrar',method:'POST',body:'conteudo invalido'});
  assert.deepEqual([corpo.statusCode,corpo.body],[400,{erro:'CORPO_INVALIDO'}]);
  const rota=await chamar(handler,{action:'desconhecida'});
  assert.deepEqual([rota.statusCode,rota.body],[404,{erro:'ROTA_NAO_ENCONTRADA'}]);
  const segredo='postgresql://usuario:senha-super-secreta@db.example.test/lume';
  const erroRepositorio={...repositorioEmMemoria(),async verificarSchema(){throw new Error(`falha em ${segredo} no caminho C:\\privado`);}};
  const falha=await chamar(fixture({repositorio:erroRepositorio}).handler,{action:'saude'});
  assert.deepEqual([falha.statusCode,falha.body],[500,{erro:'ERRO_INTERNO'}]);
  assert.equal(JSON.stringify(falha.body).includes('senha-super-secreta'),false);
  assert.equal(JSON.stringify(falha.body).includes('privado'),false);
});

test('schema operacional e exportacao administrativa nao admitem conteudo privado',async()=>{
  const sql=readFileSync('central/migrations/001-operacao.sql','utf8');
  const bloco=/CREATE TABLE IF NOT EXISTS lume_instalacoes \(([\s\S]*?)\n\);/.exec(sql)?.[1];
  assert.ok(bloco);
  const colunas=bloco.split(/\r?\n/).map(linha=>/^\s*([a-z_]+)\s+/.exec(linha)?.[1]).filter(Boolean);
  assert.deepEqual(colunas,['id','rotulo','token_hash','plataforma','arquitetura','canal','versao','estado_atualizacao','codigo_erro','whatsapp_estado','criado_em','ultimo_contato_em','revogado_em']);
  assert.doesNotMatch(bloco,/mensagem|conversa|jid|telefone|caminho|stack|transcri|arquivo/i);

  const {handler}=fixture();const cookie=await autenticar(handler);
  const lista=await chamar(handler,{action:'listar',headers:{cookie}});
  assert.equal(lista.statusCode,200);
  assert.deepEqual(Object.keys(lista.body).sort(),['instalacoes','versaoAtual']);
  assert.deepEqual(lista.body.instalacoes,[]);
  assert.doesNotMatch(JSON.stringify(lista.body),/mensagem privada|@s\.whatsapp\.net|@lid|C:\\\\Users|stack privada|senha-super-secreta/i);
});
