import {AtividadeApps} from '../atividade-apps.js';
import { createServer } from 'node:http';
import {pessoalGet,pessoalPost} from '../pessoal/http.js';
import {ErroChatGPT} from '../pessoal/chatgpt.js';
import {ExperienciaLume} from '../experiencia-lume.js';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import QRCode from 'qrcode';
import { ContextoApp } from '../contexto-app.js';
import { mapaDeNomes, nomeDe } from '../crm.js';
import { estadoConfig, testarChave, gravarEnv } from '../configuracao.js';
import { ordenarPorValor, pontuar } from '../valor.js';
import { prepararEsquemaPrecisao, marcarFalsoPositivo, desmarcar, precisao } from '../precisao.js';
import { rascunhoDoDia, prepararEsquemaRascunho } from '../rascunho.js';
import { MonitorProgresso } from '../progresso.js';
import { Desktop } from '../desktop.js';
import { DesktopIA } from '../desktop-ia.js';
import {DesktopTarefas} from '../desktop-tarefas.js';
import {AcoesLume} from '../acoes-lume.js';
import {NegociosDesktop} from '../negocios-desktop.js';
import {LembretesNegocios} from '../lembretes-negocios.js';
import {LembretesAcoes} from '../lembretes-acoes.js';
import { recorte } from '../recuperacao.js';
import {qualidadeFonte} from '../consulta-transcricao.js';
import {DesktopAudio} from '../desktop-audio.js';
import {MAX_BYTES_AUDIO} from '../audio-desktop-contrato.js';
import { DesktopCompartilhamento } from '../desktop-compartilhamento.js';
import { MAX_PACOTE } from '../compartilhamento.js';
import {Privacidade} from '../privacidade.js';
import {Backup,LIMITE_BACKUP} from '../backup.js';
import {BackupPainelV10} from './backup-v10.js';
import pacote from '../../package.json' with {type:'json'};
import {normalizarTag} from '../comandos-whatsapp.js';
import {ClarezaDia} from '../clareza-dia.js';
import {ExecucoesLume,ExecucaoErro} from '../execucao/servico.js';
import {listarArquivosProjeto} from '../execucao/projeto.js';
import {VendasJev} from '../vendas/servico.js';
import {ProjetosComerciais} from '../projetos-comerciais/index.js';
import {NotetakerServico} from '../notetaker/servico.js';
import {registrarRotasNotetaker} from '../notetaker/http.js';
import {coberturaMidiaCiclo} from '../ciclo-captura.js';
import {LEITURA_PESSOAL_SQL as LEITURA_SQL} from '../leitura-sql.js';
import {chaveConversa,chaveExclusao} from '../exclusoes.js';

const VERSAO_PRODUTO=pacote.version;
const FEEDBACK_DRAFT_KEY='lume-feedback-rascunho-v1';
const FEEDBACK_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function feedbackRascunhoValido(valor){
  return valor&&typeof valor==='object'&&!Array.isArray(valor)&&
    Object.keys(valor).every(chave=>['categoria','chaveCliente','etapa','relato','utilidade','contatoAutorizado'].includes(chave))&&
    FEEDBACK_UUID.test(String(valor.chaveCliente||''))&&
    ['erro','ideia','elogio'].includes(valor.categoria)&&
    ['onboarding','hoje','conexao','organiza','ajustes'].includes(valor.etapa)&&
    typeof valor.relato==='string'&&valor.relato.length<=2000&&
    (valor.utilidade===null||['util','parcial','nao_util'].includes(valor.utilidade))&&
    (valor.contatoAutorizado===undefined||typeof valor.contatoAutorizado==='boolean');
}

// Link que abre a conversa no WhatsApp do proprio dono. So funciona quando o
// identificador carrega telefone de verdade: `@lid` e id interno do WhatsApp, sem
// telefone derivavel, e grupo nao tem link de abertura direta. Nesses casos devolve
// null e a tela cai no "abrir aqui", que sempre funciona.
function linkWhatsapp(conversaId){
  const id=String(conversaId||'');
  if(!id.endsWith('@s.whatsapp.net')&&!id.endsWith('@c.us')) return null;
  const numero=id.split('@')[0];
  return /^[1-9][0-9]{7,14}$/.test(numero)?`https://wa.me/${numero}`:null;
}

function consultaEstrita(url,permitidos){
  const vistos=new Set();
  for(const [campo] of url.searchParams){
    if(!permitidos.includes(campo)||vistos.has(campo))throw new Error('Parâmetro de consulta inválido.');
    vistos.add(campo);
  }
}

function inteiroConsulta(url,campo,padrao,{maximo=Number.MAX_SAFE_INTEGER}={}){
  if(!url.searchParams.has(campo))return padrao;
  const bruto=url.searchParams.get(campo);
  if(!/^[1-9]\d*$/.test(bruto||''))throw new Error(`${campo} inválido.`);
  const valor=Number(bruto);
  if(!Number.isSafeInteger(valor)||valor>maximo)throw new Error(`${campo} inválido.`);
  return valor;
}

function booleanoConsulta(url,campo,padrao=false){
  if(!url.searchParams.has(campo))return padrao;
  const bruto=url.searchParams.get(campo);
  if(!['true','false'].includes(bruto))throw new Error(`${campo} inválido.`);
  return bruto==='true';
}

function erroHistorico(error){
  const erros={HISTORICO_AGUARDE:[429,'Aguarde a resposta do WhatsApp antes de pedir novamente.'],HISTORICO_SEM_ANCORA:[404,'Ainda não há referência local permitida para recuperar esta conversa.'],HISTORICO_INDISPONIVEL:[503,'A recuperação de histórico não está disponível nesta conexão.'],HISTORICO_CANCELADO:[409,'A recuperação foi interrompida. Confira a captura.'],HISTORICO_FONTE_ALTERADA:[409,'A referência da conversa mudou. Confira a permissão.'],CONVERSA_INVALIDA:[400,'Escolha uma conversa válida.'],MODO_INVALIDO:[400,'Escolha um modo de recuperação válido.'],INVALID_INPUT:[400,'Confira os campos da recuperação.']};
  const codigo=Object.hasOwn(erros,error?.code)?error.code:'HISTORICO_FALHA';
  const [status,erro]=erros[codigo]||[502,'Não foi possível recuperar o histórico agora. As mensagens locais continuam disponíveis.'];
  return {status,erro,codigo};
}

function consultaVendas(url, campos) {
  try { consultaEstrita(url, campos); }
  catch { throw Object.assign(new Error(), {code:'JEV_ENTRADA_INVALIDA'}); }
}

// Never return provider/cofre exception text: it can contain credentials or payloads.
function erroVendas(error) {
  const erros = {
    JEV_ENTRADA_INVALIDA: [400,'Confira os campos da avaliação.'],
    JEV_SELECAO_INVALIDA: [400,'Escolha de 1 a 20 mensagens diferentes desta conversa.'],
    JEV_CONVERSA_INVALIDA: [400,'Escolha uma conversa.'],
    JEV_CONTEXTO_INVALIDO: [400,'Escolha mensagens com texto e data.'],
    JEV_CONTEXTO_LONGO: [400,'O recorte é grande demais. Nenhum texto foi cortado ou enviado.'],
    JEV_SEM_FONTES: [404,'Não há mensagens permitidas com texto nesta conversa.'],
    JEV_SEM_CONSENTIMENTO: [400,'Confira e confirme o recorte antes do envio ao avaliador externo.'],
    JEV_SEM_CHAVE: [400,'Configure uma chave OpenRouter válida no cofre do aplicativo.'],
    JEV_COFRE_INDISPONIVEL: [503,'Abra o aplicativo com a proteção de credenciais disponível.'],
    JEV_FONTE_ALTERADA: [409,'O contexto ou a permissão mudou. Confira uma nova prévia.'],
    JEV_CANCELADO: [409,'Avaliação cancelada. Nenhuma etapa foi alterada.'],
    JEV_OCUPADO: [409,'Aguarde a avaliação em andamento.'],
    JEV_CORRECAO_INVALIDA: [400,'Confira temperatura e etapa antes de salvar.'],
    JEV_CHAVE_RECUSADA: [401,'A OpenRouter recusou a credencial. Confira a chave configurada.'],
    JEV_SEM_CREDITO: [402,'A OpenRouter informou saldo insuficiente. A organização local continua disponível.'],
    JEV_LIMITE: [429,'O provedor limitou as avaliações. Aguarde antes de tentar novamente.'],
    JEV_RESPOSTA_INVALIDA: [502,'O avaliador retornou uma resposta inválida. Nenhuma etapa foi alterada.'],
    JEV_MODELO_DIVERGENTE: [502,'O provedor não confirmou a versão do Jev. Nenhum modelo alternativo foi usado.'],
    JEV_INDISPONIVEL: [503,'Não foi possível concluir a avaliação externa. A organização local continua disponível.']
  };
  const codigo = Object.hasOwn(erros,error?.code) ? error.code : 'JEV_INDISPONIVEL';
  const [status,erro] = erros[codigo];
  return {status,erro,codigo};
}

function estadoConexaoPublico(conexao){
  const state=conexao.estado();
  const campos=['estado','qrGeradoEm','qrVersao','erro','erroGrupos','conectadoEm','ultimaRecepcaoEm'];
  const publico={qrDisponivel:Boolean(state.qr)};
  for(const campo of campos)if(state[campo]!==undefined)publico[campo]=state[campo];
  const ultimo=state.ultimoFechamento;
  publico.ultimoFechamento=ultimo&&typeof ultimo==='object'?{
    codigo:Number.isInteger(ultimo.codigo)&&ultimo.codigo>=100&&ultimo.codigo<=599?ultimo.codigo:null,
    tentativas:Number.isSafeInteger(ultimo.tentativas)&&ultimo.tentativas>=0?ultimo.tentativas:null,
    em:typeof ultimo.em==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(ultimo.em)?ultimo.em:null
  }:null;
  return publico;
}

