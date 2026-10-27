// The only hot maintenance path in main. The A lease and its database stay private.
function criarControladorManutencao({ userData, selection, getBroker, getUtility,
  reserve, mostrarLocal, restart, onQuitReady, onState = () => {}, api } = {}) {
  if (!userData || !selection || !getBroker || !getUtility || !reserve || !mostrarLocal ||
      !restart || !onQuitReady) throw new TypeError('MANUTENCAO_DEPENDENCIAS');
  let phase = 'normal', pendingQuit = false, quitReadyFired = false, beginPromise, endPromise;
  let restartAbort;
  let maintenanceHandle, noMutationToken, publicHandle, operation;
  let contract;
  const getContract = () => (contract ||= api ? Promise.resolve(api) : import('../src/perfil-manutencao.js'));
  const setPhase = next => { phase = next; onState(next); };
  const quitReady = () => { if (!quitReadyFired) { quitReadyFired = true; onQuitReady(); } };
  const enterIncerto = () => { setPhase('incerto'); if (pendingQuit) quitReady(); };
  const confirmed = result => result?.confirmed === true;
  const utilityClosed = result => result?.confirmado === true && result.code === 0;

  function requestQuit() {
    if (phase === 'normal') return false;
    pendingQuit = true;
    restartAbort?.abort();
    if (phase === 'incerto') quitReady();
    return true;
  }

  function beginMaintenance({ opId, kind } = {}) {
    if (beginPromise) {
      if (operation?.opId === opId && operation.kind === kind) return beginPromise;
      return Promise.reject(new Error('MANUTENCAO_CONFLITO'));
    }
    if (phase !== 'normal' || kind !== 'notetaker-delete' || typeof opId !== 'string')
      return Promise.reject(new Error('MANUTENCAO_INDISPONIVEL'));
    // All three steps are synchronous. No marker or await may precede the cut.
    if (reserve('manutencao') !== true) return Promise.reject(new Error('MANUTENCAO_DECISAO_OCUPADA'));
    operation = { opId, kind };
    setPhase('cortando');
    const broker = getBroker(), utility = getUtility();
    let cutPromise;
    try {
      broker.stopAdmission();
      cutPromise = utility.lifecycle.cortarIntake({ opId });
    } catch (error) { cutPromise = Promise.reject(error); }
    beginPromise = (async () => {
      let marker, startedAttempted = false;
      try {
        const ack = await cutPromise;
        if (ack?.opId !== opId) throw new Error('INTAKE_ACK_INVALIDO');
        const a = await getContract();
        marker = await a.createMaintenanceMarker({ userData, selection, opId, kind });
        // Once this call is attempted the marker is never released as "unstarted".
        startedAttempted = true;
        a.markMaintenanceStarted(marker);
        maintenanceHandle = marker;
        setPhase('drenando');
        await mostrarLocal();
        const brokerDone = broker.shutdown();
        void brokerDone.catch(() => {});
        if (utility.lifecycle.iniciar('manutencao', { opId }) !== true)
          throw new Error('MANUTENCAO_UTILITY_RECUSOU');
        const [brokerResult, utilityResult] = await Promise.all([brokerDone, utility.terminal]);
        if (!confirmed(brokerResult) || !utilityClosed(utilityResult))
          throw new Error('MANUTENCAO_DRAIN_NAO_CONFIRMADO');
        noMutationToken = await a.acquireExclusiveNoMutation({ selection, maintenanceHandle: marker });
        publicHandle = Object.freeze({ opId, kind });
        setPhase('exclusiva');
        return publicHandle;
      } catch (error) {
        if (!startedAttempted) {
          try {
            const a = await getContract();
            if (marker) await a.releaseUnstartedMarker(marker);
            await mostrarLocal();
            const brokerDone = broker.shutdown();
            void brokerDone.catch(() => {});
            if (utility.lifecycle.iniciar('normal') !== true) throw new Error('MANUTENCAO_UTILITY_RECUSOU');
            const [brokerResult, utilityResult] = await Promise.all([brokerDone, utility.terminal]);
            if (!confirmed(brokerResult) || !utilityClosed(utilityResult))
              throw new Error('MANUTENCAO_FECHAMENTO_INCERTO');
            a.assertNormalBootAllowed(userData);
            if (pendingQuit) quitReady();
            else {
              restartAbort = new AbortController();
              await restart({ quitSignal:restartAbort.signal });
              restartAbort = null;
              if (pendingQuit) quitReady();
            }
            setPhase('normal');
            maintenanceHandle = null; noMutationToken = null; publicHandle = null;
            operation = null; beginPromise = null; endPromise = null;
          } catch { enterIncerto(); }
        } else {
          // The marker remains authoritative. Close both services when possible.
          try { await broker.shutdown(); } catch {}
          try {
            if (!utility.lifecycle.ativo?.()) utility.lifecycle.iniciar('manutencao', { opId });
            await utility.terminal;
          } catch {}
          enterIncerto();
        }
        throw error;
      }
    })();
    return beginPromise;
  }

  function endMaintenance(handle) {
    if (phase === 'finalizando' && handle === publicHandle && endPromise) return endPromise;
    if (phase !== 'exclusiva' || handle !== publicHandle || !maintenanceHandle || !noMutationToken)
      return Promise.reject(new Error('MANUTENCAO_HANDLE_INVALIDO'));
    setPhase('finalizando');
    endPromise = (async () => {
      try {
        const a = await getContract();
        const receipt = await a.finishMaintenanceWithoutMutation({
          maintenanceHandle, noMutationToken
        });
        if (receipt?.opId !== operation.opId || receipt.kind !== operation.kind ||
            receipt.outcome !== 'sem_mutacao' || receipt.leaseClosed !== true ||
            receipt.markerRemoved !== true) throw new Error('MANUTENCAO_RECIBO_INVALIDO');
        noMutationToken = null;
        if (pendingQuit) quitReady();
        else {
          restartAbort = new AbortController();
          await restart({ quitSignal:restartAbort.signal });
          restartAbort = null;
          if (pendingQuit) quitReady();
        }
        setPhase('normal');
        maintenanceHandle = null; noMutationToken = null; publicHandle = null;
        operation = null; beginPromise = null; endPromise = null;
        return receipt;
      } catch (error) {
        enterIncerto();
        throw error;
      }
    })();
    return endPromise;
  }

  return Object.freeze({ beginMaintenance, endMaintenance, requestQuit, state: () => phase });
}

module.exports = { criarControladorManutencao };
