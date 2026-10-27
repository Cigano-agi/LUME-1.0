const { randomUUID } = require('node:crypto');

const INTERVALO_PULSO_MS = 6 * 60 * 60 * 1000;
const BACKOFF_PADRAO_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000, INTERVALO_PULSO_MS];
const CANAIS = new Set(['beta', 'estavel']);
const PLATAFORMAS = new Set(['win32', 'darwin']);
const ARQUITETURAS = new Set(['x64', 'arm64']);
const ESTADOS_ATUALIZACAO = new Set(['em_dia', 'disponivel', 'baixando', 'pronta', 'erro']);
const ESTADOS_WHATSAPP = new Set(['nao_informado', 'conectado', 'pareando', 'pausado', 'erro']);
const CODIGOS_ERRO = new Set(['SEM_REDE', 'HTTP_401', 'HTTP_403', 'HTTP_404', 'HTTP_429', 'HTTP_5XX', 'MANIFESTO_INVALIDO', 'ASSINATURA_INVALIDA', 'DOWNLOAD_FALHOU', 'INSTALACAO_FALHOU', 'ATUALIZADOR_INDISPONIVEL']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSAO = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CONVITE = /^[A-Z0-9-]{12,96}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

function validarFeedback(dados) {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados) ||
      Object.keys(dados).some(chave => !['chaveCliente','categoria','etapa','relato','utilidade','contatoAutorizado'].includes(chave)) ||
      !UUID.test(String(dados.chaveCliente || '')) || !['erro','ideia','elogio'].includes(dados.categoria) ||
      !['onboarding','hoje','conexao','organiza','ajustes'].includes(dados.etapa) ||
      typeof dados.relato !== 'string' || dados.relato.trim().length < 8 || dados.relato.length > 2000 ||
      (dados.utilidade !== undefined && dados.utilidade !== null && !['util','parcial','nao_util'].includes(dados.utilidade)) ||
      (dados.contatoAutorizado !== undefined && typeof dados.contatoAutorizado !== 'boolean')) throw new Error('FEEDBACK_INVALIDO');
  return {chaveCliente:dados.chaveCliente,categoria:dados.categoria,etapa:dados.etapa,relato:dados.relato.trim(),utilidade:dados.utilidade??null,contatoAutorizado:dados.contatoAutorizado===true};
}

function numeroData(valor) {
  if (typeof valor !== 'string') return null;
  const numero = Date.parse(valor);
  return Number.isFinite(numero) ? numero : null;
}

function estadoInicial() {
  return {
    schema: 'lume-central-client-v1', consentido: false, feedbackHabilitado: false, instalacaoId: null,
    convite: null, token: null, revogada: false, ultimoSucessoEm: null,
    proximaTentativaEm: null, falhasConsecutivas: 0
  };
}

function validarPersistido(valor) {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor) || valor.schema !== 'lume-central-client-v1') return estadoInicial();
  const instalacaoId = UUID.test(String(valor.instalacaoId || '')) ? valor.instalacaoId : null;
  const convite = CONVITE.test(String(valor.convite || '')) ? valor.convite : null;
  const token = TOKEN.test(String(valor.token || '')) ? valor.token : null;
  const autorizado = Boolean(instalacaoId) && Boolean(convite || token) && valor.revogada !== true;
  const consentido = valor.consentido === true && autorizado;
  const feedbackHabilitado = (valor.feedbackHabilitado === true || consentido) && autorizado;
  return {
    ...estadoInicial(), consentido, feedbackHabilitado, instalacaoId: feedbackHabilitado ? instalacaoId : null,
    convite: feedbackHabilitado && !token ? convite : null, token: feedbackHabilitado ? token : null,
    revogada: valor.revogada === true,
    ultimoSucessoEm: numeroData(valor.ultimoSucessoEm) === null ? null : new Date(valor.ultimoSucessoEm).toISOString(),
    proximaTentativaEm: numeroData(valor.proximaTentativaEm) === null ? null : new Date(valor.proximaTentativaEm).toISOString(),
    falhasConsecutivas: Number.isInteger(valor.falhasConsecutivas) && valor.falhasConsecutivas >= 0 ? Math.min(valor.falhasConsecutivas, 1000) : 0
  };
}

