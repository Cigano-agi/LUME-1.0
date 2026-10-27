const fsPadrao = require('node:fs');
const { join } = require('node:path');

const { ORIGEM_LUME: ORIGEM_CENTRAL } = require('./origem-lume.cjs');
const CAMINHOS = new Set(['/api/v1/instalacoes/registrar', '/api/v1/instalacoes/pulso', '/api/v1/feedback']);
const CHAVES_ESTADO_V1 = ['schema', 'consentido', 'instalacaoId', 'convite', 'token', 'revogada', 'ultimoSucessoEm', 'proximaTentativaEm', 'falhasConsecutivas'];
const CHAVES_ESTADO = [...CHAVES_ESTADO_V1,'feedbackHabilitado'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVITE = /^[A-Z0-9-]{12,96}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const VERSAO = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CANAIS = new Set(['beta', 'estavel']);
const PLATAFORMAS = new Set(['win32', 'darwin']);
const ARQUITETURAS = new Set(['x64', 'arm64']);
const ESTADOS_ATUALIZACAO = new Set(['em_dia', 'disponivel', 'baixando', 'pronta', 'erro']);
const ESTADOS_WHATSAPP = new Set(['nao_informado', 'conectado', 'pareando', 'pausado', 'erro']);
const CODIGOS_ERRO = new Set(['SEM_REDE', 'HTTP_401', 'HTTP_403', 'HTTP_404', 'HTTP_429', 'HTTP_5XX', 'MANIFESTO_INVALIDO', 'ASSINATURA_INVALIDA', 'DOWNLOAD_FALHOU', 'INSTALACAO_FALHOU', 'ATUALIZADOR_INDISPONIVEL']);
const MAX_ESTADO_BYTES = 4096;
const MAX_ARQUIVO_BYTES = 64 * 1024;
const MAX_REQUISICAO_BYTES = 12288;
const MAX_RESPOSTA_BYTES = 16 * 1024;

function dataOuNulo(valor) {
  return valor === null || (typeof valor === 'string' && Number.isFinite(Date.parse(valor)));
}

function validarEstado(valor) {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error('ESTADO_CENTRAL_INVALIDO');
  const chaves=Object.keys(valor).sort().join(',');
  const legado=chaves===[...CHAVES_ESTADO_V1].sort().join(',');
  if (!legado&&chaves!==[...CHAVES_ESTADO].sort().join(',')) throw new Error('ESTADO_CENTRAL_INVALIDO');
  if (valor.schema !== 'lume-central-client-v1' || typeof valor.consentido !== 'boolean' || typeof valor.revogada !== 'boolean') throw new Error('ESTADO_CENTRAL_INVALIDO');
  if(!legado&&typeof valor.feedbackHabilitado!=='boolean')throw new Error('ESTADO_CENTRAL_INVALIDO');
  if (valor.instalacaoId !== null && (typeof valor.instalacaoId !== 'string' || !UUID.test(valor.instalacaoId))) throw new Error('ESTADO_CENTRAL_INVALIDO');
  if (valor.convite !== null && (typeof valor.convite !== 'string' || !CONVITE.test(valor.convite))) throw new Error('ESTADO_CENTRAL_INVALIDO');
  if (valor.token !== null && (typeof valor.token !== 'string' || !TOKEN.test(valor.token))) throw new Error('ESTADO_CENTRAL_INVALIDO');
  if (!dataOuNulo(valor.ultimoSucessoEm) || !dataOuNulo(valor.proximaTentativaEm)) throw new Error('ESTADO_CENTRAL_INVALIDO');
  if (!Number.isInteger(valor.falhasConsecutivas) || valor.falhasConsecutivas < 0 || valor.falhasConsecutivas > 1000) throw new Error('ESTADO_CENTRAL_INVALIDO');
  if (valor.consentido && (!valor.instalacaoId || (!valor.convite && !valor.token))) throw new Error('ESTADO_CENTRAL_INVALIDO');
  if(!legado&&valor.feedbackHabilitado&&(!valor.instalacaoId||(!valor.convite&&!valor.token)))throw new Error('ESTADO_CENTRAL_INVALIDO');
  return valor;
}

function criarCofreCentral(diretorio, safeStorage, { fs = fsPadrao, plataforma = process.platform } = {}) {
  if (typeof diretorio !== 'string' || !diretorio) throw new TypeError('diretorio invalido');
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') throw new TypeError('safeStorage invalido');
  const arquivo = join(diretorio, 'central.seguro');
  const temporario = join(diretorio, 'central.seguro.tmp');
  const disponivel = () => {
    try { return safeStorage.isEncryptionAvailable() === true && (plataforma !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text'); }
    catch { return false; }
  };
  const falha = () => new Error('COFRE_CENTRAL_INDISPONIVEL');
  const removerSeExiste = caminho => { try { if (fs.existsSync(caminho)) fs.unlinkSync(caminho); } catch {} };

  return {
    estado() {
      let configurado = false;
      try { configurado = fs.existsSync(arquivo) && !fs.lstatSync(arquivo).isSymbolicLink(); } catch {}
      return { disponivel: disponivel(), configurado };
    },
    ler() {
      if (!fs.existsSync(arquivo)) return null;
      if (!disponivel()) throw falha();
      try {
        const stat = fs.lstatSync(arquivo);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ARQUIVO_BYTES) throw falha();
        const cifrado = fs.readFileSync(arquivo);
        const texto = safeStorage.decryptString(cifrado);
        if (typeof texto !== 'string' || Buffer.byteLength(texto, 'utf8') > MAX_ESTADO_BYTES) throw falha();
        return validarEstado(JSON.parse(texto));
      } catch { throw falha(); }
    },
    gravar(valor) {
      if (!disponivel()) throw falha();
      let texto, cifrado;
      try {
        validarEstado(valor);
        texto = JSON.stringify(valor);
        if (Buffer.byteLength(texto, 'utf8') > MAX_ESTADO_BYTES) throw falha();
        cifrado = safeStorage.encryptString(texto);
        if (!Buffer.isBuffer(cifrado) || cifrado.length <= 0 || cifrado.length > MAX_ARQUIVO_BYTES) throw falha();
        fs.mkdirSync(diretorio, { recursive: true, mode: 0o700 });
        removerSeExiste(temporario);
        fs.writeFileSync(temporario, cifrado, { mode: 0o600, flag: 'wx' });
        fs.chmodSync?.(temporario, 0o600);
        fs.renameSync(temporario, arquivo);
        fs.chmodSync?.(arquivo, 0o600);
        return { ok: true };
      } catch {
        removerSeExiste(temporario);
        throw falha();
      }
    },
    remover() {
      try {
        for (const caminho of [temporario, arquivo]) {
          try { fs.unlinkSync(caminho); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
          if (fs.existsSync(caminho)) throw falha();
        }
        return { ok: true };
      } catch { throw falha(); }
    }
  };
}

function erroTransporte(codigo, status) {
  return Object.assign(new Error(codigo), { code: codigo, ...(status ? { status } : {}) });
}

function codigoHttp(status) {
  if (status === 401) return 'HTTP_401';
  if (status === 403) return 'HTTP_403';
  if (status === 404) return 'HTTP_404';
  if (status === 429) return 'HTTP_429';
  if (status >= 500) return 'HTTP_5XX';
  return 'HTTP_ERRO';
}

function chavesExatas(valor, permitidas, obrigatorias = permitidas) {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return false;
  const chaves = Object.keys(valor);
  return !chaves.some(chave => !permitidas.includes(chave)) && !obrigatorias.some(chave => !(chave in valor));
}

function baseValida(corpo) {
  return VERSAO.test(String(corpo.versao || '')) && CANAIS.has(corpo.canal) && PLATAFORMAS.has(corpo.plataforma) && ARQUITETURAS.has(corpo.arquitetura);
}

function validarCorpoTransporte(caminho, corpo) {
  if (caminho === '/api/v1/feedback') {
    if (!chavesExatas(corpo, ['chaveCliente','categoria','etapa','relato','utilidade','contatoAutorizado'], ['chaveCliente','categoria','etapa','relato']) ||
        !UUID.test(String(corpo.chaveCliente || '')) || !['erro','ideia','elogio'].includes(corpo.categoria) ||
        !['onboarding','hoje','conexao','organiza','ajustes'].includes(corpo.etapa) ||
        typeof corpo.relato !== 'string' || corpo.relato.trim().length < 8 || corpo.relato.length > 2000 ||
        (corpo.utilidade !== undefined && corpo.utilidade !== null && !['util','parcial','nao_util'].includes(corpo.utilidade)) ||
        (corpo.contatoAutorizado !== undefined && typeof corpo.contatoAutorizado !== 'boolean')) throw erroTransporte('CORPO_INVALIDO');
    return;
  }
  if (caminho.endsWith('/registrar')) {
    if (!chavesExatas(corpo, ['convite', 'instalacaoId', 'versao', 'canal', 'plataforma', 'arquitetura']) ||
        !CONVITE.test(String(corpo.convite || '')) || !UUID.test(String(corpo.instalacaoId || '')) || !baseValida(corpo)) throw erroTransporte('CORPO_INVALIDO');
    return;
  }
  const chaves = ['versao', 'canal', 'plataforma', 'arquitetura', 'estadoAtualizacao', 'codigoErro', 'whatsappEstado'];
  if (!chavesExatas(corpo, chaves, ['versao', 'canal', 'plataforma', 'arquitetura', 'estadoAtualizacao', 'whatsappEstado']) ||
      !baseValida(corpo) || !ESTADOS_ATUALIZACAO.has(corpo.estadoAtualizacao) || !ESTADOS_WHATSAPP.has(corpo.whatsappEstado) ||
      (corpo.codigoErro !== undefined && !CODIGOS_ERRO.has(corpo.codigoErro))) throw erroTransporte('CORPO_INVALIDO');
}

async function lerRespostaLimitada(resposta, limite, abortar) {
  const declarado = Number(resposta.headers?.get?.('content-length'));
  if (Number.isFinite(declarado) && declarado > limite) throw erroTransporte('RESPOSTA_EXCESSIVA');
  if (!resposta.body || typeof resposta.body.getReader !== 'function') {
    const texto = await resposta.text();
    if (Buffer.byteLength(texto, 'utf8') > limite) throw erroTransporte('RESPOSTA_EXCESSIVA');
    return texto;
  }
  const leitor = resposta.body.getReader();
  const partes = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > limite) { abortar(); throw erroTransporte('RESPOSTA_EXCESSIVA'); }
      partes.push(Buffer.from(value));
    }
    return Buffer.concat(partes, total).toString('utf8');
  } finally {
    leitor.releaseLock?.();
  }
}