export function criarServidor(db,{atividadeApps=null,conexao,contexto=new ContextoApp(db),coletor=null,progresso=null,desktop=false,readOnly=false,whatsappLabels=null,segredos,segredosJev,avaliarJev,gerarIA,gerarAudio,audioLocal,baixarAudio,agoraIA,semantica=null,laya=null,filaLaya=null,midiaLoop=null,identidade,arquivosDados=null,notificacoes=null,atualizacoes=null,central=null,novidades=null,mcp=null,telegram=null,pessoal=null,agoraLembretes,notetakerExperimento=false,testProfileRoot,testMarker,produtores=null,selecionarProjeto=null}={}) {
  const token=randomBytes(32).toString('hex');
  const produto=new Desktop(db);
  const atividade=desktop?(atividadeApps||new AtividadeApps(db)):null;
  const intakeController=new AbortController();
  let notetaker=null;
  if(notetakerExperimento){try{notetaker=new NotetakerServico(db,{notetakerExperimento,testProfileRoot,testMarker,audioLocal,signal:intakeController.signal});}catch{/* perfil instalado e opção incompleta falham fechados */}}
  const mascararConta=conta=>{if(typeof conta!=='string')return null;const at=conta.lastIndexOf('@');if(at<1)return'••••';const usuario=conta.slice(0,at),dominio=conta.slice(at);return(usuario.length>4?usuario.slice(0,2)+'••••'+usuario.slice(-2):'••••')+dominio;};
  const respostaWhatsAppLabels=estado=>{
    const conta=estado.contaId,nomes=new Map(db.prepare('SELECT id,nome FROM conversas_app').all().map(x=>[x.id,x.nome]));
    return {disponivel:estado.disponivel,leitura:estado.leitura,contaMascarada:mascararConta(conta),estado:estado.conflito?'Conflito para revisar':estado.leitura?'Leitura observada':'Leitura desligada',labels:estado.labels.map(l=>({id:l.label_id,nome:l.nome,cor:l.cor,estado:l.conflito?'Conflito para revisar':'Leitura observada'})),associacoes:estado.associacoes.map(a=>({labelId:a.label_id,conversa:nomes.get(a.conversa_id)||'Conversa observada',escopo:a.message_id?'Mensagem observada':'Conversa observada',estado:a.conflito?'Conflito para revisar':'Leitura observada'}))};
  };
  const tagConsulta=url=>{
    if(!url.searchParams.has('tag'))return'';
    const valor=url.searchParams.get('tag');
    if(valor==='')return'';
    const normalizada=normalizarTag(valor);
    if(!normalizada.valida)throw new Error('Tag inválida.');
    if(!db.prepare('SELECT 1 FROM lume_tags WHERE chave=?').get(normalizada.chave))throw new Error('Tag desconhecida.');
    return normalizada.chave;
  };
  const negocios=new NegociosDesktop(db);
  const lembretes=produtores?.lembretes??new LembretesNegocios(db,{perfil:()=>produto.perfil(),notificacoes:desktop?notificacoes:null,agora:agoraLembretes});
  const assistente=desktop ? new DesktopIA(db,{segredos,gerar:gerarIA,agora:agoraIA,semantica}) : null;
  const tarefas=desktop?(produtores?.tarefas??new DesktopTarefas(db,{ia:assistente,agora:agoraIA,perfil:()=>produto.perfil()})):null;
  const acoes=desktop?new AcoesLume(db):null;
  const projetosSelecionados=new Map();
  let selecaoProjetoVersao=0,expiracaoProjeto=null;
  const limparProjetosSelecionados=()=>{
    if(expiracaoProjeto)clearTimeout(expiracaoProjeto);
    expiracaoProjeto=null;projetosSelecionados.clear();
  };
  const resolverProjeto=id=>{
    const item=projetosSelecionados.get(id);
    if(!item)return null;
    if(Date.now()>item.expira){limparProjetosSelecionados();return null;}
    return item;
  };
  const execucoes=desktop?new ExecucoesLume(db,{agora:agoraIA,revisaoConector:clientId=>mcp?.revisaoConector?.(clientId)??null,resolverProjeto}):null;
  if(execucoes)acoes.definirExecucoes(execucoes);
  const experiencia=new ExperienciaLume(db,{acoes,produto,organizacao:pessoal?.organizacao,pessoal,conexao});
  if(pessoal?.companheiro)pessoal.companheiro.experiencia=experiencia;
  const vendas=desktop?new VendasJev(db,{segredos:segredosJev,avaliar:avaliarJev,agora:agoraIA}):null;
  const projetosComerciais=desktop?new ProjetosComerciais(db,{agora:agoraIA}):null;
  const lembretesAcoes=desktop?(produtores?.lembretesAcoes??new LembretesAcoes(db,{perfil:()=>produto.perfil(),notificacoes,agora:agoraLembretes})):null;
  const privacidade=desktop?new Privacidade(db,{arquivos:arquivosDados}):null;
  const backup=desktop?new Backup(db,{arquivos:arquivosDados,perfil:()=>produto.perfil()}):null;
  const backupV10=desktop?new BackupPainelV10(db,()=>produto.perfil().nome):null;
  const compartilhamento=desktop?new DesktopCompartilhamento(db,{identidade,privacidade,perfil:()=>produto.perfil(),invalidar:()=>{vendas?.invalidar();lembretes.invalidar();lembretesAcoes?.invalidar();tarefas?.pausar();assistente?.invalidar();backup?.invalidar();}}):null;
  let alterandoDados=false;
  const audio=desktop&&arquivosDados?new DesktopAudio(db,{ia:assistente,arquivos:arquivosDados,gerar:gerarAudio,baixar:baixarAudio,audioLocal}):null;
  const clareza=new ClarezaDia(db,{desktop:produto});
  const destinosComSessao=new Set(['/api/v3/atividade-apps','/api/v3/clareza','/api/v3/laya','/api/v3/resumo','/api/v3/tarefas','/api/v3/acoes','/api/v3/acoes/item','/api/v3/acoes/analise','/api/v3/lembretes','/api/v3/conversas/resumo','/api/v3/contatos','/api/v3/contatos/detalhe','/api/v3/fonte','/api/v3/negocios','/api/v3/whatsapp-labels','/api/v3/central/feedback-rascunho','/api/v3/telegram-hoje']);
  const lerFeedbackRascunho=()=>{try{const valor=JSON.parse(db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(FEEDBACK_DRAFT_KEY)?.valor||'null');return feedbackRascunhoValido(valor)?valor:null;}catch{return null;}};
  const pausarDados=async({restaurar=false}={})=>{await atividade?.pausarDados();vendas?.invalidar();lembretes.invalidar();lembretesAcoes?.invalidar();negocios.previas.clear();tarefas?.pausar();assistente?.invalidar();if(!restaurar)backup?.invalidar();compartilhamento?.previas.clear();semantica?.pausar();db.prepare("INSERT INTO desktop_config VALUES('captura_pausada','1') ON CONFLICT(chave) DO UPDATE SET valor='1'").run();await midiaLoop?.parar?.();await conexao?.parar?.();};
  const monitorProgresso=progresso||new MonitorProgresso(db,{conexao});
  // Tabelas das frentes novas. Idempotente; banco antigo ganha o que falta sem migracao.
  try{ prepararEsquemaPrecisao(db); prepararEsquemaRascunho(db); }catch{ /* banco somente leitura em teste */ }
  let encerrando=null,fechado=false;
  const handlers=new Set(),jobs=new Set(),falhas=[];
  const acompanhar=(promise,grupo)=>{
    grupo.add(promise);
    void promise.then(()=>grupo.delete(promise),()=>grupo.delete(promise));
    return promise;
  };
  const server=createServer((req,res)=>{
    if(fechado){res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({erro:'Aplicativo encerrando.'}));return;}
    if(readOnly && req.method!=='GET') {res.writeHead(403,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({erro:'Ensaio somente de leitura.'}));return;}
    acompanhar(atender(req,res),handlers);
  });
  async function atender(req,res){
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port=server.address()?.port;
      if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)) return json(403,{erro:'Host não permitido'});
      const origin=`http://${req.headers.host}`;
      if(req.headers.origin && req.headers.origin!==origin) return json(403,{erro:'Origem não permitida'});
      if(req.headers['sec-fetch-site']==='cross-site') return json(403,{erro:'Acesso externo bloqueado'});
      const url=new URL(req.url,origin);
      if(desktop&&['/apresentacao','/lume-site.js'].includes(url.pathname))return json(404,{erro:'Não encontrado'});
      const publicasDesktop=['/api/sessao','/api/estado','/api/conectar','/api/desconectar','/api/qr','/api/grupos/sincronizar'];
      if(desktop && !url.pathname.startsWith('/api/v3/') && !['/','/app','/app.css','/experiencia.css','/experiencia-shell.js','/experiencia-preferencias.js','/experiencia.js','/lume-1-interface.js','/lume-auto.css','/lume-soft-mascote.js','/lume-soft-audio.js','/lume-soft-mascote.css','/lume-soft-presenca.js','/lume-soft-atividade.js','/lume-vivo-icons.svg','/app.js','/graph.js','/graph-layout.js','/audio.js','/ia.js','/tarefas.js','/acoes.js','/acoes.css','/telegram.js','/pessoal.js','/pessoal-classificador.js','/pessoal-organizacao.js','/pessoal-experiencia.css','/lume-identidade.css','/lume-icon.svg','/telegram.css','/lume-dark.css','/lume-theme-mode.js','/compartilhamento.js','/dados.js','/apresentacao','/beta','/beta.css','/beta.js','/beta-model.js','/beta-loader.js','/onboarding.css','/lume.css','/lume-site.js','/lume-motion.js','/primeiros-passos.js','/focus-mode.js','/vendor/motion.js','/workspace.css','/lume-theme.css','/beta05.css','/beta05.js','/negocios.js','/lembretes.js','/comandos.js','/atualizacoes.js','/central.js','/novidades.js','/mcp.js','/contatos.js','/conversas.js','/workspace.js','/lume-features.css','/favicon.svg','/fonts/open-runde-regular.woff2','/fonts/open-runde-medium.woff2','/fonts/open-runde-semibold.woff2','/fonts/open-runde-bold.woff2','/fonts/manrope-latin-wght-normal.woff2','/fonts/manrope-latin-ext-wght-normal.woff2'].includes(url.pathname) && !publicasDesktop.includes(url.pathname)) return json(404,{erro:'Não encontrado'});
      if(desktop || ['/app','/app.css','/experiencia.css','/experiencia-shell.js','/experiencia-preferencias.js','/experiencia.js','/lume-1-interface.js','/lume-auto.css','/lume-vivo-icons.svg','/app.js','/apresentacao','/beta','/beta.css','/beta.js','/beta-model.js'].includes(url.pathname)) res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if(req.method==='GET') {
        if(url.pathname==='/api/v3/dados/backup-v10/arquivo') {
          if(!desktop||!produto.perfil().aceito)return json(403,{erro:'Abra o perfil desktop.'});
          try{consultaEstrita(url,['ticket']);await backupV10.sendDownload(url.searchParams.get('ticket'),res);return;}
          catch(error){return json(400,{erro:error.message,codigo:error.code});}
        }
        if(url.pathname.startsWith('/api/v3/notetaker/')){
          if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida.'});
          if(!produto.perfil().aceito)return json(403,{erro:'Conclua o primeiro acesso.'});
          if(await registrarRotasNotetaker(req,res,url,{servico:notetaker,json,signal:intakeController.signal}))return;
        }
        const assets={'/app':['app.html','text/html'],'/app.css':['app.css','text/css'],'/app.js':['app.js','text/javascript'],'/ia.js':['ia.js','text/javascript'],'/tarefas.js':['tarefas.js','text/javascript'],'/compartilhamento.js':['compartilhamento.js','text/javascript'],'/dados.js':['dados.js','text/javascript'],'/apresentacao':['apresentacao.html','text/html'],'/beta':['beta.html','text/html'],'/beta.css':['beta.css','text/css'],'/beta.js':['beta.js','text/javascript'],'/beta-model.js':['beta-model.js','text/javascript'],'/favicon.svg':['favicon.svg','image/svg+xml'],'/lume-icon.svg':['lume-icon.svg','image/svg+xml']};
        assets['/lume-vivo-icons.svg']=['lume-vivo-icons.svg','image/svg+xml'];
        assets['/beta-loader.js']=['beta-loader.js','text/javascript'];
        for(const file of ['lume-soft-mascote.js','lume-soft-audio.js','lume-soft-mascote.css','lume-soft-presenca.js','lume-soft-atividade.js','lume-1-interface.js','lume-auto.css','experiencia.css','experiencia-shell.js','experiencia-preferencias.js','experiencia.js','beta05.css','beta05.js','acoes.css','acoes.js','telegram.css','telegram.js','pessoal.js','pessoal-classificador.js','pessoal-organizacao.js','pessoal-experiencia.css','lume-identidade.css','lume-dark.css','lume-theme-mode.js','lume-features.css','lume-theme.css','workspace.css','negocios.js','lembretes.js','comandos.js','atualizacoes.js','central.js','novidades.js','mcp.js','contatos.js','conversas.js','workspace.js','onboarding.css','lume.css','lume-site.js','lume-motion.js','primeiros-passos.js','focus-mode.js','vendor/motion.js']) assets['/'+file]=[file,file.endsWith('.css')?'text/css':'text/javascript'];
        for(const file of ['open-runde-regular.woff2','open-runde-medium.woff2','open-runde-semibold.woff2','open-runde-bold.woff2','manrope-latin-wght-normal.woff2','manrope-latin-ext-wght-normal.woff2']) assets['/fonts/'+file]=['fonts/'+file,'font/woff2'];
        assets['/graph.js']=['graph.js','text/javascript'];
        assets['/graph-layout.js']=['graph-layout.js','text/javascript'];
        assets['/audio.js']=['audio.js','text/javascript'];
        if(desktop && url.pathname==='/') {res.writeHead(302,{Location:'/app'});return res.end();}
        if(assets[url.pathname]) {const [file,type]=assets[url.pathname];res.setHeader('Content-Type',type+'; charset=utf-8');return res.end(await readFile(new URL(file,import.meta.url)));}
        if(url.pathname==='/api/v3/versao') return json(200,{versao:VERSAO_PRODUTO,nome:pacote.lume.nome,versaoComercial:pacote.lume.versaoComercial,titulo:pacote.lume.nome+' '+pacote.lume.versaoComercial,desktop});
        if(url.pathname==='/api/v3/perfil') return json(200,produto.perfil());
        if(url.pathname.startsWith('/api/v3/')) {
          if(!produto.perfil().aceito) return json(403,{erro:'Conclua o primeiro acesso.'});
          if((destinosComSessao.has(url.pathname)||url.pathname.startsWith('/api/v3/execucoes')||url.pathname.startsWith('/api/v3/vendas/')||url.pathname.startsWith('/api/v3/projetos-comerciais')||url.pathname==='/api/v3/historico'||url.pathname==='/api/v3/conversas/cobertura-midia')&&req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida. Recarregue a página.'});
          if(url.pathname==='/api/v3/atividade-apps'){
            if(!atividade)return json(404,{erro:'Abra o aplicativo desktop.'});
            if(alterandoDados)return json(409,{erro:'Aguarde a operação de dados terminar.'});
            try{consultaEstrita(url,['dias','pagina','limite']);return json(200,atividade.estado({dias:inteiroConsulta(url,'dias',7,{maximo:30}),pagina:inteiroConsulta(url,'pagina',1,{maximo:200}),limite:inteiroConsulta(url,'limite',50,{maximo:100})}));}
            catch{return json(400,{erro:'Período de acompanhamento inválido.'});}
          }
          if(url.pathname.startsWith('/api/v3/projetos-comerciais')){
            if(!projetosComerciais)return json(404,{erro:'Abra o aplicativo desktop.'});
            try{
              const acao=url.pathname.slice('/api/v3/projetos-comerciais'.length);
              if(acao==='/importados'){
                consultaEstrita(url,['limite']);
                return json(200,{projetos:projetosComerciais.listarImportados({limite:inteiroConsulta(url,'limite',100,{maximo:100})})});
              }
              if(acao===''){
                consultaEstrita(url,['estado','limite','pagina','q']);
                const pagina=inteiroConsulta(url,'pagina',1,{maximo:1000}),limite=inteiroConsulta(url,'limite',100,{maximo:100});
                const projetos=projetosComerciais.listar({estado:url.searchParams.get('estado')??undefined,q:url.searchParams.get('q')||'',limite:limite+1,offset:(pagina-1)*limite});
                return json(200,{projetos:projetos.slice(0,limite),pagina,proximaPagina:projetos.length>limite?pagina+1:null});
              }
              if(acao==='/item'||acao==='/timeline'){
                consultaEstrita(url,acao==='/item'?['id']:['id','antes','limite']);
                const id=url.searchParams.get('id'),projeto=projetosComerciais.obter(id);
                if(!projeto)return json(404,{erro:'Projeto indisponível. Confira as fontes e permissões.',codigo:'PROJETO_INDISPONIVEL'});
                if(acao==='/item')return json(200,{projeto});
                const limite=inteiroConsulta(url,'limite',20,{maximo:100});
                const rows=projetosComerciais.timeline({id,limite:limite+1,antes:inteiroConsulta(url,'antes',undefined)});
                const timeline=rows.slice(0,limite);
                return json(200,{timeline,antes:rows.length>limite?timeline.at(-1).id:null});
              }
              return json(404,{erro:'Não encontrado'});
            }catch{return json(400,{erro:'Confira o filtro e a identificação do projeto.',codigo:'PROJETO_INVALIDO'});}
          }
          if(url.pathname.startsWith('/api/v3/vendas/')){
            if(!vendas)return json(404,{erro:'Abra o aplicativo desktop.'});
            try{
              if(url.pathname==='/api/v3/vendas/jev'){
                consultaVendas(url,[]);return json(200,await vendas.estado());
              }
              if(url.pathname==='/api/v3/vendas/avaliacao'){
                consultaVendas(url,['conversa_id']);return json(200,{avaliacao:vendas.obter({conversa_id:url.searchParams.get('conversa_id')})});
              }
              return json(404,{erro:'Não encontrado'});
            }catch(e){const {status,...erro}=erroVendas(e);return json(status,erro);}
          }
          if(url.pathname==='/api/v3/historico'){
            if(!conexao?.historico)return json(503,{erro:'A recuperação de histórico não está disponível nesta conexão.',codigo:'HISTORICO_INDISPONIVEL'});
            try{consultaEstrita(url,['conversa_id']);}catch{return json(400,{erro:'Confira os campos da recuperação.',codigo:'INVALID_INPUT'});}
            try{return json(200,{historico:conexao.historico.estado(url.searchParams.has('conversa_id')?{conversaId:url.searchParams.get('conversa_id')}:{})});}
            catch(e){const {status,...erro}=erroHistorico(e);return json(status,erro);}
          }
          if(url.pathname==='/api/v3/execucoes/timeline'){
            if(!execucoes)return json(404,{erro:'Abra o aplicativo desktop.'});
            try{
              consultaEstrita(url,['id','antes','limite']);
              return json(200,execucoes.historico({id:url.searchParams.get('id'),antes:inteiroConsulta(url,'antes',null),limite:inteiroConsulta(url,'limite',20,{maximo:20})}));
            }catch(e){const seguro=e instanceof ExecucaoErro?e:new ExecucaoErro('INVALID_INPUT');return json(seguro.status,{erro:seguro.message,codigo:seguro.code});}
          }
          if(url.pathname==='/api/v3/execucoes'||url.pathname==='/api/v3/execucoes/item'){
            if(!execucoes)return json(404,{erro:'Abra o aplicativo desktop.'});
            try{
              const item=url.pathname.endsWith('/item');
              consultaEstrita(url,[item?'id':'acao_id']);
              return json(200,item?execucoes.obter({id:url.searchParams.get('id')}):execucoes.listar({acao_id:url.searchParams.get('acao_id')}));
            }catch(e){const seguro=e instanceof ExecucaoErro?e:new ExecucaoErro('INVALID_INPUT');return json(seguro.status,{erro:seguro.message,codigo:seguro.code});}
          }
          if(url.pathname==='/api/v3/experiencia'){
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida.'});
            try{consultaEstrita(url,['pagina','limite','id']);if(url.searchParams.has('id')){consultaEstrita(url,['id']);return json(200,experiencia.obter(url.searchParams.get('id')));}return json(200,experiencia.listar({pagina:inteiroConsulta(url,'pagina',1,{maximo:1000}),limite:inteiroConsulta(url,'limite',30,{maximo:50})}));}
            catch{return json(400,{erro:'Não foi possível recuperar os assuntos. Tente atualizar.',codigo:'EXPERIENCIA_INDISPONIVEL'});}
          }
          if(url.pathname.startsWith('/api/v3/lume-1/')){
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida.'});
            const org=pessoal?.organizador;
            if(!org)return json(503,{erro:'A organização está indisponível neste ambiente.',codigo:'ORGANIZACAO_INDISPONIVEL'});
            try{
              if(url.pathname==='/api/v3/lume-1/pessoas'){
                consultaEstrita(url,['q','pagina','limite']);return json(200,org.pessoas({q:url.searchParams.get('q')||'',pagina:inteiroConsulta(url,'pagina',1,{maximo:1000}),limite:inteiroConsulta(url,'limite',20,{maximo:50})}));
              }
              if(url.pathname==='/api/v3/lume-1/timeline'){
                consultaEstrita(url,['conversa','assunto','pessoa','projeto','pagina','limite']);
                return json(200,org.timeline({conversa:url.searchParams.get('conversa'),assunto:url.searchParams.get('assunto')||'',pessoa:url.searchParams.get('pessoa')||'',projeto:url.searchParams.get('projeto')||'',pagina:inteiroConsulta(url,'pagina',1,{maximo:1000}),limite:inteiroConsulta(url,'limite',30,{maximo:50})}));
              }
              if(url.pathname==='/api/v3/lume-1/central'){
                consultaEstrita(url,[]);const news=novidades?.estado();
                return json(200,{versao:1,acontecimentos:experiencia.listar({limite:20}).itens,comunicados:news?.comunicado?[news.comunicado]:[],organizacao:org.estado(),preferenciasNovidades:news||null});
              }
              return json(404,{erro:'Não encontrado'});
            }catch(error){return json(400,{erro:error.code?error.message:'Não foi possível recuperar este recorte. Tente novamente.',codigo:error.code||'ORGANIZACAO_INDISPONIVEL'});}
          }
          if(url.pathname==='/api/v3/clareza'){
            try{consultaEstrita(url,[]);return json(200,clareza.resumo());}
            catch{return json(400,{erro:'Não foi possível organizar este recorte. Atualize a página.'});}
          }
          if(url.pathname==='/api/v3/laya'){
            try{consultaEstrita(url,[]);return json(200,laya?.status()||{instalado:false,estado:'nao_instalado',experimental:true,local:true});}
            catch{return json(400,{erro:'Consulta inválida.'});}
          }
          if(url.pathname==='/api/v3/audio'){
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida. Recarregue a página.'});
            return json(200,audio?await audio.estado():{disponivel:false,ativo:false,padrao:'local',motores:{}});
          }
          if(url.pathname==='/api/v3/telegram-hoje'){
            try{consultaEstrita(url,[]);return telegram?json(200,await telegram.estado()):json(200,{enabled:false,available:false});}
            catch{return json(400,{erro:'Consulta inválida.'});}
          }
          if(url.pathname==='/api/v3/lembretes'){
            try{
              consultaEstrita(url,['tag','cursor','limite']);
              const tag=tagConsulta(url),cursor=inteiroConsulta(url,'cursor',Number.MAX_SAFE_INTEGER),limite=inteiroConsulta(url,'limite',50,{maximo:100});
              return json(200,{...lembretes.estado(),comandos:produto.lembretesComando({tag,cursor,limite})});
            }catch(e){return json(400,{erro:e.message});}
          }
          if(url.pathname==='/api/v3/atualizacoes')return json(200,atualizacoes?.estado()||{disponivel:false,estado:'indisponivel',canal:'beta',versaoAtual:VERSAO_PRODUTO,versaoNova:null,progresso:null,codigoErro:null,verificadoEm:null});
          if(url.pathname==='/api/v3/novidades')return novidades?json(200,novidades.estado()):json(404,{erro:'Novidades indisponíveis nesta instalação.'});
          if(url.pathname==='/api/v3/mcp'){
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida. Recarregue a página.'});
            return mcp?json(200,mcp.estado()):json(404,{erro:'Abra o aplicativo desktop para conectar um assistente.'});
          }
          if(url.pathname==='/api/v3/mcp/pacote'){
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida. Recarregue a página.'});
            if(!mcp)return json(404,{erro:'Abra o aplicativo desktop para conectar um assistente.'});
            try{
              const pacoteMcp=mcp.pacoteClaude();
              if(!/^Lume-[0-9A-Za-z.-]+\.mcpb$/.test(pacoteMcp.name)||!Buffer.isBuffer(pacoteMcp.bytes))throw new Error('Pacote indisponível.');
              res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${pacoteMcp.name}"`,'Content-Length':pacoteMcp.bytes.length,'Cache-Control':'no-store'});
              return res.end(pacoteMcp.bytes);
            }catch{return json(400,{erro:'Não foi possível preparar a extensão. Tente novamente.'});}
          }
          if(url.pathname==='/api/v3/central'){
            if(!central)return json(404,{erro:'Central indisponível nesta instalação.'});
            try{return json(200,await central.consultar());}catch{return json(503,{erro:'A Central não está disponível agora. O Lume continua funcionando.'});}
          }
          if(url.pathname==='/api/v3/tarefas/estado')return tarefas?json(200,tarefas.estado()):json(404,{erro:'Abra o aplicativo desktop.'});
          if(url.pathname==='/api/v3/acoes/conversas'){
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida. Recarregue a página.'});
            if(!acoes)return json(404,{erro:'Abra o aplicativo desktop.'});
            try{consultaEstrita(url,['busca']);return json(200,{conversas:acoes.conversas({busca:url.searchParams.get('busca')||''})});}
            catch(e){return json(400,{erro:e.message});}
          }
          if(url.pathname==='/api/v3/central/feedback-rascunho'){
            if(!desktop)return json(404,{erro:'Abra o aplicativo desktop.'});
            try{consultaEstrita(url,[]);return json(200,{rascunho:lerFeedbackRascunho()});}catch{return json(400,{erro:'Consulta inválida.'});}
          }
          if(url.pathname==='/api/v3/acoes/estado'){
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida. Recarregue a página.'});
            try{consultaEstrita(url,[]);return lembretesAcoes?json(200,lembretesAcoes.estado()):json(404,{erro:'Abra o aplicativo desktop.'});}
            catch(e){return json(400,{erro:e.message});}
          }
          if(url.pathname==='/api/v3/acoes/analise'){
            try{consultaEstrita(url,[]);return filaLaya?json(200,{...filaLaya.estado(),disponivel:true}):json(200,{disponivel:false,total:0,pendentes:0,analisando:0,aguardandoModelo:0,aguardandoValidacao:0,abstidas:0,erros:0,ultimaAnaliseEm:null});}
            catch{return json(400,{erro:'Consulta inválida.'});}
          }
          if(url.pathname==='/api/v3/acoes'){
            if(!acoes)return json(404,{erro:'Abra o aplicativo desktop.'});
            try{
              consultaEstrita(url,['estado','limite','conversa','pagina']);
              const filtros={estado:url.searchParams.get('estado')??'sugerido',limite:inteiroConsulta(url,'limite',50,{maximo:100}),pagina:inteiroConsulta(url,'pagina',1,{maximo:100000}),conversa:url.searchParams.has('conversa')?url.searchParams.get('conversa'):undefined};
              const total=acoes.contar({estado:filtros.estado,conversa:filtros.conversa});
              return json(200,{acoes:acoes.listar(filtros),total,pagina:filtros.pagina,paginas:Math.max(1,Math.ceil(total/filtros.limite))});
            }
            catch(e){return json(400,{erro:e.message});}
          }
          if(url.pathname==='/api/v3/pessoal'||url.pathname.startsWith('/api/v3/pessoal/')){
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida.'});
            try{
              const lista=url.pathname==='/api/v3/pessoal/conversas';consultaEstrita(url,lista?['busca','tipo','pagina']:[]);
              const query=lista?{busca:url.searchParams.get('busca')||'',tipo:url.searchParams.get('tipo')||'dm',pagina:Number(url.searchParams.get('pagina')||0)}:{};
              return json(200,await pessoalGet(pessoal,url.pathname,query));
            }
            catch(error){return json(400,{erro:error instanceof ErroChatGPT?error.message:'Não foi possível consultar o Lume pessoal. Confira a conexão no aplicativo.',codigo:error?.code||'PESSOAL_INDISPONIVEL',...(error instanceof ErroChatGPT?{statusHttp:error.status,requestId:error.requestId}:{})});}
          }
          if(url.pathname==='/api/v3/acoes/item'){
            if(!acoes)return json(404,{erro:'Abra o aplicativo desktop.'});
            try{consultaEstrita(url,['id']);const acao=acoes.obter(url.searchParams.get('id'));return acao?json(200,{acao}):json(404,{erro:'A ação não está mais disponível. Confira a permissão ou a fonte.'});}
            catch{return json(400,{erro:'Identificador de ação inválido.'});}
          }
          if(url.pathname==='/api/v3/tarefas'){
            if(!tarefas)return json(404,{erro:'Abra o aplicativo desktop.'});
            try{
              consultaEstrita(url,['estado','antes','tag','cursor','limite']);
              const tag=tagConsulta(url),cursor=inteiroConsulta(url,'cursor',Number.MAX_SAFE_INTEGER),limite=inteiroConsulta(url,'limite',50,{maximo:100});
              const sugestoes=tarefas.listar({
                estado:url.searchParams.get('estado')||'pendente',
                antes:inteiroConsulta(url,'antes',Number.MAX_SAFE_INTEGER)
              });
              const lista=tag?{sugestoes:[],mais:false,proximoAntes:null}:sugestoes;
              return json(200,{...lista,comandos:produto.tarefasComando({tag,cursor,limite})});
            }catch(e){return json(400,{erro:e.message});}
          }
          if(url.pathname==='/api/v3/compartilhamento') return compartilhamento?json(200,await compartilhamento.estado()):json(404,{erro:'Abra o aplicativo desktop.'});
          if(url.pathname==='/api/v3/dados')return privacidade?json(200,{...privacidade.estado(),alterandoDados,capturaPausada:db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get()?.valor==='1'}):json(404,{erro:'Abra o perfil desktop.'});
          if(url.pathname==='/api/v3/semantica') return json(200,semantica?.estado() || {ativa:false,disponivel:false});
          if(url.pathname==='/api/v3/busca-semantica') {
            if(!semantica) return json(503,{erro:'Busca por significado indisponível neste ambiente.'});
            try {
              const filtro=recorte({pergunta:url.searchParams.get('q'),conversa:url.searchParams.get('conversa')||'',periodo:'tudo'});
              const fontes=await semantica.buscar(filtro,{remoto:false});
              // Metadados integrais servem à revalidação interna, não ao resultado de busca.
              const mensagens=fontes.map(({transcricao_meta,...fonte})=>({...fonte,...qualidadeFonte(db,fonte)}));
              return json(200,{mensagens,proximoAntes:null,cobertura:semantica.estado(),aviso:'Resultados por aproximação de significado; similaridade não prova a resposta.'});
            }catch{return json(400,{erro:'Não foi possível preparar a extensão. Tente novamente.'});}
          }
          if(url.pathname==='/api/v3/ia/estado') return assistente ? json(200,await assistente.estado()) : json(404,{erro:'Abra o aplicativo desktop para configurar IA.'});
          if(url.pathname==='/api/v3/fonte') {
            try { return json(200,produto.fonte(Number(url.searchParams.get('id')))); } catch(e) { return json(404,{erro:e.message}); }
          }
          if(url.pathname==='/api/v3/comandos') {
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'SessÃ£o do painel invÃ¡lida. Recarregue a pÃ¡gina.'});
            try{
              consultaEstrita(url,['estado','tipo','tag','cursor','limite']);
              return json(200,produto.comandos({
              estado:url.searchParams.get('estado')||'',
              tipo:url.searchParams.get('tipo')||'',
              tag:tagConsulta(url),
              cursor:inteiroConsulta(url,'cursor',Number.MAX_SAFE_INTEGER),
              limite:inteiroConsulta(url,'limite',50,{maximo:100})
            }));}catch(e){return json(400,{erro:e.message});}
          }
          if(url.pathname==='/api/v3/whatsapp-labels'){
            if(!whatsappLabels)return json(404,{erro:'Laboratorio disponivel somente no aplicativo desktop.'});
            consultaEstrita(url,[]);
            return json(200,respostaWhatsAppLabels(whatsappLabels.estado(conexao?.sessaoLabels?.())));
          }
          if(url.pathname==='/api/v3/tags') {
            if(req.headers['x-assessor-token']!==token)return json(403,{erro:'SessÃ£o do painel invÃ¡lida. Recarregue a pÃ¡gina.'});
            try{
              consultaEstrita(url,['entidadeTipo','tag','cursor','limite']);
              return json(200,produto.tags({
              entidadeTipo:url.searchParams.get('entidadeTipo')||'',
              tag:tagConsulta(url),
              cursor:inteiroConsulta(url,'cursor',Number.MAX_SAFE_INTEGER),
              limite:inteiroConsulta(url,'limite',50,{maximo:100})
            }));}catch(e){return json(400,{erro:e.message});}
          }
          if(url.pathname==='/api/v3/resumo') {
            try {
              consultaEstrita(url,['ordem','pagina','tag']);
              return json(200,produto.resumo({
                ordem:url.searchParams.get('ordem')??'compromissos',
                pagina:inteiroConsulta(url,'pagina',1),
                tag:tagConsulta(url)
              }));
            }
            catch(e) { return json(400,{erro:e.message}); }
          }
          if(['/api/v3/grafo','/api/v3/grafo/fontes'].includes(url.pathname)) {
            try {
              const filtro=Object.fromEntries(url.searchParams);
              if(filtro.pagina!==undefined)filtro.pagina=Number(filtro.pagina);
              if(filtro.antes!==undefined)filtro.antes=Number(filtro.antes);
              return json(200,url.pathname.endsWith('/fontes')?produto.fontesGrafo(filtro):produto.grafo(filtro));
            } catch(e) { return json(400,{erro:e.message}); }
          }
          if(url.pathname==='/api/v3/conversas') return json(200,produto.conversas());
          if(url.pathname==='/api/v3/conversas/cobertura-midia'){
            try{
              consultaEstrita(url,['conversa']);
              const conversaId=url.searchParams.get('conversa');
              if(!conversaId||conversaId.length>200)throw new Error('Escolha uma conversa válida.');
              const conversaExcluida=db.prepare('SELECT 1 FROM priv_conversas_excluidas WHERE hash=?')
                .get(chaveConversa(conversaId));
              const fonteLegivel=db.prepare(`SELECT e.origem_id FROM eventos e
                WHERE e.conversa_id=? AND ${LEITURA_SQL}`);
              const excluida=db.prepare('SELECT 1 FROM priv_excluidos WHERE hash=?');
              let temFonte=false;
              if(!conversaExcluida)for(const fonte of fonteLegivel.iterate(conversaId)){
                if(!excluida.get(chaveExclusao(conversaId,fonte.origem_id))){temFonte=true;break;}
              }
              if(!temFonte)
                return json(404,{erro:'Conversa indisponível neste recorte.'});
              return json(200,{cobertura:coberturaMidiaCiclo(db,{conversaId}),historico:'desconhecido'});
            }catch(e){return json(400,{erro:e.message});}
          }
          if(url.pathname==='/api/v3/negocios'){
            try{
              consultaEstrita(url,['conversa','etapa','pagina','paginaRevisoes','contatos','tag']);
              return json(200,negocios.listar({
                conversa:url.searchParams.get('conversa')||'',
                etapa:url.searchParams.get('etapa')||'todas',
                pagina:inteiroConsulta(url,'pagina',1),
                paginaRevisoes:inteiroConsulta(url,'paginaRevisoes',1),
                contatos:booleanoConsulta(url,'contatos'),
                tag:tagConsulta(url)
              }));
            }catch(e){return json(400,{erro:e.message});}
          }
          if(['/api/v3/contatos','/api/v3/contatos/detalhe'].includes(url.pathname)) {
            try {
              consultaEstrita(url,url.pathname.endsWith('/detalhe')?['contato','paginaConversas','paginaMensagens','paginaNegocios']:['q','pagina','tag','periodo']);
              const filtro=Object.fromEntries(url.searchParams);
              for(const campo of ['pagina','paginaConversas','paginaMensagens','paginaNegocios'])if(filtro[campo]!==undefined)filtro[campo]=inteiroConsulta(url,campo,1);
              if(!url.pathname.endsWith('/detalhe'))filtro.tag=tagConsulta(url);
              const comProjetos={...filtro,projetosComerciais};
              return json(200,url.pathname.endsWith('/detalhe')?produto.contatoDetalhe(comProjetos):produto.contatos(comProjetos));
            }catch(e){return json(400,{erro:e.message});}
          }
          if(['/api/v3/conversas/resumo','/api/v3/conversas/detalhe'].includes(url.pathname)) {
            try {
              consultaEstrita(url,url.pathname.endsWith('/detalhe')?['conversa','paginaAcoes','paginaPessoas']:['q','filtro','pagina','tag']);
              const filtro=Object.fromEntries(url.searchParams);
              for(const campo of ['pagina','paginaAcoes','paginaPessoas'])if(filtro[campo]!==undefined)filtro[campo]=inteiroConsulta(url,campo,1);
              if(!url.pathname.endsWith('/detalhe'))filtro.tag=tagConsulta(url);
              return json(200,url.pathname.endsWith('/detalhe')?produto.conversaDetalhe(filtro):produto.carteira(filtro));
            }catch(e){return json(400,{erro:e.message});}
          }
          if(url.pathname==='/api/v3/busca') {
            try{consultaEstrita(url,['q','conversa','antes','pessoa','assunto','de','ate','tipo']);return json(200,produto.buscar({q:url.searchParams.get('q')||'',conversa:url.searchParams.get('conversa')||'',antes:Number(url.searchParams.get('antes')||Number.MAX_SAFE_INTEGER),...Object.fromEntries(['pessoa','assunto','de','ate','tipo'].map(k=>[k,url.searchParams.get(k)||'']))}));}
            catch(e){return json(400,{erro:e.message});}
          }
        }
        if(url.pathname==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(await readFile(new URL('./painel.html',import.meta.url)));}
        if(url.pathname==='/api/sessao') return json(200,{token});
        if(url.pathname==='/api/config') return json(200,estadoConfig());
        if(url.pathname==='/api/progresso') return json(200,monitorProgresso.estado());
        // Precisao: sem ela ninguem sabe se a lista mente, e alvo e anti-alvo convergiram
        // que e isso que mata o uso ("duas vezes com lixo e eu paro de abrir").
        if(url.pathname==='/api/precisao') {
          try{ return json(200,precisao(db,{desde:url.searchParams.get('desde')||undefined})); }
          catch{ return json(200,{julgados:0,falsos:0,aceitos:0,taxa:null}); }
        }
        if(url.pathname==='/api/rascunho') {
          try{ return json(200,rascunhoDoDia(db,{})??null); }catch{ return json(200,null); }
        }
        if(url.pathname==='/api/estado') {
          const estado=estadoConexaoPublico(conexao);
          if(desktop) return json(200,{conexao:estado,versao:VERSAO_PRODUTO});
          return json(200,{...contexto.estado(),pendencias:contexto.pendencias(),conexao:estado,versao:VERSAO_PRODUTO});
        }
        if(url.pathname==='/api/conversas') return json(200,contexto.conversas((url.searchParams.get('q')||'').slice(0,500)));
        if(url.pathname==='/api/mensagens') {
          const antes=url.searchParams.has('antes')?Number(url.searchParams.get('antes')):Number.MAX_SAFE_INTEGER;
          if(!Number.isSafeInteger(antes)||antes<1) return json(400,{erro:'Paginação inválida'});
          return json(200,contexto.mensagens(url.searchParams.get('conversaId')||'',{q:(url.searchParams.get('q')||'').slice(0,500),antes}));
        }
        if(url.pathname==='/api/qr') {
          const {qr}=conexao.estado(); if(!qr) return json(404,{erro:'Nenhum QR disponível'});
          res.setHeader('Content-Type','image/svg+xml');return res.end(await QRCode.toString(qr,{type:'svg',margin:3,width:300}));
        }
        // Participação observada, nunca inferida pelo tamanho do grupo: um grupo de 5
        // pessoas onde ele fala metade é trabalho; um de 800 onde ele nunca fala é ruído.
        if(url.pathname==='/api/comunidades') {
          const desde=new Date(Date.now()-30*86400000).toISOString();
          const grupos=db.prepare(`
            SELECT g.id,g.nome,g.tamanho,COUNT(e.id) mensagens,
              COALESCE(SUM(CASE WHEN e.autor_e_dono=1 THEN 1 ELSE 0 END),0) proprias,
              MAX(e.recebido_em) ultimaMensagemEm
            FROM grupos_app g LEFT JOIN eventos e
              ON e.conversa_id=g.id AND e.recebido_em>=?
            GROUP BY g.id ORDER BY ultimaMensagemEm DESC,g.nome
          `).all(desde);
          return json(200,{desde,grupos});
        }
        if(url.pathname==='/api/grupos') {
          const id=url.searchParams.get('id');
          if(id){const g=contexto.grupo(id);return g?json(200,g):json(404,{erro:'Grupo não encontrado'});}
          return json(200,contexto.grupos((url.searchParams.get('q')||'').slice(0,500)));
        }
        // A linha do tempo lê `eventos` direto. As mensagens já estão lá desde que o
        // WhatsApp pareou -- copiá-las para outra tabela só criaria duas versões da
        // mesma verdade, e a cópia nasceria velha a cada mensagem nova que chega.
        if(url.pathname==='/api/timeline') {
          const conversa=url.searchParams.get('conversa');
          const q=(url.searchParams.get('q')||'').slice(0,200);
          const limiteBruto=Number(url.searchParams.get('limite')||100);
          const limite=Number.isSafeInteger(limiteBruto)&&limiteBruto>0?Math.min(limiteBruto,500):100;
          const filtros=["e.texto IS NOT NULL","e.texto<>''"],valores=[];
          if(conversa){filtros.push('e.conversa_id = ?');valores.push(conversa);}
          if(q){filtros.push('e.texto LIKE ?');valores.push('%'+q+'%');}
          const onde='WHERE '+filtros.join(' AND ');
          const total=db.prepare(`SELECT COUNT(*) c FROM eventos e ${onde}`).get(...valores).c;
          const eventos=db.prepare(
            `SELECT e.conversa_id,e.recebido_em,e.autor_id,e.autor_e_dono,e.tipo,e.texto,
                    COALESCE(g.nome,c.nome,e.conversa_id) conversa_nome
             FROM eventos e
             LEFT JOIN grupos_app g ON g.id=e.conversa_id
             LEFT JOIN conversas_app c ON c.id=e.conversa_id
             ${onde} ORDER BY e.recebido_em DESC LIMIT ?`
          ).all(...valores,limite);
          const conversas=db.prepare(
            `SELECT e.conversa_id,COUNT(*) mensagens,MIN(e.recebido_em) primeiro_em,
                    MAX(e.recebido_em) ultimo_em,COALESCE(g.nome,c.nome,e.conversa_id) nome
             FROM eventos e
             LEFT JOIN grupos_app g ON g.id=e.conversa_id
             LEFT JOIN conversas_app c ON c.id=e.conversa_id
             WHERE e.texto IS NOT NULL AND e.texto<>''
             GROUP BY e.conversa_id ORDER BY ultimo_em DESC LIMIT 30`
          ).all();
          return json(200,{conversas,eventos,total});
        }
        if(url.pathname==='/api/crm') {
          let porTipo;
          try{porTipo=db.prepare("SELECT tipo,COUNT(*) total FROM itens_crm WHERE estado='aberto' GROUP BY tipo").all();}
          catch{return json(200,{porTipo:[],itens:[],total:0,semExtracao:true});}
          const tipo=url.searchParams.get('tipo');
          const filtros=["i.estado='aberto'"],valores=[];
          if(tipo){filtros.push('i.tipo = ?');valores.push(tipo);}
          const total=db.prepare(`SELECT COUNT(*) c FROM itens_crm i WHERE ${filtros.join(' AND ')}`).get(...valores).c;
          const crus=db.prepare(
            `SELECT i.id,i.tipo,i.resumo,i.responsavel,i.quando,i.origem_id,i.conversa_id,
                    CAST(julianday('now')-julianday(i.quando) AS INTEGER) dias,
                    COALESCE(g.nome,c.nome,i.conversa_id) conversa_nome,
                    g.id IS NOT NULL AS e_grupo
             FROM itens_crm i
             LEFT JOIN grupos_app g ON g.id=i.conversa_id
             LEFT JOIN conversas_app c ON c.id=i.conversa_id
             WHERE ${filtros.join(' AND ')}
             ORDER BY i.quando DESC LIMIT 200`
          ).all(...valores);
          // O item guarda o identificador cru que o modelo escreveu. Resolver aqui, na
          // leitura, evita reprocessar conversa inteira so para trocar um rotulo -- e e
          // o que tira `267220265488501` da tela do dono.
          const nomes=mapaDeNomes(db);
          // Ordenar por VALOR, nao por idade. O painel empurrava o mais podre para o topo:
          // o item nasce verdadeiro e apodrece sob 3.661 mensagens, e o dono abria, via o
          // mais velho primeiro e dizia "nao achei nada que valesse agir".
          const ordenados=ordenarPorValor(crus,{agora:new Date()});
          const itens=ordenados.map(i=>({
            ...i,
            ...(()=>{const {pontos,porques}=pontuar(i,{agora:new Date()});return {pontos,porques};})(),
            responsavel_nome: i.responsavel?nomeDe(i.responsavel,nomes):null,
            // Abrir a conversa dentro do app ja existe (botao "Ver conversa" do painel).
            // O que faltava era sair daqui para o WhatsApp com a pessoa ja aberta, que e
            // onde o follow-up de fato acontece. So existe para DM com telefone real:
            // em grupo e em `@lid` nao ha link, e ai a tela cai no botao de sempre.
            abrir_whatsapp: linkWhatsapp(i.conversa_id)
          }));
          return json(200,{porTipo,itens,total});
        }
        if(url.pathname==='/api/caixas') {
          if(!coletor) return json(503,{erro:'Coletor de caixas indisponível.'});
          const estado=url.searchParams.get('estado')||undefined;
          const limiteBruto=Number(url.searchParams.get('limite')||50);
          const limite=Number.isSafeInteger(limiteBruto)&&limiteBruto>0?Math.min(limiteBruto,200):50;
          const jobs=coletor.listarJobs({estado,limite});
          const porEstado=db.prepare('SELECT estado, COUNT(*) total FROM caixas_jobs GROUP BY estado').all();
          return json(200,{
            grupo:{jid:coletor.obterJidGrupo2026(),resolucao:db.prepare("SELECT valor FROM caixas_config WHERE chave='status_resolucao_2026'").get()?.valor||null},
            porEstado,
            caixas:jobs
          });
        }
      }
      if(req.method==='PATCH'&&url.pathname.startsWith('/api/v3/notetaker/')){
        if(req.headers['x-assessor-token']!==token)return json(403,{erro:'Sessão do painel inválida.'});
        if(!produto.perfil().aceito)return json(403,{erro:'Conclua o primeiro acesso.'});
        if(alterandoDados)return json(409,{erro:'Aguarde a operação de dados terminar.'});
        if(await registrarRotasNotetaker(req,res,url,{servico:notetaker,json}))return;
      }
      if(req.method==='POST') {
        if(req.headers['x-assessor-token']!==token) return json(403,{erro:'Sessão do painel inválida. Recarregue a página.'});
        if(url.pathname==='/api/v3/dados/backup-v10/importar') {
          if(!desktop||!produto.perfil().aceito)return json(403,{erro:'Abra o perfil desktop.'});
          if(alterandoDados)return json(409,{erro:'Aguarde a operação de dados terminar.'});
          try{return json(200,await backupV10.preview(req,Buffer.from(req.headers['x-lume-backup-password']||'','base64').toString('utf8')));}
          catch(error){return json(400,{erro:error.message,codigo:error.code});}
        }
        if(url.pathname.startsWith('/api/v3/notetaker/')){
          if(!produto.perfil().aceito)return json(403,{erro:'Leia e aceite os termos antes de importar.'});
          if(await registrarRotasNotetaker(req,res,url,{servico:notetaker,json}))return;
        }
        if(!req.headers['content-type']?.startsWith('application/json')) return json(415,{erro:'Envie JSON'});
        let body='',bytes=0;req.setEncoding('utf8');
        for await(const chunk of req) {bytes+=Buffer.byteLength(chunk);if(bytes>(url.pathname==='/api/v3/audio/preparar'?Math.ceil(MAX_BYTES_AUDIO/3)*4+4096:url.pathname==='/api/v3/dados/preparar-restauracao'?LIMITE_BACKUP*2+1000:url.pathname==='/api/v3/compartilhamento/preparar-importacao'?MAX_PACOTE*2+1000:120000))return json(413,{erro:'Contexto muito grande'});body+=chunk;}
        let data;try{data=JSON.parse(body||'{}');}catch{return json(400,{erro:'JSON inválido'});}
        if(alterandoDados)return json(409,{erro:'Aguarde a operação de dados terminar.'});
        if(url.pathname==='/api/v3/aceite') {try{const aceite=produto.aceitar(data);filaLaya?.sinalizar();return json(200,aceite);}catch(e){return json(400,{erro:e.message});}}
        if(url.pathname.startsWith('/api/v3/') || (desktop && ['/api/conectar','/api/grupos/sincronizar'].includes(url.pathname))) {
          if(!produto.perfil().aceito) return json(403,{erro:'Leia e aceite os termos antes de conectar.'});
          try {
            if(url.pathname.startsWith('/api/v3/atividade-apps/')){
              if(!atividade)return json(404,{erro:'Abra o aplicativo desktop.'});
              consultaEstrita(url,[]);
              if(url.pathname==='/api/v3/atividade-apps/config')return json(200,await atividade.configurar(data));
              if(url.pathname==='/api/v3/atividade-apps/apagar'){
                if(!data||Array.isArray(data)||Object.keys(data).length)return json(400,{erro:'Pedido de exclusão inválido.'});
                return json(200,await atividade.apagar());
              }
              return json(404,{erro:'Ação de acompanhamento indisponível.'});
            }
            if(url.pathname==='/api/v3/laya/classificar'){
              if(!laya)return json(503,{erro:'O auxiliar local ainda não está instalado.'});
              if(!data||Array.isArray(data)||Object.keys(data).join(',')!=='texto'||typeof data.texto!=='string'||!data.texto.trim()||data.texto.length>2000)return json(400,{erro:'Digite um trecho de até 2.000 caracteres.'});
              try{return json(200,await laya.classificar({texto:data.texto}));}
              catch(e){
                if(e.message==='LAYA_CONTEXTO_EXTENSO')return json(400,{erro:'Este trecho ficou extenso para o auxiliar local. Reduza o texto e tente novamente.'});
                return json(e.message==='LAYA_OCUPADO'?409:503,{erro:e.message==='LAYA_OCUPADO'?'Uma análise já está em andamento. Aguarde.':'Não foi possível analisar localmente. Seu texto não foi enviado a um serviço externo.'});
              }
            }
            if(url.pathname==='/api/v3/guia')return json(200,produto.configurarGuia(data));
            if(url.pathname.startsWith('/api/v3/lume-1/')){
              const org=pessoal?.organizador;if(!org)return json(503,{erro:'Organização indisponível neste ambiente.'});
              try{
                consultaEstrita(url,[]);
                const actions={
                  '/api/v3/lume-1/pessoas/correcao':{keys:['conversaId','tags'],run:()=>org.corrigirTags(data)},
                  '/api/v3/lume-1/vinculo':{keys:['eventoId','projetoId','trecho'],run:()=>org.corrigirVinculo(data)},
                  '/api/v3/lume-1/organizacao/vinculo':{keys:['eventoId','trecho','nome'],run:()=>org.corrigirOrganizacao(data)},
                  '/api/v3/lume-1/organizacao/escopo':{keys:['escopo','confirmar'],run:()=>org.configurarEscopo(data)},
                  '/api/v3/lume-1/organizacao/pergunta':{keys:['id','projetoId','adiar'],run:()=>org.responderPergunta(data)},
                  '/api/v3/lume-1/organizacao/temperatura':{keys:['eventoId','trecho','temperatura','etapa'],run:()=>org.corrigirTemperatura(data)},
                  '/api/v3/lume-1/organizacao':{keys:['acao'],run:()=>org.configurar(data)}
                },action=actions[url.pathname];
                if(!action)return json(404,{erro:'Não encontrado'});
                if(!data||Array.isArray(data)||Object.keys(data).some(k=>!action.keys.includes(k)))return json(400,{erro:'Confira os campos da operação.'});
                return json(200,action.run());
              }catch(error){return json(400,{erro:error.code?error.message:'Não foi possível salvar a correção. Confira as fontes.',codigo:error.code||'ORGANIZACAO_INVALIDA'});}
            }
            if(url.pathname.startsWith('/api/v3/pessoal/')){
              try{consultaEstrita(url,[]);return json(200,await pessoalPost(pessoal,url.pathname,data));}
              catch(error){return json(400,{erro:'Não foi possível concluir. Confira os campos, as permissões e a conexão do Lume pessoal.',codigo:error?.code||'PESSOAL_OPERACAO_RECUSADA'});}
            }
            if(url.pathname==='/api/v3/telegram-hoje'){
              if(!telegram)return json(404,{erro:'Telegram disponível somente no aplicativo instalado.'});
              if(!data||Array.isArray(data)||Object.keys(data).some(k=>!['token','chatId','shareTitles','botUsername','enabled'].includes(k)))return json(400,{erro:'Confira a configuração do Telegram.'});
              try{const state=await telegram.configurar(data);if(state.enabled)await telegram.iniciar();return json(200,await telegram.estado());}
              catch{return json(400,{erro:'Não foi possível ativar o Telegram. Confira o token, a DM e a proteção do sistema.'});}
            }
            if(url.pathname==='/api/v3/telegram-hoje/desativar'){
              if(!telegram)return json(404,{erro:'Telegram disponível somente no aplicativo instalado.'});
              if(!data||Array.isArray(data)||Object.keys(data).length)return json(400,{erro:'Envie um pedido vazio.'});
              try{return json(200,await telegram.desativar());}
              catch{return json(503,{erro:'A conexão foi parada, mas não foi possível remover a credencial protegida.'});}
            }
            if(url.pathname==='/api/v3/whatsapp-labels'){
              if(!whatsappLabels)return json(404,{erro:'Laboratorio disponivel somente no aplicativo desktop.'});
              if(!data||Object.keys(data).join(',')!=='leitura'||typeof data.leitura!=='boolean')return json(400,{erro:'Envie somente a escolha booleana de leitura.'});
              const sessao=conexao?.sessaoLabels?.();
              if(!sessao)return json(409,{erro:'Conecte a conta desktop antes de escolher a leitura.'});
              whatsappLabels.consentir(sessao,data.leitura);
              return json(200,respostaWhatsAppLabels(whatsappLabels.estado(sessao)));
            }
            if(url.pathname==='/api/v3/lembretes')return json(200,lembretes.configurar(data));
            if(url.pathname==='/api/v3/lembretes/testar')return json(200,await lembretes.testar(data));
            if(url.pathname.startsWith('/api/v3/atualizacoes/')){
              if(!atualizacoes)return json(404,{erro:'Atualizações automáticas indisponíveis nesta instalação.'});
              const acao=url.pathname.slice('/api/v3/atualizacoes/'.length);
              if(!['verificar','baixar','instalar'].includes(acao))return json(404,{erro:'Não encontrado'});
              return json(200,await atualizacoes.executar(acao));
            }
            if(url.pathname.startsWith('/api/v3/central/')){
              if(url.pathname==='/api/v3/central/feedback-rascunho'){
                if(!desktop)return json(404,{erro:'Abra o aplicativo desktop.'});
                if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).join(',')!=='rascunho'||data.rascunho!==null&&!feedbackRascunhoValido(data.rascunho))return json(400,{erro:'Rascunho inválido.'});
                if(data.rascunho===null)db.prepare('DELETE FROM desktop_config WHERE chave=?').run(FEEDBACK_DRAFT_KEY);
                else db.prepare('INSERT INTO desktop_config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(FEEDBACK_DRAFT_KEY,JSON.stringify(data.rascunho));
                return json(200,{guardado:true});
              }
              if(!central)return json(404,{erro:'Central indisponível nesta instalação.'});
              const acao=url.pathname.slice('/api/v3/central/'.length),chaves=data&&typeof data==='object'&&!Array.isArray(data)?Object.keys(data).sort().join(','):'';
              try{
                if(acao==='consentir'&&chaves==='confirmar,convite'&&data.confirmar===true)return json(200,await central.consentir(data.convite));
                if(acao==='autorizar-feedback'&&chaves==='convite')return json(200,await central.autorizarFeedback(data.convite));
                if(acao==='ativar-acompanhamento'&&chaves==='confirmar'&&data.confirmar===true)return json(200,await central.ativarAcompanhamento());
                if(acao==='desativar-acompanhamento'&&chaves==='confirmar'&&data.confirmar==='DESLIGAR')return json(200,await central.desativarAcompanhamento());
                if(acao==='revogar'&&chaves==='confirmar'&&data.confirmar==='REVOGAR')return json(200,await central.revogar());
                if(acao==='feedback'&&['categoria,chaveCliente,etapa,relato,utilidade','categoria,chaveCliente,contatoAutorizado,etapa,relato,utilidade'].includes(chaves)){
                  if(!feedbackRascunhoValido(data)||data.relato.trim().length<8)return json(400,{erro:'Confira os campos do feedback.'});
                  const recibo=await central.enviarFeedback(data);
                  const rascunho=lerFeedbackRascunho();
                  if(rascunho?.chaveCliente===data.chaveCliente)db.prepare('DELETE FROM desktop_config WHERE chave=?').run(FEEDBACK_DRAFT_KEY);
                  return json(200,recibo);
                }
                if(acao==='feedback')return json(400,{erro:'Confira os campos do feedback.'});
                if(['consentir','autorizar-feedback','ativar-acompanhamento','desativar-acompanhamento','revogar'].includes(acao))return json(400,{erro:'Confirme a ação com os campos esperados.'});
                return json(404,{erro:'Não encontrado'});
              }catch{return json(503,{erro:'A Central não está disponível agora. O Lume continua funcionando.'});}
            }
            if(url.pathname.startsWith('/api/v3/novidades/')){
              if(!novidades)return json(404,{erro:'Novidades indisponíveis nesta instalação.'});
              const acao=url.pathname.slice('/api/v3/novidades/'.length),chaves=Object.keys(data).sort().join(',');
              if(acao==='ativar'&&chaves==='confirmar'&&data.confirmar===true)return json(200,novidades.ativar());
              if(acao==='desativar'&&chaves==='confirmar'&&data.confirmar==='DESLIGAR')return json(200,novidades.desativar());
              if(acao==='verificar'&&chaves==='')return json(200,await novidades.verificar());
              if(['ativar','desativar','verificar'].includes(acao))return json(400,{erro:'Confirme a ação com os campos esperados.'});
              return json(404,{erro:'Não encontrado'});
            }
            if(url.pathname.startsWith('/api/v3/projetos-comerciais/')){
              if(!projetosComerciais)return json(404,{erro:'Abra o aplicativo desktop.'});
              const acao=url.pathname.slice('/api/v3/projetos-comerciais/'.length);
              const contrato={
                'importados/previa':{exigidos:['id'],opcionais:[]},
                'importados/revalidar':{exigidos:['previaId','confirmar'],opcionais:[]},
                'acoes/previa':{exigidos:['acaoIds'],opcionais:[]},
                'acoes/rascunho':{exigidos:['previaId','nome','confirmar'],opcionais:['natureza']},
                rascunho:{exigidos:['nome','fontes'],opcionais:['natureza','chave']},
                vincular:{exigidos:['id','eventoId'],opcionais:['trecho','inicio']},
                desvincular:{exigidos:['id','fonteId'],opcionais:[]},
                confirmar:{exigidos:['id','confirmar'],opcionais:[]},
                arquivar:{exigidos:['id','confirmar'],opcionais:[]},
                restaurar:{exigidos:['id','confirmar'],opcionais:[]}
              };
              if(!Object.hasOwn(contrato,acao))return json(404,{erro:'Não encontrado'});
              const {exigidos,opcionais}=contrato[acao];
              if(url.search||!data||typeof data!=='object'||Array.isArray(data)||exigidos.some(k=>!Object.hasOwn(data,k))||Object.keys(data).some(k=>!exigidos.includes(k)&&!opcionais.includes(k))||exigidos.includes('confirmar')&&data.confirmar!==true)return json(400,{erro:'Confira os campos do projeto.',codigo:'PROJETO_INVALIDO'});
              try{
                if(acao==='importados/previa')return json(200,{previa:projetosComerciais.prepararImportado(data)});
                if(acao==='importados/revalidar')return json(200,{projeto:projetosComerciais.revalidarImportado(data)});
                if(acao==='acoes/previa')return json(200,{previa:projetosComerciais.previaDeAcoes(data)});
                if(acao==='acoes/rascunho')return json(200,{projeto:projetosComerciais.criarRascunhoDeAcoes(data)});
                if(acao==='rascunho')return json(200,{projeto:projetosComerciais.criarRascunho(data)});
                if(acao==='vincular')return json(200,{vinculo:projetosComerciais.vincularFonte(data)});
                if(acao==='desvincular')return json(200,{vinculo:projetosComerciais.desvincularFonte(data)});
                return json(200,{projeto:projetosComerciais[acao]({id:data.id,confirmar:data.confirmar})});
              }catch(e){
                if(['PROJETO_IMPORTADO_INDISPONIVEL','PREVIA_DESATUALIZADA','PREVIA_EXPIRADA'].includes(e?.codigo))return json(409,{erro:'A revisão venceu ou as fontes mudaram. Reabra o projeto e confira as permissões.',codigo:e.codigo});
                if(['PROJETO_INDISPONIVEL','FONTE_INDISPONIVEL'].includes(e?.codigo))return json(409,{erro:'A fonte ou a permissão mudou. Confira o projeto antes de continuar.',codigo:e.codigo});
                if(e?.codigo==='CONFLITO_IDEMPOTENCIA')return json(409,{erro:'Esta identificação já foi usada para outro rascunho.',codigo:e.codigo});
                return json(400,{erro:'Não foi possível alterar o projeto. Confira os campos e as fontes.',codigo:'PROJETO_INVALIDO'});
              }
            }
            if(url.pathname.startsWith('/api/v3/vendas/')){
              if(!vendas)return json(404,{erro:'Abra o aplicativo desktop.'});
              const acao=url.pathname.slice('/api/v3/vendas/'.length);
              const campos={
                'jev/configurar':['chave'], 'jev/remover':[], preparar:['conversa_id'],
                avaliar:['confirmar','previa_id'], corrigir:['confirmar','conversa_id','etapa','temperatura']
              };
              if(!Object.hasOwn(campos,acao))return json(404,{erro:'Não encontrado'});
              try{
                consultaVendas(url,[]);
                const recebidos=data&&typeof data==='object'&&!Array.isArray(data)?Object.keys(data).sort().join(','):null;
                if(recebidos!==campos[acao].join(',')&&!(acao==='preparar'&&recebidos==='conversa_id,fonte_ids')&&!(acao==='corrigir'&&recebidos==='andamento,assunto,confirmar,continuidade,conversa_id,etapa,temperatura'))return json(400,{erro:'Confira os campos da avaliação.',codigo:'JEV_ENTRADA_INVALIDA'});
                if(acao==='jev/configurar'){pessoal?.classificador?.invalidar({desativar:true});return json(200,await vendas.configurar(data));}
                if(acao==='jev/remover'){pessoal?.classificador?.invalidar({desativar:true});return json(200,await vendas.remover());}
                if(acao==='preparar')return json(200,{previa:vendas.preparar(data)});
                if(acao==='corrigir'){pessoal?.classificador?.invalidar();return json(200,{avaliacao:vendas.corrigir(data)});}
                return json(200,{avaliacao:await vendas.avaliar(data)});
              }catch(e){const {status,...erro}=erroVendas(e);return json(status,erro);}
            }
            if(url.pathname==='/api/v3/historico/recuperar'){
              if(!conexao?.historico)return json(503,{erro:'A recuperação de histórico não está disponível nesta conexão.',codigo:'HISTORICO_INDISPONIVEL'});
              try{consultaEstrita(url,[]);}catch{return json(400,{erro:'Confira os campos da recuperação.',codigo:'INVALID_INPUT'});}
              if(!data||Array.isArray(data)||Object.keys(data).sort().join(',')!=='conversa_id,modo'||typeof data.conversa_id!=='string'||!data.conversa_id||data.conversa_id.length>160||!['retomar','anteriores'].includes(data.modo))return json(400,{erro:'Confira os campos da recuperação.',codigo:'INVALID_INPUT'});
              if(db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get()?.valor==='1')return json(409,{erro:'Retome a captura antes de pedir histórico ao WhatsApp.',codigo:'HISTORICO_CANCELADO'});
              try{return json(200,{recuperacao:await conexao.historico.recuperar(conexao,{conversaId:data.conversa_id,modo:data.modo})});}
              catch(e){const {status,...erro}=erroHistorico(e);return json(status,erro);}
            }
            if(url.pathname.startsWith('/api/v3/execucoes/')){
              if(!execucoes)return json(404,{erro:'Abra o aplicativo desktop.'});
              try{
                consultaEstrita(url,[]);
                const acao=url.pathname.slice('/api/v3/execucoes/'.length);
                if(acao==='projeto'){
                  if(!data||Array.isArray(data)||Object.keys(data).length||typeof selecionarProjeto!=='function')throw new ExecucaoErro('INVALID_INPUT');
                  const versao=++selecaoProjetoVersao;
                  limparProjetosSelecionados();
                  const escolhido=await selecionarProjeto();
                  if(versao!==selecaoProjetoVersao)return json(200,{cancelado:true});
                  if(!escolhido)return json(200,{cancelado:true});
                  const info=await lstat(escolhido);
                  if(!info.isDirectory()||info.isSymbolicLink())throw new ExecucaoErro('INVALID_INPUT');
                  const origem=await realpath(escolhido),projeto_id=randomBytes(16).toString('hex');
                  let inventario;
                  try{inventario=await listarArquivosProjeto({origem:escolhido});}
                  catch(error){throw new ExecucaoErro(error?.message==='PROJECT_TOO_LARGE'?'PROJECT_TOO_LARGE':'SOURCE_CHANGED');}
                  if(versao!==selecaoProjetoVersao)return json(200,{cancelado:true});
                  const projeto={id:projeto_id,origem,nome:basename(origem),expira:Date.now()+15*60000,
                    arquivosPermitidos:inventario.arquivos.map(arquivo=>arquivo.caminho)};
                  projetosSelecionados.set(projeto_id,projeto);
                  expiracaoProjeto=setTimeout(()=>{if(projetosSelecionados.get(projeto_id)===projeto)limparProjetosSelecionados();},15*60000);
                  expiracaoProjeto.unref?.();
                  return json(200,{projeto:{id:projeto.id,nome:projeto.nome,expira_em:new Date(projeto.expira).toISOString(),...inventario}});
                }
                if(acao==='contexto')return json(200,execucoes.preparar(data));
                if(acao==='iniciar'){
                  // The selected-file preview must not authorize a runner that
                  // the product has not wired and proved natively yet.
                  if(data?.aceite)throw new ExecucaoErro('CODEX_NATIVE_NOT_READY');
                  return json(200,execucoes.iniciar(data));
                }
                if(acao==='progresso')return json(200,execucoes.registrar('progresso',data));
                if(acao==='resultado')return json(200,execucoes.registrar('resultado',data));
                if(acao==='verificar')return json(200,execucoes.registrar('verificacao',data));
                if(acao==='revogar')return json(200,execucoes.revogar(data));
                return json(404,{erro:'Não encontrado'});
              }catch(e){const seguro=e instanceof ExecucaoErro?e:new ExecucaoErro('INTERNAL_ERROR');return json(seguro.status,{erro:seguro.message,codigo:seguro.code});}
            }
            if(url.pathname.startsWith('/api/v3/mcp/')){
              if(!mcp)return json(404,{erro:'Abra o aplicativo desktop para conectar um assistente.'});
              const acao=url.pathname.slice('/api/v3/mcp/'.length),chaves=Object.keys(data).sort().join(',');
              if(acao==='ativar-claude'&&(chaves==='confirmar'||chaves==='confirmar,renovar'))return json(200,mcp.ativarClaudeHoje({confirmar:data.confirmar,renovar:data.renovar}));
              if(acao==='revogar-claude'&&chaves==='confirmar')return json(200,mcp.revogarClaude({confirmar:data.confirmar}));
              if(acao==='testar-local'&&chaves===''){
                try{return json(200,await mcp.testarClaudeLocal());}
                catch(e){
                  const mensagens={NAO_PREPARADO:'Prepare o acesso antes de fazer o teste local.',PACOTE_INDISPONIVEL:'A extensão do Lume não está disponível nesta instalação.',SISTEMA_INCOMPATIVEL:'Este sistema ainda não é compatível com a extensão do Lume.',MEMORIA_INDISPONIVEL:'A memória local do Lume não está disponível.',LUME_FECHADO:'Mantenha o Lume aberto para fazer o teste local.'};
                  return json(400,{erro:mensagens[e?.code]||'O teste local não passou. Feche e abra o Lume e tente novamente.'});
                }
              }
              if(['ativar-claude','revogar-claude','testar-local'].includes(acao))return json(400,{erro:'Confirme a ação com os campos esperados.'});
              return json(404,{erro:'Não encontrado'});
            }
            if(url.pathname==='/api/v3/negocios/preparar'){const p=negocios.preparar(data);return json(200,{...p,mensagem:produto.fonte(p.fonte)});}
            if(url.pathname==='/api/v3/negocios/salvar'){const salvo=negocios.salvar(data);lembretes.invalidar();return json(200,salvo);}
            if(url.pathname.startsWith('/api/v3/audio/')){
              if(!audio)return json(404,{erro:'Abra o perfil desktop com armazenamento de anexos.'});
              const acao=url.pathname.slice('/api/v3/audio/'.length);
              if(acao==='preparar')return json(200,await audio.preparar(data));
              if(acao==='ler')return json(200,audio.ler(data));
              if(acao==='baixar')return json(200,await audio.baixar(data));
              if(acao==='transcrever')return json(200,await audio.transcrever(data));
              if(acao==='cancelar')return json(200,audio.cancelar({id:data?.id}));
              return json(404,{erro:'Não encontrado'});
            }
            if(url.pathname.startsWith('/api/v3/tarefas/')){
              if(!tarefas)return json(404,{erro:'Abra o aplicativo desktop.'});
              const acao=url.pathname.slice('/api/v3/tarefas/'.length);
              if(acao==='config')return json(200,tarefas.configurar(data));
              if(acao==='pausar'){tarefas.pausar();return json(200,tarefas.estado());}
              if(acao==='preparar')return json(200,tarefas.preparar(data));
              if(acao==='gerar')return json(200,await tarefas.gerar({id:data?.id,confirmar:data?.confirmar}));
              if(acao==='decidir')return json(200,tarefas.decidir(data));
              return json(404,{erro:'Não encontrado'});
            }
            if(url.pathname.startsWith('/api/v3/acoes/')){
              if(!acoes)return json(404,{erro:'Abra o aplicativo desktop.'});
              const acao=url.pathname.slice('/api/v3/acoes/'.length);
              if(acao==='organizar'){
                if(!filaLaya)return json(404,{erro:'Abra o aplicativo desktop.'});
                if(!data||Array.isArray(data)||Object.keys(data).sort().join('|')!=='conversa|limite')return json(400,{erro:'Escolha uma conversa e o tamanho do recorte.'});
                return json(200,filaLaya.organizarConversa(data));
              }
              if(acao==='cancelar-analise'){
                if(!filaLaya)return json(404,{erro:'Abra o aplicativo desktop.'});
                if(!data||Array.isArray(data)||Object.keys(data).join('|')!=='conversa')return json(400,{erro:'Escolha a conversa para cancelar.'});
                return json(200,filaLaya.cancelarConversa(data));
              }
              if(acao==='autorizar'){
                if(!data||Array.isArray(data)||Object.keys(data).sort().join('|')!=='conversa|permitida')return json(400,{erro:'Escolha uma conversa e a permissão local.'});
                const resultado=acoes.autorizar(data);if(!data.permitida)lembretesAcoes?.invalidar();filaLaya?.sinalizar();return json(200,resultado);
              }
              if(acao==='revisar'){
                if(!data||Array.isArray(data)||Object.keys(data).some(k=>!['id','acao','lembrarEm','fuso','motivo'].includes(k)))return json(400,{erro:'Revisão de ação inválida.'});
                return json(200,acoes.revisar(data));
              }
              if(acao==='corrigir'){
                if(!data||Array.isArray(data)||Object.keys(data).sort().join('|')!=='id|resumo')return json(400,{erro:'Correção de ação inválida.'});
                return json(200,acoes.corrigir(data));
              }
              if(acao==='minha'){
                if(!data||Array.isArray(data)||Object.keys(data).sort().join('|')!=='id|minha')return json(400,{erro:'Responsabilidade de ação inválida.'});
                return json(200,acoes.definirMinha(data));
              }
              if(acao==='som'){
                if(!lembretesAcoes||!data||Array.isArray(data)||Object.keys(data).join('|')!=='som')return json(400,{erro:'Preferência de som inválida.'});
                return json(200,lembretesAcoes.configurarSom(data));
              }
              return json(404,{erro:'Não encontrado'});
            }
            if(url.pathname.startsWith('/api/v3/dados/')){
              if(!privacidade)return json(404,{erro:'Abra o perfil desktop para administrar dados.'});
              const acao=url.pathname.slice('/api/v3/dados/'.length);
              if(acao==='backup-v10/criar')return json(200,await backupV10.export(data.senha));
              if(acao==='backup-v10/restaurar')return json(200,await backupV10.restore(data.id,data.confirmarMeuBackup));
              if(acao==='preparar-exclusao')return json(200,privacidade.preparar(data));
              if(acao==='exportar')return json(200,privacidade.exportar(data));
              if(acao==='backup'){privacidade.schemaConhecido();return json(200,await backup.criar(data));}
              if(acao==='preparar-restauracao')return json(200,await backup.preparar(data));
              if(acao==='excluir'||acao==='restaurar'){
                if(acao==='excluir'&&data.confirmar!=='APAGAR'||acao==='restaurar'&&data.confirmarMeuBackup!==true)throw new Error('Confirme a operação antes de continuar.');
                if(acao==='restaurar'&&backup.ocupado)throw new Error('Aguarde a operação de backup terminar.');
                alterandoDados=true;
                try{await pausarDados({restaurar:acao==='restaurar'});return json(200,acao==='excluir'?privacidade.excluir(data):backup.restaurar(data));}finally{alterandoDados=false;}
              }
              if(acao==='retomar-limpeza'){
                alterandoDados=true;
                try{await pausarDados();if(audio)audio.limpeza=audio.arquivos.recuperar();return json(200,{audios:audio?.limpeza,exclusoes:arquivosDados?.recuperar(db),restauracoes:arquivosDados?.recuperarRestauracoes(db)});}finally{alterandoDados=false;}
              }
              return json(404,{erro:'Não encontrado'});
            }
            if(url.pathname.startsWith('/api/v3/compartilhamento/')) {
              if(!compartilhamento)return json(404,{erro:'Abra o aplicativo desktop.'});
              const acao=url.pathname.slice('/api/v3/compartilhamento/'.length);
              if(acao==='identidade')return json(200,await compartilhamento.criarIdentidade());
              if(acao==='projeto')return json(201,compartilhamento.f.criarProjeto(data));
              if(acao==='preparar-exportacao')return json(200,compartilhamento.prepararExportacao(data));
              if(acao==='exportar')return json(200,await compartilhamento.exportar(data));
              if(acao==='preparar-importacao')return json(200,compartilhamento.prepararImportacao(data));
              if(acao==='importar')return json(200,compartilhamento.importar(data));
              if(acao==='preparar-remocao')return json(200,compartilhamento.prepararRemocao(data));
              if(acao==='remover-origem'){
                if(data.confirmar!=='REMOVER'||!data.id)throw new Error('Confira a prévia e digite REMOVER.');
                alterandoDados=true;
                try{await pausarDados();return json(200,compartilhamento.removerOrigem(data));}finally{alterandoDados=false;}
              }
              return json(404,{erro:'Não encontrado'});
            }
            if(url.pathname==='/api/v3/politica') { const resultado=produto.politica(data);vendas?.invalidar();lembretes.invalidar();negocios.previas.clear(); tarefas?.pausar();assistente?.invalidar(); return json(200,resultado); }
            if(url.pathname==='/api/v3/resolver') return json(200,produto.resolver(data));
            if(url.pathname==='/api/v3/nota') return json(201,contexto.nota(data));
            if(url.pathname==='/api/v3/semantica/ativar') {
              if(!semantica) return json(503,{erro:'Modelo local indisponível.'});
              if(data.baixar!==true) return json(400,{erro:'Confirme o download do modelo público antes de ativar.'});
              const ativacao=acompanhar(semantica.ativar({baixar:true}),jobs);
              void ativacao.catch(()=>{});
              return json(202,{ok:true,estado:semantica.estado()});
            }
            if(url.pathname==='/api/v3/semantica/pausar') return json(200,semantica?.pausar() || {ativa:false});
            if(url.pathname.startsWith('/api/v3/ia/')) {
              if(!assistente) return json(404,{erro:'Abra o aplicativo desktop para usar IA.'});
              if(url.pathname==='/api/v3/ia/config'){tarefas?.pausar();return json(200,await assistente.configurar(data));}
              if(url.pathname==='/api/v3/ia/remover-chave'){tarefas?.pausar();return json(200,await assistente.removerChave());}
              if(url.pathname==='/api/v3/ia/permissao'){tarefas?.pausar();return json(200,assistente.permitir(data));}
              if(url.pathname==='/api/v3/ia/preparar') return json(200,await assistente.prepararConsulta(data));
              if(url.pathname==='/api/v3/ia/responder') return json(200,await assistente.responder(data));
            }
          }catch(e){return json(400,{erro:e.message});}
        }
        if(url.pathname==='/api/notas') {try{return json(201,contexto.nota(data));}catch(e){return json(400,{erro:e.message});}}
        // Testa contra a API de verdade ANTES de gravar. "Salvo" e "funcionando" sao
        // coisas diferentes, e e essa diferenca que vira chamado de suporte depois.
        if(url.pathname==='/api/config/chave') {
          const r=await testarChave(data.chave);
          if(!r.ok) return json(400,r);
          try{
            const grava={GEMINI_API_KEY:String(data.chave).trim()};
            if(typeof data.dono==='string'&&data.dono.trim()) grava.ASSESSOR_DONO=data.dono.trim();
            gravarEnv(grava);
            // Vale ja nesta execucao: sem isto a pessoa precisaria reiniciar o app
            // depois de configurar, e ninguem avisaria ela disso.
            process.env.GEMINI_API_KEY=grava.GEMINI_API_KEY;
            if(grava.ASSESSOR_DONO) process.env.ASSESSOR_DONO=grava.ASSESSOR_DONO;
          }catch(e){return json(500,{ok:false,erro:'A chave funciona, mas nao consegui gravar o arquivo: '+e.message});}
          return json(200,{...r,gravada:true});
        }
        // Marcar lixo e reversivel: `descartado` e mudanca de estado, nunca remocao.
        if(url.pathname==='/api/crm/falso-positivo') {
          try{
            const r=data.desfazer
              ? desmarcar(db,{itemId:data.itemId})
              : marcarFalsoPositivo(db,{itemId:data.itemId,motivo:data.motivo});
            return json(200,{ok:true,mudou:r});
          }catch(e){ return json(400,{erro:e.message}); }
        }
        if(url.pathname==='/api/conectar') {
          if(desktop){
            const exclusoes=arquivosDados?.recuperar(db),restauracoes=arquivosDados?.recuperarRestauracoes(db);
            if(exclusoes?.pendentes||restauracoes?.pendentes)return json(409,{erro:'Há arquivos pendentes de exclusão ou restauração. Confira a seção de recibos antes de retomar a captura.'});
            db.prepare("INSERT INTO desktop_config VALUES('captura_pausada','0') ON CONFLICT(chave) DO UPDATE SET valor='0'").run();
          }
          await conexao.iniciar();await midiaLoop?.iniciar?.();return json(200,{ok:true});
        }
        if(url.pathname==='/api/desconectar') {vendas?.invalidar();if(desktop)db.prepare("INSERT INTO desktop_config VALUES('captura_pausada','1') ON CONFLICT(chave) DO UPDATE SET valor='1'").run();await midiaLoop?.parar?.();await conexao.parar();return json(200,{ok:true});}
        if(url.pathname==='/api/grupos/sincronizar') {
          try {
            const resultado=await conexao.sincronizarGrupos();
            if(!resultado)return json(409,{erro:'Conecte o WhatsApp antes de sincronizar grupos.'});
            return json(200,{ok:true,total:Object.keys(resultado).length});
          }catch(e){return json(e.code==='GRUPOS_INDISPONIVEIS'?409:502,{erro:'Não foi possível sincronizar os grupos. Verifique a conexão e tente novamente.'});}
        }
        if(url.pathname==='/api/crm/estado') {
          const id=Number(data?.id);const estado=String(data?.estado||'');
          if(!Number.isSafeInteger(id)||!['aberto','resolvido','descartado','expirado'].includes(estado))
            return json(400,{erro:'Item ou estado inválido'});
          try{
            // `estado` existia e nunca mudava de valor. Sem saber QUANDO mudou e por
            // quem, a taxa de falso positivo do CRM continua impossível de medir.
            const r=db.prepare('UPDATE itens_crm SET estado=?,estado_em=?,estado_motivo=? WHERE id=?')
              .run(estado,new Date().toISOString(),estado==='aberto'?null:'decidido no painel',id);
            return json(r.changes?200:404,{ok:Boolean(r.changes)});
          }catch(e){return json(500,{erro:'Não foi possível atualizar o item.'});}
        }
        if(url.pathname==='/api/caixas/backfill') {
          if(!coletor) return json(503,{erro:'Coletor de caixas indisponível.'});
          const limiteBruto=Number(data?.limite??1000);
          const limite=Number.isSafeInteger(limiteBruto)&&limiteBruto>0?Math.min(limiteBruto,5000):1000;
          try{
            const resumo=await coletor.backfillDoBanco({limite});
            return json(resumo.ok?200:409,resumo);
          }catch(e){return json(502,{erro:'Backfill falhou.',detalhe:e?.message});}
        }
      }
      return json(404,{erro:'Não encontrado'});
    }catch{if(!res.destroyed){if(!res.headersSent)json(500,{erro:'Operação falhou. Verifique o estado da conexão.'});else res.end();}}
  }
  // Operações v10 podem levar mais de dez minutos no acervo medido; o upload
  // continua limitado em bytes pelo bridge, e os demais POSTs pelo parser.
  server.requestTimeout=desktop||notetaker?0:15000;server.headersTimeout=10000;
  let timerTarefas=null,execucaoAutomatica=null;
  if(tarefas){
    server.on('listening',()=>{if(fechado)return;timerTarefas=setInterval(()=>{if(fechado||alterandoDados||execucaoAutomatica)return;const job=tarefas.executarAutomatico().catch(()=>tarefas.pausar('Automação interrompida. Confira os dados antes de reativar.')).finally(()=>{execucaoAutomatica=null;});execucaoAutomatica=acompanhar(job,jobs);},produtores?.intervaloTarefasMs??30000);timerTarefas.unref();});
  }
  let timerLembretes;
  const lembrar=()=>{if(fechado||alterandoDados||!lembretesAcoes)return;const job=acompanhar(lembretesAcoes.executar().then(r=>!fechado&&r.resultado==='sem-aviso'?lembretes.executar():null),jobs);void job.catch(()=>{});};
  if(desktop&&notificacoes)server.on('listening',()=>{if(fechado)return;lembrar();timerLembretes=setInterval(lembrar,60000);timerLembretes.unref();});
  const fecharLembretes=()=>{clearInterval(timerLembretes);for(const recurso of [lembretes,lembretesAcoes])try{recurso?.encerrar();}catch(error){falhas.push(error);}};
  server.cortarAdmissao=()=>{
    if(fechado)return false;
    fechado=true;
    intakeController.abort();
    if(atividade){const drain=acompanhar(atividade.encerrar(),jobs);void drain.catch(error=>falhas.push(error));}
    clearInterval(timerTarefas);fecharLembretes();
    for(const invalidar of [()=>vendas?.invalidar(),()=>assistente?.invalidar()])try{invalidar();}catch(error){falhas.push(error);}
    if(falhas.length)throw new AggregateError(falhas,'Falha ao cortar admissão do painel.');
    return true;
  };
  const fecharHttp=server.close.bind(server),ouvir=server.listen.bind(server);
  let bindResultado=null;
  server.listen=(...args)=>{
    if(fechado)throw new Error('SERVIDOR_ENCERRADO');
    let concluir;
    const anterior=bindResultado;
    const tentativa=new Promise(resolve=>{concluir=resolve;});
    const abriu=()=>{server.off('error',falhou);concluir({});};
    const falhou=error=>{server.off('listening',abriu);concluir({error});};
    server.once('listening',abriu);
    server.once('error',falhou);
    try{
      const result=ouvir(...args);
      bindResultado=tentativa;
      return result;
    }catch(error){server.off('listening',abriu);server.off('error',falhou);bindResultado=anterior;throw error;}
  };
  server.encerrar=()=>{
    if(encerrando)return encerrando;
    ++selecaoProjetoVersao;
    limparProjetosSelecionados();
    try{server.cortarAdmissao();}catch(error){if(!falhas.includes(error))falhas.push(error);}
    const http=(async()=>{
      const bind=await bindResultado;
      if(bind?.error)throw bind.error;
      if(!server.listening)return;
      await new Promise((resolve,reject)=>{
        try{fecharHttp(error=>error?reject(error):resolve());server.closeAllConnections();}
        catch(error){reject(error);}
      });
    })();
    encerrando=(async()=>{
      const resultados=await Promise.allSettled([http]);
      for(const result of resultados)if(result.status==='rejected')falhas.push(result.reason);
      while(handlers.size||jobs.size)await Promise.allSettled([...handlers,...jobs]);
      if(falhas.length)throw new AggregateError(falhas,'Falha ao encerrar o painel.');
    })();
    return encerrando;
  };
  server.close=callback=>{const result=server.encerrar();if(callback)void result.then(()=>callback(),callback);else void result.catch(()=>{});return server;};
  return server;
}
