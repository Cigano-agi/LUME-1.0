// Processo exclusivo do aplicativo. Não carrega .env nem abre o banco do checkout.
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { abrirBanco } from '../src/banco.js';
import {AtividadeApps} from '../src/atividade-apps.js';
import {criarColetorApps} from '../src/atividade-apps-nativo.js';
import { ContextoApp } from '../src/contexto-app.js';
import {reconciliarCicloFontes} from '../src/ciclo-captura.js';
import {MidiaArquivos} from '../src/ciclo-midia-worker.js';
import {CicloMidiaLoop} from '../src/ciclo-midia-loop.js';
import { Conexao } from '../src/transporte/socket.js';
import { HistoricoWhatsApp } from '../src/transporte/historico.js';
import { criarServidor } from '../src/painel/servidor.js';
import { Desktop } from '../src/desktop.js';
import { randomUUID } from 'node:crypto';
import { Semantica } from '../src/semantica.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {criarPonteLembretes} from './lembretes-ponte.js';
import {criarPonteAtualizacoes} from './atualizacoes-ponte.js';
import {criarPonteCentral,whatsappParaCentral} from './central-ponte.js';
import {Novidades,carregarPoliticaComunicados} from '../src/novidades.js';
import {LumeMcpDesktopService} from '../src/mcp/desktop-service.js';
import {startLumeAppPresence} from '../src/mcp/presence.js';
import {WhatsAppLabels} from '../src/whatsapp-labels.js';
import {criarLayaLocal} from '../src/laya/index.js';
import {FilaLaya} from '../src/laya/fila.js';
import {criarAudioLocalRuntime} from '../src/audio-local-runtime.js';
import politicaAudio from './audio-local-policy.json' with {type:'json'};
import {MonitorProgresso} from '../src/progresso.js';
import pacote from '../package.json' with {type:'json'};
import { validarEnvelopeLegado, erroPublicoPerfil } from '../src/perfil-boot.js';
import {criarEncerramentoDesktop} from './encerramento.js';
import {criarReciboUtility,observarDrenagem} from './utility-receipt.js';
import {TelegramHojeIntegracao} from '../src/telegram-integracao.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {ClassificadorPessoal} from '../src/pessoal/classificador.js';
import {ChatGPTPessoal} from '../src/pessoal/chatgpt.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {AudioPessoal} from '../src/pessoal/audio.js';
import {salvarNomesWhatsapp,recuperarNomesWhatsapp} from '../src/nomes-conversa.js';

