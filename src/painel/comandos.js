(() => {
  function criarFiltroTags({id,label,tipos,target,onChange}){
    const box=element('div',null,'tag-filter'),select=element('select'),status=element('small',null,'muted');
    const title=element('label',label);select.id=id;title.htmlFor=id;box.append(title,select,status);target.append(box);
    let revision=0,value='';
    const option=(text,key)=>{const node=element('option',text);node.value=key;return node;};
    const control={
      get value(){return value;},
      invalidate(){revision++;},
      clear(message='Atualize para consultar as tags.'){
        revision++;value='';select.replaceChildren(option('Todas as tags',''));select.value='';status.textContent=message;
      },
      async load({notify=false}={}){
        const request=++revision,previous=value;status.textContent='Atualizando tags…';
        try{
          const pages=await Promise.all(tipos.map(tipo=>api('/api/v3/tags?'+new URLSearchParams({entidadeTipo:tipo,limite:'100'}))));
          if(request!==revision)return false;
          const byKey=new Map();
          for(const page of pages)for(const facet of page.facetas||[])if(!byKey.has(facet.chave))byKey.set(facet.chave,{chave:facet.chave,nome:facet.nome,total:Number(facet.total)||0});else byKey.get(facet.chave).total+=Number(facet.total)||0;
          const facets=[...byKey.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')||a.chave.localeCompare(b.chave));
          select.replaceChildren(option('Todas as tags',''),...facets.map(f=>option(`${f.nome} (${number(f.total)})`,f.chave)));
          value=facets.some(f=>f.chave===previous)?previous:'';select.value=value;
          status.textContent=facets.length?`${number(facets.length)} tags disponíveis`:'Nenhuma tag neste recorte';
          if(notify&&value!==previous)await onChange(value);
          return true;
        }catch(error){if(request!==revision)return false;select.replaceChildren(option('Todas as tags',''));value='';status.textContent='Não foi possível atualizar as tags.';throw error;}
      }
    };
    select.onchange=()=>run(async()=>{control.invalidate();value=select.value;await onChange(value);},select);
    return control;
  }
  window.criarFiltroTags=criarFiltroTags;

  const panel=element('section',null,'panel commands-panel');panel.id='commands-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','memory-mode-commands');panel.tabIndex=0;
  const head=element('div',null,'panel-title'),heading=element('h2','Comandos do WhatsApp');heading.id='commands-heading';heading.tabIndex=-1;
  const help=element('button','Como usar','secondary');help.type='button';head.append(heading,help);
  const intro=element('p','O Lume organiza somente comandos enviados por você. Nenhum deles responde ou reage no WhatsApp.','muted');
  const laboratorio=element('details',null,'labels-lab'),laboratorioTitulo=element('summary'),experimental=element('span','Experimental','pill'),laboratorioNome=element('span','Laboratório de labels');laboratorioTitulo.append(laboratorioNome,experimental);
  const laboratorioTexto=element('p','O Lume registra eventos vistos depois da ativação. Ele não consulta uma lista histórica nem confirma o estado atual no telefone.','muted');
  const leituraLabel=element('label',null,'check labels-read-choice'),leitura=element('input'),leituraTexto=element('span','Observar eventos da conta desktop atual');leitura.type='checkbox';leitura.id='whatsapp-labels-read';leituraLabel.append(leitura,leituraTexto);
  const laboratorioMeta=element('div',null,'labels-lab-meta'),laboratorioEstado=element('strong','Leitura desligada'),laboratorioConta=element('span','Conta indisponível','muted');laboratorioEstado.id='whatsapp-labels-state';laboratorioConta.id='whatsapp-labels-account';laboratorioMeta.append(laboratorioEstado,laboratorioConta);
  const laboratorioLista=element('div',null,'labels-observed');laboratorioLista.id='whatsapp-labels-observed';laboratorioLista.setAttribute('aria-live','polite');laboratorio.append(laboratorioTitulo,laboratorioTexto,leituraLabel,laboratorioMeta,laboratorioLista);
  const filters=element('div',null,'command-filters'),type=element('select');type.id='commands-type';
  for(const [value,text] of [['','Todos os tipos'],['tarefa','Tarefas'],['lembrete','Lembretes'],['cliente','Clientes'],['tag','Tags'],['ajuda','Ajuda'],['desconhecido','Não reconhecidos']]){const o=element('option',text);o.value=value;type.append(o);}
  const typeLabel=element('label','Tipo');typeLabel.htmlFor=type.id;typeLabel.append(type);filters.append(typeLabel);
  const list=element('div',null,'command-list');list.id='commands-list';list.setAttribute('aria-live','polite');
  const footer=element('div',null,'tasks-pagination'),count=element('p','Atualize para consultar os comandos.','muted'),more=element('button','Carregar mais','secondary');more.type='button';more.hidden=true;footer.append(count,more);
  panel.append(head,intro,laboratorio,filters,list,footer);$('search-form').before(panel);

  const dialog=element('dialog',null,'command-help');dialog.id='commands-help';dialog.setAttribute('aria-labelledby','commands-help-title');
  const close=element('button','Fechar','secondary dialog-close');close.type='button';
  dialog.append(close);
  const helpTitle=element('h2','Comandos disponíveis');helpTitle.id='commands-help-title';dialog.append(helpTitle,element('p','Use uma ação por mensagem. O resultado aparece somente dentro do Lume.','muted'));
  const examples=element('ul',null,'command-examples');
  for(const text of ['#lume_tarefa Revisar contrato #cliente','#lume_lembrete amanhã 09:00 | Ligar para Ana #cliente','#lume_cliente #proposta','#lume_tag prioridade','#lume_ajuda'])examples.append(element('li',text));
  dialog.append(examples);document.body.append(dialog);
  let helpReturn=null;help.onclick=()=>{helpReturn=help;dialog.showModal();close.focus();};close.onclick=()=>dialog.close();dialog.addEventListener('cancel',e=>{e.preventDefault();dialog.close();});dialog.addEventListener('close',()=>helpReturn?.focus());

  const labels={feito:'Feito',revisar:'Precisa revisar',nao_reconhecido:'Não reconhecido',nao_executado:'Não reconhecido',origem_removida:'Origem removida'};
  const reasons={
    autor_nao_autorizado:'Ignorado porque não foi enviado por você',
    eco_do_aplicativo:'Ignorado porque veio do próprio aplicativo',
    comando_desconhecido:'Este comando não faz parte da lista disponível',
    origem_removida:'A mensagem de origem não está mais disponível',
    origem_editada:'A mensagem de origem mudou; confira antes de continuar'
  };
  const safeReason=command=>reasons[command.motivo]||({feito:'Ação organizada no Lume',revisar:'Confira os dados antes de continuar',nao_reconhecido:'Comando não reconhecido',nao_executado:'Comando ignorado com segurança',origem_removida:'A origem foi removida'}[command.estado]||'Confira este registro');
  let revision=0,cursor=null,total=0,busy=false;
  let labelsRevision=0;
  function limparLabels(){labelsRevision++;leitura.checked=false;leitura.disabled=true;laboratorioEstado.textContent='Leitura desligada';laboratorioConta.textContent='Conta indisponível';laboratorioLista.replaceChildren();}
  const apiSemMonitorDeConexao=api;
  window.api=async(path,body)=>{
    const data=await apiSemMonitorDeConexao(path,body);
    if(path==='/api/desconectar'||path==='/api/estado'&&data?.conexao?.estado!=='conectada')limparLabels();
    return data;
  };
  function mostrarLabels(data){
    leitura.checked=Boolean(data.leitura);leitura.disabled=!data.disponivel;laboratorioEstado.textContent=data.estado==='Conflito para revisar'?'Conflito para revisar':data.leitura?'Leitura observada':'Leitura desligada';laboratorioConta.textContent=data.contaMascarada?'Conta '+data.contaMascarada:'Conta indisponível';laboratorioLista.replaceChildren();
    if(!data.leitura)return;
    const nomes=new Map((data.labels||[]).map(label=>[label.id,label.nome]));
    if(!(data.associacoes||[]).length){laboratorioLista.append(element('p','Nenhum evento visível no seu recorte de leitura.','muted'));return;}
    for(const associacao of data.associacoes){const card=element('article',null,'labels-observed-card');card.append(element('span',associacao.estado,'command-state'),element('b',nomes.get(associacao.labelId)||'Label observada'),element('span',associacao.conversa),element('small',associacao.escopo));laboratorioLista.append(card);}
  }
  async function carregarLabels(){
    const request=++labelsRevision,dataRevision=revisaoDadosVisiveis;
    try{const data=await api('/api/v3/whatsapp-labels');if(request!==labelsRevision||dataRevision!==revisaoDadosVisiveis)return;mostrarLabels(data);}
    catch(error){if(request!==labelsRevision)return;limparLabels();throw error;}
  }
  leitura.onchange=()=>run(async()=>{const escolhida=leitura.checked,request=++labelsRevision,dataRevision=revisaoDadosVisiveis;if(!escolhida){laboratorioLista.replaceChildren();laboratorioEstado.textContent='Leitura desligada';}let data;try{data=await api('/api/v3/whatsapp-labels',{leitura:escolhida});}catch(error){if(request===labelsRevision)limparLabels();throw error;}if(request!==labelsRevision||dataRevision!==revisaoDadosVisiveis)return;mostrarLabels(data);},leitura);
  laboratorio.ontoggle=()=>{if(laboratorio.open)run(carregarLabels);else labelsRevision++;};
  setInterval(()=>{if(laboratorio.open&&!document.hidden)run(carregarLabels);},6000);
  window.carregarWhatsAppLabels=carregarLabels;window.limparWhatsAppLabels=limparLabels;
  function card(command){
    const item=element('article',null,'command-card');item.dataset.command=String(command.id);
    const badge=element('span',labels[command.estado]||'Não reconhecido','command-state command-state-'+(labels[command.estado]?'known':'unknown'));
    item.append(badge,element('h3',command.comando||'#lume'),element('p',safeReason(command)),element('small',`${command.tipo||'comando'} · ${date(command.criadoEm)}`));
    if(command.tags?.length){const tags=element('div',null,'command-tags');for(const tag of command.tags)tags.append(element('span','#'+tag.nome));item.append(tags);}
    item.append(action('Abrir origem',()=>window.abrirFonteComando(command.eventoId),'secondary'));return item;
  }
  window.abrirFonteComando=async id=>{
    const dataRevision=revisaoDadosVisiveis,request=revision,navigation=window.revisaoNavegacaoAtual?.()??0,memoryMode=window.revisaoModoMemoriaAtual?.()??0,found=await api('/api/v3/fonte?id='+encodeURIComponent(id));
    if(dataRevision!==revisaoDadosVisiveis||request!==revision||navigation!==(window.revisaoNavegacaoAtual?.()??0)||memoryMode!==(window.revisaoModoMemoriaAtual?.()??0))return;
    const showTicket=await show('memory');
    if(dataRevision!==revisaoDadosVisiveis||window.paginaAtual?.()!=='memory'||(window.revisaoNavegacaoAtual?.()??0)!==showTicket)return;
    window.lumeSetMemoryMode?.('search');
    if(window.paginaAtual?.()!=='memory')return;
    revisaoBusca++;$('results').replaceChildren(source(found));$('more').hidden=true;$('search-context').textContent='Fonte '+found.origem_id+' · '+found.conversa_nome;$('results').focus();
  };
  window.carregarComandos=async({append=false}={})=>{
    if(busy)return;busy=true;const request=++revision,dataRevision=revisaoDadosVisiveis,currentType=type.value;
    if(!append){cursor=null;list.replaceChildren(element('p','Carregando comandos…','muted'));}
    try{
      const params=new URLSearchParams({limite:'20'});if(currentType)params.set('tipo',currentType);if(append&&cursor)params.set('cursor',cursor);
      const page=await api('/api/v3/comandos?'+params);if(request!==revision||dataRevision!==revisaoDadosVisiveis||currentType!==type.value)return;
      if(!append)list.replaceChildren();if(!page.comandos.length&&!append)empty(list,'Nenhum comando neste recorte.','Envie um dos cinco comandos pelo seu próprio WhatsApp para começar.');else list.append(...page.comandos.map(card));
      total=page.total;cursor=page.proximoCursor;count.textContent=`${number(list.querySelectorAll('.command-card').length)} de ${number(total)} comandos`;more.hidden=!cursor;
    }catch(error){if(request!==revision)return;list.replaceChildren(element('p',error.message),action('Tentar novamente',async()=>{await window.carregarComandos();heading.focus();},'secondary'));count.textContent='Não foi possível atualizar os comandos.';more.hidden=true;throw error;}
    finally{if(request===revision)busy=false;}
  };
  window.limparComandos=()=>{revision++;busy=false;cursor=null;list.replaceChildren();count.textContent='Atualize para consultar os comandos.';more.hidden=true;};
  type.onchange=()=>{window.limparComandos();run(()=>window.carregarComandos(),type);};more.onclick=()=>run(()=>window.carregarComandos({append:true}),more);
  window.configurarFiltroHoje?.();if(token)run(()=>window.recarregarFiltroHoje?.());
  addEventListener('DOMContentLoaded',()=>{const previous=window.limparDadosVisiveis;window.limparDadosVisiveis=(...args)=>{window.limparComandos();limparLabels();window.limparLembretesComandos?.();previous?.(...args);};},{once:true});
})();
