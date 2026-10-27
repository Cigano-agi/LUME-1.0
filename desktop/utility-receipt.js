function mesmoPerfil(a, b) {
  return a && b && Object.getPrototypeOf(a) === Object.prototype &&
    Object.keys(a).sort().join(',') === 'geracao,id,tipo' &&
    a.tipo === b.tipo && a.id === b.id && a.geracao === b.geracao;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// O corte inicia finalizers antes do pedido de shutdown. Observe rejeições já,
// preservando o Promise original para que o drain ainda receba a falha.
export function observarDrenagem(promise) {
  void promise.catch(() => {});
  return promise;
}

export function criarReciboUtility({ selection, postMessage, fechar, cortarIntake, onError = () => {},
  timeoutMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const perfil = Object.freeze({ tipo: selection.tipo, id: selection.id, geracao: selection.geracao });
  let pedido = null, corte = null, estado = 'idle', ackResolve, ackReject, timer;
  const keys = value => Object.keys(value).sort().join(',');
  function receberCorte(message) {
    if (message?.tipo !== 'intake-cut-pedido') return false;
    if (keys(message) !== 'boot,opId,pedido,perfil,tipo' ||
        typeof message.boot !== 'string' || !message.boot || typeof message.pedido !== 'string' || !message.pedido ||
        typeof message.opId !== 'string' || !UUID.test(message.opId) || !mesmoPerfil(message.perfil, perfil) ||
        estado !== 'idle' || typeof cortarIntake !== 'function') return false;
    if (corte) {
      if (corte.boot !== message.boot || corte.pedido !== message.pedido || corte.opId !== message.opId ||
          corte.state !== 'acked') return false;
    } else {
      corte = { boot: message.boot, pedido: message.pedido, opId: message.opId, state: 'cutting' };
      try {
        const result = cortarIntake();
        if (result && typeof result.then === 'function') throw new Error('INTAKE_CORTE_ASSINCRONO');
        corte.state = 'acked';
      } catch (error) { corte.state = 'failed'; onError(error); return true; }
    }
    try { postMessage({ tipo: 'intake-cut-ack', boot: corte.boot, pedido: corte.pedido, perfil, opId: corte.opId }); }
    catch (error) { corte.state = 'failed'; onError(error); }
    return true;
  }
  function cancelar() {
    if (estado === 'cancelled') return;
    estado = 'cancelled';
    if (timer !== undefined) clearTimer(timer);
    ackReject?.(new Error('ACK indisponível'));
  }
  function aguardarAck() {
    if (!pedido) return Promise.resolve(); // fechamento legado, sem recibo
    if (estado === 'cancelled') return Promise.reject(new Error('Encerramento cancelado'));
    estado = 'waiting';
    return new Promise((resolve, reject) => {
      ackResolve = resolve; ackReject = reject;
      timer = setTimer(() => { cancelar(); }, timeoutMs);
      try { postMessage({ tipo: 'shutdown-recibo', boot: pedido.boot, pedido: pedido.pedido, perfil,
        ...(pedido.motivo === 'manutencao' ? { motivo: pedido.motivo, opId: pedido.opId } : {}) }); }
      catch (error) { cancelar(); }
    }).then(() => {
      if (estado !== 'acked') throw new Error('Encerramento cancelado');
    });
  }
  function receber(message) {
    if (receberCorte(message)) return true;
    if (message?.tipo === 'shutdown-ack') {
      if (estado !== 'waiting' || message.boot !== pedido.boot || message.pedido !== pedido.pedido ||
          !mesmoPerfil(message.perfil, perfil) ||
          keys(message) !== (pedido.motivo === 'manutencao' ? 'boot,motivo,opId,pedido,perfil,tipo' : 'boot,pedido,perfil,tipo') ||
          (pedido.motivo === 'manutencao' && (message.motivo !== pedido.motivo || message.opId !== pedido.opId))) return false;
      estado = 'acked'; clearTimer(timer); ackResolve(); return true;
    }
    if (message?.tipo !== 'shutdown-pedido') return false;
    const maintenance = message.motivo === 'manutencao';
    if (keys(message) !== (maintenance ? 'boot,motivo,opId,pedido,perfil,tipo' : 'boot,pedido,perfil,tipo') ||
        typeof message.boot !== 'string' || !message.boot || typeof message.pedido !== 'string' || !message.pedido ||
        !mesmoPerfil(message.perfil, perfil) || keys(message.perfil) !== 'geracao,id,tipo' ||
        (maintenance && (typeof message.opId !== 'string' || !message.opId ||
          corte?.state !== 'acked' || corte.boot !== message.boot || corte.opId !== message.opId))) return false;
    if (pedido) return pedido.boot === message.boot && pedido.pedido === message.pedido &&
      pedido.motivo === (maintenance ? 'manutencao' : null) && (!maintenance || pedido.opId === message.opId);
    pedido = { boot: message.boot, pedido: message.pedido, motivo: maintenance ? 'manutencao' : null,
      opId: maintenance ? message.opId : null };
    estado = 'closing';
    try { Promise.resolve(fechar()).catch(onError); } catch (error) { onError(error); }
    return true;
  }
  return { receber, aguardarAck, cancelar };
}