function validarConfiguracao({ versao, canal, plataforma, arquitetura }) {
  if (!VERSAO.test(String(versao || ''))) throw new TypeError('versao invalida');
  if (!CANAIS.has(canal)) throw new TypeError('canal invalido');
  if (!PLATAFORMAS.has(plataforma)) throw new TypeError('plataforma invalida');
  if (!ARQUITETURAS.has(arquitetura)) throw new TypeError('arquitetura invalida');
}

function payloadBase(configuracao) {
  return {
    versao: configuracao.versao,
    canal: configuracao.canal,
    plataforma: configuracao.plataforma,
    arquitetura: configuracao.arquitetura
  };
}

function payloadPulso(configuracao, lerEstado) {
  let origem = {};
  try { origem = lerEstado?.() || {}; } catch { origem = {}; }
  const estadoAtualizacao = ESTADOS_ATUALIZACAO.has(origem.estadoAtualizacao) ? origem.estadoAtualizacao : 'em_dia';
  const whatsappEstado = ESTADOS_WHATSAPP.has(origem.whatsappEstado) ? origem.whatsappEstado : 'nao_informado';
  const resultado = { ...payloadBase(configuracao), estadoAtualizacao, whatsappEstado };
  if (estadoAtualizacao === 'erro' && CODIGOS_ERRO.has(origem.codigoErro)) resultado.codigoErro = origem.codigoErro;
  return resultado;
}

function statusDoErro(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  return Number.isInteger(status) ? status : null;
}

/**
 * Cliente operacional isolado. O cofre injetado deve implementar ler(), gravar(valor)
 * e remover(); o transporte recebe somente { caminho, token?, corpo }.
 */
