import { randomUUID } from 'node:crypto';

const ACOES = new Set(['consultar', 'consentir', 'autorizar-feedback', 'ativar-acompanhamento', 'desativar-acompanhamento', 'revogar', 'feedback']);
const SITUACOES = new Set(['pronto', 'pronto_para_registrar', 'feedback_autorizado', 'registrado', 'pulso_enviado', 'em_dia', 'adiado', 'central_indisponivel', 'cofre_indisponivel', 'sem_consentimento', 'revogada', 'revogada_localmente', 'encerrado']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVITE = /^[A-Z0-9-]{12,96}$/i;

function data(valor) { return typeof valor === 'string' && Number.isFinite(Date.parse(valor)) ? new Date(valor).toISOString() : null; }
function limpar(valor) {
  const v = valor && typeof valor === 'object' ? valor : {};
  return {
    situacao: SITUACOES.has(v.situacao) ? v.situacao : 'central_indisponivel',
    consentido: v.consentido === true,
    feedbackHabilitado: v.feedbackHabilitado === true,
    registrado: v.registrado === true,
    revogada: v.revogada === true,
    instalacaoId: typeof v.instalacaoId === 'string' && UUID.test(v.instalacaoId) ? v.instalacaoId : null,
    ultimoSucessoEm: data(v.ultimoSucessoEm),
    proximaTentativaEm: data(v.proximaTentativaEm),
    falhasConsecutivas: Number.isInteger(v.falhasConsecutivas) && v.falhasConsecutivas >= 0 ? Math.min(v.falhasConsecutivas, 1000) : 0
  };
}

export function whatsappParaCentral(estado) {
  if (estado === 'conectada') return 'conectado';
  if (['conectando', 'aguardando_qr', 'reconectando'].includes(estado)) return 'pareando';
  if (['erro', 'auth_invalida', 'substituida'].includes(estado)) return 'erro';
  return 'pausado';
}

export function criarPonteCentral(porta, { timeout = 15_000 } = {}) {
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60_000) throw new TypeError('timeout invalido');
  let fechado = false;
  let estado = limpar({ situacao: 'central_indisponivel' });
  const pendentes = new Map();
  const receber = ({ data: mensagem }) => {
    if (mensagem?.tipo !== 'central-resposta' || typeof mensagem.id !== 'string') return;
    const pendente = pendentes.get(mensagem.id);
    if (!pendente) return;
    clearTimeout(pendente.timer); pendentes.delete(mensagem.id);
    if (mensagem.erro) pendente.reject(new Error('A Central não está disponível agora. Seu texto foi preservado para tentar de novo.'));
    else if(pendente.acao==='feedback'){
      const recibo=mensagem.recibo;
      if(!recibo||!UUID.test(String(recibo.id||''))||!data(recibo.recebidoEm))pendente.reject(new Error('A Central não confirmou o recebimento. Tente novamente.'));
      else pendente.resolve({id:recibo.id,recebidoEm:data(recibo.recebidoEm)});
    }else { estado = limpar(mensagem.estado); pendente.resolve({ ...estado }); }
  };
  porta?.on('message', receber);

  const executar = (acao, entrada = {}) => {
    if (fechado || !porta || !ACOES.has(acao)) return Promise.reject(new Error('Central indisponível.'));
    const mensagem = { tipo: 'central-comando', id: randomUUID(), acao };
    if (acao === 'consentir' || acao === 'autorizar-feedback') {
      const convite = String(entrada.convite || '').trim();
      if (!CONVITE.test(convite)) return Promise.reject(new Error('Convite inválido.'));
      mensagem.convite = convite;
    } else if(acao==='feedback'){
      const dados=entrada.dados;
      if(!dados||typeof dados!=='object'||Array.isArray(dados)||Object.keys(dados).some(k=>!['chaveCliente','categoria','etapa','relato','utilidade','contatoAutorizado'].includes(k))||!UUID.test(String(dados.chaveCliente||''))||!['erro','ideia','elogio'].includes(dados.categoria)||!['onboarding','hoje','conexao','organiza','ajustes'].includes(dados.etapa)||typeof dados.relato!=='string'||dados.relato.trim().length<8||dados.relato.length>2000||(dados.utilidade!==undefined&&dados.utilidade!==null&&!['util','parcial','nao_util'].includes(dados.utilidade))||(dados.contatoAutorizado!==undefined&&typeof dados.contatoAutorizado!=='boolean'))return Promise.reject(new Error('Confira os campos do feedback.'));
      mensagem.dados={chaveCliente:dados.chaveCliente,categoria:dados.categoria,etapa:dados.etapa,relato:dados.relato.trim(),utilidade:dados.utilidade??null,contatoAutorizado:dados.contatoAutorizado===true};
    } else if (Object.keys(entrada).length) return Promise.reject(new Error('Ação inválida.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendentes.delete(mensagem.id); reject(new Error('A Central demorou para responder. O Lume continua funcionando.')); }, timeout);
      timer.unref?.(); pendentes.set(mensagem.id, { resolve, reject, timer, acao });
      try { porta.postMessage(mensagem); }
      catch { clearTimeout(timer); pendentes.delete(mensagem.id); reject(new Error('Central indisponível.')); }
    });
  };

  return {
    estado: () => ({ ...estado }),
    consultar: () => executar('consultar'),
    consentir: convite => executar('consentir', { convite }),
    autorizarFeedback: convite => executar('autorizar-feedback', { convite }),
    ativarAcompanhamento: () => executar('ativar-acompanhamento'),
    desativarAcompanhamento:()=>executar('desativar-acompanhamento'),
    revogar: () => executar('revogar'),
    enviarFeedback: dados => executar('feedback', { dados }),
    encerrar() {
      if (fechado) return;
      fechado = true; porta?.off('message', receber);
      for (const pendente of pendentes.values()) { clearTimeout(pendente.timer); pendente.reject(new Error('O Lume está encerrando.')); }
      pendentes.clear();
    }
  };
}

export { limpar as limparEstadoCentral };