let selection;
try { selection = await validarEnvelopeLegado(process.env); }
catch (error) {
  const safe = erroPublicoPerfil(error);
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  if (process.parentPort) {
    process.parentPort.postMessage({ tipo: 'perfil-erro', codigo: safe.code });
    await new Promise(resolveAck => {
      const timer = setTimeout(resolveAck, 1000);
      process.parentPort.once('message', ({ data }) => {
        if (data?.tipo === 'perfil-erro-recebido') { clearTimeout(timer); resolveAck(); }
      });
    });
  }
  process.exit(1);
}
const dados = selection.dataDir;
mkdirSync(dados, { recursive: true });
const db = abrirBanco(join(dados, 'assessor.db'));
const contexto = new ContextoApp(db);
let reconciliadorCiclo,recuperadorNomes;
const historico = new HistoricoWhatsApp(db);
const produto = new Desktop(db);
const coletorApps=criarColetorApps();
const atividadeApps=new AtividadeApps(db,{...coletorApps,sistemaPausado:true});
process.parentPort?.on('message',({data})=>{if(data?.tipo==='atividade-sistema'&&typeof data.pausado==='boolean'&&!fechando)atividadeApps.sistema(data.pausado);});
const arquivosDados=new ArquivosDados(dados);
const arquivosMidia=new MidiaArquivos(db,arquivosDados);
const recuperacaoArquivos=arquivosDados.recuperar(db),recuperacaoRestauro=arquivosDados.recuperarRestauracoes(db);
if(recuperacaoArquivos.pendentes||recuperacaoRestauro.pendentes)db.prepare("INSERT INTO desktop_config VALUES('captura_pausada','1') ON CONFLICT(chave) DO UPDATE SET valor='1'").run();
const authDir = join(dados, 'wa-auth');
const whatsappLabels=new WhatsAppLabels(db);
let filaLaya,pessoal;
let fechando=false;
const publicarEstadoCentral=estado=>{if(fechando)return;try{process.parentPort?.postMessage({tipo:'central-operacional',whatsappEstado:whatsappParaCentral(estado?.estado)});}catch{}};
const conexao = new Conexao({
  authDir,
  historico,
  aoLote: lote => {if(fechando)throw new Error('INTAKE_FECHADO');const resultado=contexto.receber(lote);filaLaya?.sinalizar();return resultado;},
  aoNomes: lote => {if(fechando)throw new Error('INTAKE_FECHADO');return salvarNomesWhatsapp(db,lote);},
  aoAtualizarMensagens: updates => {if(fechando)return;return contexto.atualizarMensagens(updates);},
  aoRemoverMensagens: evento => {if(fechando)return;return contexto.removerMensagens(evento);},
  aoRecibos: updates => {if(!fechando)pessoal?.receberRecibos(updates);},
  autorizarEnvio: (jid,id,texto) => !fechando&&pessoal?.autorizarTransporte(jid,id,texto)===true,
  aoGrupos: grupos => {if(fechando)return;return contexto.salvarGrupos(grupos);},
  whatsappLabels,
  aoEstado: publicarEstadoCentral
});
const pendentes = new Map();
const projetosPendentes = new Map();
function selecionarProjeto() {
  if (fechando || !process.parentPort) return Promise.reject(new Error('SELETOR_INDISPONIVEL'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { projetosPendentes.delete(id); reject(new Error('SELETOR_INDISPONIVEL')); }, 60000);
    projetosPendentes.set(id, { resolve, reject, timer });
    process.parentPort.postMessage({ tipo: 'selecionar-projeto', id });
  });
}
process.parentPort?.on('message', ({ data }) => {
  if (data?.tipo !== 'selecionar-projeto-resposta') return;
  const pending = projetosPendentes.get(data.id); if (!pending) return;
  clearTimeout(pending.timer); projetosPendentes.delete(data.id);
  if (data.erro) pending.reject(new Error('SELETOR_INDISPONIVEL'));
  else pending.resolve(typeof data.caminho === 'string' ? data.caminho : null);
});
function segredo(operacao, valor) {
  if(fechando)return Promise.reject(new Error('O Lume está encerrando.'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pendentes.delete(id); reject(new Error('O serviço protegido não respondeu.')); }, operacao==='audio-converter'?40000:10000);
    pendentes.set(id, { resolve, reject, timer });
    process.parentPort.postMessage({ tipo: 'segredo', id, operacao, valor });
  });
}
process.parentPort?.on('message', ({ data }) => {
  if (data?.tipo !== 'segredo-resposta') return;
  const pending = pendentes.get(data.id); if (!pending) return;
  clearTimeout(pending.timer); pendentes.delete(data.id);
  if (data.erro) pending.reject(new Error(data.erro)); else pending.resolve(data.valor);
});
const segredos = { estado: () => segredo('estado'), ler: () => segredo('ler'), gravar: valor => segredo('gravar',valor), remover: () => segredo('remover') };
const segredosJev = {
  estado: () => segredo('openrouter-estado'),
  ler: () => segredo('openrouter-ler'),
  gravar: valor => segredo('openrouter-gravar', valor),
  remover: () => segredo('openrouter-remover')
};
const segredosTelegram = {
  estado: () => segredo('telegram-estado'),
  ler: () => segredo('telegram-ler'),
  gravar: valor => segredo('telegram-gravar',valor),
  remover: () => segredo('telegram-remover')
};
const cofrePessoal=tipo=>({estado:()=>segredo(tipo+'-estado'),ler:()=>segredo(tipo+'-ler'),gravar:v=>segredo(tipo+'-gravar',v),remover:()=>segredo(tipo+'-remover')});
const chatgpt=new ChatGPTPessoal(db,{cofre:cofrePessoal('chatgpt')});
const audioLocal = criarAudioLocalRuntime({
  raiz:process.env.LUME_AUDIO_BUNDLED_DIR,
  manifestoSha256:politicaAudio.versao===1?politicaAudio.pacotes?.[`${process.platform}-${process.arch}`]?.manifestoSha256:undefined
});
const semantica = new Semantica(db,{cacheDir:join(dados,'modelos')});
const laya=criarLayaLocal({modelDir:process.env.LUME_LAYA_BUNDLED_DIR||join(dados,'modelos','laya'),nomeDono:()=>produto.perfil().nome});
filaLaya=new FilaLaya(db,{laya,podeProcessar:()=>!fechando&&produto.perfil().aceito});
const preparoLaya=laya.preparar().then(ready=>{if(ready&&!fechando)filaLaya.sinalizar();}).catch(()=>{});
const notificacoes=criarPonteLembretes(process.parentPort,{suportado:process.env.LUME_NOTIFICACOES_SUPORTADAS==='1'});
const progresso=new MonitorProgresso(db,{conexao,notificar:()=>{void notificacoes.mostrar({categoria:'captura'}).catch(()=>{});}});
const versao=pacote.version;
const atualizacoes=criarPonteAtualizacoes(process.parentPort,{versao,suportado:process.env.LUME_ATUALIZACOES_SUPORTADAS==='1'});
const central=criarPonteCentral(process.parentPort);
const novidades=new Novidades(db,{politica:carregarPoliticaComunicados(new URL('./comunicados-policy.json',import.meta.url)),versao,plataforma:process.platform});
const mcp=new LumeMcpDesktopService({dataDir:dados});
const presencaMcp=startLumeAppPresence({dataDir:dados});
const telegram=new TelegramHojeIntegracao(db,{desktop:produto,segredos:segredosTelegram,fetchImpl:fetch});
const audioPessoal=new AudioPessoal(db,{arquivos:arquivosDados,audioLocal,
  converter:base64=>segredo('audio-converter',base64),ativo:()=>!fechando&&pessoal?.ativa()===true});
