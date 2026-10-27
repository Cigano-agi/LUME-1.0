(() => {
  const box=element('section',null,'conversation-workspace');
  box.innerHTML=`<section id="conversation-directory" aria-labelledby="conversation-directory-title"><div class="conversation-directory-head"><div><p class="eyebrow">CONVERSAS</p><h2 id="conversation-directory-title" tabindex="-1">Todas as conversas</h2></div><p id="conversation-result-count" class="conversation-result-count" role="status" aria-live="polite">Consultando…</p></div><form id="conversation-filters" class="conversation-filters"><label>Buscar<input id="conversation-name" maxlength="200" placeholder="Pessoa ou grupo"></label><label>Mostrar<select id="conversation-filter"><option value="todas">Todas</option><option value="acoes">Com próximos passos</option><option value="oportunidades">Com oportunidades</option></select></label><div id="conversation-tag-filter"></div><button class="secondary">Aplicar</button></form><div class="conversation-list-head" aria-hidden="true"><span>Conversa</span><span>O que apareceu</span><span>Última atividade</span><span></span></div><div id="conversation-list" class="conversation-list"></div><div id="conversation-pages" class="tasks-pagination conversation-pagination"></div></section><section id="conversation-detail" hidden aria-label="Resumo da conversa"></section>`;
  $('search-form').before(box);
  let revision=0,listPage=1,actionPage=1,personPage=1,current='';
  const tagFilter=window.criarFiltroTags({id:'conversation-tag',label:'Tag',tipos:['conversa'],target:$('conversation-tag-filter'),onChange:async()=>{listPage=1;await window.carregarConversas();}});
  const type={lead:'Oportunidade',compromisso:'Compromisso',pendencia:'Pendência',decisao:'Decisão'};

  function pagination(target,p,move,label){
    const unit=p.total===1?({conversas:'conversa','ações':'ação',pessoas:'pessoa'}[label]||label):label;
    target.replaceChildren(element('p',`${number(p.total)} ${unit} · página ${p.numero} de ${p.paginas}`,'muted'));
    if(p.paginas<=1)return;
    const row=element('div',null,'button-row'),before=action('Anterior',()=>move(p.numero-1),'secondary'),after=action('Próxima',()=>move(p.numero+1),'secondary');
    before.disabled=p.numero<=1;after.disabled=p.numero>=p.paginas;
    before.setAttribute('aria-label','Página anterior de '+label);after.setAttribute('aria-label','Próxima página de '+label);
    row.append(before,after);target.append(row);
  }

  function loading(target,kind='lista'){
    const status=element('p',kind==='detalhe'?'Abrindo conversa…':'Carregando conversas…','conversation-state conversation-loading');status.setAttribute('role','status');
    target.replaceChildren(status);
    if(kind==='lista')for(let i=0;i<3;i++){const row=element('div',null,'conversation-row conversation-skeleton');row.setAttribute('aria-hidden','true');row.append(element('span'),element('span'),element('span'));target.append(row);}
  }

  function errorState(target,error,retry){
    const state=element('div',null,'conversation-state conversation-error');state.setAttribute('role','alert');
    state.append(element('h3','Não foi possível carregar'),element('p',error.message||'Tente novamente em alguns instantes.'),action('Tentar novamente',retry,'secondary'));
    target.replaceChildren(state);
  }

  function emptyState(title,description){
    const state=element('div',null,'conversation-state conversation-empty');state.append(element('h3',title),element('p',description));return state;
  }

  function history(conversaId){
    const detail=element('details',null,'conversation-history');detail.append(element('summary','Recuperar contexto da conversa'));
    const content=element('div');detail.append(content);let historyRevision=0;
    async function refresh(){
      const request=++historyRevision,dataRevision=revisaoDadosVisiveis;
      content.replaceChildren(element('p','Conferindo o histórico disponível…','muted'));
      const valid=()=>request===historyRevision&&dataRevision===revisaoDadosVisiveis&&detail.isConnected;
      try{
        const [historicoResult,coberturaResult]=await Promise.allSettled([
          api('/api/v3/historico?'+new URLSearchParams({conversa_id:conversaId})),
          api('/api/v3/conversas/cobertura-midia?'+new URLSearchParams({conversa:conversaId}))
        ]);if(!valid())return;
        content.replaceChildren();
        const media=element('section',null,'history-media-coverage');media.append(element('h4','Mídia desta conversa'));
        if(coberturaResult.status==='fulfilled'){
          const c=coberturaResult.value.cobertura;
          const qtd=(n,singular,plural)=>`${number(n)} ${n===1?singular:plural}`;
          media.append(element('p',`${qtd(c.recebidas,'mídia registrada','mídias registradas')} · ${qtd(c.pendentes,'pendente','pendentes')} · ${number(c.emCurso)} em curso · ${number(c.falhas)} aguardando nova tentativa`,'history-coverage'));
          media.append(element('p',`${number(c.indisponiveis)} indisponíveis · ${number(c.esgotadas)} tentativas esgotadas · ${qtd(c.bloqueadas,'bloqueada','bloqueadas')} · ${number(c.desconhecidas)} sem estado conhecido`,'muted'));
          if(c.bloqueadas>0)media.append(element('p','Há arquivos que precisam de conferência manual. PDFs, documentos, imagens, vídeos e figurinhas ainda não são baixados nem lidos pelo Lume. Consulte o original no WhatsApp; para usar o conteúdo aqui, envie os trechos relevantes como texto.','history-media-guidance'));
          media.append(element('p','O registro de uma mídia não comprova que o arquivo foi baixado. A cobertura do histórico anterior continua desconhecida.','muted'));
        }else media.append(element('p','Não foi possível conferir a mídia agora. A cobertura do histórico anterior continua desconhecida.','muted'));
        content.append(media);
        if(historicoResult.status==='rejected'){
          content.append(element('p','Recuperação indisponível: '+historicoResult.reason.message,'muted'),action('Conferir novamente',refresh,'secondary'));
          return;
        }
        const {historico}=historicoResult.value;
        content.append(element('p',`${number(historico.armazenado?.mensagens||0)} mensagens guardadas · cobertura desconhecida`,'history-coverage'),element('p',historico.aviso,'muted'));
        if(historico.armazenado?.primeira_em)content.append(element('p',`No computador: de ${date(historico.armazenado.primeira_em)} a ${date(historico.armazenado.ultima_em)}.`,'muted'));
        const controls=element('div',null,'button-row');
        for(const [mode,label]of [['retomar','Recuperar contexto'],['anteriores','Buscar anteriores']])controls.append(action(label,async()=>{
          for(const button of controls.querySelectorAll('button'))button.disabled=true;
          try{const {recuperacao}=await api('/api/v3/historico/recuperar',{conversa_id:conversaId,modo:mode});if(!valid())return;await refresh();const receipt=element('p','Pedido registrado · aguardando histórico. '+recuperacao.aviso,'history-receipt');receipt.setAttribute('role','status');content.prepend(receipt);}
          catch(error){if(valid()){const errorNode=element('p',error.message,'history-error');errorNode.setAttribute('role','alert');content.append(errorNode);}}
          finally{if(valid())for(const button of controls.querySelectorAll('button'))button.disabled=false;}
        },'secondary'));
        controls.append(action('Atualizar estado',refresh,'text-button'));content.append(controls);
        for(const attempt of historico.tentativas||[]){const label={aguardando_historico:'Aguardando histórico',solicitando:'Solicitando',falhou:'Pedido não concluído',interrompida:'Pedido interrompido'}[attempt.estado]||'Estado não confirmado';content.append(element('p',`${label} · ${date(attempt.atualizado_em||attempt.pedido_em)}`,'muted'));}
      }catch(error){if(valid())content.replaceChildren(element('p','Recuperação indisponível: '+error.message,'muted'),element('p','As mensagens já guardadas continuam disponíveis.','muted'),action('Conferir novamente',refresh,'secondary'));}
    }
    detail.addEventListener('toggle',()=>{if(detail.open)void refresh();});return detail;
  }

  async function showSource(id,target,captured){
    target.replaceChildren();target.hidden=false;
    try{const value=await api('/api/v3/fonte?id='+id);if(captured!==revision)return;target.replaceChildren(source(value));target.tabIndex=-1;target.focus();}
    catch(e){if(captured!==revision)return;errorState(target,e,()=>showSource(id,target,captured));}
  }

  window.carregarConversas=async()=>{
    const captured=++revision,dataRevision=revisaoDadosVisiveis,selected=conversa;
    if(selected!==current){current=selected;actionPage=1;personPage=1;}
    const valid=()=>captured===revision&&dataRevision===revisaoDadosVisiveis&&selected===conversa;
    $('conversation-directory').hidden=Boolean(selected);$('conversation-detail').hidden=!selected;
    const target=selected?$('conversation-detail'):$('conversation-list');loading(target,selected?'detalhe':'lista');target.setAttribute('aria-busy','true');
    $('conversation-pages').replaceChildren();
    if(!selected)$('conversation-result-count').textContent='Consultando…';
    try{
      if(!selected)await tagFilter.load({notify:false});if(!valid())return;
      const params=new URLSearchParams(selected?{conversa:selected,paginaAcoes:actionPage,paginaPessoas:personPage}:{q:$('conversation-name').value,filtro:$('conversation-filter').value,pagina:listPage,...(tagFilter.value?{tag:tagFilter.value}:{})});
      const data=await api('/api/v3/conversas/'+(selected?'detalhe?':'resumo?')+params);
      if(!valid())return;
      target.replaceChildren();
      if(!selected){
        listPage=data.pagina.numero;
        $('conversation-result-count').textContent=`${number(data.pagina.total)} ${data.pagina.total===1?'conversa':'conversas'}`;
        if(!data.conversas.length){
          const filtrada=$('conversation-name').value.trim()||$('conversation-filter').value!=='todas'||tagFilter.value;
          target.replaceChildren(filtrada
            ? emptyState('Nenhuma conversa neste filtro.','Tente outro nome, sinal ou tag.')
            : emptyState('Nenhuma conversa chegou ainda.','Confira se o WhatsApp está conectado e deixe o Lume aberto para receber novas mensagens.'));
        }
        for(const c of data.conversas){
          const row=element('article',null,'conversation-row conversation-card');row.setAttribute('aria-label',c.nome);
          const primary=element('div',null,'conversation-primary'),title=element('h3',c.nome),context=element('p',`${number(c.mensagens)} ${c.mensagens===1?'mensagem':'mensagens'} · ${number(c.pessoas)} ${c.pessoas===1?'pessoa':'pessoas'}`,'conversation-context');title.title=c.nome;primary.append(title,context);
          const signals=element('div',null,'conversation-signals');
          if(c.acoes)signals.append(element('span',`${number(c.acoes)} ${c.acoes===1?'ação':'ações'}`,'conversation-signal conversation-signal-action'));
          if(c.oportunidades)signals.append(element('span',`${number(c.oportunidades)} ${c.oportunidades===1?'oportunidade':'oportunidades'}`,'conversation-signal conversation-signal-opportunity'));
          if(!c.acoes&&!c.oportunidades)signals.append(element('span','Sem ação aberta','conversation-quiet'));
          const time=element('time',date(c.ultimaMensagemEm),'conversation-time');if(c.ultimaMensagemEm)time.dateTime=c.ultimaMensagemEm;
          const open=action('Abrir conversa',async()=>{await openConversation(c.id,c.nome);$('conversation-heading')?.focus();},'text-button conversation-open');
          row.append(primary,signals,time,open);target.append(row);
        }
        pagination($('conversation-pages'),data.pagina,async n=>{listPage=n;await window.carregarConversas();$('conversation-directory-title').focus();},'conversas');
      }else{
        actionPage=data.paginaAcoes.numero;personPage=data.paginaPessoas.numero;
        const heading=element('h2',data.nome);heading.id='conversation-heading';heading.tabIndex=-1;heading.title=data.nome;
        const back=action('Voltar à lista',async()=>{conversa='';$('search').value='';$('clear-filter').hidden=true;$('search-context').textContent='Todas as conversas permitidas · busca textual local';await show('memory');},'text-button conversation-back');back.setAttribute('aria-label','Voltar à lista');
        const head=element('header',null,'conversation-detail-head');head.append(back,heading);
        const summary=element('dl',null,'conversation-summary');
        for(const [value,label]of [[data.mensagens,'mensagens'],[data.acoes,'ações abertas'],[data.oportunidades,'oportunidades']]){const item=element('div');item.append(element('dt',label),element('dd',number(value)));summary.append(item);}
        const last=element('p','Última atividade: '+date(data.ultimaMensagemEm),'conversation-detail-time');
        target.append(head,summary,last);
        target.append(history(selected));

        const agreements=element('section',null,'conversation-agreements');target.append(agreements);
        await window.carregarCombinadosDaConversa?.(selected,agreements,{total:data.acoes06});
        if(!valid())return;

        const columns=element('div',null,'conversation-columns'),tasks=element('section',null,'conversation-section conversation-tasks'),people=element('section',null,'conversation-section conversation-people');
        const taskHead=element('div',null,'conversation-section-head'),order=element('details',null,'conversation-order'),orderTitle=element('summary','Como a lista é organizada');order.append(orderTitle,element('p',data.ordem,'muted'));taskHead.append(element('h3',data.acoes06?'Outras ações registradas':'Ações'),order);tasks.append(taskHead);
        if(data.acoes06&&data.tarefas.length)tasks.append(element('p','Registros preservados com suas próprias fontes.','muted'));
        if(!data.tarefas.length)tasks.append(emptyState('Nenhuma ação aberta.','Novas ações aparecem quando forem detectadas nas mensagens permitidas.'));
        for(const task of data.tarefas){
          const row=element('article',null,'conversation-action'),proof=element('div',null,'conversation-proof'),actionType=Object.hasOwn(type,task.tipo)?task.tipo:'acao';proof.hidden=true;row.dataset.actionType=actionType;
          const copy=element('div',null,'conversation-action-copy');copy.append(element('span',type[task.tipo]||'Ação','action-type-label'),element('h4',task.resumo));
          const when=element('p',task.quando?'Prazo: '+task.quando:'Sem prazo registrado','conversation-action-time');
          const buttons=element('div',null,'button-row');buttons.append(action('Ver origem',()=>showSource(task.evento_id,proof,captured)),action('Marcar resolvido',async()=>{await api('/api/v3/resolver',{id:task.id});if(!valid())return;await window.carregarConversas();feedback('Ação marcada como resolvida.');},'secondary'));
          row.append(copy,when,buttons,proof);tasks.append(row);
        }
        const taskPages=element('div',null,'tasks-pagination');tasks.append(taskPages);
        pagination(taskPages,data.paginaAcoes,async n=>{actionPage=n;await window.carregarConversas();$('conversation-heading')?.focus();},'ações');

        const peopleHead=element('div',null,'conversation-section-head');peopleHead.append(element('h3','Pessoas'),element('p','Autores nas mensagens que você pode ler.','muted'));people.append(peopleHead);
        if(!data.pessoas.length)people.append(emptyState('Nenhuma pessoa identificada.','Os nomes aparecem conforme as mensagens permitidas chegam.'));
        for(const person of data.pessoas){
          const row=element('article',null,'conversation-person'),proof=element('div',null,'conversation-proof');proof.hidden=true;
          const copy=element('div',null,'conversation-person-copy');copy.append(element('b',person.nome),element('small',`${number(person.mensagens)} ${person.mensagens===1?'mensagem':'mensagens'}`));
          const identity=element('details');identity.append(element('summary','Identificação'),element('code',person.id));
          row.append(copy,identity,action('Ver mensagem',()=>showSource(person.fonte_id,proof,captured),'text-button'),proof);people.append(row);
        }
        const peoplePages=element('div',null,'tasks-pagination');people.append(peoplePages);
        pagination(peoplePages,data.paginaPessoas,async n=>{personPage=n;await window.carregarConversas();$('conversation-heading')?.focus();},'pessoas');
        // A lista legada tem paginação própria. Não mostrar um vazio contraditório
        // quando os próximos passos já estão nas fichas atuais acima.
        if(data.tarefas.length||!data.acoes06)columns.append(tasks);
        columns.append(people);target.append(columns);window.lumeReveal?.(head);
      }
    }catch(e){
      if(!valid())return;
      if(!selected)$('conversation-result-count').textContent='Falha ao atualizar';
      errorState(target,e,()=>window.carregarConversas());
    }finally{if(valid())target.setAttribute('aria-busy','false');}
  };

  window.limparConversas=()=>{revision++;tagFilter.invalidate();current='';listPage=1;actionPage=1;personPage=1;for(const id of ['conversation-list','conversation-pages','conversation-detail'])$(id).replaceChildren();$('conversation-result-count').textContent='Atualize para consultar';conversa='';$('clear-filter').hidden=true;$('search-context').textContent='Atualize para consultar as conversas permitidas.';};
  $('conversation-filters').onsubmit=e=>{e.preventDefault();listPage=1;run(async()=>{await window.carregarConversas();$('conversation-directory-title').focus();},e.submitter);};
})();
