/* Lume 1.0: permission-aware local projections. No sample content or remote assets. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = String(text); if (cls) n.className = cls; return n; };
  const status = text => { const n = el('p', text, 'lv-status'); n.setAttribute('role', 'status'); return n; };
  const button = (text, action) => { const n = el('button', text, 'lv-button'); n.type = 'button'; n.onclick = () => Promise.resolve().then(action).catch(error => { if(n.isConnected)n.after(status(error.message || 'Não foi possível concluir.')); }); return n; };
  const request = (path, body, signal) => window.lumeConnectionRequest(path, body, {timeout: 15000, signal});
  const denied = error => [401,403,404,410].includes(error.status)||['SOURCE_CHANGED','FONTE_ALTERADA','FORBIDDEN','SOURCE_UNAVAILABLE','FONTE_INDISPONIVEL','PROJETO_INDISPONIVEL'].includes(error.code||error.codigo);
  const date = value => { const d = value && new Date(value); return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('pt-BR') : 'Data não informada'; };
  const tagLabels = {cliente:'Cliente',fornecedor:'Fornecedor',equipe:'Equipe',parceiro:'Parceiro',organizacao:'Organização',projeto:'Projeto'};
  const interestLabels={frio:'Frio',morno:'Morno',quente:'Quente',insuficiente:'Sem informação suficiente'};
  const coverageControllers=new Map();
  if(!document.getElementById('lume-auto-style')){const style=el('link');style.id='lume-auto-style';style.rel='stylesheet';style.href='/lume-auto.css';document.head.append(style);}
  function interesse(data={}){
    const value=!data.desatualizada&&!data.incerta&&Object.hasOwn(interestLabels,data.temperatura)?data.temperatura:'insuficiente';
    const badge=el('span',null,'la-interest');badge.dataset.temperature=value;
    const bars=el('span',null,'la-interest-bars');bars.setAttribute('aria-hidden','true');for(let i=0;i<3;i++)bars.append(el('i'));
    badge.append(bars,el('span','Interesse: '+interestLabels[value]));return badge;
  }
  function projectLinks(projects,root,selection={}){
    if(!Array.isArray(projects)||!projects.length)return;
    const links=el('div',null,'lv-toolbar la-project-links');links.setAttribute('aria-label','Projetos deste contexto');
    for(const project of projects)if(project.id)links.append(button(project.nome||'Abrir projeto',()=>timeline({...selection,projeto:project.id,titulo:project.nome})));
    root.append(links);
  }
  function reverInteresse(data,root,{signal,valid,refresh}){
    const proof=data?.fontes?.find(item=>item?.eventoId!=null&&typeof item.trecho==='string'&&item.trecho);
    if(!proof)return;
    const details=el('details',null,'la-interest-correction');details.append(el('summary','Corrigir avaliação deste assunto'));
    const form=el('form',null,'la-interest-form'),temperature=el('select'),stage=el('select');
    temperature.setAttribute('aria-label','Interesse neste assunto');stage.setAttribute('aria-label','Etapa avaliada neste assunto');
    for(const [value,label]of Object.entries(interestLabels))temperature.append(new Option(label,value));
    for(const [value,label]of Object.entries({insuficiente:'Sem informação suficiente',interesse:'Interesse',proposta:'Proposta',conversa:'Em conversa',fechado:'Fechamento citado',encerrado:'Encerrado'}))stage.append(new Option(label,value));
    temperature.value=data.desatualizada||data.incerta?'insuficiente':data.temperatura;stage.value=data.etapa||'insuficiente';
    const temperatureLabel=el('label','Interesse neste assunto'),stageLabel=el('label','Etapa avaliada neste assunto');temperatureLabel.append(temperature);stageLabel.append(stage);
    const save=el('button','Salvar minha avaliação','lv-button');save.type='submit';const feedback=status('');
    form.append(el('p','Sua correção vale para este trecho e prevalece sobre novas sugestões. Não confirma uma venda nem autoriza envio.','lv-status'),el('blockquote',proof.trecho),temperatureLabel,stageLabel,save,feedback);details.append(form);root.append(details);
    form.onsubmit=async event=>{event.preventDefault();if(save.disabled||!valid())return;save.disabled=true;feedback.textContent='Conferindo a fonte e salvando sua avaliação…';
      try{await request('/api/v3/lume-1/organizacao/temperatura',{eventoId:proof.eventoId,trecho:proof.trecho,temperatura:temperature.value,etapa:stage.value},signal);if(valid())await refresh();}
      catch(error){if(valid()){if(denied(error)){root.replaceChildren(status(error.message),button('Atualizar contexto',refresh));return;}feedback.textContent=error.message;save.disabled=false;}}
    };
  }
  const commitmentStates={sugerido:'Sugerido · confira a fonte',confirmado:'Confirmado',estacionado:'Estacionado',resolvido:'Conclusão informada',descartado:'Descartado',pendente:'Pendente',em_andamento:'Em andamento',concluido:'Conclusão informada',concluida:'Conclusão informada'};
  const executionStates={nenhuma:'Sem execução registrada',aguardando_assistente:'Aguardando executor',em_andamento:'Em execução',executando:'Em execução',resultado_informado:'Resultado informado · falta conferir',verificado:'Resultado verificado',verificada:'Resultado verificado',enviado:'Envio registrado',aceito:'Aceite registrado',aceita:'Aceite registrado',revogada:'Autorização revogada',invalidada:'Contexto alterado · confira',expirada:'Autorização expirada',indisponivel:'Execução indisponível',falhou:'Execução falhou',cancelada:'Execução cancelada'};
  const stateLabel=(value,labels)=>labels[value]||(typeof value==='string'?value.replaceAll('_',' '):'Não informado');
  let peopleRevision = 0, peopleController, panelRevision = 0, panelController, dialog, returnFocus;
  function errors(root, error, retry) { root.replaceChildren(status(error.message || 'Não foi possível consultar este recorte.'),button('Tentar novamente',retry)); }
  function source(item, root) {
    const id = item.fonte?.eventoId ?? item.eventoId;
    if (id != null) root.append(button('Conferir fonte', () => { close(); return window.abrirFonteTarefa?.(id); }));
  }
  function occurrences(items,root,fallback){
    const kinds={decisao:'Decisão',mudanca:'Mudança',resultado:'Resultado citado'};
    for(const item of Array.isArray(items)?items:[]){
      const section=el('section',null,'lv-section l1-occurrence');section.setAttribute('aria-label','Acontecimento da mensagem');
      section.append(el('h4',kinds[item.tipo]||'Acontecimento citado'),el('p',item.resumo||'Resumo não disponível'),el('p','Inferido · confira a fonte','lv-card-meta'));
      if(item.atualizadoEm)section.append(el('p','Organizado em '+date(item.atualizadoEm),'lv-card-meta'));
      if(item.trecho)section.append(el('blockquote',item.trecho));
      if(item.tipo==='resultado')section.append(el('p','Resultado citado na conversa; verificação, envio e aceite exigem registros próprios.','lv-status'));
      source(item.fonte?.eventoId!=null?item:fallback,section);root.append(section);
    }
  }
  function organizations(items,root,{signal,valid,refresh}={}){
    for(const item of Array.isArray(items)?items:[]){
      const section=el('section',null,'lv-section l1-organization');section.setAttribute('aria-label','Organização citada');
      section.append(el('h4','Organização citada'),el('p',item.nome||'Nome não disponível'),el('p',item.origem==='manual'?'Corrigido por você':'Inferido · confira a fonte','lv-card-meta'));
      if(item.trecho)section.append(el('blockquote',item.trecho));
      if(item.atualizadoEm)section.append(el('p','Organizado em '+date(item.atualizadoEm),'lv-card-meta'));
      for(const proof of item.fontes||[])source(proof,section);
      const proof=item.fontes?.find(p=>p.eventoId!=null&&(p.trecho||item.trecho));
      if(proof){
        const details=el('details'),form=el('form',null,'lv-section'),label=el('label','Nome da organização'),input=el('input');input.value=item.nome||'';input.maxLength=160;input.required=true;label.append(input);
        const save=el('button','Salvar organização','lv-button');save.type='submit';const remove=button('Remover vínculo de organização',()=>persist('')),message=status('');
        form.append(label,el('p','A correção vale para este trecho. Remover o vínculo preserva a conversa e sua identidade de pessoa ou grupo.','lv-status'),save,remove,message);details.append(el('summary','Rever organização'),form);section.append(details);
        const current=()=>section.isConnected&&!signal?.aborted&&(!valid||valid());let busy=false;
        async function persist(name){
          if(busy||!current())return;busy=true;save.disabled=true;remove.disabled=true;message.textContent='Conferindo a fonte e salvando a organização…';
          try{await request('/api/v3/lume-1/organizacao/vinculo',{eventoId:proof.eventoId,trecho:proof.trecho||item.trecho,nome:name},signal);if(!current())return;message.textContent=name?'Organização salva.':'Vínculo removido.';await refresh?.();}
          catch(error){if(current()){if(denied(error)){section.replaceChildren(status(error.message));return;}message.textContent=error.message;}}
          finally{if(current()){busy=false;save.disabled=false;remove.disabled=false;}}
        }
        form.onsubmit=event=>{event.preventDefault();const name=input.value.trim();if(!name){message.textContent='Informe o nome para salvar, ou use Remover vínculo de organização.';return;}void persist(name);};
      }
      root.append(section);
    }
  }
  function commitments(items, root){
    for(const item of Array.isArray(items)?items:[]){
      const section=el('section',null,'lv-section l1-commitment');section.setAttribute('aria-label','Compromisso da mensagem');
      section.append(el('h4',item.resumo||'Compromisso sem resumo'),el('p','Compromisso: '+stateLabel(item.estado,commitmentStates),'lv-card-meta'),el('p','Execução: '+stateLabel(item.execucao?.estado,executionStates),'lv-card-meta'));
      if(typeof item.prazo==='string'&&item.prazo)section.append(el('p','Prazo citado: '+item.prazo));
      if(item.trecho)section.append(el('blockquote',item.trecho));
      if(item.mudancas?.length){const history=el('details');history.append(el('summary','Mudanças do compromisso'));
        for(const change of item.mudancas)history.append(el('p',`${date(change.alterada_em)} · ${stateLabel(change.estado_anterior,commitmentStates)} → ${stateLabel(change.estado_novo,commitmentStates)}${change.motivo?' · '+change.motivo:''}`));section.append(history);}
      if(item.id&&typeof window.abrirAcaoDoAviso==='function')section.append(button('Rever compromisso',()=>{close();return window.abrirAcaoDoAviso(item.id);}));root.append(section);
    }
  }
  function projectCorrection(item, root, signal, valid) {
    if(item.fonte?.eventoId==null||!item.texto)return;
    const details=el('details'),summary=el('summary','Corrigir projeto');details.append(summary);root.append(details);let loaded=false;
    details.addEventListener('toggle',async()=>{
      if(!details.open||loaded)return;loaded=true;const content=el('div',null,'lv-section');details.append(content);
          const searchForm=el('form',null,'l1-search'),queryLabel=el('label','Buscar projeto por nome'),query=el('input'),search=el('button','Buscar projetos','lv-button');query.type='search';query.maxLength=160;queryLabel.append(query);search.type='submit';searchForm.append(queryLabel,search);
          const form=el('form',null,'lv-section'),label=el('label','Projeto da fonte'),select=el('select');select.required=true;select.setAttribute('aria-label','Projeto da fonte');select.append(new Option('Escolha um projeto',''));label.append(select);
          const excerptLabel=el('label','Trecho que sustenta o vínculo'),excerpt=el('textarea');excerpt.required=true;excerpt.maxLength=300;excerpt.value=item.texto.slice(0,300);excerptLabel.append(excerpt);
          const save=el('button','Salvar vínculo','lv-button');save.type='submit';const message=status(''),feedback=status(''),pagination=el('div',null,'lv-toolbar');form.append(label,excerptLabel,save,message);content.append(searchForm,feedback,pagination,form);
          let revision=0,searchValue='';
          async function load(number=1,append=false){
            const own=++revision;search.disabled=true;select.disabled=true;save.disabled=true;feedback.textContent='Buscando projetos disponíveis…';pagination.replaceChildren();
            try{
              const data=await request('/api/v3/projetos-comerciais?'+new URLSearchParams({q:searchValue,pagina:String(number),limite:'20'}),undefined,signal);if(!valid()||own!==revision)return;
              if(!Array.isArray(data.projetos))throw Error('A lista de projetos está indisponível.');
              if(!append)select.replaceChildren(new Option('Escolha um projeto',''));
              for(const p of data.projetos)if(![...select.options].some(option=>option.value===p.id))select.append(new Option(p.nome||p.titulo||p.id,p.id));
              feedback.textContent=select.options.length===1?'Nenhum projeto disponível com essa busca e as permissões atuais.':(select.options.length-1)+' projetos neste recorte.';
              if(data.proximaPagina!=null)pagination.append(button('Mais projetos',()=>load(data.proximaPagina,true)));
            }catch(error){if(valid()&&own===revision){if(denied(error))select.replaceChildren(new Option('Escolha um projeto',''));feedback.textContent=error.message;pagination.append(button('Tentar novamente',()=>load(number,append)));}}
            finally{if(valid()&&own===revision){search.disabled=false;select.disabled=false;save.disabled=select.options.length===1;}}
          }
          searchForm.onsubmit=event=>{event.preventDefault();searchValue=query.value.trim();void load();};
          form.onsubmit=async event=>{event.preventDefault();if(save.disabled)return;save.disabled=true;message.textContent='Conferindo fonte e salvando vínculo…';
            try{await request('/api/v3/lume-1/vinculo',{eventoId:item.fonte.eventoId,projetoId:select.value,trecho:excerpt.value},signal);if(valid())message.textContent='Vínculo salvo. Reaplique o filtro para consultar a timeline atualizada.';}
            catch(error){if(valid()){message.textContent=error.message;save.disabled=false;}}
          };
      await load();
    });
  }
  function close(restore = true) {
    panelRevision++;panelController?.abort();panelController=null;
    if(dialog){dialog.close();dialog.remove();dialog=null;}
    if(restore&&returnFocus?.isConnected)returnFocus.focus({preventScroll:true});returnFocus=null;
  }
  function open(title) {
    close();returnFocus=document.activeElement;
    dialog=el('dialog',null,'lv-drawer l1-dialog');dialog.setAttribute('aria-labelledby','l1-dialog-title');
    const head=el('header',null,'lv-drawer-header'),h=el('h2',title);h.id='l1-dialog-title';
    head.append(h,button('Fechar',()=>close()));const body=el('div',null,'lv-drawer-body');dialog.append(head,body);
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});document.body.append(dialog);dialog.showModal();
    return body;
  }
  function entityCard(person) {
    const card=el('article',null,'lv-card l1-person');card.dataset.personId=person.id;
    card.append(el('small',person.tipo==='grupo'?'Grupo':'Pessoa','l1-entity-kind'),el('h2',person.nome||'Nome não disponível'));
    const tags=el('div',null,'l1-tags');
    for(const tag of person.tags||[]){
      const chip=el('span',(tagLabels[tag.valor]||tag.valor)+' · '+(tag.origem==='corrigido'||tag.origem==='manual'?'corrigido por você':'sugestão'),'l1-tag');tags.append(chip);
      for(const proof of tag.fontes||[])source(proof,tags);
    }
    if(!tags.childNodes.length)tags.append(el('p','Sem classificação profissional confirmada.','lv-status'));card.append(tags);
    const actions=el('div',null,'lv-toolbar');actions.append(button('Ver timeline',()=>timeline({conversa:person.id,titulo:person.nome})),button('Corrigir tags',()=>correction(person)));card.append(actions);
    projectLinks(person.projetos,card,{conversa:person.id});
    if(Array.isArray(person.interesses)&&person.interesses.length){
      const list=el('section',null,'la-person-interests');list.append(el('h3','Interesses por assunto'));
      for(const item of person.interesses){const entry=el('div',null,'la-person-interest');entry.append(el('h4',item.nome||'Assunto comercial'),interesse(item));if(item.motivo)entry.append(el('p',item.motivo,'lv-card-meta'));entry.append(el('small','Sinais deste assunto · confira a fonte','lv-card-meta'));source(item,entry);list.append(entry);}card.append(list);
    }
    organizations(person.organizacoes,card,{signal:peopleController?.signal,valid:()=>card.isConnected,refresh:()=>pessoas()});
    return card;
  }
  const peopleRoot=el('section',null,'lv-page l1-people');peopleRoot.id='l1-people';
  $('contacts')?.prepend(peopleRoot);
  $('contact-directory')?.addEventListener('toggle',()=>{if($('contact-directory').open)void window.carregarContatos?.();});
  let peopleQuery='';
  async function pessoas(number=1,append=false){
    peopleController?.abort();peopleController=new AbortController();const signal=peopleController.signal,ticket=++peopleRevision;
    if(!append){
      const header=el('div',null,'lv-toolbar'),form=el('form',null,'l1-search');const label=el('label','Buscar pessoa ou grupo'),input=el('input');input.type='search';input.maxLength=100;input.value=peopleQuery;label.append(input);
      const submit=el('button','Buscar','lv-button');submit.type='submit';form.append(label,submit);form.onsubmit=e=>{e.preventDefault();peopleQuery=input.value.trim();void pessoas();};
      header.append(form,button('Timeline completa',()=>timeline()));peopleRoot.replaceChildren(header,el('p','Pessoas e grupos têm identidades separadas. Nomes iguais só se unem quando há um vínculo registrado.','lv-card-meta'),el('div',null,'l1-people-list'));
    }
    const list=peopleRoot.querySelector('.l1-people-list');peopleRoot.querySelector('.l1-people-more')?.remove();
    const pending=status('Buscando pessoas e grupos nas fontes disponíveis…');peopleRoot.append(pending);peopleRoot.setAttribute('aria-busy','true');
    try{
      const data=await request('/api/v3/lume-1/pessoas?'+new URLSearchParams({q:peopleQuery,pagina:String(number),limite:'20'}),undefined,signal);
      if(ticket!==peopleRevision||signal.aborted)return;
      if(!Array.isArray(data.pessoas))throw Error('A lista recebida está indisponível. Atualize para conferir.');
      pending.remove();
      for(const person of data.pessoas)if(![...list.children].some(n=>n.dataset.personId===person.id))list.append(entityCard(person));
      if(!list.children.length)list.append(status('Nenhuma pessoa ou grupo neste recorte. Tente outro nome ou confira as conexões.'));
      for(const gap of data.lacunas||[])peopleRoot.append(status(gap));
      if(data.proximaPagina!=null){const more=button('Mais pessoas e grupos',()=>pessoas(data.proximaPagina,true));more.classList.add('l1-people-more');peopleRoot.append(more);}
    }catch(error){if(ticket!==peopleRevision||signal.aborted)return;if(denied(error))list.replaceChildren();pending.replaceChildren(status(error.message),button('Tentar novamente',()=>pessoas(denied(error)?1:number,denied(error)?false:append)));}
    finally{if(ticket===peopleRevision)peopleRoot.setAttribute('aria-busy','false');}
  }
  function correction(person){
    const body=open('Corrigir tags de '+(person.nome||'pessoa'));const form=el('form',null,'lv-section');
    form.append(el('p','Sua correção fica salva neste computador e prevalece sobre novas sugestões. A identidade de pessoa ou grupo vem da fonte.'));
    const fields=el('fieldset',null,'l1-tag-options');fields.append(el('legend','Classificação profissional'));
    for(const [value,label]of Object.entries(tagLabels)){const wrap=el('label'),input=el('input');input.type='checkbox';input.value=value;input.checked=(person.tags||[]).some(t=>t.valor===value);wrap.append(input,el('span',label));fields.append(wrap);}
    const save=el('button','Salvar correção','lv-button');save.type='submit';const message=status('');form.append(fields,save,message);body.append(form);
    const ticket=panelRevision;panelController=new AbortController();const signal=panelController.signal;
    form.onsubmit=async e=>{
      e.preventDefault();if(save.disabled)return;save.disabled=true;message.textContent='Salvando correção…';
      try{await request('/api/v3/lume-1/pessoas/correcao',{conversaId:person.id,tags:[...fields.querySelectorAll('input:checked')].map(n=>n.value)},signal);
        if(ticket!==panelRevision||signal.aborted)return;message.textContent='Correção salva. Atualizando as pessoas…';await pessoas();if(ticket===panelRevision){close();const updated=[...peopleRoot.querySelectorAll('.l1-person')].find(n=>n.dataset.personId===person.id);updated?.querySelector('button')?.focus({preventScroll:true});}
      }catch(error){if(ticket!==panelRevision||signal.aborted)return;message.textContent=error.message||'Não foi possível confirmar a gravação.';save.disabled=false;}
    };
  }
  function timeline(selection={}){
    const body=open(selection.titulo?'Timeline · '+selection.titulo:'Timeline da memória'),form=el('form',null,'lv-filters'),list=el('div',null,'l1-timeline');
    const values={conversa:selection.conversa||'',assunto:selection.assunto||'',pessoa:selection.pessoa||'',projeto:selection.projeto||''};
    for(const [key,label]of [['assunto','Assunto'],['pessoa','Pessoa'],['projeto','Projeto']]){const wrap=el('label',label),input=el('input');input.name=key;input.value=values[key];input.maxLength=200;wrap.append(input);form.append(wrap);}
    const apply=el('button','Filtrar timeline','lv-button');apply.type='submit';form.append(apply);
    if(values.conversa)form.append(button('Todas as conversas',()=>{values.conversa='';return load(1,false);}));
    body.append(el('p','Mensagens de pessoas e grupos, com autoria, data e fonte. Os filtros combinam o recorte.'),form,list);
    let cursor=null,loading=false,requestVersion=0,filterRevision=0;
    const ticket=panelRevision;panelController=new AbortController();const signal=panelController.signal;
    async function load(number=1,append=false){
      const own=++requestVersion;loading=true;apply.disabled=true;
      if(!append){filterRevision++;list.replaceChildren();}const filterTicket=filterRevision;list.querySelector('.l1-timeline-more')?.remove();
      const pending=status('Consultando mensagens salvas…');list.append(pending);list.setAttribute('aria-busy','true');
      try{
        const data=await request('/api/v3/lume-1/timeline?'+new URLSearchParams({...values,pagina:String(number),limite:'20'}),undefined,signal);
        if(ticket!==panelRevision||own!==requestVersion||signal.aborted)return;
        if(!Array.isArray(data.itens))throw Error('Timeline indisponível. Atualize para conferir.');pending.remove();cursor=data.proximaPagina;
        for(const item of data.itens){
          if([...list.children].some(n=>n.dataset.eventId===String(item.id)))continue;
          const row=el('article',null,'l1-timeline-item');row.dataset.eventId=item.id;
          const conversationName=item.conversaNome||(typeof item.conversa==='object'?item.conversa.nome:null)||selection.titulo||(typeof item.conversa==='string'&&!item.conversa.includes('@')?item.conversa:'Conversa de origem');
          row.append(el('h3',item.autor||'Autoria não identificada'),el('p',[date(item.recebidoEm),conversationName,item.tipo].filter(Boolean).join(' · '),'lv-card-meta'));
          row.append(el('p',item.texto||'Fonte sem texto disponível.'));
          if(item.assuntos?.length)row.append(el('p','Assuntos: '+item.assuntos.join(' · '),'lv-status'));
          projectLinks(item.projetos,row,{conversa:values.conversa});
          commitments(item.compromissos,row);
          occurrences(item.acontecimentos,row,item);
          organizations(item.organizacoes,row,{signal,valid:()=>ticket===panelRevision&&filterTicket===filterRevision&&!signal.aborted,refresh:()=>load()});
          source(item,row);projectCorrection(item,row,signal,()=>ticket===panelRevision&&filterTicket===filterRevision&&!signal.aborted);list.append(row);
        }
        if(!data.itens.length&&!append)list.append(status('Nenhuma mensagem disponível com esses filtros.'));
        for(const gap of data.lacunas||[])list.append(status(gap));
        if(cursor!=null){const more=button('Mais mensagens',()=>{if(!loading)return load(cursor,true);});more.classList.add('l1-timeline-more');list.append(more);}
      }catch(error){if(ticket!==panelRevision||own!==requestVersion||signal.aborted)return;if(denied(error)){list.replaceChildren(pending);}pending.replaceChildren(status(error.message),button('Tentar novamente',()=>load(denied(error)?1:number,denied(error)?false:append)));}
      finally{if(ticket===panelRevision&&own===requestVersion){loading=false;apply.disabled=false;list.setAttribute('aria-busy','false');}}
    }
    form.onsubmit=e=>{e.preventDefault();for(const input of form.querySelectorAll('input'))values[input.name]=input.value.trim();void load();};
    void load();
  }
  const organizationLabels={pausado:'Organização pausada',pausada:'Organização pausada',executando:'Organizando conversas autorizadas',processando:'Organizando conversas autorizadas',aguardando:'Aguardando processamento',indisponivel:'Organização indisponível',concluido:'Recorte processado',ocioso:'Nenhum processamento em andamento'};
  function organization(data,root){
    if(!data)return;root.append(el('strong',organizationLabels[data.estado]||'Estado: '+(data.estado||'não informado')));
    if(Number.isFinite(data.processados)||Number.isFinite(data.pendentes))root.append(el('p',`${Number.isFinite(data.processados)?data.processados:'Não informado'} processados · ${Number.isFinite(data.pendentes)?data.pendentes:'Não informado'} pendentes`));
    if(typeof data.cobertura==='string')root.append(el('p',data.cobertura));
    else if(Number.isFinite(data.cobertura))root.append(el('p',data.cobertura+' fontes examinadas neste recorte.'));
    if(data.historicoCompleto===false)root.append(el('p','A cobertura do histórico é parcial.','lv-status'));
    if(Number.isFinite(data.abstidos))root.append(el('p',data.abstidos+' fontes sem classificação suficiente.','lv-status'));
    if(data.limitacao)root.append(el('p',({avaliacao_pendente:'Organização ainda em preparação. Sua memória salva continua disponível.',conta_indisponivel:'A conta ChatGPT está indisponível. A memória salva continua acessível.'})[data.limitacao]||data.limitacao,'lv-status'));
  }
  function scopeControls(data,root,{signal,valid,refresh}){
    const scope=data.escopo;if(!scope)return;
    const details=el('details',null,'la-scope');details.append(el('summary','Conversas que o Lume organiza'));
    details.append(el('p',scope.tipo==='todas'?'Todas as conversas atuais e futuras estão no escopo, respeitando as exclusões.':'O Lume organiza as conversas já autorizadas.'));
    if(Number.isFinite(scope.conversasElegiveis))details.append(el('p',`${scope.conversasElegiveis} conversas elegíveis${Number.isFinite(scope.gruposElegiveis)?' · '+scope.gruposElegiveis+' grupos':''}.`,'lv-card-meta'));
    const exclusions=Array.isArray(scope.exclusoes)?scope.exclusoes.length:scope.exclusoes;if(Number.isFinite(exclusions))details.append(el('p',exclusions+' exclusões preservadas.','lv-card-meta'));
    const all=scope.tipo!=='todas',form=el('form',null,'la-scope-form'),label=el('label',null,'la-consent'),check=el('input');check.type='checkbox';check.required=true;
    label.append(check,el('span',all?'Autorizo a conta ChatGPT conectada a organizar o conteúdo das conversas atuais e futuras, inclusive grupos. As exclusões serão respeitadas. Isso não autoriza enviar mensagens.':'Quero organizar apenas as conversas com autorização individual. As exclusões continuam valendo. Isso não muda as permissões de envio.'));
    const submit=el('button',all?'Organizar todas as conversas':'Usar autorizações individuais','lv-button');submit.type='submit';const feedback=status('');form.append(label,submit,feedback);details.append(form);root.append(details);
    form.onsubmit=async event=>{event.preventDefault();if(submit.disabled||!check.checked||!valid())return;submit.disabled=true;feedback.textContent='Salvando sua escolha…';
      try{await request('/api/v3/lume-1/organizacao/escopo',{escopo:all?'todas':'autorizadas',confirmar:true},signal);if(valid())await refresh();}
      catch(error){if(valid()){if(denied(error)){root.replaceChildren(status(error.message));return;}feedback.textContent=error.message;submit.disabled=false;}}
    };
  }
  function questions(items,root,{signal,valid,refresh,limit=3}){
    root.replaceChildren();const pending=Array.isArray(items)?items:[];
    for(const item of pending.slice(0,limit)){
      const card=el('article',null,'lv-card la-question');card.dataset.questionId=item.id;
      card.append(el('small','Uma dúvida para organizar','lv-card-meta'),el('h3',item.pergunta||'A qual projeto este trecho pertence?'));
      if(item.trecho){const excerpt=el('details');excerpt.append(el('summary','Ver o trecho'),el('blockquote',item.trecho));card.append(excerpt);}
      const actions=el('div',null,'lv-toolbar'),feedback=status('');let busy=false;
      const options=(item.opcoes||[]).filter(o=>o.projetoId);
      async function answer(body){if(busy||!valid())return;busy=true;for(const control of actions.querySelectorAll('button,select'))control.disabled=true;feedback.textContent='Salvando sua resposta…';
        try{await request('/api/v3/lume-1/organizacao/pergunta',{id:item.id,...body},signal);if(valid())await refresh();}
        catch(error){if(valid()){if(denied(error)){root.replaceChildren(status(error.message),button('Atualizar contexto',refresh));return;}feedback.textContent=error.message;busy=false;for(const control of actions.querySelectorAll('button,select'))control.disabled=false;}}
      }
      if(options.length<=3){for(const option of options)actions.append(button(option.nome||'Este projeto',()=>answer({projetoId:option.projetoId})));}
      else{const label=el('label','Projeto deste assunto'),select=el('select');select.setAttribute('aria-label','Projeto deste assunto');select.append(new Option('Escolha um projeto',''));for(const option of options)select.append(new Option(option.nome,option.projetoId));label.append(select);actions.append(label,button('Confirmar projeto',()=>{if(select.value)return answer({projetoId:select.value});feedback.textContent='Escolha um dos projetos.';}));}
      actions.append(button('Adiar',()=>answer({adiar:true})));source(item,actions);card.append(actions,feedback);root.append(card);
    }
    if(pending.length>limit)root.append(button(`Ver mais ${pending.length-limit} dúvidas`,()=>central()));
  }
  async function cobertura(root,{perguntas}={}){
    for(const [node,controller]of coverageControllers)if(!node.isConnected){controller.abort();coverageControllers.delete(node);}
    const box=el('section',null,'l1-coverage la-coverage');box.setAttribute('aria-label','Organização das conversas');root.append(box);
    const controller=new AbortController(),signal=controller.signal;coverageControllers.set(box,controller);
    const valid=()=>box.isConnected&&!signal.aborted;
    async function load(){
      const restoreFocus=box.contains(document.activeElement)||perguntas?.contains(document.activeElement);
      box.replaceChildren(status('Consultando a organização das conversas…'));box.setAttribute('aria-busy','true');if(perguntas)perguntas.replaceChildren();
      try{const data=await request('/api/v3/lume-1/central',undefined,signal);if(!valid())return;box.replaceChildren();
        const org=data.organizacao;if(!org){box.append(status('Estado da organização não disponível.'),button('Tentar novamente',load));return;}
        const summary=el('div',null,'la-coverage-summary');summary.append(el('strong',org.limitacao==='avaliacao_pendente'?'Organização ainda em preparação':organizationLabels[org.estado]||'Organização das conversas'));
        const scope=org.escopo;summary.append(el('p',(scope?.tipo==='todas'?'Conversas atuais e futuras, respeitando as exclusões.':'Conversas autorizadas, respeitando as exclusões.')+(Number.isFinite(org.processados)?` ${org.processados} fontes processadas.`:'')+(Number.isFinite(org.pendentes)?` ${org.pendentes} pendentes.`:''),'lv-card-meta'));box.append(summary);
        const more=el('details',null,'la-coverage-detail');more.append(el('summary','Ver cobertura e controles'));const content=el('div',null,'la-coverage-content');organization(org,content);scopeControls(org,content,{signal,valid,refresh:load});
        const controls=el('div',null,'lv-toolbar');controls.append(button('Abrir central',()=>central()));
        if(['pausado','pausada'].includes(org.estado))controls.append(button('Retomar organização',async()=>{await request('/api/v3/lume-1/organizacao',{acao:'retomar'},signal);if(valid())await load();}));
        if(org.limitacao==='conta_indisponivel')controls.append(button('Ver conexão ChatGPT',()=>window.abrirAjuste?.('pessoal-panel')));
        content.append(controls);more.append(content);box.append(more);
        if(perguntas)questions(org.perguntas,perguntas,{signal,valid,refresh:load});
      }catch(error){if(valid())errors(box,error,load);}finally{if(valid()){box.setAttribute('aria-busy','false');if(restoreFocus)(perguntas?.querySelector('button')||box.querySelector('summary,button'))?.focus({preventScroll:true});}}
    }
    await load();
  }
  async function central(){
    const body=open('Central de acontecimentos');const ticket=panelRevision;panelController=new AbortController();const signal=panelController.signal;
    body.append(status('Consultando acontecimentos e comunicados…'));body.setAttribute('aria-busy','true');
    try{
      const data=await request('/api/v3/lume-1/central',undefined,signal);if(ticket!==panelRevision||signal.aborted)return;
      body.replaceChildren();const progress=el('section',null,'lv-section');progress.append(el('h3','Organização das conversas'));organization(data.organizacao,progress);
      if(data.organizacao){const paused=['pausado','pausada'].includes(data.organizacao.estado);const control=button(paused?'Retomar organização':'Pausar organização',async()=>{control.disabled=true;try{await request('/api/v3/lume-1/organizacao',{acao:paused?'retomar':'pausar'},signal);if(ticket===panelRevision)await central();}catch(error){if(ticket===panelRevision){control.disabled=false;control.after(status(error.message));}}});progress.append(control,el('p','Essa pausa controla a organização; as permissões de leitura e atendimento continuam nos Ajustes.','lv-status'));scopeControls(data.organizacao,progress,{signal,valid:()=>ticket===panelRevision&&!signal.aborted,refresh:central});}body.append(progress);
      if(data.organizacao?.perguntas?.length){const pending=el('section',null,'lv-section la-questions');body.append(pending);questions(data.organizacao.perguntas,pending,{signal,valid:()=>ticket===panelRevision&&!signal.aborted,refresh:central,limit:Infinity});}
      for(const [key,title]of [['acontecimentos','Acontecimentos locais'],['comunicados','Comunicados do Lume']]){
        const section=el('section',null,'lv-section');section.append(el('h3',title));
        const items=Array.isArray(data[key])?data[key]:[];
        if(!items.length)section.append(status(key==='comunicados'?'Nenhum comunicado disponível.':'Nenhum acontecimento disponível neste recorte.'));
        for(const item of items){const row=el('article',null,'l1-timeline-item');row.append(el('h4',item.titulo||item.assunto||'Registro'),el('p',item.texto||item.descricao||item.acontecimento||''),el('small',date(item.recebidoEm||item.criadoEm||item.data||item.fonte?.recebidoEm)));source(item,row);const subjectId=item.assuntoId||(key==='acontecimentos'?item.id:null);if(subjectId)row.append(button('Abrir assunto',()=>{close();return window.LumeVivo?.abrirAssunto(subjectId);}));if(key==='comunicados'&&item.acao==='ver_atualizacoes')row.append(button('Ver atualizações',()=>{close();return window.abrirAjuste?.('atualizacoes-panel');}));section.append(row);}body.append(section);
      }
    }catch(error){if(ticket===panelRevision&&!signal.aborted)errors(body,error,central);}
    finally{if(ticket===panelRevision)body.setAttribute('aria-busy','false');}
  }
  function globalControls(){
    const search=$('lv-global-search');if(!search)return;
    const bar=el('div',null,'l1-global-controls');bar.setAttribute('aria-label','Preferências globais');
    const label=el('label','Tema'),theme=el('select');theme.id='l1-global-theme';for(const [v,t]of [['system','Sistema'],['light','Claro'],['dark','Escuro']])theme.append(new Option(t,v));label.append(theme);
    const sound=button('Som desligado',()=>save({som:!window.LumePreferencias.estado().som}));sound.id='l1-global-sound';
    const soundOptions=el('details',null,'l1-sound-options');soundOptions.id='l1-sound-options';const soundSummary=el('summary','Volume e prévia');soundSummary.id='l1-sound-summary';
    const soundPanel=el('div',null,'lv-section l1-sound-panel');soundPanel.setAttribute('role','region');soundPanel.setAttribute('aria-labelledby','l1-sound-summary');
    const volumeLabel=el('label','Volume dos sons'),volume=el('input'),volumeValue=el('output','35%');volume.id='l1-global-volume';volumeValue.setAttribute('for',volume.id);volume.type='range';volume.min='0';volume.max='1';volume.step='.05';volume.value='.35';volumeLabel.append(volumeValue,volume);
    const previewActions=el('div',null,'lv-toolbar'),audioMessage=status('O som começa desligado. A prévia só toca quando você pedir.');audioMessage.id='l1-audio-status';
    const previews=['decisao','conclusao'].map(kind=>{const preview=button(kind==='decisao'?'Ouvir decisão':'Ouvir conclusão',async()=>{const result=await window.LumePreferencias?.previa(kind);audioMessage.textContent=result?.texto||'Prévia indisponível.';});preview.id='l1-preview-'+kind;previewActions.append(preview);return preview;});
    soundPanel.append(volumeLabel,previewActions,audioMessage);soundOptions.append(soundSummary,soundPanel);
    const companion=button('Mostrar Lume',()=>save({enabled:true}));companion.id='l1-global-companion';
    const centralButton=button('Acontecimentos',central);centralButton.id='l1-global-central';
    const message=status('');message.id='l1-global-status';bar.append(label,sound,soundOptions,companion,centralButton);search.after(bar,message);
    let busy=false,volumeDraft=null;
    function paint(){const p=window.LumePreferencias?.estado();if(!p)return;theme.value=p.tema;sound.textContent=p.som?(p.pausado?'Som pausado':'Som ligado'):'Som desligado';sound.setAttribute('aria-pressed',String(p.som));for(const n of [theme,sound,companion,volume])n.disabled=busy;volume.value=String(volumeDraft??p.volume??.35);volumeValue.textContent=Math.round(Number(volume.value)*100)+'%';for(const preview of previews)preview.disabled=busy||!p.som||p.pausado||document.hidden;companion.title=p.disponivel?'Mostrar a companhia sem interromper sua janela':'A companhia aparece no aplicativo instalado';}
    async function save(patch){
      if(busy)return;if(patch.enabled&&!window.LumePreferencias.estado().disponivel){message.textContent='A companhia está disponível no aplicativo instalado. As preferências ficam em Ajustes → Aparência.';return;}
      const feedback=Object.hasOwn(patch,'volume')?audioMessage:message;
      busy=true;paint();feedback.textContent='Salvando…';
      try{await window.LumePreferencias.atualizar(patch);feedback.textContent=patch.enabled?'Lume solicitado na área de trabalho.':'Preferência salva.';}
      catch(error){feedback.textContent=error.message||'Não foi possível confirmar a gravação.';}
      finally{busy=false;paint();}
    }
    theme.onchange=()=>void save({tema:theme.value});window.addEventListener('lume:preferences',paint);paint();
    volume.oninput=()=>{volumeDraft=Number(volume.value);volumeValue.textContent=Math.round(volumeDraft*100)+'%';};
    volume.onchange=async()=>{const value=Number(volume.value);volumeDraft=value;await save({volume:value});volumeDraft=null;paint();};
    soundOptions.addEventListener('keydown',event=>{if(event.key==='Escape'&&soundOptions.open){event.preventDefault();soundOptions.open=false;soundSummary.focus({preventScroll:true});}});
    document.addEventListener('visibilitychange',paint);
    window.addEventListener('lume:navigate',()=>{message.textContent='';soundOptions.open=false;});
    // Session is established by app.js before the first navigation; a deferred
    // script must not issue protected requests while the session is still loading.
    window.addEventListener('lume:navigate',()=>{void window.LumePreferencias?.carregar().then(paint);},{once:true});
  }
  function mapRecovery(){
    const canvas=$('network'),root=$('graph');if(!canvas||!root)return;
    const controls=el('div',null,'lv-toolbar l1-map-controls');const message=status('');message.id='l1-map-status';
    const list=button('Usar lista',()=>{root.dataset.mapMode='list';$('graph-list').tabIndex=-1;$('graph-list').focus({preventScroll:true});list.setAttribute('aria-pressed','true');map.setAttribute('aria-pressed','false');});
    const map=button('Usar mapa',()=>{root.dataset.mapMode='map';list.setAttribute('aria-pressed','false');map.setAttribute('aria-pressed','true');});list.setAttribute('aria-pressed','false');map.setAttribute('aria-pressed','true');
    const retry=button('Tentar mapa novamente',()=>window.carregarGrafo?.());retry.hidden=true;controls.append(map,list,retry,message);$('graph-filters').after(controls);
    let timer;
    const check=()=>{
      clearTimeout(timer);
      if(canvas.getAttribute('aria-busy')==='true'){
        message.textContent='Consultando relações salvas…';retry.hidden=true;
        timer=setTimeout(()=>{if(canvas.getAttribute('aria-busy')!=='true')return;window.limparGrafo?.();message.textContent='A consulta do mapa demorou mais de 15 segundos. Tente novamente ou abra a timeline da memória.';retry.hidden=false;},15000);
      }else if(!retry.hidden){/* Preserve the timeout explanation until the next request. */}
      else {const failed=$('graph-count').textContent.includes('Não consegui');message.textContent=failed?'Mapa indisponível. Tente novamente ou consulte a timeline.':'';retry.hidden=!failed;}
    };
    new MutationObserver(check).observe(canvas,{attributes:true,attributeFilter:['aria-busy']});
    controls.append(button('Abrir timeline',()=>timeline()));
    window.addEventListener('lume:navigate',event=>{if(event.detail?.view!=='graph'){clearTimeout(timer);if(canvas.getAttribute('aria-busy')==='true')window.limparGrafo?.();}});
  }
  async function identity(){
    const about=$('settings-about');if(!about)return;
    const version=el('p',null,'lv-status');version.id='l1-version';about.append(version);
    try{
      const data=await request('/api/v3/versao');
      if(data.titulo){document.title=data.titulo;about.querySelector('h2').textContent='Sobre '+data.titulo;}
      const welcomeVersion=document.querySelector('.welcome-art .brand .pill');if(welcomeVersion&&data.versaoComercial){welcomeVersion.textContent=data.versaoComercial;welcomeVersion.setAttribute('aria-label',data.titulo||data.nome||'Lume');}
      version.textContent=data.versao?'Versão técnica: '+data.versao:'Versão técnica não disponível.';
      const brand=document.querySelector('.sidebar .brand');
      if(brand&&data.versaoComercial){const mark=el('small',data.versaoComercial,'l1-brand-version');brand.append(mark);brand.setAttribute('aria-label',data.titulo||data.nome);}
    }catch{version.textContent='Versão não disponível nesta consulta.';}
  }
  window.addEventListener('lume:navigate',()=>{close(false);peopleRevision++;peopleController?.abort();});
  window.addEventListener('lume:invalidate',()=>{close(false);peopleRevision++;peopleController?.abort();peopleRoot.replaceChildren();peopleQuery='';});
  for(const event of ['lume:navigate','lume:invalidate'])window.addEventListener(event,()=>{for(const [node,controller]of coverageControllers){controller.abort();if(event==='lume:invalidate')node.replaceChildren();}coverageControllers.clear();if(event==='lume:invalidate')document.querySelectorAll('.la-questions').forEach(node=>node.replaceChildren());});
  window.LumeUm=Object.freeze({pessoas,timeline,central,cobertura,interesse,reverInteresse});globalControls();mapRecovery();
  window.addEventListener('lume:navigate',()=>void identity(),{once:true});
  const tools=$('lv-memory-tools');if(tools)tools.prepend(button('Timeline',()=>timeline()));
})();
