/* Classic script shares the app's safe DOM/source components. No remote assets. */
(() => {
  const layout=import('./graph-layout.js');
  const canvas=$('network'),ns='http://www.w3.org/2000/svg';
  let request=0,sourceRequest=0,state=null,filter={q:'',periodo:'tudo',projeto:'',foco:'',pagina:1};
  let camera={x:480,y:270,zoom:1},drag=null,selectedId=null,selectionTrigger=null;
  const svg=(tag,attrs={})=>{const n=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;};
  const reducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function reveal(panel){
    panel.tabIndex=-1;panel.focus({preventScroll:true});
    panel.scrollIntoView({block:'nearest',behavior:reducedMotion()?'auto':'smooth'});
  }
  // Keep the selected name/actions next to the map, ahead of help and pagination.
  canvas.closest('.graph-panel').after($('graph-selection'),$('graph-sources'));
  $('graph-query').placeholder='Nome de pessoa ou conversa';
  $('graph-query').closest('label').firstChild.textContent='Buscar pessoa ou conversa';
  $('graph-help').textContent='Selecione um ponto ou use a lista. Enter ou espaço selecionam; Esc volta ao mapa. Arraste o fundo para mover. Distância entre pontos não mede proximidade.';
  for(const id of ['graph-selection','graph-sources'])$(id).addEventListener('keydown',e=>{
    if(e.key!=='Escape')return;e.preventDefault();
    const target=selectionTrigger?.isConnected?selectionTrigger:[...canvas.querySelectorAll('.graph-node')].find(n=>n.dataset.id===selectedId);
    (target??canvas).focus();
  });
  function clearSources(){sourceRequest++;$('graph-sources').replaceChildren();$('graph-sources').hidden=true;}
  function clear(){
    request++;state=null;drag=null;selectedId=null;selectionTrigger=null;clearSources();canvas.replaceChildren();$('graph-list').replaceChildren();
    $('graph-selection').replaceChildren();$('graph-selection').hidden=true;
    for(const id of ['graph-count','graph-sample','graph-page'])$(id).textContent='';
    $('graph-back').hidden=!filter.foco;$('graph-empty').hidden=true;
    $('graph-prev').disabled=true;$('graph-next').disabled=true;canvas.setAttribute('aria-busy','false');
  }
  window.limparGrafo=()=>{clear();$('graph-count').textContent='Atualize para consultar o recorte atual.';};
  function viewport(){
    const w=960/camera.zoom,h=540/camera.zoom;
    camera.x=Math.max(-480,Math.min(1440,camera.x));camera.y=Math.max(-270,Math.min(810,camera.y));
    canvas.setAttribute('viewBox',`${camera.x-w/2} ${camera.y-h/2} ${w} ${h}`);$('graph-zoom').textContent=Math.round(camera.zoom*100)+'%';
  }
  function zoom(factor){camera.zoom=Math.max(0.5,Math.min(4,camera.zoom*factor));viewport();}
  $('graph-in').onclick=()=>zoom(1.25);$('graph-out').onclick=()=>zoom(0.8);
  $('graph-reset').onclick=()=>{camera={x:480,y:270,zoom:1};viewport();};
  canvas.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();zoom(e.deltaY<0?1.15:1/1.15);},{passive:false});
  canvas.addEventListener('keydown',e=>{
    if(e.target!==canvas)return;
    const vectors={ArrowLeft:[-45,0],ArrowRight:[45,0],ArrowUp:[0,-45],ArrowDown:[0,45]};
    if(vectors[e.key]){e.preventDefault();camera.x+=vectors[e.key][0]/camera.zoom;camera.y+=vectors[e.key][1]/camera.zoom;viewport();}
    if(['+','=','-'].includes(e.key)){e.preventDefault();zoom(e.key==='-'?0.8:1.25);}
  });
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('.graph-node'))return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,cx:camera.x,cy:camera.y,moved:false};});
  canvas.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;
    if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;
    if(!drag.moved){drag.moved=true;canvas.setPointerCapture(e.pointerId);}
    const rect=canvas.getBoundingClientRect(),scale=Math.min(rect.width/960,rect.height/540)*camera.zoom;
    camera.x=drag.cx-(e.clientX-drag.x)/scale;camera.y=drag.cy-(e.clientY-drag.y)/scale;viewport();
  });
  for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,e=>{if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);drag=null;});
  async function sources(edge,append=false,cursor=null){
    if(!state)return;
    const revision=revisaoDadosVisiveis,ticket=++sourceRequest,current=request;
    const panel=$('graph-sources');panel.hidden=false;
    if(!append){panel.replaceChildren(element('h2','Mensagens desta ligação'),element('p','Carregando mensagens…','graph-source-status'));reveal(panel);}
    const params=new URLSearchParams({conversa:edge.conversa_id,autor:edge.autor_id,periodo:filter.periodo,projeto:filter.projeto});
    if(cursor)params.set('antes',cursor);
    try{
      const r=await api('/api/v3/grafo/fontes?'+params);
      if(ticket!==sourceRequest||current!==request||revision!==revisaoDadosVisiveis)return;
      panel.querySelector('.graph-source-status')?.remove();panel.querySelector('.graph-source-more')?.remove();
      if(!append)panel.append(element('p','Desta pessoa nesta conversa, com os filtros do mapa.','muted'));
      if(!r.mensagens.length&&!append)panel.append(element('p','Nenhuma fonte disponível. O recorte pode ter mudado.'));
      panel.append(...r.mensagens.map(m=>source({...m,texto:m.texto||(m.tipo==='audio'?null:`Registro de ${m.tipo} sem texto.`)})));
      if(r.proximoAntes)panel.append(action('Mais mensagens desta ligação',()=>sources(edge,true,r.proximoAntes),'secondary graph-source-more'));
    }catch(e){
      if(ticket!==sourceRequest||current!==request||revision!==revisaoDadosVisiveis)return;
      panel.replaceChildren(element('h2','Não consegui carregar estas fontes.'),element('p',e.message),action('Tentar fontes novamente',()=>sources(edge),'secondary'));
    }
  }
  function select(id,trigger=null){
    if(!state)return;const n=state.nos.find(n=>n.id===id);if(!n)return;
    selectedId=id;selectionTrigger=trigger;
    clearSources();const edges=state.arestas.filter(e=>e.origem===id||e.destino===id),neighbors=new Set([id,...edges.flatMap(e=>[e.origem,e.destino])]);
    canvas.querySelectorAll('.graph-node').forEach(g=>{g.classList.toggle('graph-muted',!neighbors.has(g.dataset.id));g.classList.toggle('selected',g.dataset.id===id);g.setAttribute('aria-pressed',String(g.dataset.id===id));});
    canvas.querySelectorAll('.edge').forEach(g=>g.classList.toggle('graph-muted',g.dataset.from!==id&&g.dataset.to!==id));
    $('graph-list').querySelectorAll('button').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.id===id));b.classList.toggle('selected',b.dataset.id===id);});
    const panel=$('graph-selection');panel.hidden=false;panel.replaceChildren(element('p',n.tipo==='conversa'?'CONVERSA':'PESSOA','eyebrow'),element('h2',n.nome));
    panel.querySelector('h2').id='graph-selected-title';panel.setAttribute('aria-labelledby','graph-selected-title');
    panel.append(element('p',`${number(n.mensagens)} mensagens ${n.tipo==='conversa'?'nesta conversa':'nas conversas exibidas'}.`));
    const controls=element('div',null,'button-row');
    controls.append(action(n.tipo==='conversa'?'Focar conversa':'Focar pessoa',()=>{filter.foco=n.id;filter.pagina=1;return load();},'primary'));
    if(n.tipo==='conversa')controls.append(action('Abrir conversa',()=>openConversation(n.conversa_id,n.nome),'secondary'));
    panel.append(controls,element('h3',n.tipo==='conversa'?'Pessoas nesta conversa':'Conversas desta pessoa'));
    if(!edges.length)panel.append(element('p','Não há autor identificado nas mensagens deste recorte.'));
    for(const e of edges){
      const other=state.nos.find(o=>o.id===(n.tipo==='conversa'?e.origem:e.destino)),row=element('div',null,'graph-relation');
      row.append(element('span',`${other.nome} · ${number(e.mensagens)} mensagens`),action('Conferir mensagens',()=>sources(e),'secondary'));panel.append(row);
    }
    reveal(panel);
  }
  function paint(data,positions){
    canvas.classList.toggle('graph-dense',data.nos.length>30);
    for(const e of data.arestas){const a=positions.get(e.origem),b=positions.get(e.destino);if(!a||!b)continue;
      const line=svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,class:'edge'});line.dataset.from=e.origem;line.dataset.to=e.destino;canvas.append(line);
    }
    for(const n of data.nos){
      const p=positions.get(n.id),group=svg('g',{class:'graph-node'+(n.tipo==='pessoa'?' person':''),transform:`translate(${p.x} ${p.y})`,tabindex:0,role:'button','aria-label':`${n.tipo==='pessoa'?'Pessoa':'Conversa'}: ${n.nome}`,'aria-pressed':'false','aria-controls':'graph-selection'});
      group.dataset.id=n.id;const title=svg('title');title.textContent=n.nome;
      group.append(title,svg('circle',{r:8+Math.min(13,Math.log2(n.mensagens+1))}));
      const text=svg('text',{y:35,'text-anchor':'middle'});text.textContent=n.nome.length>23?n.nome.slice(0,22)+'…':n.nome;
      // Product CSS disables text hit testing; labels must remain part of the
      // button instead of starting a pan on the underlying canvas.
      text.style.pointerEvents='auto';group.append(text);
      group.onclick=()=>select(n.id,group);group.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();if(!e.repeat)select(n.id,group);}};canvas.append(group);
      const b=action(`${n.tipo==='pessoa'?'Pessoa':'Conversa'} · ${n.nome} · ${number(n.mensagens)}`,()=>select(n.id,b),'secondary');b.dataset.id=n.id;b.setAttribute('aria-pressed','false');b.setAttribute('aria-controls','graph-selection');$('graph-list').append(b);
    }
  }
  async function load(){
    clear();const ticket=request,revision=revisaoDadosVisiveis;
    const params=new URLSearchParams(filter);$('graph-count').textContent='Carregando conexões…';canvas.setAttribute('aria-busy','true');
    try{
      const [data,{layoutGrafo}]=await Promise.all([api('/api/v3/grafo?'+params),layout]);
      if(ticket!==request||revision!==revisaoDadosVisiveis)return;
      state=data;filter.pagina=data.pagina.numero;
      const selectProject=$('graph-project'),draftProject=selectProject.value;
      selectProject.replaceChildren(new Option('Todos os projetos',''),...data.projetos.map(p=>new Option(p.nome,p.id)));
      selectProject.value=draftProject;
      const period=data.recorte.desde?`${data.recorte.desde} a ${data.recorte.ate}`:`Histórico até ${data.recorte.ate}`;
      const project=data.projetos.find(p=>p.id===data.recorte.projeto)?.nome;
      $('graph-count').textContent=`${number(data.total.mensagens)} mensagens · ${number(data.total.conversas)} conversas · ${number(data.total.ligacoes)} ligações · ${period}${project?' · '+project:''}${filter.q?' · busca: '+filter.q:''}${data.foco?' · foco: '+data.foco.nome:''}`;
      $('graph-page').textContent=`${data.pagina.tipo} · página ${number(data.pagina.numero)} de ${number(data.pagina.paginas)} · ${number(data.pagina.total)} no recorte`;
      $('graph-prev').disabled=data.pagina.numero<=1;$('graph-next').disabled=data.pagina.numero>=data.pagina.paginas;
      $('graph-sample').textContent=`${filter.foco.startsWith('c:')?'Percorra as páginas para ver todas as pessoas.':'Até 3 pessoas por conversa; use Focar conversa para ver todas.'} ${data.total.semAutor?number(data.total.semAutor)+' mensagens sem autor identificado.':''}`;
      camera={x:480,y:270,zoom:1};viewport();paint(data,layoutGrafo(data.nos,data.arestas));
      if(data.foco)select(data.foco.id);
      if(!data.nos.length){$('graph-empty').hidden=false;$('graph-empty').replaceChildren(element('h2','Nenhuma conexão neste recorte.'),element('p','Ajuste os filtros ou confira a leitura em Configurações.'));}
    }catch(e){
      if(ticket!==request||revision!==revisaoDadosVisiveis)return;
      $('graph-count').textContent='Não consegui carregar o mapa.';$('graph-empty').hidden=false;
      $('graph-empty').replaceChildren(element('h2','Vamos tentar novamente?'),element('p',e.message),action('Tentar mapa novamente',load,'secondary'));
    }finally{if(ticket===request)canvas.setAttribute('aria-busy','false');}
  }
  $('graph-filters').onsubmit=e=>{e.preventDefault();filter={q:$('graph-query').value,periodo:$('graph-period').value,projeto:$('graph-project').value,foco:'',pagina:1};return run(load);};
  $('graph-back').onclick=()=>{filter.foco='';filter.pagina=1;run(load);};
  $('graph-prev').onclick=()=>{filter.pagina--;run(load);};$('graph-next').onclick=()=>{filter.pagina++;run(load);};
  window.carregarGrafo=load;
})();
