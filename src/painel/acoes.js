(() => {
  const section=element('section',null,'acoes06-panel');
  section.id='acoes06';section.setAttribute('aria-labelledby','acoes06-title');
  const heading=element('div',null,'panel-title'),title=element('div');
  title.append(element('p','AÇÕES COM ORIGEM','eyebrow'),element('h2','Precisa de você'));
  title.querySelector('h2').id='acoes06-title';
  heading.append(title,element('span','VOCÊ DECIDE','pill'));
  const intro=element('p','Cada pedido fica ligado à mensagem de origem. O Laya local ainda está em validação; sugestões novas aparecem aqui somente após passar na avaliação.','muted');
  const controls=element('div',null,'acoes06-controls'),label=element('label','Mostrar','acoes06-filter-label'),filter=element('select');
  filter.id='acoes06-filter';label.htmlFor=filter.id;
  for(const [value,name] of [['ativos','Agora'],['minhas','Minhas ações'],['sugerido','Para conferir'],['confirmado','Confirmadas'],['estacionado','Estacionadas'],['resolvido','Resolvidas'],['descartado','Descartadas']])filter.append(new Option(name,value));
  const viewSwitch=element('div',null,'acoes06-view-switch');viewSwitch.setAttribute('role','group');viewSwitch.setAttribute('aria-label','Visualização das ações');
  const listButton=element('button','Lista','secondary'),boardButton=element('button','Quadro','secondary');
  for(const button of [listButton,boardButton])button.type='button';
  listButton.id='acoes06-view-list';boardButton.id='acoes06-view-board';
  listButton.setAttribute('aria-pressed','true');boardButton.setAttribute('aria-pressed','false');
  listButton.setAttribute('aria-controls','acoes06-list');boardButton.setAttribute('aria-controls','acoes06-list');
  viewSwitch.append(listButton,boardButton);controls.append(label,filter,viewSwitch);
  const status=element('p',null,'muted');status.id='acoes06-status';status.setAttribute('role','status');
  const analysisStatus=element('p',null,'muted');analysisStatus.id='acoes06-analysis-status';analysisStatus.setAttribute('role','status');
  const notificationTarget=element('section',null,'acoes06-target');notificationTarget.id='acoes06-target';notificationTarget.hidden=true;
  notificationTarget.setAttribute('aria-label','Ação aberta pelo aviso do Lume');
  const list=element('div',null,'acoes06-list');list.id='acoes06-list';
  const pagination=element('nav',null,'acoes06-pagination');pagination.id='acoes06-pagination';pagination.hidden=true;pagination.setAttribute('aria-label','Paginação das ações');
  const pageStatus=element('p',null,'muted');pageStatus.id='acoes06-page-status';pageStatus.setAttribute('role','status');
  const previousPage=element('button','Anterior','secondary'),nextPage=element('button','Próxima','secondary');
  previousPage.type=nextPage.type='button';previousPage.id='acoes06-prev';nextPage.id='acoes06-next';
  previousPage.setAttribute('aria-label','Página anterior de ações');nextPage.setAttribute('aria-label','Próxima página de ações');
  pagination.append(pageStatus,element('div',null,'button-row'));pagination.lastElementChild.append(previousPage,nextPage);
  const explanation=element('details',null,'acoes06-info');explanation.append(element('summary','Como os próximos passos aparecem'),intro,analysisStatus);
  section.append(heading,controls,status,notificationTarget,list,pagination,explanation);
  const luminus=element('section',null,'luminus-banner');luminus.id='luminus-banner';luminus.hidden=true;luminus.setAttribute('aria-labelledby','luminus-title');
  const luminusHead=element('div',null,'luminus-head'),luminusName=element('div');
  luminusName.append(element('p','SEU PRÓXIMO COMBINADO','eyebrow'),element('h2','Um passo de cada vez.'));
  luminusName.querySelector('h2').id='luminus-title';
  const luminusPosition=element('span',null,'luminus-position');luminusPosition.id='luminus-position';luminusPosition.setAttribute('role','status');
  luminusHead.append(luminusName,luminusPosition);
  const luminusRail=element('nav',null,'luminus-rail');luminusRail.id='luminus-rail';luminusRail.setAttribute('aria-label','Folhear ações por conversa');
  const luminusCurrent=element('p',null,'luminus-current');luminusCurrent.id='luminus-current';
  const luminusBody=element('div',null,'luminus-body');luminusBody.id='luminus-body';
  const luminusNav=element('div',null,'luminus-nav');
  const previous=element('button','‹','secondary'),next=element('button','›','secondary');
  previous.type=next.type='button';previous.setAttribute('aria-label','Ficha anterior');next.setAttribute('aria-label','Próxima ficha');
  previous.setAttribute('aria-controls','luminus-body');next.setAttribute('aria-controls','luminus-body');
  luminusNav.append(previous,next);
  luminus.append(luminusHead,luminusRail,luminusCurrent,luminusBody,luminusNav);
  $('home-status').after(luminus);
  let bannerItems=[],bannerSelectedId=null,bannerSignature='',touchStart=null;
  function mostrarFicha(direcao='next'){
    if(!bannerItems.length)return;
    const index=Math.max(0,bannerItems.findIndex(item=>item.id===bannerSelectedId));
    const item=bannerItems[index];
    luminusPosition.textContent=`FICHA ${number(index+1)} DE ${number(bannerItems.length)}`;
    luminusCurrent.replaceChildren(element('span','CONVERSA','luminus-current-label'),element('strong',item.conversa_nome||item.conversa_id||'Conversa'));
    previous.setAttribute('aria-disabled',String(index===0));next.setAttribute('aria-disabled',String(index===bannerItems.length-1));
    for(const [i,tab] of [...luminusRail.children].entries())tab.setAttribute('aria-pressed',String(i===index));
    luminusBody.dataset.motionDirection=direcao;
    luminusBody.replaceChildren(card(item,{compacto:true}));
    window.lumeChanged?.(luminusBody,`${item.id}:${item.estado}`);
  }
  function navegar(delta){
    const index=bannerItems.findIndex(item=>item.id===bannerSelectedId),novo=index+delta;
    if(novo<0||novo>=bannerItems.length)return;
    bannerSelectedId=bannerItems[novo].id;mostrarFicha(delta>0?'next':'previous');
  }
  function criarAbas(){
    const totais=new Map(),vistos=new Map();
    for(const item of bannerItems){const nome=item.conversa_nome||item.conversa_id||'Conversa';totais.set(nome,(totais.get(nome)||0)+1);}
    luminusRail.replaceChildren(...bannerItems.map((item,index)=>{
      const nome=item.conversa_nome||item.conversa_id||'Conversa';
      const letra=[...nome.trim()][0]?.toLocaleUpperCase('pt-BR')||'•';
      const ordem=(vistos.get(nome)||0)+1;vistos.set(nome,ordem);
      const tab=element('button',null,'luminus-tab');tab.type='button';tab.append(element('span',letra));
      if(totais.get(nome)>1)tab.append(element('small',String(ordem)));
      tab.title=`${nome} · ${item.resumo}`;tab.setAttribute('aria-label',`Ficha ${index+1} de ${bannerItems.length}: ${nome} · ${item.resumo}`);
      const selecionar=()=>{const anterior=bannerItems.findIndex(a=>a.id===bannerSelectedId);if(anterior===index)return;bannerSelectedId=item.id;mostrarFicha(index>anterior?'next':'previous');};
      tab.onclick=selecionar;
      // Hover is not selection: keep a draft and its source stable until a click.
      return tab;
    }));
  }
  previous.onclick=()=>navegar(-1);next.onclick=()=>navegar(1);
  luminus.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight'].includes(event.key)||event.target.closest('input,textarea,select'))return;
    event.preventDefault();navegar(event.key==='ArrowRight'?1:-1);
  });
  luminusBody.addEventListener('touchstart',event=>{const point=event.touches[0];touchStart=point?{x:point.clientX,y:point.clientY}:null;},{passive:true});
  luminusBody.addEventListener('touchend',event=>{const point=event.changedTouches[0];if(!point||!touchStart)return;const dx=point.clientX-touchStart.x,dy=point.clientY-touchStart.y;touchStart=null;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.3)navegar(dx<0?1:-1);},{passive:true});
  function atualizarBanner(itens){
    const signature=JSON.stringify(itens.map(item=>[item.id,item.estado,item.execucao_ui?.estado,item.execucao_ui?.id,item.resumo,item.trecho,item.lembrar_em,item.conversa_nome,item.conversa_id,item.recebido_em,item.prazo_citado,item.evento_id,item.aviso_resultado,item.fuso,item.responsavel_id]));
    if(signature===bannerSignature)return;
    bannerSignature=signature;bannerItems=itens;
    luminus.dataset.count=String(itens.length);
    luminus.hidden=!itens.length;
    const antigo=$('clarity-content').querySelector('.clarity-lead');if(antigo)antigo.hidden=Boolean(itens.length);
    if(!itens.length){luminusBody.replaceChildren();luminusRail.replaceChildren();luminusCurrent.replaceChildren();bannerSelectedId=null;return;}
    if(!itens.some(item=>item.id===bannerSelectedId))bannerSelectedId=itens[0].id;
    criarAbas();
    mostrarFicha();
  }
  const attention=$('today').querySelector('.attention-panel');
  const legacy=element('details',null,'acoes06-legacy');legacy.id='legacy-actions';
  const legacySummary=element('summary','Ações do histórico anterior');
  legacy.append(legacySummary,...[...attention.children]);
  attention.removeAttribute('aria-labelledby');attention.setAttribute('aria-label','Ações que precisam de você');
  attention.append(section,legacy);
  legacySummary.addEventListener('click',()=>{legacy.dataset.manuallyToggled='true';});

  const settings=element('section',null,'panel settings-card');settings.id='settings-actions';
  settings.append(element('h2','Organização local das conversas'),element('p','O Lume organiza automaticamente as conversas disponíveis neste computador. Ajustes manuais são opcionais e não são necessários para começar. A análise é local; o Laya ainda se abstém de criar sugestões enquanto a qualidade não passar na avaliação.'));
  settings.append(action('Relatar problema ao organizar',()=>window.abrirFeedbackLume('organiza'),'text-button central-feedback-shortcut'));
  const search=element('form',null,'acoes06-search'),query=element('input');query.type='search';query.placeholder='Nome da conversa';query.maxLength=100;query.setAttribute('aria-label','Buscar conversa para ajustar');
  const searchButton=element('button','Buscar','secondary');searchButton.type='submit';search.append(query,searchButton);
  const permissionStatus=element('p',null,'muted');permissionStatus.id='acoes06-permissions-status';permissionStatus.setAttribute('role','status');
  const permissions=element('div',null,'acoes06-permissions');settings.append(search,permissionStatus,permissions);
  const soundBox=element('div',null,'acoes06-sound'),soundLabel=element('label',null,'check'),soundCheck=element('input');
  soundCheck.id='acoes06-sound';soundCheck.type='checkbox';soundCheck.disabled=true;soundLabel.htmlFor=soundCheck.id;
  soundLabel.append(soundCheck,element('span','Som nos avisos de ações'));
  soundBox.append(element('h3','Avisos das ações'),soundLabel,element('p','O aviso mostra texto genérico. Esta escolha vale para os próximos avisos; o sistema pode silenciar o aplicativo.','muted'));
  settings.append(soundBox);
  window.registrarAjuste(settings,'settings-actions','work');

  let revision=0,permissionRevision=0,busy=false,lastSignature='',avisosDisponiveis=false,somSalvando=false,view='list',page=1,pages=1,total=0;
  const boardStates=[['sugerido','Para conferir'],['confirmado','Confirmadas'],['estacionado','Estacionadas'],['resolvido','Resolvidas']];
  const queryActions=(estado,limite=50,pagina=1)=>{const params=new URLSearchParams({estado,limite:String(limite)});if(pagina>1)params.set('pagina',String(pagina));return api('/api/v3/acoes?'+params);};
  function showView(next){
    if(view===next)return;
    view=next;page=1;listButton.setAttribute('aria-pressed',String(view==='list'));boardButton.setAttribute('aria-pressed',String(view==='board'));
    label.hidden=filter.hidden=view==='board';list.classList.toggle('acoes06-board',view==='board');
    limparAlvo();lastSignature='';window.carregarAcoes06();
  }
  listButton.onclick=()=>showView('list');boardButton.onclick=()=>showView('board');
  soundCheck.onchange=async()=>{const som=soundCheck.checked;somSalvando=true;soundCheck.disabled=true;try{
    await api('/api/v3/acoes/som',{som});feedback(som?'Som ligado para próximos avisos de ações.':'Som desligado para próximos avisos de ações.');
  }catch(error){soundCheck.checked=!som;feedback(error.message);}finally{somSalvando=false;soundCheck.disabled=false;}};
  const limparAlvo=()=>{notificationTarget.hidden=true;notificationTarget.replaceChildren();list.querySelectorAll('.acoes06-from-notification').forEach(node=>node.classList.remove('acoes06-from-notification'));};
  window.abrirAcaoDoAviso=async id=>{
    limparAlvo();
    if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return false;
    try{
      await window.abrirHojeDoAviso();
      const {acao}=await api('/api/v3/acoes/item?'+new URLSearchParams({id}));
      await window.carregarAcoes06();
      const existente=[...list.querySelectorAll('.acoes06-card')].find(node=>node.dataset.acao===id);
      const destino=existente||notificationTarget;
      if(existente)existente.classList.add('acoes06-from-notification');
      else{notificationTarget.append(element('p','Aberta pelo aviso','eyebrow'),card(acao));notificationTarget.hidden=false;}
      const focus=destino.querySelector('h3');focus.tabIndex=-1;focus.focus({preventScroll:true});
      if(!window.lumeScrollIntoView?.(destino,{smooth:true,block:'start'}))destino.scrollIntoView({block:'start'});
      return true;
    }catch{
      notificationTarget.hidden=false;
      notificationTarget.append(element('p','A ação não está mais disponível. Confira a permissão ou a fonte.','muted'));
      notificationTarget.scrollIntoView({block:'start'});
      return false;
    }
  };
  function card(a,{compacto=false,aoAtualizar,board=false}={}){
    const atualizar=async()=>{await Promise.all([window.carregarAcoes06(),overview()]);await aoAtualizar?.();};
    const node=element('article',null,'acoes06-card');node.dataset.acao=a.id;
    const meta=element('div',null,'acoes06-meta');meta.append(element('span',a.tipo==='compromisso'?'Compromisso':'Pendência','action-type-label'),element('small',a.conversa_nome||a.conversa_id,'action-context'),element('small',date(a.recebido_em),'action-context'));
    meta.append(element('small',a.responsavel_id==='local:owner'?'Sua ação · definida por você':a.responsavel_id?'Outro responsável':'Responsável não definido','action-context'));
    if(board)meta.append(element('small','Área não definida · Prioridade não definida','action-context'));
    node.append(meta,element('h3',a.resumo),element('blockquote',a.trecho));
    if(a.prazo_citado)node.append(element('p','Prazo citado: '+a.prazo_citado+' · confirme na conversa.','muted'));
    if(a.estado==='estacionado'&&a.lembrar_em){
      const resultado={mostrado:'Aviso exibido pelo sistema.',falhou:'O sistema não exibiu o aviso.',pendente:'Aguardando confirmação do sistema.','sem-confirmacao':'O sistema não confirmou a exibição.',cancelado:'Aviso cancelado.'}[a.aviso_resultado];
      node.append(element('p','Rever em '+date(a.lembrar_em)+' · '+a.fuso+'. '+(resultado||avisoTexto()),'acoes06-due'));
    }
    const buttons=element('div',null,'button-row'),optionsButtons=element('div',null,'button-row');
    buttons.append(action('Ver mensagem E'+a.evento_id,()=>window.abrirFonteTarefa(a.evento_id),'text-button'));
    if(!a.responsavel_id||a.responsavel_id==='local:owner')(a.responsavel_id==='local:owner'?buttons:optionsButtons).append(action(a.responsavel_id?'Tirar de minhas ações':'Assumir ação',async()=>{
      const minha=a.responsavel_id!=='local:owner';
      await api('/api/v3/acoes/minha',{id:a.id,minha});
      await atualizar();
      feedback(minha?'Ação incluída em Minhas ações.':'Ação retirada de Minhas ações.');
    },'secondary'));
    const decidir=(acao,label,cls,target=optionsButtons)=>target.append(action(label,async()=>{await api('/api/v3/acoes/revisar',{id:a.id,acao});if(notificationTarget.querySelector(`[data-acao="${a.id}"]`))limparAlvo();await atualizar();feedback('Ação atualizada.');},cls));
    const abrir=(texto,historico,classe)=>{
      const button=element('button',texto,classe);
      button.type='button';
      button.onclick=()=>run(()=>window.abrirResolverLume(a,{historico,origem:button}));
      return button;
    };
    const execution=a.execucao_ui?.estado||'indisponivel';
    const stateText={nenhuma:a.estado==='sugerido'?'A confirmar':a.estado==='resolvido'?'Concluída':a.estado==='descartado'?'Descartada':'Confirmada',
      aguardando_assistente:'Contexto autorizado · início não confirmado',em_andamento:'Em andamento',resultado_informado:'Resultado recebido · confira',
      verificado:'Resultado verificado',revogada:'Autorização revogada',expirada:'Autorização expirada',invalidada:'Contexto alterado · revalide',indisponivel:'Estado da execução indisponível'};
    const state=element('p',stateText[execution]||'Estado indisponível','acoes06-cycle-state');node.append(state);
    if(execution==='verificado')buttons.append(abrir('Ver resultado verificado',false,'secondary resolver-open'));
    else if(['resolvido','descartado'].includes(a.estado)){
      // Historical actions keep corrections in the detail, without a new execution CTA.
    }else if(execution==='nenhuma'&&a.estado==='sugerido')decidir('confirmar','Confirmar','primary',buttons);
    else if(execution==='nenhuma'&&['confirmado','estacionado'].includes(a.estado)||execution==='aguardando_assistente')buttons.append(abrir('Resolver com →',false,'primary resolver-open'));
    else if(execution==='em_andamento')buttons.append(abrir('Ver andamento',false,'secondary resolver-open'));
    else if(execution==='resultado_informado')buttons.append(abrir('Conferir resultado',false,'secondary resolver-open'));
    else if(['invalidada','revogada','expirada'].includes(execution))buttons.append(abrir('Revalidar contexto',false,'secondary resolver-open'));
    if(execution==='nenhuma'&&(a.estado==='confirmado'||a.estado==='estacionado'))decidir('resolver','Resolvida','secondary');
    if(a.estado==='confirmado')optionsButtons.append(action('Organizar em projeto',()=>window.abrirProjetoDeAcoes([a.id]),'secondary project-from-action'));
    if(a.estado==='sugerido'||a.estado==='confirmado'||a.estado==='estacionado')decidir('descartar','Descartar','text-button');
    if(a.estado==='resolvido'||a.estado==='descartado')decidir('reabrir','Reabrir','secondary');
    node.append(buttons);
    const correction=element('details',null,'acoes06-correction'),correctionSummary=element('summary','Corrigir descrição');
    const correctionForm=element('form',null,'acoes06-correction-form'),correctionLabel=element('label','Próximo passo correto'),correctionInput=element('input');
    correctionInput.type='text';correctionInput.maxLength=500;correctionInput.required=true;correctionInput.value=a.resumo;
    correctionLabel.append(correctionInput);
    const correctionButton=element('button','Salvar correção','secondary');correctionButton.type='submit';
    correctionForm.append(correctionLabel,correctionButton);
    correctionForm.onsubmit=async event=>{event.preventDefault();correctionButton.disabled=true;try{
      const novo=correctionInput.value.trim();if(!novo)throw Error('Escreva o próximo passo correto.');
      const result=await api('/api/v3/acoes/corrigir',{id:a.id,resumo:novo});
      node.querySelector('h3').textContent=result.resumo;
      await atualizar();
      correction.open=false;feedback(result.alterado?'Descrição corrigida e guardada no histórico.':'Descrição já estava atualizada.');
    }catch(error){feedback(error.message);}finally{correctionButton.disabled=false;}};
    correction.append(correctionSummary,correctionForm);node.append(correction);
    if(['sugerido','confirmado','estacionado'].includes(a.estado)){
      const park=element('form',null,'acoes06-park'),parkLabel=element('label','Rever em','muted'),when=element('input');when.type='datetime-local';when.required=true;parkLabel.append(when);
      const parkButton=element('button',a.estado==='estacionado'?'Mudar data':'Estacionar','secondary');parkButton.type='submit';
      park.append(parkLabel,parkButton,element('small',avisoTexto(),'muted'));
      park.onsubmit=async event=>{event.preventDefault();parkButton.disabled=true;try{
        const local=new Date(when.value);if(!when.value||!Number.isFinite(local.getTime()))throw Error('Escolha data e hora para rever.');
        const fuso=Intl.DateTimeFormat().resolvedOptions().timeZone||'America/Sao_Paulo';
        await api('/api/v3/acoes/revisar',{id:a.id,acao:'estacionar',lembrarEm:local.toISOString(),fuso});
        if(notificationTarget.querySelector(`[data-acao="${a.id}"]`))limparAlvo();
        await atualizar();feedback('Ação estacionada. A data ficou salva no Lume.');
      }catch(error){feedback(error.message);}finally{parkButton.disabled=false;}};
      const detail=element('details',null,'luminus-park'),summary=element('summary',a.estado==='estacionado'?'Mudar data de revisão':'Estacionar para rever');detail.append(summary,park);node.append(detail);
    }
    const options=element('details',null,'acoes06-options');options.append(element('summary','Revisar combinado'),optionsButtons,correction);
    const park=node.querySelector('.luminus-park');if(park)options.append(park);
    node.append(options);
    return node;
  }
  function avisoTexto(){return avisosDisponiveis?'Com o Lume aberto, o sistema tentará avisar uma vez na hora marcada.':'A data fica salva. Abra o Lume instalado e confira a permissão de notificações para receber o aviso.';}
  window.carregarCombinadosDaConversa=async(conversaId,target,{total}={})=>{
    const dataRevision=revisaoDadosVisiveis;
    target.append(element('h3','Próximos passos desta conversa'));
    const result=await api('/api/v3/acoes?'+new URLSearchParams({estado:'ativos',limite:'100',conversa:conversaId}));
    if(dataRevision!==revisaoDadosVisiveis||!target.isConnected)return;
    if(!result.acoes.length){target.hidden=true;return;}
    const selecionada=()=>dataRevision===revisaoDadosVisiveis&&conversa===conversaId&&!$('memory').hidden;
    const aoAtualizar=async()=>{
      if(!selecionada()||!target.isConnected)return;
      await window.carregarConversas();
      if(selecionada())$('conversation-heading')?.focus({preventScroll:true});
    };
    for(const item of result.acoes)target.append(card(item,{aoAtualizar}));
    if(total>result.acoes.length)target.append(element('p',`Mostrando ${number(result.acoes.length)} de ${number(total)} ações atuais desta conversa. O recorte exibe até 100; outros estados ficam em Hoje.`,'muted'));
  };
  window.carregarAcoes06=async({automatico=false}={})=>{
    if(automatico&&(busy||$('today').hidden||section.contains(document.activeElement)||luminus.contains(document.activeElement)))return;
    const current=++revision,dataRevision=revisaoDadosVisiveis;busy=true;list.setAttribute('aria-busy','true');
    try{
      const board=view==='board';
      const [result,estado,analise,ativas]=await Promise.all([
        board?Promise.all(boardStates.map(([state])=>queryActions(state))):queryActions(filter.value,50,page),
        api('/api/v3/acoes/estado'),api('/api/v3/acoes/analise'),
        !board&&filter.value==='ativos'?Promise.resolve(null):queryActions('ativos')
      ]);
      if(current!==revision||dataRevision!==revisaoDadosVisiveis)return;
      atualizarBanner((ativas||result).acoes);
      avisosDisponiveis=estado.disponivel===true;
      if(!somSalvando){soundCheck.checked=estado.som!==false;soundCheck.disabled=false;}
      if(!board){
        total=Number.isFinite(Number(result.total))?Number(result.total):result.acoes.length;
        pages=Math.max(1,Number(result.paginas)||Math.ceil(total/50)||1);
        if(page>pages){page=pages;lastSignature='';window.carregarAcoes06();return;}
        pagination.hidden=pages<=1;pageStatus.textContent=`Página ${number(page)} de ${number(pages)} · ${number(total)} ${total===1?'ação':'ações'} no filtro`;previousPage.disabled=page<=1;nextPage.disabled=page>=pages;
      }else pagination.hidden=true;
      const signature=JSON.stringify([view,page,result,avisosDisponiveis]);if(signature!==lastSignature){lastSignature=signature;
        if(board){
          list.replaceChildren(...boardStates.map(([state,name],index)=>{
            const items=result[index].acoes,column=element('section',null,'acoes06-column');
            const quantidade=Number.isSafeInteger(result[index].total)?result[index].total:items.length;
            column.setAttribute('aria-labelledby',`acoes06-column-${state}`);
            const heading=element('h3',null,'acoes06-column-title');heading.id=`acoes06-column-${state}`;
            heading.append(document.createTextNode(name),element('span',String(quantidade),'acoes06-column-count'));
            column.append(heading);
            if(items.length)column.append(...items.map(item=>card(item,{board:true})));
            else column.append(element('p','Nenhuma ação neste estado.','muted acoes06-column-empty'));
            if(quantidade>items.length)column.append(action(`Ver todas as ${number(quantidade)} na lista`,()=>{
              filter.value=state;showView('list');
            },'text-button'));
            return column;
          }));
        }else if(result.acoes.length)list.replaceChildren(...result.acoes.map(card));
        else empty(list,filter.value==='ativos'?'Nada novo para conferir agora.':filter.value==='minhas'?'Nenhuma ação sua pendente.':'Nenhuma ação neste estado.',filter.value==='ativos'||filter.value==='sugerido'?'O Laya local continua em avaliação. Quando houver sugestões verificadas de conversas disponíveis, elas aparecerão aqui.':filter.value==='minhas'?'Use “Assumir ação” em uma ficha para incluí-la aqui.':'As ações revisadas aparecem aqui.');
        window.lumeChanged?.(list,signature);
      }
      const shown=board?result.reduce((sum,group)=>sum+group.acoes.length,0):result.acoes.length;
      status.textContent=shown?`Mostrando ${number(shown)} ${shown===1?'ação':'ações'}${board?' no quadro':` · página ${number(page)} de ${number(pages)}`} · fonte conferível`:'Nenhuma ação para mostrar';
      const partes=[];
      if(analise.pendentes||analise.analisando)partes.push(`${number(analise.pendentes+analise.analisando)} ${analise.pendentes+analise.analisando===1?'mensagem na fila':'mensagens na fila'}`);
      if(analise.aguardandoModelo)partes.push(`${number(analise.aguardandoModelo)} aguardando o modelo local`);
      if(analise.aguardandoValidacao)partes.push(`${number(analise.aguardandoValidacao)} aguardando aprovação de qualidade do Laya`);
      if(analise.sugeridas)partes.push(`${number(analise.sugeridas)} ${analise.sugeridas===1?'mensagem com ação proposta':'mensagens com ações propostas'}`);
      if(analise.abstidas)partes.push(`${number(analise.abstidas)} analisadas sem sugestão aprovada`);
      if(analise.erros)partes.push(`${number(analise.erros)} com erro de análise`);
      if(analise.canceladas)partes.push(`${number(analise.canceladas)} canceladas`);
      analysisStatus.textContent=partes.length?`Análise local: ${partes.join(' · ')}.`:'Acompanhamento local: as conversas disponíveis entram automaticamente; a interpretação depende da aprovação do modelo.';
    }catch(error){if(current===revision){lastSignature='';bannerSignature='';pagination.hidden=true;atualizarBanner([]);empty(list,'Não foi possível carregar as ações.','Confira a conexão local e tente novamente.');list.append(action('Tentar novamente',window.carregarAcoes06,'secondary'));status.textContent='Não foi possível atualizar as ações.';analysisStatus.textContent=error.message||'Não foi possível consultar o acompanhamento local.';}}
    finally{if(current===revision){busy=false;list.setAttribute('aria-busy','false');}}
  };
  previousPage.onclick=()=>{if(page>1){page--;lastSignature='';window.carregarAcoes06();}};
  nextPage.onclick=()=>{if(page<pages){page++;lastSignature='';window.carregarAcoes06();}};
  filter.onchange=()=>{limparAlvo();page=1;lastSignature='';window.carregarAcoes06();};
  window.limparAcoes06=()=>{revision++;page=1;pages=1;total=0;lastSignature='';bannerSignature='';busy=false;pagination.hidden=true;atualizarBanner([]);list.replaceChildren();limparAlvo();status.textContent='Atualize para consultar as ações permitidas.';};

  window.carregarPermissoesAcoes06=async()=>{
    const current=++permissionRevision;permissionStatus.textContent='Buscando conversas…';
    try{
      const [result,analise]=await Promise.all([api('/api/v3/acoes/conversas?'+new URLSearchParams({busca:query.value.trim()})),api('/api/v3/acoes/analise')]);
      if(current!==permissionRevision)return;
      permissions.replaceChildren();
      const porConversa=new Map((analise.conversas||[]).map(item=>[item.id,item]));
      for(const conversation of result.conversas){
        const row=element('div',null,'acoes06-permission'),name=element('div'),cobertura=porConversa.get(conversation.id);
        const andamento=[];
        if(cobertura?.erros)andamento.push(`${number(cobertura.erros)} com erro`);
        if(cobertura?.aguardandoValidacao)andamento.push(`${number(cobertura.aguardandoValidacao)} aguardando aprovação de qualidade do Laya`);
        if(cobertura?.aguardandoModelo)andamento.push(`${number(cobertura.aguardandoModelo)} aguardando o modelo local`);
        if(cobertura?.naFila)andamento.push(`${number(cobertura.naFila)} na fila`);
        if(cobertura?.sugeridas)andamento.push(`${number(cobertura.sugeridas)} com ação proposta`);
        if(cobertura?.abstidas)andamento.push(`${number(cobertura.abstidas)} sem sugestão aprovada`);
        const estadoConversa=!conversation.autorizada?'Organização automática ativa · sem ajuste manual':!cobertura?.total?'Ajuste manual ativo · aguardando novas mensagens':andamento.join(' · ')||'Ajuste manual ativo · sem análise recente';
        name.append(element('strong',conversation.nome),element('small',estadoConversa));
        const button=action(conversation.autorizada?'Revogar':'Autorizar',async()=>{
          if(conversation.autorizada&&!window.confirm('Remover o ajuste manual desta conversa? As ações derivadas podem deixar de aparecer.'))return;
          await api('/api/v3/acoes/autorizar',{conversa:conversation.id,permitida:!conversation.autorizada});
          if(conversation.autorizada)limparAlvo();
          await window.carregarPermissoesAcoes06();await window.carregarAcoes06();
          feedback(conversation.autorizada?'Ajuste manual removido.':'Ajuste manual salvo para esta conversa.');
        },conversation.autorizada?'text-button':'secondary');
        button.textContent=conversation.autorizada?'Remover ajuste manual':'Ajustar manualmente';
        // A remoção manual ainda usa um endpoint legado e pode ser reconstituída pela organização automática.
        // Deixe a decisão no fluxo de privacidade até existir uma rota de exclusão com escopo fechado.
        button.hidden=true;
        row.append(name,button);
        if(conversation.autorizada){
          const organizar=action('Organizar agora',async()=>{
            organizar.disabled=true;
            try{
              const resultado=await api('/api/v3/acoes/organizar',{conversa:conversation.id,limite:50});
              await window.carregarPermissoesAcoes06();await window.carregarAcoes06();
              feedback(resultado.selecionadas?`${number(resultado.selecionadas)} mensagens selecionadas. Confira o andamento acima.`:'Nenhuma mensagem de texto legível encontrada nessa conversa.');
            }catch(error){feedback(error.message);organizar.disabled=false;}
          },'secondary');
          row.append(organizar);
          if(cobertura?.manuaisNaFila){
            const cancelar=action('Cancelar análise',async()=>{
              cancelar.disabled=true;
              try{
                const resultado=await api('/api/v3/acoes/cancelar-analise',{conversa:conversation.id});
                await window.carregarPermissoesAcoes06();await window.carregarAcoes06();
                feedback(`${number(resultado.canceladas)} mensagens canceladas nesta conversa.`);
              }catch(error){feedback(error.message);cancelar.disabled=false;}
            },'text-button');
            row.append(cancelar);
          }
        }
        permissions.append(row);
      }
      if(!result.conversas.length)empty(permissions,'Nenhuma conversa encontrada.','Conecte o WhatsApp ou procure por outro nome.');
      permissionStatus.textContent=result.conversas.length?`Mostrando até 50 conversas · ${result.conversas.filter(c=>c.autorizada).length} autorizadas (ajuste manual, opcional) nesta busca`:'Sem resultados';
    }catch(error){if(current===permissionRevision){permissionStatus.textContent=error.message;permissions.replaceChildren(action('Tentar novamente',window.carregarPermissoesAcoes06,'secondary'));}}
  };
  search.onsubmit=event=>{event.preventDefault();window.carregarPermissoesAcoes06();};
})();

