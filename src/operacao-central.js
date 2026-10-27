import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {normalizarListaFeedback} from './feedback-paginacao.js';

const PLATAFORMAS=new Set(['win32','darwin']);
const ARQUITETURAS=new Set(['x64','arm64']);
const CANAIS=new Set(['beta','estavel']);
const ESTADOS_ATUALIZACAO=new Set(['em_dia','disponivel','baixando','pronta','erro']);
const ESTADOS_WHATSAPP=new Set(['nao_informado','conectado','pareando','pausado','erro']);
const CATEGORIAS_FEEDBACK=new Set(['erro','ideia','elogio']);
const ETAPAS_FEEDBACK=new Set(['onboarding','hoje','conexao','organiza','ajustes']);
const UTILIDADES_FEEDBACK=new Set(['util','parcial','nao_util']);
const ESTADOS_FEEDBACK=new Set(['novo','em_analise','resolvido']);
const SEVERIDADES_FEEDBACK=new Set(['baixa','media','alta']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSAO=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CODIGOS_ERRO=new Set(['SEM_REDE','HTTP_401','HTTP_403','HTTP_404','HTTP_429','HTTP_5XX','MANIFESTO_INVALIDO','ASSINATURA_INVALIDA','DOWNLOAD_FALHOU','INSTALACAO_FALHOU','ATUALIZADOR_INDISPONIVEL']);

const erro=(codigo,status=400)=>Object.assign(new Error(codigo),{codigo,status});
const texto=(valor,maximo,codigo)=>{
  if(typeof valor!=='string'||!valor.trim()||valor.length>maximo)throw erro(codigo);
  return valor.trim();
};
const objetoExato=(valor,chaves,obrigatorias=chaves)=>{
  if(!valor||typeof valor!=='object'||Array.isArray(valor))throw erro('CORPO_INVALIDO');
  const recebidas=Object.keys(valor);
  if(recebidas.some(chave=>!chaves.includes(chave))||obrigatorias.some(chave=>!(chave in valor)))throw erro('CAMPOS_INVALIDOS');
};
const contemConteudoProibido=valor=>{
  const serializado=JSON.stringify(valor).toLowerCase();
  return ['mensagem','conversa','contato','telefone','jid','whatsapp.net','@lid','stack','caminho','arquivo','transcricao','nota','grupo'].some(sinal=>serializado.includes(sinal));
};

export function validarRegistro(valor){
  objetoExato(valor,['convite','instalacaoId','versao','canal','plataforma','arquitetura']);
  if(contemConteudoProibido(valor))throw erro('CONTEUDO_NAO_PERMITIDO');
  const convite=texto(valor.convite,96,'CONVITE_INVALIDO');
  if(!/^[A-Z0-9-]{12,96}$/i.test(convite))throw erro('CONVITE_INVALIDO');
  if(typeof valor.instalacaoId!=='string'||!UUID.test(valor.instalacaoId))throw erro('INSTALACAO_INVALIDA');
  if(typeof valor.versao!=='string'||!VERSAO.test(valor.versao))throw erro('VERSAO_INVALIDA');
  if(!CANAIS.has(valor.canal))throw erro('CANAL_INVALIDO');
  if(!PLATAFORMAS.has(valor.plataforma))throw erro('PLATAFORMA_INVALIDA');
  if(!ARQUITETURAS.has(valor.arquitetura))throw erro('ARQUITETURA_INVALIDA');
  return {...valor,convite};
}

export function validarPulso(valor){
  const chaves=['versao','canal','plataforma','arquitetura','estadoAtualizacao','codigoErro','whatsappEstado'];
  objetoExato(valor,chaves,['versao','canal','plataforma','arquitetura','estadoAtualizacao']);
  if(contemConteudoProibido(valor))throw erro('CONTEUDO_NAO_PERMITIDO');
  if(typeof valor.versao!=='string'||!VERSAO.test(valor.versao))throw erro('VERSAO_INVALIDA');
  if(!CANAIS.has(valor.canal))throw erro('CANAL_INVALIDO');
  if(!PLATAFORMAS.has(valor.plataforma))throw erro('PLATAFORMA_INVALIDA');
  if(!ARQUITETURAS.has(valor.arquitetura))throw erro('ARQUITETURA_INVALIDA');
  if(!ESTADOS_ATUALIZACAO.has(valor.estadoAtualizacao))throw erro('ESTADO_ATUALIZACAO_INVALIDO');
  const codigoErro=valor.codigoErro==null?null:texto(valor.codigoErro,48,'CODIGO_ERRO_INVALIDO');
  if(codigoErro&&!CODIGOS_ERRO.has(codigoErro))throw erro('CODIGO_ERRO_INVALIDO');
  const whatsappEstado=valor.whatsappEstado??'nao_informado';
  if(!ESTADOS_WHATSAPP.has(whatsappEstado))throw erro('ESTADO_WHATSAPP_INVALIDO');
  return {...valor,codigoErro,whatsappEstado};
}

export function validarRotulo(valor){return texto(valor,80,'ROTULO_INVALIDO');}
export function validarUuid(valor){if(typeof valor!=='string'||!UUID.test(valor))throw erro('INSTALACAO_INVALIDA');return valor;}
export function validarFeedback(valor){
  objetoExato(valor,['chaveCliente','categoria','etapa','relato','utilidade','contatoAutorizado'],['chaveCliente','categoria','etapa','relato']);
  if(typeof valor.chaveCliente!=='string'||!UUID.test(valor.chaveCliente))throw erro('CHAVE_FEEDBACK_INVALIDA');
  if(!CATEGORIAS_FEEDBACK.has(valor.categoria))throw erro('CATEGORIA_INVALIDA');
  if(!ETAPAS_FEEDBACK.has(valor.etapa))throw erro('ETAPA_INVALIDA');
  const relato=texto(valor.relato,2000,'RELATO_INVALIDO');
  if(relato.length<8)throw erro('RELATO_INVALIDO');
  const utilidade=valor.utilidade??null;
  if(utilidade!==null&&!UTILIDADES_FEEDBACK.has(utilidade))throw erro('UTILIDADE_INVALIDA');
  if(valor.contatoAutorizado!==undefined&&typeof valor.contatoAutorizado!=='boolean')throw erro('CONTATO_INVALIDO');
  return {chaveCliente:valor.chaveCliente,categoria:valor.categoria,etapa:valor.etapa,relato,utilidade,contatoAutorizado:valor.contatoAutorizado===true};
}
export function validarEstadoFeedback(valor){if(!ESTADOS_FEEDBACK.has(valor))throw erro('ESTADO_FEEDBACK_INVALIDO');return valor;}
export function validarSeveridadeFeedback(valor){if(!SEVERIDADES_FEEDBACK.has(valor))throw erro('SEVERIDADE_FEEDBACK_INVALIDA');return valor;}
export const novoId=()=>randomUUID();
export const novoConvite=()=>`LUME-${randomBytes(12).toString('hex').toUpperCase()}`;
export const novoToken=()=>randomBytes(32).toString('base64url');
export const hashSegredo=(valor,pepper)=>{
  if(typeof pepper!=='string'||pepper.length<24||pepper.length>512)throw erro('SERVIDOR_NAO_CONFIGURADO',500);
  return createHmac('sha256',pepper).update(valor).digest('hex');
};
export const hashPublico=valor=>createHash('sha256').update(valor).digest('hex');

export function segredoIgual(a,b){
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  return timingSafeEqual(Buffer.from(a),Buffer.from(b));
}

const partes=versao=>{
  const [base,pre='']=versao.split('-',2);
  return {base:base.split('.').map(Number),pre};
};
export function compararVersoes(a,b){
  if(!VERSAO.test(a)||!VERSAO.test(b))throw erro('VERSAO_INVALIDA');
  const x=partes(a),y=partes(b);
  for(let i=0;i<3;i++)if(x.base[i]!==y.base[i])return x.base[i]-y.base[i];
  if(x.pre===y.pre)return 0;if(!x.pre)return 1;if(!y.pre)return -1;
  return x.pre.localeCompare(y.pre,undefined,{numeric:true,sensitivity:'base'});
}

export function estadoDaInstalacao(instalacao,{agora=new Date(),versaoAtual}={}){
  if(instalacao.revogadoEm)return 'revogada';
  if(!instalacao.ultimoPulsoEm)return 'apenas_feedback';
  const ultimo=new Date(instalacao.ultimoPulsoEm).getTime(),limite=agora.getTime()-36*60*60*1000;
  if(!Number.isFinite(ultimo)||ultimo<limite)return 'sem_contato';
  if(instalacao.estadoAtualizacao==='erro')return 'erro_atualizacao';
  if(versaoAtual&&compararVersoes(instalacao.versao,versaoAtual)<0)return 'desatualizado';
  return 'ativo';
}

export class CentralOperacional{
  constructor({repositorio,pepper,agora=()=>new Date(),versaoAtual}){
    if(!repositorio)throw new TypeError('repositorio obrigatorio');
    this.repositorio=repositorio;this.pepper=pepper;this.agora=agora;this.versaoAtual=versaoAtual;
  }
  async criarConvite(rotulo){
    const codigo=novoConvite(),registro={id:novoId(),rotulo:validarRotulo(rotulo),codigoHash:hashSegredo(codigo,this.pepper),criadoEm:this.agora().toISOString()};
    await this.repositorio.criarConvite(registro);return {id:registro.id,rotulo:registro.rotulo,codigo};
  }
  async revogarConvite(id){
    validarUuid(id);if(!await this.repositorio.revogarConvite(id,this.agora().toISOString()))throw erro('CONVITE_NAO_ENCONTRADO',404);
    return {revogado:true};
  }
  async registrar(entrada){
    const dados=validarRegistro(entrada),token=novoToken(),agora=this.agora().toISOString();
    const instalacao=await this.repositorio.consumirConvite({conviteHash:hashSegredo(dados.convite,this.pepper),instalacaoId:dados.instalacaoId,tokenHash:hashSegredo(token,this.pepper),dados,agora});
    if(!instalacao)throw erro('CONVITE_INVALIDO_OU_USADO',403);
    return {instalacaoId:instalacao.id,token,canal:instalacao.canal};
  }
  async pulso(token,entrada){
    const dados=validarPulso(entrada),tokenHash=hashSegredo(texto(token,128,'TOKEN_INVALIDO'),this.pepper);
    const instalacao=await this.repositorio.registrarPulso({tokenHash,dados,agora:this.agora().toISOString()});
    if(!instalacao)throw erro('TOKEN_INVALIDO',401);
    return {recebido:true,servidorEm:this.agora().toISOString()};
  }
  async enviarFeedback(token,entrada){
    if(typeof token!=='string'||!token.trim()||token.length>128)throw erro('TOKEN_INVALIDO',401);
    const dados=validarFeedback(entrada),tokenHash=hashSegredo(token,this.pepper);
    const conteudoHash=hashPublico(JSON.stringify(dados));
    const registro=await this.repositorio.salvarFeedback({tokenHash,dados,conteudoHash,id:novoId(),agora:this.agora().toISOString()});
    if(!registro)throw erro('TOKEN_INVALIDO',401);
    if(registro.conflito)throw erro('CHAVE_FEEDBACK_REUTILIZADA',409);
    if(registro.limite)throw erro('LIMITE_FEEDBACK',429);
    return {id:registro.id,recebidoEm:registro.criadoEm};
  }
  async listarFeedback(filtros){return this.repositorio.listarFeedback(normalizarListaFeedback(filtros));}
  async revisarFeedback(id,estado,severidade){
    validarUuid(id);validarEstadoFeedback(estado);validarSeveridadeFeedback(severidade);
    const item=await this.repositorio.revisarFeedback(id,estado,severidade,this.agora().toISOString());
    if(!item)throw erro('FEEDBACK_NAO_ENCONTRADO',404);
    return {id:item.id,estado:item.estado,severidade:item.severidade};
  }
  async excluirFeedback(id){
    validarUuid(id);
    if(!await this.repositorio.excluirFeedback(id,this.agora().toISOString()))throw erro('FEEDBACK_NAO_ENCONTRADO',404);
    return {excluido:true};
  }
  async listar(){
    const itens=await this.repositorio.listarInstalacoes();
    return itens.map(item=>({...item,estado:estadoDaInstalacao(item,{agora:this.agora(),versaoAtual:this.versaoAtual})}));
  }
  async revogar(id){
    validarUuid(id);if(!await this.repositorio.revogarInstalacao(id,this.agora().toISOString()))throw erro('INSTALACAO_NAO_ENCONTRADA',404);
    return {revogada:true};
  }
}

export function respostaErro(error){
  const status=Number.isInteger(error?.status)?error.status:500;
  return {status,corpo:{erro:status===500?'ERRO_INTERNO':error.codigo||'REQUISICAO_INVALIDA'}};
}
