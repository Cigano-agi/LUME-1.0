// Motion and sound stay local. The product works without either.
(() => {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const running = new Set();
  const animations = new WeakMap();
  const signatures = new WeakMap();
  const mascotSignatures = new WeakMap();
  const mascotTimers = new WeakMap();
  const mascotStates = new Set(['idle', 'attentive', 'processing', 'success', 'alert']);
  const soundKey = 'lume-interface-sounds';


  const reduced = () => preference.matches || document.documentElement.dataset.motion === 'reduce';
  const motionReady = () => !document.hidden && !reduced() && Boolean(window.Motion?.animate);
  const inViewport = node => { const r=node.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth; };
  const stopNode=node=>{finish(node);for(const animation of node.getAnimations?.()||[])animation.cancel();};
  const viewport = typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(!entry.isIntersecting)stopNode(entry.target);}):null;
  document.addEventListener('animationstart',event=>{const node=event.target;if(!node.getBoundingClientRect)return;viewport?.observe(node);if(!motionReady()||!inViewport(node))stopNode(node);});

  function finish(node) {
    const current = node && animations.get(node);
    if (!current) return;
    try { current.complete?.(); } catch { current.cancel?.(); }
    running.delete(current);
    animations.delete(node);
  }

  function track(node, animation) {
    finish(node);
    animations.set(node, animation);
    running.add(animation);
    Promise.resolve(animation).finally(() => {
      running.delete(animation);
      if (animations.get(node) === animation) animations.delete(node);
    });
    return animation;
  }

  function animate(node, keyframes, options) {
    if (!node || !motionReady() || !inViewport(node)) return null;
    viewport?.observe(node);
    return track(node, window.Motion.animate(node, keyframes, options));
  }

  window.lumeReducedMotion = reduced;
  window.lumeSpringReveal = (node, {from = 24} = {}) => animate(node,
    {opacity:[0,1],x:[from,0]},
    {duration:.42,ease:[.2,.8,.2,1]}
  );
  window.lumeReveal = node => {
    if (!node || node.classList?.contains('mode-hidden') || node.hidden || !node.getClientRects().length) return null;
    return animate(node, { opacity: [0, 1], y: [8, 0] }, { duration: .18, ease: [.2, .8, .2, 1] });
  };
  window.lumeChanged = (node, signature = node?.textContent) => {
    if (!node) return false;
    if (signatures.has(node) && Object.is(signatures.get(node), signature)) return false;
    signatures.set(node, signature);
    if(node.id==='luminus-body'){
      animate(node,{opacity:[.5,1],x:[node.dataset.motionDirection==='previous'?-18:18,0]},{duration:.28,ease:[.2,.8,.2,1]});
    }else animate(node, { opacity: [.68, 1], y: [2, 0] }, { duration: .16, ease: [.2, .8, .2, 1] });
    return true;
  };
  window.lumeMascotState = (node, requestedState = 'idle', signature = requestedState) => {
    if (!node) return false;
    if(node.classList.contains('ls-mascote')){
      const state=({idle:'aguardando',attentive:'atencao',processing:'trabalhando',success:'concluido',alert:'atencao'})[requestedState]||requestedState;
      const previous=mascotSignatures.get(node);
      if(previous&&previous.state===state&&Object.is(previous.signature,signature))return false;
      const changed=window.LumeMascote?.atualizar(node,state)??false;
      if(changed)mascotSignatures.set(node,{state,signature});
      return changed;
    }
    const state = mascotStates.has(requestedState) ? requestedState : 'idle';
    const previous = mascotSignatures.get(node);
    if (previous && previous.state === state && Object.is(previous.signature, signature)) return false;

    const timer = mascotTimers.get(node);
    if (timer) clearTimeout(timer);
    mascotTimers.delete(node);
    finish(node);
    mascotSignatures.set(node, { state, signature });
    node.dataset.mascotState = state;

    const gestures = {
      attentive: [{ rotate: [0, -5, 0] }, { duration: .28, ease: [.2, .8, .2, 1] }],
      processing: [{ y: [0, -3, 0], scale: [1, .96, 1] }, { duration: .42, ease: [.2, .8, .2, 1] }],
      success: [{ y: [0, -6, 0], scale: [1, 1.04, 1] }, { duration: .42, ease: [.2, .8, .2, 1] }],
      alert: [{ y: [0, 2, 0], scale: [1, .92, 1] }, { duration: .28, ease: [.2, .8, .2, 1] }]
    };
    const gesture = gestures[state];
    if (gesture) animate(node, gesture[0], gesture[1]);

    if (state === 'success') {
      const reset = setTimeout(() => {
        const current = mascotSignatures.get(node);
        if (!current || current.state !== 'success' || !Object.is(current.signature, signature)) return;
        node.dataset.mascotState = 'idle';
        mascotSignatures.set(node, { state: 'idle', signature: `idle-after:${signature}` });
        mascotTimers.delete(node);
      }, 480);
      mascotTimers.set(node, reset);
    }
    return true;
  };
  window.lumeToast = (node, visible = true) => {
    if (!node) return null;
    if (visible) node.hidden = false;
    if (!motionReady()) {
      finish(node);
      if (!visible) node.hidden = true;
      return null;
    }
    const animation = animate(
      node,
      visible ? { opacity: [0, 1], y: [4, 0] } : { opacity: [1, 0] },
      { duration: .18, ease: [.2, .8, .2, 1] }
    );
    if (!visible && animation) Promise.resolve(animation).then(() => { if (!animations.has(node)) node.hidden = true; });
    return animation;
  };
  window.lumeScrollIntoView = (node, { smooth = false, ...options } = {}) => {
    if (!node?.scrollIntoView) return false;
    node.scrollIntoView({ ...options, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
    return true;
  };

  // Compatibility entry point: the preference owner controls opt-in and volume.
  window.lumeSoundEnabled = () => window.LumePreferencias?.estado().som === true && !window.LumePreferencias.estado().pausado;
  window.lumeSound = () => false; // No operational callers; previews are explicit in Aparência.

  function ready() {
    const sound = document.getElementById('ui-sounds');
    if (sound) {
      sound.checked = window.lumeSoundEnabled();
      sound.onchange = () => {
        localStorage.setItem(soundKey, sound.checked ? 'on' : 'off');
        void window.LumePreferencias?.atualizar({som:sound.checked});
      };
    }
    // F21: Interação finita de hover/foco no mascote sem loop contínuo
    document.addEventListener('pointerenter', event => {
      const mascot = event.target.closest?.('.lume-mascot');
      if (!mascot || !motionReady()) return;
      if (event.target !== mascot) return;
      if (event.relatedTarget && mascot.contains(event.relatedTarget)) return;
      if (!mascotTimers.has(mascot)) {
        animate(mascot, { scale: [1, 1.05, 1], rotate: [0, -3, 0] }, { duration: .18, ease: [.2, .8, .2, 1] });
      }
    }, true);
    document.addEventListener('focusin', event => {
      const mascot = event.target.closest?.('.lume-mascot') || event.target.querySelector?.('.lume-mascot');
      if (mascot && motionReady() && !mascotTimers.has(mascot)) {
        animate(mascot, { scale: [1, 1.06, 1] }, { duration: .18, ease: [.2, .8, .2, 1] });
      }
      if (event.target.closest?.('.sales-pipeline, .luminus-rail, nav, .memory-modes')) {
        event.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    }, true);
    const choices = [...document.querySelectorAll('#first-use .focus-choice')];
    if (choices.length && motionReady()) {
      const animation = window.Motion.animate(choices, { opacity: [0, 1], y: [8, 0] }, { duration: .2, delay: window.Motion.stagger(.045), ease: [.2, .8, .2, 1] });
      running.add(animation);
      Promise.resolve(animation).finally(() => running.delete(animation));
    }
  }

  const stopMotion = () => {
    document.documentElement.dataset.visible=String(!document.hidden);
    if (!reduced() && !document.hidden) return;
    for(const animation of document.getAnimations?.()||[])animation.cancel();
    for (const animation of [...running]) {
      try { animation.complete?.(); } catch { animation.cancel?.(); }
      running.delete(animation);
    }
  };
  preference.addEventListener?.('change', stopMotion);
  window.addEventListener('lume:preferences', stopMotion);
  document.addEventListener('visibilitychange', stopMotion);
  stopMotion();
  ready();
})();