/* Scoped execution: preview -> authorization -> reported result -> verification.
 * The renderer never invents activity or treats clipboard export as execution. */
(() => {
  const names={claude:'Claude',codex:'Codex',hermes:'Hermes'};
  const states={aguardando_assistente:'Aguardando o assistente',em_andamento:'Em andamento',resultado_informado:'Resultado informado · confira',verificado:'Resultado verificado por você',revogada:'Autorização revogada'};
  const historicalStates={aguardando_assistente:'Aguardava o assistente antes da mudança',em_andamento:'Estava em andamento antes da mudança',resultado_informado:'Resultado informado antes da mudança',verificado:'Resultado verificado por você antes da mudança',revogada:'Autorização revogada'};
  const stateLabel=execution=>(execution.contexto_invalidado?historicalStates:states)[execution.estado]||'Estado indisponível';
  const dialog=element('dialog',null,'resolver-dialog');dialog.id='resolver-dialog';dialog.setAttribute('aria-labelledby','resolver-title');
  document.body.append(dialog);
  let revision=0,selectedAction=null,opener=null,restoreFocus=true,requestDataRevision=0;
  const valid=r=>r===revision&&dialog.open&&requestDataRevision===revisaoDadosVisiveis;
  const key=()=>crypto.randomUUID();
  function frame(kicker='RESOLVER COM',title=selectedAction?.resumo||'Próximo passo'){
    const close=action('Fechar',()=>dialog.close(),'secondary resolver-close');close.setAttribute('aria-label','Fechar Resolver com');
    const head=element('header',null,'resolver-heading'),copy=element('div');
    const heading=element('h2',title);heading.id='resolver-title';heading.tabIndex=-1;
    copy.append(element('p',kicker,'eyebrow'),heading);head.append(copy,close);
    const body=element('div',null,'resolver-body');dialog.replaceChildren(head,body);heading.focus({preventScroll:true});return body;
  }
  function fail(error,r){
    if(!valid(r))return;
    const body=frame('CONTEXTO INDISPONÍVEL');
    const message=element('p',error.message||'Não foi possível abrir. Tente novamente.','resolver-error');message.setAttribute('role','alert');
    body.append(message,element('p','A fonte ou a autorização pode ter mudado. Abra uma nova prévia para conferir.','muted'),action('Tentar novamente',()=>load(false),'secondary'));
  }
  function formStatus(form){
    const status=element('div',null,'resolver-form-status');status.setAttribute('role','alert');status.tabIndex=-1;status.hidden=true;form.append(status);return status;
  }
  function formError(error,r,form,status){
    if(!valid(r)||!form.isConnected)return;
    // A local validation or transient failure must not erase a draft. Access,
    // source and state failures still clear the old context, as before.
    const conflict=error.code==='IDEMPOTENCY_CONFLICT';
    if(error.status>=400&&error.status<500&&![400,429].includes(error.status)&&!conflict){fail(error,r);return;}
    const message=error instanceof TypeError?'Não foi possível confirmar o salvamento.':error.message||'Não foi possível salvar agora.';
    status.replaceChildren(element('p',message,'resolver-error'),element('p',conflict?
      'Seu texto foi mantido. Use “Atualizar andamento” para conferir o envio anterior antes de continuar.':
      'Seu texto foi mantido. Confira os campos e tente novamente.','muted'));
    status.hidden=false;status.focus();
  }
  function sourceList(context,body){
    const section=element('section',null,'resolver-sources');section.append(element('h3','O contexto que vai junto'));
    for(const source of context.fontes||[]){
      const article=element('article');article.append(element('p',source.conversa||'Conversa autorizada','resolver-source-name'),element('blockquote',source.trecho||'Trecho indisponível'),element('small',[source.autor,date(source.em)].filter(Boolean).join(' · ')));section.append(article);
    }
    section.append(element('p','Somente este recorte acompanha a tarefa. As mensagens originais continuam no Lume.','muted'));body.append(section);
  }
  function timeline(events,body,{execucaoId,r}={}){
    const section=element('section',null,'resolver-timeline');section.setAttribute('aria-label','Histórico da execução');section.append(element('h3','Do combinado ao resultado'));
    const list=element('ol');
    const seen=new Set();
    function row(event){
      if(Number.isSafeInteger(event.id)){if(seen.has(event.id))return null;seen.add(event.id);}
      const item=element('li');item.dataset.kind=event.tipo;
      const title=event.tipo==='resultado'&&event.ator==='local:owner'?'Retorno registrado por você':({acao:'Combinado registrado',autorizacao:'Contexto autorizado',inicio:'Assistente iniciou',progresso:'Progresso informado',resultado:'Resultado informado',verificacao:'Conferido por você',revogacao:'Autorização revogada'}[event.tipo]||'Registro');
      item.append(element('b',title),element('time',date(event.em)),element('p',event.resumo||event.texto||event.nota||event.estado||''));
      if(event.tipo==='resultado')item.append(element('small',(event.ator==='local:owner'?'Relato registrado por você.':'Informado pelo assistente.')+' A conferência é uma etapa separada.'));
      if(event.artefatos?.length){const files=element('ul',null,'resolver-artifacts');for(const file of event.artefatos){const li=element('li');li.append(element('code',file));files.append(li);}item.append(files);}
      return item;
    }
    for(const event of events||[]){const item=row(event);if(item)list.append(item);}
    if(!list.children.length)section.append(element('p','Ainda não há retorno do assistente.','muted'));
    section.append(list);body.append(section);
    // The short context snapshot is not the complete execution history.
    // Ask for older records only on demand, with the same server-side access checks.
    if(execucaoId&&seen.size>=20){
      let before=Math.min(...seen);
      const status=element('p',null,'muted');status.setAttribute('role','status');
      const more=action('Ver registros anteriores',async()=>{
        status.textContent='Buscando registros anteriores…';
        try{
          const next=await api('/api/v3/execucoes/timeline?'+new URLSearchParams({id:execucaoId,limite:'20',antes:before}));
          if(!valid(r)||!section.isConnected)return;
          const fragment=document.createDocumentFragment();
          for(const event of [...next.timeline].reverse()){const item=row(event);if(item)fragment.append(item);}
          list.prepend(fragment);before=next.antes;more.hidden=!before;
          status.textContent=next.timeline.length?`${next.timeline.length} registros anteriores carregados.`:'Você chegou ao início do histórico.';
          if(!before){status.tabIndex=-1;status.focus({preventScroll:true});}
        }catch(error){if(section.isConnected)fail(error,r);}
      },'secondary');section.append(more,status);
    }
  }
  async function preview(r,projetoEscolhido=null){
    const pedido={acao_id:selectedAction.id,...(projetoEscolhido?{projeto_id:projetoEscolhido.id,escopo:projetoEscolhido.escopo}:{})};
    const {contexto,prazo_disponivel}=await api('/api/v3/execucoes/contexto',pedido);if(!valid(r))return;
    const body=frame('1 · CONFIRA O COMBINADO',contexto.tarefa);
    body.append(element('p','Leve o contexto certo para preparar o próximo passo.','resolver-intro'));
    sourceList(contexto,body);
    const form=element('form',null,'resolver-authorize'),fieldset=element('fieldset'),legend=element('legend','Com quem você quer resolver?');fieldset.append(legend);
    const choices=element('div',null,'resolver-assistants');
    for(const [id,name]of Object.entries(names).filter(([id])=>!contexto.projeto||id==='codex')){
      const label=element('label'),input=element('input');input.type='radio';input.name='assistente';input.value=id;input.required=true;input.checked=id===(contexto.projeto?'codex':'claude');
      label.append(input,element('b',name));choices.append(label);
    }
    fieldset.append(choices);form.append(fieldset,element('p',contexto.projeto?'Prévia de projeto para conferência. O Lume ainda não executa o Codex nem impõe este escopo ao repasse manual.':'Claude tem configuração guiada nos Ajustes. Para Codex ou Hermes, a conexão precisa estar configurada no próprio assistente.','resolver-connection-note'));
    const scopeNote=element('p','A conexão “Hoje” deixa de incluir mensagens de dias anteriores. Para continuar esta tarefa amanhã, você pode autorizar um prazo separado abaixo.','muted');form.append(scopeNote);
    const keepLabel=element('label',null,'check resolver-consent'),keep=element('input');keep.type='checkbox';keep.id='resolver-keep-context';
    keepLabel.append(keep,element('span','Manter somente este contexto acessível ao assistente por 7 dias, mesmo fora de “Hoje”.'));
    const keepHelp=element('p',null,'resolver-scope');keepHelp.id='resolver-keep-help';keep.setAttribute('aria-describedby',keepHelp.id);
    const updateKeep=()=>{const available=prazo_disponivel?.[new FormData(form).get('assistente')]===true;keep.disabled=!available;if(!available)keep.checked=false;
      keepHelp.textContent=available?'Opcional. Não abre outras conversas. Você pode revogar antes; alterações da fonte ou da permissão bloqueiam o acesso.':'O prazo extra precisa de uma conexão gerida e ativa. Por enquanto, está disponível com o Claude configurado nos Ajustes. Sem ele, vale o recorte da conexão.';
    };fieldset.addEventListener('change',updateKeep);form.append(keepLabel,keepHelp);updateKeep();
    const consentLabel=element('label',null,'check resolver-consent'),consent=element('input');consent.type='checkbox';consent.required=true;consent.id='resolver-consent';
    consentLabel.append(consent,element('span','Autorizo o assistente escolhido a receber este contexto e preparar material para esta tarefa.'));
    const scope=element('p','Esta autorização não inclui enviar mensagens, publicar, gastar ou mudar o negócio.','resolver-scope');
    const cost=element('p','O custo do assistente escolhido depende da sua conta e não é estimado pelo Lume nesta prévia. Confira no assistente antes de autorizar.','resolver-scope');
    const submit=element('button','Autorizar contexto →','primary');submit.type='submit';
    const local=element('p','Autorizar registra o pedido. O assistente só começa quando abrir a tarefa na conexão do Lume.','muted');
    const status=element('div',null,'resolver-form-status');status.setAttribute('role','alert');status.tabIndex=-1;status.hidden=true;
    form.append(consentLabel,scope,cost,submit,local,status);
    if(contexto.projeto){
      const project=element('section',null,'resolver-project-scope');
      project.append(element('h3',`Projeto: ${contexto.projeto.nome}`),element('p','Arquivos escolhidos para uma futura cópia descartável. Esta prévia ainda não limita um Codex aberto fora do Lume. Ferramentas externas previstas: nenhuma.','muted'));
      const permissions=element('ul');
      for(const caminho of contexto.escopo.arquivos)permissions.append(element('li',`${contexto.escopo.permissoes.escrita.includes(caminho)?'Editar':'Ler'} · ${caminho}`));
      project.append(permissions,element('p','Esta prévia vale para esta fonte e este escopo exatos. Se mudarem, prepare outra.','muted'),
        action('Voltar ao repasse manual',async()=>{try{await preview(r);}catch(error){fail(error,r);}},'secondary'));
      fieldset.after(project);
      consentLabel.querySelector('span').textContent='Conferi este projeto, os arquivos e as permissões da prévia.';
      consent.disabled=true;submit.disabled=true;submit.textContent='Execução no Lume indisponível';
      local.textContent='A prévia não inicia nem autoriza alterações. Você ainda pode voltar e usar o repasse manual sem este projeto.';
    }else{
      const project=element('section',null,'resolver-project-scope');
      project.hidden=true;
      project.append(element('h3','Conferir escopo de projeto para Codex'));
      const choose=element('button','Escolher pasta no computador','secondary');choose.type='button';
      const projectStatus=element('p','Prévia opcional: escolha uma pasta e marque arquivos para conferir. O repasse manual continua disponível; esta seleção ainda não autoriza alterações.','muted');projectStatus.setAttribute('role','status');
      const filter=element('input');filter.type='search';filter.placeholder='Buscar arquivo pelo nome';filter.setAttribute('aria-label','Buscar arquivo do projeto');filter.hidden=true;
      const rows=element('div',null,'resolver-project-files'),continueButton=element('button','Conferir escopo e fonte →','primary');continueButton.type='button';continueButton.hidden=true;
      project.append(choose,projectStatus,filter,rows,continueButton);fieldset.after(project);
      let selected=null;const permissions=new Map();
      const renderFiles=()=>{
        if(!selected)return;
        const query=filter.value.trim().toLocaleLowerCase('pt-BR');
        const found=selected.arquivos.filter(file=>file.caminho.toLocaleLowerCase('pt-BR').includes(query));
        const visible=found.slice(0,150);
        rows.replaceChildren(...visible.map(file=>{
          const label=element('label',null,'resolver-project-file'),name=element('span',`${file.caminho} · ${file.bytes} bytes`),choice=element('select');
          choice.setAttribute('aria-label',`Permissão para ${file.caminho}`);
          for(const [value,title] of [['','Não incluir'],['ler','Ler'],['editar','Ler e editar']])choice.append(new Option(title,value));
          choice.value=permissions.get(file.caminho)||'';
          choice.onchange=()=>{if(choice.value)permissions.set(file.caminho,choice.value);else permissions.delete(file.caminho);projectStatus.textContent=`${permissions.size} arquivos escolhidos de ${selected.arquivos.length}.`};
          label.append(name,choice);return label;
        }));
        if(!permissions.size)projectStatus.textContent=`${selected.nome}: ${selected.arquivos.length} arquivos disponíveis, ${selected.omitidos} entradas protegidas omitidas. Mostrando ${visible.length} de ${found.length}.`;
      };
      filter.oninput=renderFiles;
      choose.onclick=async()=>{
        selected=null;permissions.clear();filter.hidden=true;rows.replaceChildren();continueButton.hidden=true;
        choose.disabled=true;projectStatus.textContent='Abrindo o seletor de pasta…';
        try{
          const result=await api('/api/v3/execucoes/projeto',{});if(!valid(r))return;
          if(result.cancelado){projectStatus.textContent='Escolha cancelada. Nenhum projeto foi autorizado.';return;}
          selected=result.projeto;permissions.clear();filter.value='';filter.hidden=false;continueButton.hidden=false;renderFiles();
          if(!selected.arquivos.length)projectStatus.textContent='Não há arquivos disponíveis nesta pasta. Escolha outra.';
        }catch(error){if(valid(r))projectStatus.textContent=error.message||'Não foi possível listar esta pasta.';}
        finally{choose.disabled=false;}
      };
      continueButton.onclick=async()=>{
        if(!selected||!permissions.size){projectStatus.textContent='Marque pelo menos um arquivo para continuar.';return;}
        continueButton.disabled=true;projectStatus.textContent='Preparando a prévia exata…';
        const escolhidos=selected.arquivos.filter(file=>permissions.has(file.caminho)).map(file=>file.caminho);
        const escopo={arquivos:escolhidos,permissoes:{leitura:escolhidos,escrita:escolhidos.filter(file=>permissions.get(file)==='editar'),ferramentas:[]}};
        try{await preview(r,{id:selected.id,escopo});}
        catch(error){if(valid(r))projectStatus.textContent=error.message||'Não foi possível preparar a prévia.';}
        finally{continueButton.disabled=false;}
      };
      const updateProject=()=>{project.hidden=new FormData(form).get('assistente')!=='codex';};
      fieldset.addEventListener('change',updateProject);updateProject();
    }
    body.append(form);
    const idempotency=key();let submitting=false;
    form.onsubmit=async event=>{
      event.preventDefault();if(submitting||!consent.checked||contexto.projeto)return;submitting=true;submit.disabled=true;status.hidden=false;status.textContent='Registrando sua autorização…';
      try{
        const result=await api('/api/v3/execucoes/iniciar',{contexto_id:contexto.id,assistente:new FormData(form).get('assistente'),confirmar:true,chave_idempotencia:idempotency,...(keep.checked?{manter_contexto:true}:{})});
        if(valid(r))renderExecution(result,r);
      }catch(error){formError(error,r,form,status);}finally{submitting=false;submit.disabled=false;}
    };
    dialog.querySelector('#resolver-title').focus({preventScroll:true});
  }
  function renderExecution(result,r){
    if(!valid(r))return;
    const {execucao,contexto}=result,body=frame('2 · ACOMPANHE O RETORNO',contexto.tarefa);
    if(contexto.historico_importado)body.append(element('p','Histórico importado do seu backup. Este é o contexto daquela época; nenhuma autorização de execução foi restaurada.','resolver-connection-note'));
    const invalidated=execucao.contexto_invalidado===true;
    if(invalidated)body.append(element('p','O contexto desta tarefa mudou. Este registro preserva o que aconteceu antes da mudança; o assistente não pode continuar nem você confirmar novos resultados com esta autorização.','resolver-connection-note resolver-context-invalidated'));
    const state=element('p',stateLabel(execucao),'resolver-state');state.dataset.state=execucao.estado;state.setAttribute('role','status');body.append(state);
    const blockedContext=invalidated||['revogado','expirado'].includes(execucao.contexto_prazo_estado);
    if(execucao.manter_contexto&&execucao.contexto_expira_em){
      const expired=execucao.contexto_prazo_estado==='expirado';
      body.append(element('p',invalidated?'O prazo adicional foi interrompido pela mudança de contexto. Confira uma nova prévia antes de autorizar o assistente novamente.':execucao.estado==='revogada'||execucao.contexto_prazo_estado==='revogado'?'O acesso adicional está revogado. Prepare outra autorização para retomar com o assistente.':expired?
        `O acesso adicional terminou em ${date(execucao.contexto_expira_em)}. O histórico permanece aqui; prepare outra autorização para retomar com o assistente.`:
        `Somente este contexto fica acessível até ${date(execucao.contexto_expira_em)}. O restante da conexão mantém seu recorte.`, 'resolver-connection-note resolver-context-expiry'));
    }
    const bar=element('div',null,'button-row resolver-toolbar');
    const refresh=action('Atualizar andamento',async()=>{
      try{const next=await api('/api/v3/execucoes/item?id='+encodeURIComponent(execucao.id));if(valid(r))renderExecution(next,r);}catch(error){fail(error,r);}
    },'secondary');bar.append(refresh);
    if(blockedContext&&!invalidated&&execucao.estado!=='revogada'&&!['resolvido','descartado'].includes(selectedAction.estado))bar.prepend(action('Preparar nova autorização',async()=>{try{await preview(r);}catch(error){fail(error,r);}},'primary'));
    if(execucao.estado==='aguardando_assistente'&&!blockedContext){
      body.append(element('p',`Abra ${names[execucao.assistente]||'o assistente'} com a conexão do Lume e peça para assumir esta tarefa. O pedido continua aguardando até o assistente registrar o início.`,'resolver-intro'));
      const copyStatus=element('p',null,'resolver-copy-status');copyStatus.setAttribute('role','status');
      bar.append(action('Copiar pedido',async()=>{
        // Only the execution identifier leaves the clipboard. Source access is
        // revalidated by the server when the authorized assistant requests it.
        const text=`Abra a execução ${execucao.id} no Lume com lume_obter_contexto_execucao. Confira as fontes e o escopo autorizado. Registre o início com lume_iniciar_execucao, o progresso com lume_registrar_progresso e o resultado com lume_registrar_resultado. Use uma chave_idempotencia única por registro. Não envie mensagens, publique ou faça gastos.`;
        try{await navigator.clipboard.writeText(text);if(valid(r))copyStatus.textContent='Pedido copiado. Cole no assistente. A execução ainda aguarda o início.';}
        catch{if(valid(r)){copyStatus.textContent='Selecione e copie o pedido abaixo.';const field=element('textarea');field.value=text;field.readOnly=true;field.rows=5;field.setAttribute('aria-label','Pedido para copiar');copyStatus.append(field);field.focus();field.select();}}
      },'primary'));
      if(execucao.assistente==='claude')bar.append(action('Conferir conexão',async()=>{restoreFocus=false;dialog.close();await window.abrirAjuste('mcp-panel');},'secondary'));
      else body.append(element('p','O Lume ainda não confirmou a conexão com este assistente. Confira a configuração nele antes de colar o pedido.','resolver-connection-note'));
      body.append(bar,copyStatus);
    }else body.append(bar);
    const contextDetails=element('details',null,'resolver-context-detail');contextDetails.append(element('summary','Rever o contexto autorizado'));sourceList(contexto,contextDetails);body.append(contextDetails);
    timeline(contexto.timeline,body,{execucaoId:execucao.id,r});
    if(!invalidated&&execucao.pode_registrar_resultado!==false&&['aguardando_assistente','em_andamento'].includes(execucao.estado)){
      const details=element('details',null,'resolver-manual');details.append(element('summary','Registrar um retorno recebido fora do Lume'));
      const form=element('form'),label=element('label','O que o assistente entregou?'),summary=element('textarea');summary.rows=4;summary.maxLength=4000;summary.required=true;summary.name='resumo';label.append(summary);
      const filesLabel=element('label','Arquivos ou links do resultado (um por linha)'),files=element('textarea');files.rows=2;files.name='artefatos';filesLabel.append(files);
      const submit=element('button','Guardar resultado informado','secondary');submit.type='submit';form.append(label,filesLabel,element('p','Este registro guarda o relato. Você confere o material na próxima etapa.','muted'),submit);details.append(form);body.append(details);
      const idempotency=key(),status=formStatus(form);
      form.onsubmit=async event=>{event.preventDefault();if(submit.disabled)return;submit.disabled=true;status.hidden=true;try{
        const artifacts=files.value.split('\n').map(x=>x.trim()).filter(Boolean);
        if(artifacts.length>10||artifacts.some(x=>x.length>500))throw Error('Use até 10 referências, com no máximo 500 caracteres cada.');
        const next=await api('/api/v3/execucoes/resultado',{execucao_id:execucao.id,chave_idempotencia:idempotency,resumo:summary.value.trim(),artefatos:artifacts});if(valid(r))renderExecution(next,r);
      }catch(error){formError(error,r,form,status);}finally{submit.disabled=false;}};
    }
    if(!invalidated&&execucao.pode_verificar!==false&&execucao.estado==='resultado_informado'){
      const form=element('form',null,'resolver-verify'),label=element('label','O que você conferiu no resultado?'),note=element('textarea');note.rows=3;note.required=true;note.maxLength=1000;note.id='resolver-verification-note';label.append(note);
      const submit=element('button','Confirmar resultado verificado','primary');submit.type='submit';
      form.append(element('h3','O combinado foi atendido?'),element('p','Abra o material recebido e confira antes de confirmar.','muted'),label,submit);body.append(form);
      const idempotency=key(),status=formStatus(form);
      form.onsubmit=async event=>{event.preventDefault();if(submit.disabled)return;submit.disabled=true;status.hidden=true;try{const next=await api('/api/v3/execucoes/verificar',{execucao_id:execucao.id,chave_idempotencia:idempotency,confirmar:true,nota:note.value.trim()});if(valid(r)){renderExecution(next,r);window.lumeSound?.('success');}}catch(error){formError(error,r,form,status);}finally{submit.disabled=false;}};
    }
    const revoke=element('details',null,'resolver-revoke');revoke.append(element('summary','Revogar acesso a esta tarefa'),element('p','O assistente perde o acesso e não pode registrar novos retornos. Conteúdo já copiado fora do Lume não é apagado.','muted'),action('Confirmar revogação',async()=>{
      try{await api('/api/v3/execucoes/revogar',{execucao_id:execucao.id,confirmar:true});if(valid(r)){const content=frame('ACESSO REVOGADO');content.append(element('p','A autorização desta tarefa foi revogada.','resolver-state'),action('Voltar ao histórico',()=>load(true),'secondary'));}}
      catch(error){fail(error,r);}
    },'secondary'));if(execucao.estado!=='revogada')body.append(revoke);
    body.append(element('small',`Execução ${execucao.id}`,'resolver-id'));
  }
  async function load(historico=false){
    const r=++revision;requestDataRevision=revisaoDadosVisiveis;
    const body=frame();const status=element('p','Abrindo o contexto desta tarefa…');status.setAttribute('role','status');body.append(status);
    try{
      const {execucoes}=await api('/api/v3/execucoes?'+new URLSearchParams({acao_id:selectedAction.id}));if(!valid(r))return;
      const active=execucoes.find(x=>x.estado!=='revogada');
      if(active&&!historico){const result=await api('/api/v3/execucoes/item?id='+encodeURIComponent(active.id));if(valid(r))renderExecution(result,r);return;}
      if(!historico){await preview(r);return;}
      const content=frame('HISTÓRICO DA TAREFA');
      if(!execucoes.length)content.append(element('p','Nenhuma execução autorizada para este combinado ainda.','resolver-intro'));
      for(const execution of execucoes){
        const row=element('article',null,'resolver-history-row');row.append(element('b',names[execution.assistente]||'Assistente'));
        if(execution.contexto_invalidado)row.append(element('p','Contexto alterado · histórico','resolver-history-context'));
        row.append(element('p',stateLabel(execution)),element('small',date(execution.atualizada_em)));
        row.append(action(execution.contexto_invalidado||execution.estado==='revogada'?'Ver histórico preservado':'Abrir andamento',async()=>{try{const result=await api('/api/v3/execucoes/item?id='+encodeURIComponent(execution.id));if(valid(r))renderExecution(result,r);}catch(error){fail(error,r);}},'secondary'));
        content.append(row);
      }
      if(!['resolvido','descartado'].includes(selectedAction.estado)&&!execucoes.some(x=>x.contexto_invalidado))content.append(action('Preparar novo contexto',async()=>{try{await preview(r);}catch(error){fail(error,r);}},'primary'));
    }catch(error){fail(error,r);}
  }
  window.abrirResolverLume=async(action,{historico=false,origem=null}={})=>{
    opener=origem||document.activeElement;restoreFocus=true;selectedAction={...action};requestDataRevision=revisaoDadosVisiveis;
    if(!dialog.open)dialog.showModal();await load(historico);
  };
  dialog.addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const closed=[...dialog.querySelectorAll('details:not([open])')];
    const controls=[...dialog.querySelectorAll('button,input,textarea,select,summary,a[href],[tabindex]')].filter(n=>!n.disabled&&n.tabIndex>=0&&n.getClientRects().length&&!closed.some(d=>d.contains(n)&&d.querySelector(':scope > summary')!==n));
    if(!controls.length){event.preventDefault();dialog.querySelector('h2')?.focus();return;}
    const first=controls[0],last=controls.at(-1),active=document.activeElement;
    if(event.shiftKey&&(active===first||!controls.includes(active))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(active===last||!dialog.contains(active))){event.preventDefault();first.focus();}
  });
  dialog.addEventListener('close',()=>{
    if(dialog.open)return;
    revision++;dialog.replaceChildren();selectedAction=null;
    const active=document.activeElement;
    if(restoreFocus&&opener?.isConnected&&!opener.disabled&&opener.getClientRects().length&&
      (!active||active===document.body||active===document.documentElement||active===dialog||dialog.contains(active)))opener.focus({preventScroll:true});
    opener=null;
  });
  const clear=window.limparDadosVisiveis;
  if(clear)window.limparDadosVisiveis=(...args)=>{revision++;restoreFocus=false;if(dialog.open)dialog.close();window.limparAcoes06?.();return clear(...args);};
})();