function criarTransporteCentral({ fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxRespostaBytes = MAX_RESPOSTA_BYTES, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch indisponivel');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new TypeError('timeout invalido');
  if (!Number.isInteger(maxRespostaBytes) || maxRespostaBytes < 256 || maxRespostaBytes > MAX_RESPOSTA_BYTES) throw new TypeError('limite invalido');

  return async function enviar({ caminho, token, corpo } = {}) {
    if (!CAMINHOS.has(caminho)) throw erroTransporte('CAMINHO_NAO_PERMITIDO');
    const registro = caminho === '/api/v1/instalacoes/registrar';
    if ((registro && token !== undefined) || (!registro && (typeof token !== 'string' || !TOKEN.test(token)))) throw erroTransporte('AUTENTICACAO_INVALIDA');
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erroTransporte('CORPO_INVALIDO');
    validarCorpoTransporte(caminho, corpo);
    let serializado;
    try { serializado = JSON.stringify(corpo); } catch { throw erroTransporte('CORPO_INVALIDO'); }
    if (!serializado || Buffer.byteLength(serializado, 'utf8') > (caminho === '/api/v1/feedback' ? MAX_REQUISICAO_BYTES : 4096)) throw erroTransporte('CORPO_INVALIDO');

    const controlador = new AbortController();
    let expirou = false;
    const timer = setTimer(() => { expirou = true; controlador.abort(); }, timeoutMs);
    timer?.unref?.();
    try {
      const headers = { accept: 'application/json', 'content-type': 'application/json' };
      if (!registro) headers.authorization = `Bearer ${token}`;
      const url = new URL(caminho, ORIGEM_CENTRAL);
      if (url.protocol !== 'https:' || url.origin !== ORIGEM_CENTRAL || url.pathname !== caminho || url.search || url.hash) throw erroTransporte('CAMINHO_NAO_PERMITIDO');
      const resposta = await fetchImpl(url.href, {
        method: 'POST', headers, body: serializado, signal: controlador.signal,
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer'
      });
      if (!resposta || typeof resposta.status !== 'number') throw erroTransporte('RESPOSTA_INVALIDA');
      if (!resposta.ok) {
        try { await resposta.body?.cancel?.(); } catch {}
        throw erroTransporte(codigoHttp(resposta.status), resposta.status);
      }
      const texto = await lerRespostaLimitada(resposta, maxRespostaBytes, () => controlador.abort());
      let resultado;
      try { resultado = JSON.parse(texto); } catch { throw erroTransporte('RESPOSTA_INVALIDA'); }
      if (!resultado || typeof resultado !== 'object' || Array.isArray(resultado)) throw erroTransporte('RESPOSTA_INVALIDA');
      return resultado;
    } catch (error) {
      if (error?.code) throw error;
      if (expirou || error?.name === 'AbortError') throw erroTransporte('SEM_REDE');
      throw erroTransporte('SEM_REDE');
    } finally { clearTimer(timer); }
  };
}

async function executarComandoCentral(cliente, mensagem) {
  if (!cliente || !mensagem || mensagem.tipo !== 'central-comando' || typeof mensagem.id !== 'string' || !UUID.test(mensagem.id)) return null;
  const base = { tipo: 'central-resposta', id: mensagem.id };
  try {
    let estado;
    const chaves=Object.keys(mensagem).sort().join(',');
    if (mensagem.acao === 'consultar' && chaves==='acao,id,tipo') estado = await cliente.estado();
    else if (mensagem.acao === 'consentir' && chaves==='acao,convite,id,tipo' && typeof mensagem.convite === 'string' && CONVITE.test(mensagem.convite)) {
      await cliente.consentir(mensagem.convite);
      estado = await cliente.sincronizar();
    } else if (mensagem.acao === 'autorizar-feedback' && chaves==='acao,convite,id,tipo' && typeof mensagem.convite === 'string' && CONVITE.test(mensagem.convite)) {
      estado = await cliente.autorizarFeedback(mensagem.convite);
    } else if (mensagem.acao === 'ativar-acompanhamento' && chaves==='acao,id,tipo') {
      await cliente.ativarAcompanhamento();
      estado = await cliente.sincronizar();
    } else if (mensagem.acao === 'desativar-acompanhamento' && chaves==='acao,id,tipo') {
      estado = await cliente.desativarAcompanhamento();
    } else if (mensagem.acao === 'revogar' && chaves==='acao,id,tipo') estado = await cliente.revogarLocalmente();
    else if (mensagem.acao === 'feedback' && chaves==='acao,dados,id,tipo') return { ...base, recibo: await cliente.enviarFeedback(mensagem.dados) };
    else return { ...base, erro: 'ACAO_INVALIDA' };
    return { ...base, estado };
  } catch { return { ...base, erro: 'CENTRAL_INDISPONIVEL' }; }
}

module.exports = { criarCofreCentral, criarTransporteCentral, executarComandoCentral, ORIGEM_CENTRAL, MAX_RESPOSTA_BYTES };
