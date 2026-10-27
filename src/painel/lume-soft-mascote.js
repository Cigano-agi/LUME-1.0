/* One original, articulated vector character for the panel and desktop. */
(() => {
  'use strict';
  const definitions=[['aguardando','Por aqui',true],['buscando','Buscando',true],['trabalhando','Conferindo',true],['concluido','Concluído',true],['atencao','Precisa de você',true],['pausado','Em pausa',true],['desconectado','Sem conexão',true],['curiosidade','Curiosidade',false],['acolhimento','Acolhimento',false],['ideia','Uma ideia',false],['leitura','Leitura',false],['celebracao','Celebração',false],['descanso','Descanso',false]];
  const states=new Map(definitions.map(([id,nome,operacional])=>[id,{id,nome,operacional}]));
  const aliases={idle:'aguardando',attentive:'atencao',processing:'trabalhando',success:'concluido',alert:'atencao'};
  const timers=new WeakMap();let serial=0;
  const visible=node=>{const r=node.getBoundingClientRect();return !document.hidden&&r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches||document.documentElement.dataset.motion==='reduce';
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const e of entries){e.target.dataset.visible=String(e.isIntersecting);if(!e.isIntersecting)parar(e.target);}}):null;
  function parar(node){clearTimeout(timers.get(node));timers.delete(node);node.classList.remove('ls-gesture');}
  function atualizar(node,requested,{previa=false,animar=true}={}){
    const state=states.get(aliases[requested]||requested);if(!node||!state||!state.operacional&&!previa)return false;
    parar(node);node.dataset.estado=state.id;node.dataset.previa=String(previa);node.setAttribute('aria-label',(previa?'Prévia · ':'')+state.nome);
    if(animar&&visible(node)&&!reduced()){node.classList.add('ls-gesture');timers.set(node,setTimeout(()=>parar(node),480));}
    return true;
  }
  function criar({estado='aguardando',rotulo,previa=false}={}){
    const node=document.createElementNS('http://www.w3.org/2000/svg','svg'),id='ls-ghost-'+(++serial);
    node.setAttribute('viewBox','0 0 180 164');node.setAttribute('class','ls-mascote');node.setAttribute('role','img');node.setAttribute('focusable','false');
    node.innerHTML=`<defs><linearGradient id="${id}" x1=".2" y1="0" x2=".8" y2="1"><stop stop-color="#fffbe4"/><stop offset=".5" stop-color="#ffe89b"/><stop offset="1" stop-color="#f4ce46"/></linearGradient><radialGradient id="${id}-light"><stop stop-color="#fff8c2" stop-opacity=".8"/><stop offset="1" stop-color="#f4ce46" stop-opacity="0"/></radialGradient></defs>
      <ellipse class="ls-shadow" cx="86" cy="148" rx="43" ry="7"/>
      <g class="ls-body"><path class="ls-arm ls-arm-left" d="M49 80Q26 74 26 93Q31 102 45 94"/><g class="ls-arm-right"><path class="ls-arm" d="M121 78Q141 67 147 84Q151 94 136 96"/><circle class="ls-lantern-glow" cx="150" cy="109" r="29" fill="url(#${id}-light)"/><path class="ls-lantern-handle" d="M142 95V88Q150 77 158 88V95"/><rect class="ls-lantern" x="140" y="94" width="20" height="28" rx="6"/><rect class="ls-lantern-core" x="144" y="99" width="12" height="16" rx="4"/><path class="ls-lantern-line" d="M139 96H161M140 120H160"/></g>
      <path class="ls-sheet" fill="url(#${id})" d="M42 75C39 43 55 23 83 22C114 20 130 41 129 75L133 122Q135 143 122 136L112 130Q106 126 100 135Q92 145 84 135Q77 126 70 134Q60 144 51 133Q45 127 36 136Q29 141 35 123Z"/>
      <path class="ls-highlight" d="M52 64Q51 37 77 33"/>
      <g class="ls-face"><g class="ls-eyes"><ellipse cx="69" cy="73" rx="4.5" ry="6"/><ellipse cx="101" cy="73" rx="4.5" ry="6"/></g><g class="ls-eye-smile"><path d="M63 75Q69 66 75 75M95 75Q101 66 107 75"/></g><g class="ls-eye-rest"><path d="M63 75Q69 80 75 75M95 75Q101 80 107 75"/></g><g class="ls-brows"><path d="M63 62L75 60M95 60L107 62"/></g><path class="ls-mouth" d="M77 89Q85 96 93 89"/><ellipse class="ls-mouth-oh" cx="85" cy="90" rx="4" ry="5"/><g class="ls-cheeks"><ellipse cx="58" cy="86" rx="7" ry="3"/><ellipse cx="112" cy="86" rx="7" ry="3"/></g></g>
      <g class="ls-book"><path d="M58 105Q72 99 85 106Q99 99 112 105V126Q98 120 85 127Q71 120 58 126Z"/><path d="M85 106V126M64 111L77 113M94 113L106 111"/></g></g>
      <g class="ls-idea"><path d="M88 10V3M106 17L113 11M69 17L62 11"/><circle cx="88" cy="14" r="5"/></g><g class="ls-spark"><path d="M30 44V56M24 50H36M142 34V46M136 40H148"/></g><g class="ls-attention"><circle cx="136" cy="38" r="12"/><path d="M136 31V39M136 43V44"/></g>`;
    atualizar(node,estado,{previa,animar:false});if(rotulo)node.setAttribute('aria-label',rotulo);observer?.observe(node);return node;
  }
  function stopAll(){if(document.hidden||reduced())document.querySelectorAll('.ls-mascote').forEach(parar);}
  document.addEventListener('visibilitychange',stopAll);window.addEventListener('lume:preferences',stopAll);matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change',stopAll);
  window.LumeMascote=Object.freeze({criar,atualizar,parar,estados:Object.freeze([...states.values()].map(Object.freeze))});
})();