function criarClienteCentral({
  cofre, enviar, versao, canal = 'beta', plataforma = process.platform,
  arquitetura = process.arch, lerEstado = () => ({}), agora = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, intervaloMs = INTERVALO_PULSO_MS,
  backoffMs = BACKOFF_PADRAO_MS
} = {}) {
  if (!cofre || !['ler', 'gravar', 'remover'].every(nome => typeof cofre[nome] === 'function')) throw new TypeError('cofre invalido');
  if (typeof enviar !== 'function') throw new TypeError('transporte invalido');
  if (!Number.isFinite(intervaloMs) || intervaloMs < INTERVALO_PULSO_MS) throw new TypeError('intervalo minimo de seis horas');
  if (!Array.isArray(backoffMs) || !backoffMs.length || backoffMs.some(ms => !Number.isFinite(ms) || ms <= 0 || ms > intervaloMs)) throw new TypeError('backoff invalido');
  const configuracao = { versao: String(versao || ''), canal, plataforma, arquitetura };
  validarConfiguracao(configuracao);

  let memoria = null;
  let carregando = null;
  let operacao = null;
  let registroFeedback=null;
  let timer = null;
  let encerrado = false;
  let geracao = 0;

  async function carregar() {
    if (memoria) return memoria;
    if (!carregando) carregando = Promise.resolve().then(() => cofre.ler()).then(valor => validarPersistido(valor)).catch(() => estadoInicial()).then(valor => (memoria = valor));
    return carregando;
  }
  async function salvar(valor) {
    memoria = validarPersistido(valor);
    await cofre.gravar({ ...memoria });
    return memoria;
  }
  function limparTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  function agendarEm(ms) {
    limparTimer();
    if (encerrado) return;
    timer = setTimer(() => { timer = null; sincronizar().catch(() => {}); }, Math.max(0, ms));
    timer?.unref?.();
  }
  function publico(estado, situacao) {
    return {
      situacao,
      consentido: estado.consentido,
      feedbackHabilitado: estado.feedbackHabilitado,
      registrado: Boolean(estado.token),
      revogada: estado.revogada,
      instalacaoId: estado.instalacaoId,
      ultimoSucessoEm: estado.ultimoSucessoEm,
      proximaTentativaEm: estado.proximaTentativaEm,
      falhasConsecutivas: estado.falhasConsecutivas
    };
  }
  async function falhar(estado) {
    const falhas = Math.min(estado.falhasConsecutivas + 1, 1000);
    const atraso = backoffMs[Math.min(falhas - 1, backoffMs.length - 1)];
    const proxima = new Date(agora() + atraso).toISOString();
    const salvo = await salvar({ ...estado, falhasConsecutivas: falhas, proximaTentativaEm: proxima }).catch(() => ({ ...estado, falhasConsecutivas: falhas, proximaTentativaEm: proxima }));
    agendarEm(atraso);
    return publico(salvo, 'central_indisponivel');
  }

  async function executar() {
    const geracaoDaOperacao = geracao;
    let estado;
    try { estado = await carregar(); } catch { return publico(estadoInicial(), 'cofre_indisponivel'); }
    if (encerrado) return publico(estado, 'encerrado');
    if (!estado.consentido) return publico(estado, 'sem_consentimento');
    if (estado.revogada) return publico(estado, 'revogada');

    const agoraMs = agora();
    const proximaTentativa = numeroData(estado.proximaTentativaEm);
    if (proximaTentativa !== null && agoraMs < proximaTentativa) {
      agendarEm(proximaTentativa - agoraMs);
      return publico(estado, 'adiado');
    }
    const ultimoSucesso = numeroData(estado.ultimoSucessoEm);
    if (estado.token && ultimoSucesso !== null && agoraMs - ultimoSucesso < intervaloMs) {
      agendarEm(intervaloMs - (agoraMs - ultimoSucesso));
      return publico(estado, 'em_dia');
    }

    try {
      if (!estado.token) {
        const corpo = { convite: estado.convite, instalacaoId: estado.instalacaoId, ...payloadBase(configuracao) };
        const resposta = await enviar({ caminho: '/api/v1/instalacoes/registrar', corpo });
        if (geracaoDaOperacao !== geracao || encerrado) return publico(memoria || estadoInicial(), 'encerrado');
        if (!resposta || resposta.instalacaoId !== estado.instalacaoId || !TOKEN.test(String(resposta.token || ''))) throw new Error('resposta de registro invalida');
        const horario = new Date(agora()).toISOString();
        estado = await salvar({ ...estado, convite: null, token: resposta.token, ultimoSucessoEm: horario, proximaTentativaEm: null, falhasConsecutivas: 0 });
        agendarEm(intervaloMs);
        return publico(estado, 'registrado');
      }
      await enviar({ caminho: '/api/v1/instalacoes/pulso', token: estado.token, corpo: payloadPulso(configuracao, lerEstado) });
      if (geracaoDaOperacao !== geracao || encerrado) return publico(memoria || estadoInicial(), 'encerrado');
      const horario = new Date(agora()).toISOString();
      estado = await salvar({ ...estado, ultimoSucessoEm: horario, proximaTentativaEm: null, falhasConsecutivas: 0 });
      agendarEm(intervaloMs);
      return publico(estado, 'pulso_enviado');
    } catch (error) {
      if (geracaoDaOperacao !== geracao || encerrado) return publico(memoria || estadoInicial(), 'encerrado');
      const status = statusDoErro(error);
      if (estado.token && (status === 401 || status === 403)) {
        limparTimer();
        estado = await salvar({ ...estado, token: null, convite: null, consentido: false, revogada: true, proximaTentativaEm: null, falhasConsecutivas: 0 }).catch(() => ({ ...estado, token: null, convite: null, consentido: false, revogada: true }));
        return publico(estado, 'revogada');
      }
      return falhar(estado);
    }
  }

  function sincronizar() {
    if (operacao) return operacao;
    operacao = executar().catch(() => publico(memoria || estadoInicial(), 'central_indisponivel')).finally(() => { operacao = null; });
    return operacao;
  }

  function registrarParaFeedback() {
    if(registroFeedback)return registroFeedback;
    registroFeedback=(async()=>{
    const estado=await carregar();
    if(encerrado||estado.revogada||!estado.feedbackHabilitado)throw new Error('FEEDBACK_SEM_INSTALACAO');
    if(estado.token)return estado;
    if(!estado.convite)throw new Error('FEEDBACK_SEM_INSTALACAO');
    const geracaoInicial=geracao;
    const resposta=await enviar({caminho:'/api/v1/instalacoes/registrar',corpo:{convite:estado.convite,instalacaoId:estado.instalacaoId,...payloadBase(configuracao)}});
    if(encerrado||geracaoInicial!==geracao)throw new Error('FEEDBACK_ESTADO_ALTERADO');
    if(!resposta||resposta.instalacaoId!==estado.instalacaoId||!TOKEN.test(String(resposta.token||'')))throw new Error('FEEDBACK_REGISTRO_INVALIDO');
    return salvar({...estado,convite:null,token:resposta.token,ultimoSucessoEm:new Date(agora()).toISOString()});
    })().finally(()=>{registroFeedback=null;});
    return registroFeedback;
  }

  return {
    async consentir(convite) {
      const codigo = String(convite || '').trim();
      if (!CONVITE.test(codigo)) throw new TypeError('convite invalido');
      limparTimer(); encerrado = false; geracao += 1;
      const anterior = await carregar();
      const estado = await salvar({ ...estadoInicial(), consentido: true, feedbackHabilitado:true, instalacaoId: anterior.instalacaoId || randomUUID(), convite: codigo });
      return publico(estado, 'pronto_para_registrar');
    },
    async autorizarFeedback(convite) {
      const codigo=String(convite||'').trim();
      if(!CONVITE.test(codigo))throw new TypeError('convite invalido');
      limparTimer();encerrado=false;geracao+=1;
      const estado=await salvar({...estadoInicial(),feedbackHabilitado:true,instalacaoId:randomUUID(),convite:codigo});
      try {return publico(await registrarParaFeedback(),'feedback_autorizado');}
      catch(error){
        // A pessoa mantém o convite para tentar novamente; nenhum pulso é agendado.
        if(statusDoErro(error)===403)await salvar({...estadoInicial(),revogada:true});
        throw error;
      }
    },
    async ativarAcompanhamento() {
      const estado=await carregar();
      if(encerrado||estado.revogada||!estado.feedbackHabilitado||!estado.token)throw new Error('SEM_INSTALACAO');
      const salvo=await salvar({...estado,consentido:true,ultimoSucessoEm:null,proximaTentativaEm:null});
      return publico(salvo,'pronto_para_registrar');
    },
    async desativarAcompanhamento() {
      geracao+=1;limparTimer();
      const estado=await carregar();
      const salvo=await salvar({...estado,consentido:false,proximaTentativaEm:null,falhasConsecutivas:0});
      return publico(salvo,'sem_consentimento');
    },
    iniciar() {
      encerrado = false;
      Promise.resolve().then(async () => {
        const estado = await carregar();
        if (!estado.consentido || estado.revogada) return;
        const limite = estado.token && numeroData(estado.ultimoSucessoEm) !== null ? numeroData(estado.ultimoSucessoEm) + intervaloMs : agora();
        const backoff = numeroData(estado.proximaTentativaEm);
        agendarEm(Math.max(0, Math.max(limite, backoff || 0) - agora()));
      }).catch(() => {});
      return { iniciado: true };
    },
    sincronizar,
    async enviarFeedback(entrada) {
      const corpo=validarFeedback(entrada);
      let estado=await carregar();
      if(encerrado||!estado.feedbackHabilitado||estado.revogada)throw new Error('FEEDBACK_SEM_INSTALACAO');
      if(!estado.token)estado=await registrarParaFeedback();
      if(encerrado||!estado.feedbackHabilitado||estado.revogada||!estado.token)throw new Error('FEEDBACK_SEM_INSTALACAO');
      const geracaoInicial=geracao;
      const resposta=await enviar({caminho:'/api/v1/feedback',token:estado.token,corpo});
      if(encerrado||geracaoInicial!==geracao)throw new Error('FEEDBACK_ESTADO_ALTERADO');
      if(!resposta||!UUID.test(String(resposta.id||''))||numeroData(resposta.recebidoEm)===null)throw new Error('FEEDBACK_RECIBO_INVALIDO');
      return {id:resposta.id,recebidoEm:new Date(resposta.recebidoEm).toISOString()};
    },
    async estado() { return publico(await carregar(), encerrado ? 'encerrado' : 'pronto'); },
    async revogarLocalmente() {
      encerrado = true; geracao += 1; limparTimer(); memoria = { ...estadoInicial(), revogada: true }; carregando = null;
      try { await cofre.remover(); return publico(memoria, 'revogada_localmente'); }
      catch {
        // Se o arquivo não puder ser removido, tenta substituir a credencial por uma
        // lápide sem token. Assim, uma reinicialização não reativa pulsos antigos.
        try { await cofre.gravar({ ...memoria }); return publico(memoria, 'revogada_localmente'); }
        catch { return publico(memoria, 'cofre_indisponivel'); }
      }
    },
    encerrar() { encerrado = true; limparTimer(); }
  };
}

module.exports = { criarClienteCentral, INTERVALO_PULSO_MS, BACKOFF_PADRAO_MS, payloadPulso };
