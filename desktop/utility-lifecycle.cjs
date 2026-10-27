const { randomUUID } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mesmoPerfil(a, b) {
  return a && b && Object.getPrototypeOf(a) === Object.prototype &&
    Object.keys(a).sort().join(',') === 'geracao,id,tipo' &&
    a.tipo === b.tipo && a.id === b.id && a.geracao === b.geracao;
}

function criarUtilityLifecycle({ worker, selection, onTerminal, timeoutMs = 5000,
  setTimer = setTimeout, clearTimer = clearTimeout, randomId = randomUUID }) {
  const boot = randomId();
  const perfil = Object.freeze({ tipo: selection.tipo, id: selection.id, geracao: selection.geracao });
  let pedido = null, motivo = null, recibo = false, falha = false, terminado = false, timer = null, corte = null;
  const keys = value => Object.keys(value).sort().join(',');
  function cortarIntake({ opId } = {}) {
    if (corte) return corte.opId === opId ? corte.promise : Promise.reject(new Error('INTAKE_CONFLITO'));
    if (pedido || terminado || typeof opId !== 'string' || !UUID.test(opId)) return Promise.reject(new Error('INTAKE_INDISPONIVEL'));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    corte = { opId, pedido: randomId(), state: 'pending', promise, resolve, reject, timer: null };
    try { worker.postMessage({ tipo: 'intake-cut-pedido', boot, pedido: corte.pedido, perfil, opId }); }
    catch { corte.state = 'failed'; reject(new Error('INTAKE_ENVIO_FALHOU')); return promise; }
    corte.timer = setTimer(() => {
      if (corte.state !== 'pending') return;
      corte.state = 'failed'; reject(new Error('INTAKE_ACK_AUSENTE'));
    }, timeoutMs);
    return promise;
  }
  function receberCorte(message) {
    if (message?.tipo !== 'intake-cut-ack') return false;
    if (!corte || corte.state !== 'pending') return true;
    if (keys(message) !== 'boot,opId,pedido,perfil,tipo' || message.boot !== boot ||
        message.pedido !== corte.pedido || message.opId !== corte.opId || !mesmoPerfil(message.perfil, perfil)) {
      corte.state = 'failed'; clearTimer(corte.timer); corte.reject(new Error('INTAKE_ACK_INVALIDO')); return true;
    }
    corte.state = 'acked'; clearTimer(corte.timer); corte.resolve({ boot, pedido: corte.pedido, perfil, opId: corte.opId });
    return true;
  }
  function terminal(code, causa) {
    if (terminado) return;
    terminado = true;
    if (timer !== null) clearTimer(timer);
    if (corte?.state === 'pending') { corte.state = 'failed'; clearTimer(corte.timer); corte.reject(new Error('INTAKE_TERMINAL')); }
    onTerminal({ motivo, code, causa, confirmado: Boolean(pedido && recibo && !falha && code === 0 &&
      (motivo !== 'manutencao' || corte?.state === 'acked')) });
  }
  function iniciar(razao, { opId } = {}) {
    if (pedido || terminado || !['normal', 'instalar', 'manutencao'].includes(razao) ||
        (razao === 'manutencao' && (corte?.state !== 'acked' || corte.opId !== opId)) ||
        (razao === 'instalar' && corte)) return false;
    motivo = razao;
    pedido = randomId();
    try { worker.postMessage({ tipo: 'shutdown-pedido', boot, pedido, perfil,
      ...(razao === 'manutencao' ? { motivo: razao, opId } : {}) }); }
    catch { falha = true; terminal(null, 'envio'); return true; }
    timer = setTimer(() => {
      if (terminado) return;
      falha = true;
      try { worker.kill(); } catch {}
      terminal(null, 'timeout');
    }, timeoutMs);
    return true;
  }
  function receber(message) {
    if (receberCorte(message)) return true;
    if (!pedido || terminado || message?.tipo !== 'shutdown-recibo') return false;
    if (message.boot !== boot || message.pedido !== pedido || !mesmoPerfil(message.perfil, perfil) ||
        keys(message) !== (motivo === 'manutencao' ? 'boot,motivo,opId,pedido,perfil,tipo' : 'boot,pedido,perfil,tipo') ||
        (motivo === 'manutencao' && (message.motivo !== motivo || message.opId !== corte.opId))) { falha = true; return true; }
    if (recibo) return true;
    recibo = true;
    try { worker.postMessage({ tipo: 'shutdown-ack', boot, pedido, perfil,
      ...(motivo === 'manutencao' ? { motivo, opId: corte.opId } : {}) }); }
    catch { falha = true; try { worker.kill(); } catch {} terminal(null, 'ack-envio'); }
    return true;
  }
  return { cortarIntake, iniciar, receber, sair: code => terminal(code, 'exit'),
    falhar: causa => { falha = true; terminal(null, causa); },
    ativo: () => Boolean(pedido && !terminado), motivo: () => motivo };
}

module.exports = { criarUtilityLifecycle };