pessoal=new LumePessoal(db,{chatgpt,telegram,conexao,desktop:produto,semantica,
  transcrever:(eventoId,options)=>audioPessoal.transcrever(eventoId,options),
  credencial:async tipo=>{const cofre=cofrePessoal(tipo);return (await cofre.estado()).configurada?cofre.ler():null;}});
pessoal.salvarCredencial=(tipo,token)=>cofrePessoal(tipo).gravar(token);
pessoal.classificador=new ClassificadorPessoal(db,{pessoal,segredos:segredosJev});
pessoal.companheiro=new CompanheiroPessoal(db,{pessoal,conexao,disponivel:Boolean(process.parentPort),
  publicar:estado=>{if(!fechando)process.parentPort?.postMessage({tipo:'companheiro-estado',estado});}});
process.parentPort?.on('message',({data})=>{
  if(data?.tipo==='companheiro-preferencia'&&typeof data.id==='string'&&data.id.length<=80){
    let ok=false;try{if(!fechando){pessoal.companheiro.configurar(data.config);ok=true;}}catch{}
    process.parentPort?.postMessage({tipo:'companheiro-preferencia-resposta',id:data.id,ok});
  }
});
telegram.pessoal=pessoal;
const midiaLoop=new CicloMidiaLoop(db,{arquivos:arquivosMidia,
  podeProcessar:()=>!fechando&&produto.perfil().aceito&&
    db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get()?.valor!=='1',
  onError:()=>console.error('A fila local de mídia pausou uma tentativa; consulte a cobertura na conversa.')});
