(() => {
  'use strict';
  const mascot=window.LumeMascote;if(!mascot)return;
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  // Preserve anchors and interaction owners while replacing the old inline art.
  function upgrade(old){
    if(old.classList.contains('ls-mascote'))return;
    const fresh=mascot.criar({estado:old.dataset.mascotState||'aguardando'});for(const cls of old.classList)fresh.classList.add(cls);if(old.id)fresh.id=old.id;fresh.setAttribute('aria-hidden','true');old.replaceWith(fresh);
  }
  document.querySelectorAll('svg.lume-mascot').forEach(upgrade);
  new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){if(node.nodeType!==1)continue;if(node.matches('svg.lume-mascot:not(.ls-mascote)'))upgrade(node);else node.querySelectorAll('svg.lume-mascot:not(.ls-mascote)').forEach(upgrade);}}).observe(document.body,{childList:true,subtree:true});
  const brandArt=document.querySelector('.sidebar .brand .ls-mascote');
  if(brandArt){
    const secret=el('button',null,'ls-brand-play');secret.id='ls-brand-play';secret.type='button';secret.setAttribute('aria-label','Lume · três toques para um aceno de brincadeira');secret.title='Três toques para um aceno';brandArt.before(secret);secret.append(brandArt);
    const message=el('span','','lv-sr-only');message.id='ls-brand-message';message.setAttribute('role','status');secret.after(message);let taps=0,last=0,reset;
    secret.onclick=()=>{const now=Date.now();if(now-last>1800)taps=0;last=now;taps++;if(taps<3)return;taps=0;clearTimeout(reset);mascot.atualizar(brandArt,'acolhimento',{previa:true});message.textContent='Prévia lúdica · um aceno para você.';reset=setTimeout(()=>{mascot.atualizar(brandArt,'aguardando',{animar:false});message.textContent='';},1200);};
  }
  const host=document.getElementById('settings-group-appearance-cards');
  if(host){
    const gallery=el('section',null,'settings-card lv-page ls-gallery');gallery.id='ls-gallery';gallery.setAttribute('aria-labelledby','ls-gallery-title');
    const heading=el('h2','Conheça seu Lume');heading.id='ls-gallery-title';
    const explanation=el('p','Um pequeno fantasma, muitas expressões. Aqui tudo é prévia: nenhuma pose indica atividade nas suas conversas.');
    const stage=el('div',null,'ls-gallery-stage'),art=mascot.criar({estado:'acolhimento',previa:true}),label=el('p','Prévia · Acolhimento','ls-gallery-status');label.id='ls-gallery-status';label.setAttribute('role','status');stage.append(art,label);
    const list=el('div',null,'ls-expression-grid');list.setAttribute('role','group');list.setAttribute('aria-label','Prévias de expressões');
    for(const state of mascot.estados){const control=el('button',state.nome,'ls-expression');control.type='button';control.dataset.expression=state.id;control.setAttribute('aria-pressed',String(state.id==='acolhimento'));const thumbnail=mascot.criar({estado:state.id,previa:true});thumbnail.setAttribute('aria-hidden','true');control.prepend(thumbnail);control.onclick=()=>{mascot.atualizar(art,state.id,{previa:true});label.textContent='Prévia · '+state.nome;list.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===control)));};list.append(control);}
    const play=el('button','Um pequeno aceno','lv-button');play.id='ls-easter-egg';play.type='button';let turn=0;const sequence=['acolhimento','curiosidade','celebracao'];
    play.onclick=()=>{const state=sequence[turn++%sequence.length];mascot.atualizar(art,state,{previa:true});label.textContent='Prévia lúdica · '+mascot.estados.find(s=>s.id===state).nome;list.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed','false'));};
    const lantern=el('button','Acender uma constelação','lv-button');lantern.id='ls-lantern-surprise';lantern.type='button';let constellationTimer;
    lantern.onclick=()=>{clearTimeout(constellationTimer);stage.querySelector('.ls-constellation')?.remove();const stars=el('span',null,'ls-constellation');stars.setAttribute('aria-hidden','true');for(let i=0;i<5;i++){const star=el('i','✦');star.style.setProperty('--star-index',String(i));stars.append(star);}stage.append(stars);mascot.atualizar(art,'ideia',{previa:true});label.textContent='Prévia lúdica · a lanterna encontrou uma constelação imaginária.';list.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed','false'));constellationTimer=setTimeout(()=>stars.remove(),1200);};
    const games=el('div',null,'lv-toolbar');games.append(play,lantern);
    gallery.append(heading,explanation,stage,list,games,el('p','Outra brincadeira: dê três toques no pequeno Lume ao lado da marca. Funciona também com Enter. Nenhuma dessas prévias toca som.','lv-card-meta'));host.append(gallery);
  }
  window.LumePresenca=Object.freeze({montar(root,{estado='aguardando'}={}){
    const header=root.querySelector('.lv-page-heading');if(!header||header.querySelector('.ls-mascote'))return;
    const art=mascot.criar({estado});art.classList.add('ls-page-companion');header.append(art);
  }});
})();
