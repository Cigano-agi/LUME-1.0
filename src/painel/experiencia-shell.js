/* One desktop shell over the existing sources and permission-aware controls. */
(() => {
  'use strict';
  const get=id=>document.getElementById(id);
  const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(label,fn)=>{const n=make('button',label,'lv-button secondary');n.type='button';n.onclick=()=>run(fn,n);return n;};
  document.body.classList.add('lume-vivo');
  // Ensure the consolidated foundation follows all legacy dynamically loaded CSS.
  const css=make('link');css.rel='stylesheet';css.href='/experiencia.css';document.head.append(css);
  const nav=document.querySelector('.sidebar nav');nav.replaceChildren();
  const routes=[['today','Agora','combinados'],['memory','Memória','memoria'],['sales','Vendas','comercial'],['deliveries','Projetos','entregas'],['contacts','Pessoas','pessoas']];
  for(const [index,[route,label,category]] of routes.entries()){
    const control=button(label,async()=>{if(route==='memory')window.lumeSetMemoryMode?.('search');await window.navegarLume(route,{focarTitulo:true});});
    control.dataset.view=route;control.dataset.category=category;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.classList.add('nav-icon');use.setAttribute('href','/lume-vivo-icons.svg#lv-'+category);svg.append(use);control.prepend(svg);control.append(make('kbd',String(index+1)));nav.append(control);
  }
  const bottom=make('div',null,'nav-secondary');const settings=button('Ajustes',()=>window.navegarLume('settings',{focarTitulo:true}));settings.dataset.view='settings';bottom.append(settings);nav.append(bottom);
  const heading=(title,detail)=>{const h=make('div',null,'page-heading lv-page-heading'),copy=make('div');copy.append(make('h1',title),make('p',detail));h.append(copy);return h;};
  // Retain legacy operations and their element identities in a contextual disclosure.
  const today=get('today'),legacy=make('details',null,'lv-legacy');legacy.id='lv-legacy';
  const summary=make('summary','Todas as ações e ferramentas');legacy.append(summary);
  for(const child of [...today.children])legacy.append(child);
  today.append(heading('Agora','O que precisa de você, o que está em acompanhamento e o que aconteceu.'),legacy);
  // Keep first access visible independently of the optional legacy tools.
  today.insertBefore(get('first-use'),legacy);
  get('first-use').querySelector('h2').textContent='Sua memória começa pelas conversas';
  get('first-use').querySelector('h2 + p').textContent='Conecte o WhatsApp ou consulte as fontes que já estão neste computador.';
  const readiness=get('first-readiness');
  if(readiness)get('first-use').querySelector('.first-help').append(readiness);
  get('guide-ai').querySelector('b').textContent='Conectar meu ChatGPT';
  get('guide-ai').querySelector('small').textContent='Opcional para preparar respostas e usar o Telegram.';
  get('guide-ai').onclick=()=>run(()=>window.abrirAjuste('pessoal-panel'));
  legacy.addEventListener('toggle',()=>{if(legacy.open)void run(async()=>{await overview();await window.carregarTarefas?.();await window.carregarAcoes06?.();});});
  // Existing source/action deep-links reveal their original controls on demand.
  const openAction=window.abrirAcaoDoAviso;
  if(openAction)window.abrirAcaoDoAviso=async(...args)=>{legacy.open=true;return openAction(...args);};
  for(const [id,label,detail]of [['sales','Vendas','Oportunidades e retornos com o contexto da conversa.'],['deliveries','Projetos','Projetos, entregas, compromissos, andamento e resultados que você pode conferir.']]){
    if(get(id))continue;const section=make('section',null,'view');section.id=id;section.hidden=true;section.append(heading(label,detail));get('memory').before(section);
  }
  const searchForm=make('form',null,'lv-global-search');searchForm.id='lv-global-search';searchForm.setAttribute('role','search');
  const input=make('input');input.id='lv-global-query';input.type='search';input.maxLength=300;input.placeholder='Buscar pessoa, assunto ou combinado';input.setAttribute('aria-label','Buscar pessoa, assunto ou combinado');
  const submit=make('button','Buscar','lv-button');submit.type='submit';searchForm.append(input,submit);
  const main=document.querySelector('.workspace main');main.prepend(searchForm);
  searchForm.onsubmit=e=>{e.preventDefault();void run(async()=>{conversa='';get('search').value=input.value;get('clear-filter').hidden=true;window.lumeSetMemoryMode?.('search');await window.navegarLume('memory');get('results').tabIndex=-1;get('results').focus({preventScroll:true});},submit);};
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&!document.querySelector('dialog[open]')){e.preventDefault();input.focus();}});

  const memoryHeading=get('memory').querySelector('.page-heading');
  memoryHeading.querySelector('h1').textContent='Memória';memoryHeading.querySelector('.eyebrow').textContent='SUAS FONTES';
  memoryHeading.querySelector('div > p:last-child').textContent='Encontre o combinado e volte à mensagem que o sustenta.';
  const memoryTools=make('div',null,'lv-toolbar');memoryTools.id='lv-memory-tools';
  memoryTools.append(button('Buscar fontes',async()=>{window.lumeSetMemoryMode('search');await window.carregarModoMemoria();}),button('Conversas',async()=>{window.lumeSetMemoryMode('conversations');await window.carregarModoMemoria();}),button('Relações',()=>window.navegarLume('graph')));
  const extra=make('details');extra.append(make('summary','Mais na memória'));
  for(const [mode,label]of [['ask','Perguntar às fontes'],['commands','Itens organizados'],['businesses','Negócios confirmados'],['projects','Projetos vinculados']])extra.append(button(label,async()=>{window.lumeSetMemoryMode(mode);await window.carregarModoMemoria();}));
  memoryTools.append(extra);memoryHeading.after(memoryTools);get('memory-modes').hidden=true;
  const filters=make('details',null,'lv-memory-filters');filters.id='lv-memory-filters';filters.append(make('summary','Filtrar pessoa, assunto, período ou fonte'));
  const fields=make('div',null,'lv-filters');
  for(const [key,label,type] of [['pessoa','Pessoa','select'],['assunto','Assunto','text'],['de','Desde (UTC)','date'],['ate','Até (UTC)','date'],['tipo','Tipo de fonte','select']]){
    const wrap=make('label',label),field=make(type==='select'?'select':'input');field.id='lv-filter-'+key;
    if(type!=='select'){field.type=type;if(type==='text')field.maxLength=200;}
    else{field.append(new Option(key==='pessoa'?'Todas as pessoas':'Todos os tipos',''));if(key==='tipo')for(const [v,n]of [['texto','Texto'],['audio','Áudio'],['documento','Documento'],['imagem','Imagem'],['video','Vídeo'],['nota','Nota'],['notetaker_trecho','Reunião']])field.append(new Option(n,v));}
    wrap.append(field);fields.append(wrap);
  }
  fields.append(button('Aplicar filtros',()=>search()),button('Limpar filtros',async()=>{fields.querySelectorAll('input,select').forEach(f=>f.value='');await search();}));filters.append(fields);get('search-form').append(filters);
  let peopleLoaded=false,peoplePage=1,peopleQuery='',peopleRevision=0;
  const personSearch=make('input');personSearch.type='search';personSearch.maxLength=200;personSearch.placeholder='Encontrar pessoa pelo nome';personSearch.setAttribute('aria-label','Nome da pessoa para filtrar');
  const personStatus=make('p',null,'lv-status');personStatus.setAttribute('role','status');
  const personMore=button('Mais pessoas',()=>loadPeople(peoplePage+1));personMore.hidden=true;
  const personFind=button('Procurar pessoa',()=>{peopleQuery=personSearch.value.trim();return loadPeople(1);});
  get('lv-filter-pessoa').parentElement.append(personSearch,personFind,personMore,personStatus);
  async function loadPeople(number=1){
    const own=++peopleRevision;
    const result=await api('/api/v3/contatos?'+new URLSearchParams({pagina:String(number),q:peopleQuery,periodo:'tudo'}));
    if(own!==peopleRevision)return;
    const select=get('lv-filter-pessoa'),selected=select.value;
    if(number===1)select.replaceChildren(new Option('Todas as pessoas',''));
    for(const p of result.contatos||[]){if(p.id)select.append(new Option(p.nome||'Contato',p.id));}
    if([...select.options].some(o=>o.value===selected))select.value=selected;
    peoplePage=result.pagina?.numero||number;personMore.hidden=peoplePage>=(result.pagina?.paginas||1);peopleLoaded=true;
    personStatus.textContent=result.pagina?.total?`${select.options.length-1} de ${result.pagina.total} pessoas. Escolha uma para aplicar o filtro.`:'Nenhuma pessoa encontrada com esse nome.';
  }
  personSearch.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();personFind.click();}});
  filters.addEventListener('toggle',()=>{if(filters.open&&!peopleLoaded)void run(()=>loadPeople());});
  const contacts=get('contacts');const attendance=make('div',null,'lv-toolbar');
  attendance.append(make('p','Acompanhar, preparar resposta e atender têm permissões separadas.'),button('Atendimento por pessoa',async()=>{await window.abrirAjuste('pessoal-panel');get('pessoal-atendimento')?.scrollIntoView({block:'start'});}));contacts.prepend(attendance);

  window.lumeSyncNavigation=()=>{
    if(page==='sales'||page==='deliveries')get('current-page').textContent=page==='sales'?'Vendas':'Projetos';
    const current=page==='memory'&&get('memory').dataset.mode==='contacts'?'contacts':page==='graph'?'memory':page;
    for(const n of nav.querySelectorAll('[data-view]')){const active=n.dataset.view===current;n.classList.toggle('active',active);if(active)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');}
    if(page==='memory'){const people=current==='contacts';get('current-page').textContent=people?'Pessoas':'Memória';memoryHeading.querySelector('h1').textContent=people?'Pessoas':'Memória';memoryTools.hidden=people;memoryHeading.querySelector('.eyebrow').textContent=people?'SEUS CONTATOS':'SUAS FONTES';memoryHeading.querySelector('div > p:last-child').textContent=people?'Pessoas, contexto recente e atendimento sob seu controle.':'Encontre o combinado e volte à mensagem que o sustenta.';}
  };
  const clear=window.limparDadosVisiveis;
  window.limparDadosVisiveis=(...args)=>{peopleRevision++;peopleLoaded=false;peopleQuery='';personSearch.value='';personStatus.textContent='';personMore.hidden=true;get('lv-filter-pessoa').replaceChildren(new Option('Todas as pessoas',''));window.LumeVivo?.limpar();window.dispatchEvent(new CustomEvent('lume:invalidate'));return clear?.(...args);};
  window.lumeSyncNavigation();
})();