const server = criarServidor(db, { atividadeApps, contexto, conexao, progresso, desktop: true, whatsappLabels, segredos, segredosJev, audioLocal, semantica, laya, filaLaya, identidade:segredo, arquivosDados, notificacoes, atualizacoes,central,novidades,mcp,telegram,pessoal,midiaLoop,selecionarProjeto });
const indexador = setInterval(() => { if (!fechando && semantica.ativa()) semantica.indexar().catch(()=>{}); }, 5000);
indexador.unref();
let recibo;
let paradaConexao,paradaFila,paradaSemantica,paradaTelegram,paradaMidias,paradaPessoal,paradaAtividade;
function cortarProdutores(){
  if(fechando)return;
  fechando=true;
  clearInterval(indexador);
  paradaAtividade=observarDrenagem(atividadeApps.encerrar());
  clearInterval(reconciliadorCiclo);
    clearTimeout(recuperadorNomes);
  pessoal.companheiro.encerrar();
  paradaMidias=observarDrenagem(midiaLoop.parar());
    paradaPessoal=observarDrenagem(Promise.all([pessoal.encerrar(),pessoal.classificador.encerrar()]));
  for(const pendente of pendentes.values()){
    clearTimeout(pendente.timer);
    pendente.reject(new Error('O Lume está encerrando.'));
  }
  pendentes.clear();
  for(const pending of projetosPendentes.values()){
    clearTimeout(pending.timer); pending.reject(new Error('SELETOR_INDISPONIVEL'));
  }
  projetosPendentes.clear();
  server.cortarAdmissao();
  // Os três métodos invalidam entradas antes do primeiro await; os promises
  // permanecem no drain existente até seus trabalhos anteriores terminarem.
  paradaSemantica=observarDrenagem(semantica.encerrar());
  paradaConexao=observarDrenagem(conexao.encerrar());
  paradaFila=observarDrenagem(filaLaya.parar());
  paradaTelegram=observarDrenagem(telegram.encerrar());
}
const fechar=criarEncerramentoDesktop({
  cortar:cortarProdutores,
  drenar:[
    ()=>server.encerrar(),
    ()=>paradaAtividade??atividadeApps.encerrar(),
    ()=>paradaSemantica??semantica.encerrar(),
    ()=>paradaConexao??conexao.encerrar(),
    ()=>paradaFila??filaLaya.parar(),
    ()=>paradaMidias??midiaLoop.parar(),
    ()=>paradaTelegram??telegram.encerrar(),
    ()=>paradaPessoal??pessoal.encerrar(),
    ()=>laya.close(),
    ()=>preparoLaya,
    ()=>presencaMcp.stop(),
    ()=>notificacoes.encerrar(),
    ()=>atualizacoes.encerrar(),
    ()=>central.encerrar()
  ],
  fecharBanco:()=>db.close(),
  aposFecharBanco:()=>recibo.aguardarAck(),
  sair:codigo=>process.exit(codigo)
});
const solicitarFechamento=()=>{void fechar().catch(()=>{console.error('Falha ao encerrar o Lume.');process.exit(1);});};
recibo=criarReciboUtility({
  selection,
  postMessage:message=>process.parentPort.postMessage(message),
  cortarIntake:cortarProdutores,
  fechar,
  onError:()=>{console.error('Falha ao encerrar o Lume.');process.exit(1);}
});
process.parentPort?.on('message', ({ data }) => {
  if(data === 'shutdown'){recibo.cancelar();solicitarFechamento();return;}
  recibo.receber(data);
});
process.on('SIGTERM',()=>{recibo.cancelar();solicitarFechamento();});
server.listen(0, '127.0.0.1', () => {
  if(fechando)return;
  const recuperarNomes=()=>{
    if(fechando)return;
    try{
      const anterior=Number(db.prepare("SELECT valor FROM desktop_config WHERE chave='nomes-whatsapp-cursor'").get()?.valor||0);
      const r=recuperarNomesWhatsapp(db,{aposId:Number.isSafeInteger(anterior)&&anterior>=0?anterior:0,limite:200,maxBytes:4*1024*1024,maxMs:20});
      if(r.examinados)db.prepare("INSERT INTO desktop_config VALUES('nomes-whatsapp-cursor',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor").run(String(r.ultimoId));
      if(!r.concluido&&!fechando){recuperadorNomes=setTimeout(recuperarNomes,500);recuperadorNomes.unref?.();}
    }catch{console.error('Recuperação de nomes interrompida; será retomada ao abrir o Lume.');}
  };
  recuperadorNomes=setTimeout(recuperarNomes,500);recuperadorNomes.unref?.();
  filaLaya.iniciar();
  let cursorCiclo=0;
  const reconciliar=()=>{
    if(fechando)return;
    try{
      const resultado=reconciliarCicloFontes(db,{limite:250,cursor:cursorCiclo});
      cursorCiclo=resultado.cursor;
      if(!resultado.restam)clearInterval(reconciliadorCiclo);
    }
    catch{console.error('Reconciliação da fila de fontes falhou; nova tentativa em um minuto.');
      clearInterval(reconciliadorCiclo);reconciliadorCiclo=setInterval(reconciliar,60000);reconciliadorCiclo.unref?.();}
  };
  reconciliadorCiclo=setInterval(reconciliar,100);
  reconciliadorCiclo.unref?.();
  setImmediate(reconciliar);
  try{midiaLoop.iniciar();}catch{
    db.prepare("INSERT INTO desktop_config VALUES('captura_pausada','1') ON CONFLICT(chave) DO UPDATE SET valor='1'").run();
    console.error('A recuperação de mídia exigiu pausa da captura. Confira os anexos no perfil.');
  }
  void telegram.iniciar().catch(()=>{});
  pessoal.iniciar();
  pessoal.companheiro.iniciar();
  pessoal.classificador.iniciar();
  publicarEstadoCentral(conexao.estado());
  atividadeApps.iniciar();
  process.parentPort?.postMessage({ tipo: 'pronto', porta: server.address().port });
  if (produto.perfil().aceito && db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get()?.valor!=='1' && existsSync(join(authDir, 'creds.json'))) conexao.iniciar().catch(e => console.error(e.message));
});
