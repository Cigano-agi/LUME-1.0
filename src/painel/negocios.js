(() => {
  const etapas={interesse:'Interesse',proposta:'Proposta',conversa:'Conversa em andamento',fechado:'Fechado',encerrado:'Encerrado'};
  const money=v=>v===null?'Valor não informado':new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v/100);
  const day=v=>v?v.split('-').reverse().join('/'):'Sem data marcada';
  const slots={};let opening=0,preview=null,businessTagFilter=null;
  for(const [id,title]of [['memory','Seus negócios'],['today','Negócios']]){
    const box=element('section',null,'panel negocio-panel');box.id='negocios-'+id;
    const header=element('div',null,'conversation-detail-head');header.append(element('h2',title));
    const filter=element('select');filter.setAttribute('aria-label','Etapa dos negócios');
    for(const [v,n]of Object.entries({todas:'Todas as etapas',...etapas})){const o=element('option',n);o.value=v;filter.append(o);}
    if(id==='memory')header.append(filter);
    const list=element('div',null,'negocio-list'),pages=element('div',null,'tasks-pagination');
    box.append(header,element('p',id==='today'?'Datas que você marcou, em ordem. O Lume não envia mensagens por você.':'Acompanhe uma mensagem para organizar a venda. Etapas e valores são conferidos por você.','muted'),list,pages);
    if(id==='today')$('today').querySelector('.content-grid').after(box);else{const shell=element('section',null,'business-memory-shell');shell.id='negocios-memory-shell';const tagSlot=element('div');tagSlot.id='business-tag-filter';shell.append(tagSlot,box);$('search-form').before(shell);businessTagFilter=window.criarFiltroTags({id:'business-tag',label:'Filtrar negócios por tag',tipos:['negocio'],target:tagSlot,onChange:async()=>{slots.memory.page=1;await load('memory');}});}
    slots[id]={box,filter,list,pages,page:1,reviewPage:1,rev:0,conversa:''};
    filter.onchange=()=>{slots[id].page=1;run(()=>load(id));};
  }
  const dialog=element('dialog',null,'negocio-dialog');dialog.id='negocio-dialog';dialog.setAttribute('aria-labelledby','negocio-heading');document.body.append(dialog);
  function field(form,text,node){const label=element('label',text);label.append(node);form.append(label);return node;}
  window.abrirNegocio=async fonte=>{
    const request=++opening,dataRevision=revisaoDadosVisiveis;
    preview=null;dialog.replaceChildren(element('p','Abrindo a mensagem…'),action('Cancelar',()=>dialog.close(),'secondary'));
    if(!dialog.open)dialog.showModal();
    const valid=()=>request===opening&&dataRevision===revisaoDadosVisiveis&&dialog.open;
    try{
      const p=await api('/api/v3/negocios/preparar',{fonte});if(!valid())return;preview=p;
      dialog.replaceChildren();const heading=element('h2',p.revisar?'Confira novamente':p.negocio?'Rever negócio':'Acompanhar negócio');heading.id='negocio-heading';
      dialog.append(action('Cancelar',()=>dialog.close(),'secondary dialog-close'),heading,element('p','Uma mensagem como ponto de partida. Confira a conversa antes de registrar um acordo.','muted'));
      const proof=source(p.mensagem);proof.querySelector('.source-actions')?.remove();dialog.append(proof);
      if(p.revisar)dialog.append(element('p','A mensagem mudou. Os dados antigos foram ocultados. Ao salvar, você recomeça este registro e substitui o histórico anterior.','negocio-warning'));
      const form=element('form'),name=element('input');name.id='negocio-title';name.required=true;name.maxLength=160;name.value=p.negocio?.titulo||'';name.placeholder='Ex.: Site da Ana';field(form,'Nome do negócio',name);
      const stage=element('select');stage.id='negocio-stage';for(const [v,n]of Object.entries(etapas)){const o=element('option',n);o.value=v;stage.append(o);}stage.value=p.negocio?.etapa||'interesse';field(form,'Etapa',stage);
      const amount=element('input');amount.id='negocio-value';amount.inputMode='decimal';amount.placeholder='Ex.: 2.500,00';amount.value=p.negocio?.valor_centavos==null?'':(p.negocio.valor_centavos/100).toFixed(2).replace('.',',');field(form,'Valor em reais · opcional',amount);
      const when=element('input');when.id='negocio-date';when.type='date';when.min='2000-01-01';when.max='2100-12-31';when.value=p.negocio?.proximo_contato||'';field(form,'Próximo contato · opcional',when);
      form.append(element('p','Deixe valor e data vazios se ainda não souber. “Fechado” significa acordo registrado por você; não confirma pagamento. Para fechar ou encerrar, retire a data do próximo contato.','muted'));
      const confirmed=element('input');confirmed.type='checkbox';confirmed.id='negocio-confirm';confirmed.required=true;const consent=element('label',null,'check');consent.append(confirmed,document.createTextNode(p.revisar?'Conferi a mensagem e quero recomeçar este registro.':'Conferi a mensagem e os dados deste negócio.'));form.append(consent);
      const error=element('p');error.id='negocio-error';error.setAttribute('role','alert');const save=element('button','Salvar negócio');save.type='submit';form.append(error,save);dialog.append(form);
      if(p.historico.length){const history=element('details');history.append(element('summary',`Alterações confirmadas · ${p.historico.length} de ${p.historicoTotal}`));for(const h of p.historico){const entry=element('p',`${date(h.confirmado_em)} · ${h.titulo} · ${etapas[h.etapa]} · ${money(h.valor_centavos)} · ${day(h.proximo_contato)}`);history.append(entry);}dialog.append(history);}
      form.onsubmit=async e=>{
        e.preventDefault();if(!valid()||!preview)return;error.textContent='';save.disabled=true;
        try{
          const raw=amount.value.trim();if(raw&&!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(raw))throw Error('Use um valor como 2.500,00 ou deixe vazio.');
          const cents=raw?Math.round(Number(raw.replaceAll('.','').replace(',','.'))*100):null;
          await api('/api/v3/negocios/salvar',{previa:p.id,confirmar:confirmed.checked,revisar:p.revisar,titulo:name.value,etapa:stage.value,valor_centavos:cents,proximo_contato:when.value||null});
          if(!valid())return;dialog.close();feedback('Negócio salvo.');await window.carregarNegocios?.(page);await window.carregarClareza?.();if(page==='memory')await window.carregarContatos?.();
        }catch(e){if(valid())error.textContent=e.message;}finally{if(valid())save.disabled=false;}
      };
      name.focus();
    }catch(e){if(valid())dialog.replaceChildren(element('h2','Não consegui abrir o negócio'),element('p',e.message),action('Tentar novamente',()=>window.abrirNegocio(fonte),'secondary'),action('Cancelar',()=>dialog.close(),'secondary'));}
  };
  dialog.addEventListener('close',()=>{opening++;preview=null;dialog.replaceChildren();});
  async function load(id){
    const s=slots[id];if(!s)return;
    const selected=id==='memory'?conversa:'',rev=++s.rev,dataRevision=revisaoDadosVisiveis;
    if(s.conversa!==selected){s.page=1;s.reviewPage=1;s.conversa=selected;}
    const valid=()=>rev===s.rev&&dataRevision===revisaoDadosVisiveis&&(id!=='memory'||selected===conversa);
    s.list.replaceChildren(element('p','Carregando negócios…','muted'));s.pages.replaceChildren();s.box.setAttribute('aria-busy','true');
    try{
      if(id==='memory')await businessTagFilter.load({notify:false});if(!valid())return;
      const selectedTag=id==='memory'?businessTagFilter.value:(window.tagHojeAtual?.()||'');
      const q=new URLSearchParams({conversa:selected,etapa:id==='memory'?s.filter.value:'todas',pagina:s.page,paginaRevisoes:s.reviewPage,contatos:id==='today',...(selectedTag?{tag:selectedTag}:{})});
      const d=await api('/api/v3/negocios?'+q);if(!valid())return;s.page=d.pagina.numero;s.reviewPage=d.paginaRevisoes.numero;s.list.replaceChildren();
      if(!d.negocios.length)empty(s.list,id==='today'?'Nenhum contato marcado.':'Nenhum negócio neste filtro.',id==='today'?'Ao rever um negócio, escolha a data para falar com a pessoa.':'Na mensagem de origem, escolha “Acompanhar negócio”.');
      const columns=new Map();
      if(id==='memory'&&d.negocios.length){
        const pipeline=element('div',null,'sales-pipeline');pipeline.setAttribute('aria-label','Pipeline · negócios desta página');
        for(const [stage,label]of Object.entries(etapas)){
          if(s.filter.value!=='todas'&&s.filter.value!==stage)continue;
          const column=element('section',null,'sales-column');column.append(element('h3',label));
          if(!d.negocios.some(n=>n.etapa===stage))column.append(element('p','Nenhum nesta página.','muted'));
          columns.set(stage,column);pipeline.append(column);
        }
        s.list.append(pipeline);
      }
      for(const n of d.negocios){
        const card=element('article',null,'negocio-card'),tag=element('span',etapas[n.etapa],'negocio-stage');
        const when=n.proximo_contato?`${n.proximo_contato<d.hoje?'Data passou':n.proximo_contato===d.hoje?'Hoje':'Próximo contato'} · ${day(n.proximo_contato)}`:'Sem data marcada';
        card.append(tag,element('h3',n.titulo),element('p',money(n.valor_centavos)),element('p',when,'muted'),action('Rever negócio',()=>window.abrirNegocio(n.evento_id),'secondary'));
        if(id==='memory'){
          const evaluation=element('div',null,'sales-temperature');evaluation.append(element('span','Interesse ainda não avaliado','sales-temperature-label'),action('Conferir interesse',()=>window.abrirAvaliacaoVenda(n.conversa_id,n.titulo),'text-button'));card.append(evaluation);
          void api('/api/v3/vendas/avaliacao?'+new URLSearchParams({conversa_id:n.conversa_id})).then(({avaliacao})=>{
            if(!valid()||!card.isConnected)return;
            const temp=avaliacao?.desatualizada?'insuficiente':avaliacao?.temperatura;const labels={frio:'Frio',morno:'Morno',quente:'Quente',insuficiente:'Informação insuficiente'};
            evaluation.dataset.temperature=temp||'insuficiente';evaluation.querySelector('span').textContent=temp?labels[temp]||'Informação insuficiente':'Interesse ainda não avaliado';
            if(avaliacaoComercialIncerta(avaliacao)&&!avaliacao.desatualizada){evaluation.dataset.temperature='insuficiente';evaluation.querySelector('span').textContent='Revisão necessária';}
            if(avaliacao)evaluation.append(element('small',(avaliacao.desatualizada?'Contexto mudou':avaliacao.origem==='manual'?'Avaliação sua':'Avaliação Jev')+' · '+date(avaliacao.avaliado_em)));
          }).catch(()=>{if(valid()&&card.isConnected)evaluation.querySelector('span').textContent='Avaliação indisponível';});
        }
        (columns.get(n.etapa)||s.list).append(card);
      }
      for(const r of d.revisoes){const box=element('article',null,'negocio-card negocio-warning');box.append(element('h3','A mensagem mudou'),element('p','Confira a fonte para recomeçar o registro deste negócio.'),action('Conferir novamente',()=>window.abrirNegocio(r.evento_id),'secondary'));s.list.append(box);}
      s.pages.append(element('p',`${d.pagina.total} ${id==='today'?(d.pagina.total===1?'contato marcado':'contatos marcados'):(d.pagina.total===1?'negócio':'negócios')} · página ${d.pagina.numero} de ${d.pagina.paginas}`,'muted'));
      if(d.pagina.paginas>1){const before=action('Anterior',()=>{s.page--;return load(id);},'secondary'),after=action('Próxima',()=>{s.page++;return load(id);},'secondary');before.disabled=d.pagina.numero<=1;after.disabled=d.pagina.numero>=d.pagina.paginas;before.setAttribute('aria-label','Página anterior de negócios');after.setAttribute('aria-label','Próxima página de negócios');s.pages.append(before,after);}
      if(d.paginaRevisoes.total){const r=d.paginaRevisoes;s.pages.append(element('p',`${r.total} negócios para conferir novamente · página ${r.numero} de ${r.paginas}. Inclui todas as etapas.`,'muted'));if(r.paginas>1){const before=action('Conferências anteriores',()=>{s.reviewPage--;return load(id);},'secondary'),after=action('Próximas conferências',()=>{s.reviewPage++;return load(id);},'secondary');before.disabled=r.numero<=1;after.disabled=r.numero>=r.paginas;s.pages.append(before,after);}}
    }catch(e){if(valid())s.list.replaceChildren(element('p',e.message),action('Tentar novamente',()=>load(id),'secondary'));}
    finally{if(valid())s.box.setAttribute('aria-busy','false');}
  }
  window.carregarNegocios=load;
  window.limparNegocios=()=>{opening++;businessTagFilter?.invalidate();preview=null;dialog.close();dialog.replaceChildren();for(const s of Object.values(slots)){s.rev++;s.page=1;s.reviewPage=1;s.conversa='';s.list.replaceChildren();s.pages.replaceChildren();s.box.setAttribute('aria-busy','false');}};
})();

/* Sales assessment is optional. Reading saved state never invokes Jev. */
function avaliacaoComercialIncerta(avaliacao){
  return avaliacao?.origem==='jev'&&(avaliacao.revisao==='necessaria'||[avaliacao.confianca,avaliacao.confianca_etapa].some(n=>Number.isFinite(n)&&n<.7));
}
(() => {
  const temperatures={insuficiente:'Informação insuficiente',frio:'Frio',morno:'Morno',quente:'Quente'};
  const tag=$('business-tag-filter'),filters=element('details',null,'sales-filters');tag.before(filters);filters.append(element('summary','Filtrar por tag'),tag);
  const stages={insuficiente:'Informação insuficiente',interesse:'Interesse',proposta:'Proposta',conversa:'Conversa em andamento',fechado:'Fechado',encerrado:'Encerrado'};
  const dialog=element('dialog',null,'resolver-dialog sales-dialog');dialog.id='sales-dialog';dialog.setAttribute('aria-labelledby','sales-title');document.body.append(dialog);
  let revision=0,currentConversation='',currentName='',opener=null,dataRevision=0;
  const valid=r=>r===revision&&dialog.open&&dataRevision===revisaoDadosVisiveis;
  function frame(){
    const heading=element('h2',currentName||'Interesse nas mensagens');heading.id='sales-title';heading.tabIndex=-1;
    const head=element('header',null,'resolver-heading'),copy=element('div');copy.append(element('p','VENDAS · AVALIAÇÃO DE INTERESSE','eyebrow'),heading);
    head.append(copy,action('Fechar',()=>dialog.close(),'secondary resolver-close'));const body=element('div',null,'resolver-body');dialog.replaceChildren(head,body);heading.focus({preventScroll:true});return body;
  }
  function failed(error,r){if(!valid(r))return;const body=frame();body.append(element('p',error.message,'resolver-error'),action('Conferir novamente',load,'secondary'));}
  async function preview(r,chosen=null){
    try{
      const {previa}=await api('/api/v3/vendas/preparar',{conversa_id:currentConversation});if(!valid(r))return;
      const body=frame();body.append(element('h3','Quais mensagens ajudam nesta avaliação?'),element('p','Escolha entre as últimas 20 mensagens disponíveis. Nada sai do seu computador nesta etapa.','resolver-intro'));
      const candidates=previa.candidatas||previa.fontes,selected=new Set(chosen??candidates.map(f=>f.id));
      const form=element('form',null,'sales-selection-form'),summary=element('p',null,'sales-selection-count');summary.setAttribute('role','status');
      const sources=element('div',null,'sales-selection-sources'),inputs=[];
      for(const source of candidates){
        const label=element('label',null,'sales-select-source'),check=element('input'),content=element('span',null,'sales-select-copy');
        check.type='checkbox';check.value=String(source.id);check.checked=selected.has(source.id);check.setAttribute('aria-label',`Incluir mensagem E${source.id}`);
        content.append(element('b',source.autor_e_dono?'Sua mensagem':'Mensagem do contato'),element('small',date(source.recebido_em)),element('span',source.texto,'sales-select-text'));
        label.append(check,content);sources.append(label);inputs.push(check);
      }
      const review=element('button','Conferir seleção','primary');review.type='submit';
      const update=()=>{const chosenSources=candidates.filter((_,i)=>inputs[i].checked),bytes=new TextEncoder().encode(JSON.stringify(chosenSources.map((f,i)=>({referencia:i+1,quando:f.recebido_em,papel:f.autor_e_dono?'vendedor':'contato',texto:f.texto})))).length;
        review.disabled=chosenSources.length===0||bytes>24000;
        summary.textContent=`${chosenSources.length} de ${candidates.length} mensagens selecionadas`+(bytes>24000?' · Recorte grande demais. Retire mensagens para continuar.':chosenSources.length===0?' · Selecione pelo menos uma.':'.');
      };
      for(const check of inputs)check.onchange=update;
      const controls=element('div',null,'button-row sales-selection-controls');
      for(const [name,checked]of [['Selecionar todas',true],['Limpar seleção',false]])controls.append(action(name,()=>{for(const check of inputs)check.checked=checked;update();},'text-button'));
      form.append(summary,controls,sources,element('p','Inclua as respostas e correções relevantes. Deixar uma mensagem de fora pode mudar a avaliação; o Jev não verá o restante.','resolver-scope'),review);body.append(form,action('Voltar sem enviar',load,'text-button'));update();
      form.onsubmit=async event=>{event.preventDefault();if(review.disabled)return;review.disabled=true;
        try{const fonte_ids=candidates.filter((_,i)=>inputs[i].checked).map(f=>f.id);
          const {previa:final}=await api('/api/v3/vendas/preparar',{conversa_id:currentConversation,fonte_ids});
          if(!valid(r)||!form.isConnected)return;
          if(!final.apto||!final.id)throw Error('Este recorte é grande demais. Escolha menos mensagens.');
          confirmPreview(r,final);
        }catch(error){failed(error,r);}finally{update();}
      };
    }catch(error){failed(error,r);}
  }
  function confirmPreview(r,previa){
      const body=frame();body.append(element('h3','Confira exatamente o que será enviado'),element('p',previa.aviso,'resolver-intro'));
      const sources=element('div',null,'sales-preview-sources');
      for(const source of previa.fontes){const article=element('article',null,'resolver-sources');article.append(element('b',source.autor_e_dono?'Sua mensagem':'Mensagem do contato'),element('small',date(source.recebido_em)),element('blockquote',source.texto));sources.append(article);}body.append(sources);
      const form=element('form',null,'sales-consent-form'),label=element('label',null,'check resolver-consent'),check=element('input');check.type='checkbox';check.required=true;check.id='sales-consent';
      label.append(check,element('span','Autorizo enviar estas mensagens à OpenRouter e à TypeSafe para esta avaliação.'));
      const submit=element('button','Enviar este recorte ao Jev','primary');submit.type='submit';
      const status=element('p',null,'muted');status.setAttribute('role','status');
      form.append(label,element('p','Pode haver cobrança na sua conta OpenRouter. O custo não é confirmado antes da avaliação. O pipeline continua como você registrou.','resolver-scope'),submit,status);body.append(form,action('Rever seleção',()=>preview(r,previa.fontes.map(f=>f.id)),'secondary'),action('Voltar sem enviar',load,'text-button'));
      form.onsubmit=async event=>{event.preventDefault();if(!check.checked||submit.disabled)return;submit.disabled=true;status.textContent='Avaliando o recorte autorizado…';try{await api('/api/v3/vendas/avaliar',{previa_id:previa.id,confirmar:true});if(valid(r)){await load();void window.carregarNegocios('memory');}}catch(error){failed(error,r);}finally{submit.disabled=false;}};
  }
  async function load(){
    const r=++revision;dataRevision=revisaoDadosVisiveis;const body=frame();body.append(element('p','Conferindo a avaliação guardada…','muted'));
    try{
      const [state,{avaliacao}]=await Promise.all([api('/api/v3/vendas/jev'),api('/api/v3/vendas/avaliacao?'+new URLSearchParams({conversa_id:currentConversation}))]);if(!valid(r))return;body.replaceChildren();
      const incerta=avaliacaoComercialIncerta(avaliacao);
      const temperature=avaliacao?.desatualizada||incerta?'insuficiente':avaliacao?.temperatura||'insuficiente';
      const meter=element('section',null,'sales-meter');meter.dataset.temperature=temperature;
      meter.append(element('p','INTERESSE NAS MENSAGENS','eyebrow'),element('h3',incerta&&!avaliacao.desatualizada?'Revisão necessária':avaliacao?temperatures[temperature]||temperatures.insuficiente:'Ainda não avaliado'));
      const bars=element('div',null,'sales-meter-bars');bars.setAttribute('aria-hidden','true');for(const label of ['Frio','Morno','Quente'])bars.append(element('span',label));meter.append(bars);
      meter.append(element('p',avaliacao?.desatualizada?'O recorte mudou desde a avaliação. Confira as fontes antes de avaliar novamente.':incerta?'O Jev retornou baixa confiança. Confira as mensagens e registre sua avaliação antes de usar esta classificação.':avaliacao?.criterio?'Critério aplicado: '+avaliacao.criterio:'Confira as mensagens antes de avaliar. Falta de resposta não determina interesse.'));
      if(avaliacao){
        meter.append(element('small',`${avaliacao.desatualizada?'Contexto mudou':avaliacao.origem==='manual'?'Registrado por você':'Avaliado por Jev'} · ${date(avaliacao.avaliado_em)}`));
        if(!avaliacao.desatualizada&&!incerta){meter.append(element('p',`Etapa avaliada: ${stages[avaliacao.etapa]||stages.insuficiente}. Critério aplicado: ${avaliacao.criterio_etapa||''}`,'muted'));}
        if(incerta&&!avaliacao.desatualizada){
          const review=element('p','Classificação incerta · revisão necessária.','resolver-connection-note sales-review-required');review.setAttribute('role','status');meter.append(review);
          const tentative=element('details');tentative.append(element('summary','Ver sugestão incerta do Jev'),element('p',`Sugestão ainda não validada: ${temperatures[avaliacao.temperatura]||temperatures.insuficiente} · ${stages[avaliacao.etapa]||stages.insuficiente}.`));meter.append(tentative);
        }
        const sources=element('div',null,'button-row sales-source-buttons');for(const id of avaliacao.fontes||[])sources.append(action('Fonte E'+id,async()=>{dialog.close();await window.abrirFonteTarefa(id);},'text-button'));meter.append(sources);
        if(!avaliacao.desatualizada&&avaliacao.origem==='jev')meter.append(element('p',`Avaliação de ${avaliacao.fontes?.length||0} mensagens ${avaliacao.somenteSugestao?'do recorte autorizado':'escolhidas'}. O restante da conversa não foi enviado.`,'muted'));
        if(!avaliacao.desatualizada&&avaliacao.assunto){
          const labels={comercial:'Comercial',tarefa:'Tarefa',projeto:'Projeto',pessoal:'Pessoal',insuficiente:'Informação insuficiente',planejado:'Planejado',em_andamento:'Em andamento',bloqueado:'Bloqueado',concluido_informado:'Conclusão informada',mesmo_assunto:'Mesmo assunto',novo_assunto:'Novo assunto',incerto:'Continuidade incerta'};
          for(const [key,label] of [['assunto','Assunto'],['andamento','Andamento'],['continuidade','Continuidade']]){
            const value=avaliacao[key];if(value)meter.append(element('p',`${label}: ${labels[value.valor]||'Informação insuficiente'}${Number.isFinite(value.confianca)&&value.confianca<.7?' · revisar sugestão incerta':''}.`,'muted'));
          }
          meter.append(element('small','Conclusão informada não comprova publicação, entrega ou aceite.'));
        }
        if(Number.isFinite(avaliacao.custo_usd))meter.append(element('small','Custo informado pelo provedor: US$ '+avaliacao.custo_usd.toFixed(6)));
      }
      body.append(meter,element('p','Temperatura descreve os sinais do recorte. Não é probabilidade de fechar venda e não muda a etapa do pipeline.','resolver-scope'));
      const evaluate=action('Conferir recorte para avaliar com Jev',()=>preview(r),'primary');evaluate.disabled=!state.configurada||!state.disponivel;body.append(evaluate);
      if(!state.configurada)body.append(element('p',state.disponivel?'Configure o Jev abaixo para habilitar a avaliação opcional.':'A avaliação externa está indisponível aqui. Você pode registrar sua avaliação local.','muted'));

      const manual=element('details',null,'sales-manual');manual.append(element('summary','Registrar ou corrigir minha avaliação'));
      const form=element('form'),tempLabel=element('label','Interesse'),temp=element('select');temp.name='temperatura';for(const [id,name]of Object.entries(temperatures))temp.append(new Option(name,id));temp.value=temperature;tempLabel.append(temp);
      const stageLabel=element('label','Etapa avaliada'),stage=element('select');stage.name='etapa';for(const [id,name]of Object.entries(stages))stage.append(new Option(name,id));stage.value=incerta||avaliacao?.desatualizada?'insuficiente':avaliacao?.etapa||'insuficiente';stageLabel.append(stage);
      const extra={};
      const extraFields=[['assunto','Assunto',{insuficiente:'Não sei ainda',comercial:'Comercial',tarefa:'Tarefa',projeto:'Projeto',pessoal:'Pessoal'}],['andamento','Andamento',{insuficiente:'Não sei ainda',planejado:'Planejado',em_andamento:'Em andamento',bloqueado:'Bloqueado',concluido_informado:'Conclusão informada'}],['continuidade','Continuidade',{incerto:'Não sei ainda',mesmo_assunto:'Mesmo assunto',novo_assunto:'Novo assunto'}]];
      const detail=element('details');detail.append(element('summary','Corrigir assunto e andamento'));
      for(const [key,label,options]of extraFields){const field=element('label',label),select=element('select');select.name=key;for(const [id,name]of Object.entries(options))select.append(new Option(name,id));select.value=avaliacao?.desatualizada?Object.keys(options)[0]:avaliacao?.[key]?.valor||Object.keys(options)[0];field.append(select);detail.append(field);extra[key]=select;}
      const checkLabel=element('label',null,'check'),check=element('input');check.type='checkbox';check.required=true;checkLabel.append(check,element('span','Conferi as mensagens e quero guardar esta avaliação.'));
      const save=element('button','Guardar minha avaliação','secondary');save.type='submit';form.append(tempLabel,stageLabel,checkLabel,element('p','Registro local. Nenhuma mensagem é enviada ao Jev.','muted'),save);manual.append(form);body.append(manual);
      form.insertBefore(detail,checkLabel);
      form.onsubmit=async event=>{event.preventDefault();if(save.disabled||!check.checked)return;save.disabled=true;try{await api('/api/v3/vendas/corrigir',{conversa_id:currentConversation,temperatura:temp.value,etapa:stage.value,confirmar:true,...(detail.open?Object.fromEntries(Object.entries(extra).map(([k,v])=>[k,v.value])):{})});if(valid(r)){await load();void window.carregarNegocios('memory');}}catch(error){failed(error,r);}finally{save.disabled=false;}};

      const connection=element('details',null,'sales-connection');connection.append(element('summary','Conexão Jev · opcional'),element('p',state.configurada?'Chave protegida configurada. Avaliações avulsas exigem confirmação; a classificação contínua é configurada separadamente no Lume pessoal.':'Jev usa uma chave OpenRouter guardada na proteção de credenciais do aplicativo.','muted'));
      if(state.disponivel&&!state.configurada){
        const form=element('form'),label=element('label','Chave OpenRouter'),input=element('input');input.type='password';input.autocomplete='off';input.required=true;input.maxLength=100;input.name='chave';label.append(input);
        const save=element('button','Guardar chave protegida','secondary');save.type='submit';form.append(label,save);connection.append(form);
        form.onsubmit=async event=>{event.preventDefault();if(save.disabled)return;save.disabled=true;const secret=input.value;input.value='';try{await api('/api/v3/vendas/jev/configurar',{chave:secret});if(valid(r))await load();}catch(error){failed(error,r);}finally{save.disabled=false;}};
      }
      if(state.configurada)connection.append(action('Remover chave do Jev',async()=>{try{await api('/api/v3/vendas/jev/remover',{});if(valid(r))await load();}catch(error){failed(error,r);}},'secondary'));
      body.append(connection);
    }catch(error){failed(error,r);}
  }
  window.abrirAvaliacaoVenda=async(conversation,name)=>{opener=document.activeElement;currentConversation=conversation;currentName=name;if(!dialog.open)dialog.showModal();await load();};
  dialog.addEventListener('close',()=>{revision++;dialog.replaceChildren();if(opener?.isConnected)opener.focus({preventScroll:true});});
  dialog.addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;const closed=[...dialog.querySelectorAll('details:not([open])')];const nodes=[...dialog.querySelectorAll('button,input,textarea,select,summary')].filter(n=>!n.disabled&&n.getClientRects().length&&!closed.some(d=>d.contains(n)&&d.querySelector('summary')!==n));
    if(!nodes.length)return;if(event.shiftKey&&(document.activeElement===nodes[0]||!nodes.includes(document.activeElement))){event.preventDefault();nodes.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0].focus();}
  });
  const clean=window.limparNegocios;window.limparNegocios=()=>{revision++;if(dialog.open)dialog.close();clean?.();};
  const projects=element('section',null,'panel projects06');projects.id='projects06';projects.setAttribute('aria-label','Projetos');
  $('search-form').before(projects);
})();

/* Projects group explicitly selected sources, without granting filesystem access. */
(() => {
  const target=$('projects06'),dialog=element('dialog',null,'resolver-dialog projects-dialog');dialog.id='projects-dialog';dialog.setAttribute('aria-labelledby','projects-title');document.body.append(dialog);
  const states={rascunho:'Rascunho',confirmado:'Organizado',arquivado:'Arquivado'},natures={incerto:'A conferir',proposta:'Proposta',acordo_citado:'Acordo citado'};
  const endpoint='/api/v3/projetos-comerciais';let revision=0,listRevision=0,dataRevision=0,opener=null;
  const valid=r=>r===revision&&dialog.open&&dataRevision===revisaoDadosVisiveis;
  function frame(title,kicker='PROJETOS · CONTEXTO REUNIDO'){
    const heading=element('h2',title);heading.id='projects-title';heading.tabIndex=-1;
    const head=element('header',null,'resolver-heading'),copy=element('div');copy.append(element('p',kicker,'eyebrow'),heading);head.append(copy,action('Fechar',()=>dialog.close(),'secondary resolver-close'));
    const body=element('div',null,'resolver-body');dialog.replaceChildren(head,body);heading.focus({preventScroll:true});return body;
  }
  function error(e,r){if(!valid(r))return;const body=frame('Não foi possível abrir');const message=element('p',e.message,'resolver-error');message.setAttribute('role','alert');body.append(message,element('p','Reabra o projeto ou a mensagem para conferir o contexto atual.','muted'));}
  window.carregarProjetos06=async()=>{
    const r=++listRevision,d=revisaoDadosVisiveis;target.replaceChildren(element('p','Reunindo seus projetos…','muted'));
    try{
      const [{projetos},{projetos:importados}]=await Promise.all([api(endpoint),api(endpoint+'/importados')]);if(r!==listRevision||d!==revisaoDadosVisiveis)return;
      const intro=element('div',null,'projects-intro');intro.append(element('h2','Cada projeto, com seu contexto.'),element('p','Abra uma mensagem e escolha “Adicionar a projeto”. Você vincula só as fontes que fazem parte daquele trabalho.','muted'),action('Encontrar uma mensagem',async()=>{window.lumeSetMemoryMode('search');await show('memory');$('search').focus({preventScroll:true});},'secondary'));
      target.replaceChildren(intro);
      const list=element('div',null,'projects-list');target.append(list);
      if(!projetos.length&&!importados.length)empty(list,'Nenhum projeto disponível aqui.','Encontre uma mensagem e use “Adicionar a projeto”. Projetos do backup só aparecem quando suas fontes podem ser conferidas; restaurações antigas podem não ter essa informação.');
      for(const project of projetos){const card=element('article',null,'project-card');card.append(element('span',states[project.estado]||project.estado,'project-state'),element('h3',project.nome),element('p',`${project.fontes.length} ${project.fontes.length===1?'fonte vinculada':'fontes vinculadas'} · ${natures[project.natureza]||'A conferir'}`,'muted'),element('small','Atualizado em '+date(project.atualizadoEm)),action('Abrir projeto',()=>open(project.id),'secondary'));list.append(card);}
      if(importados.length){
        const section=element('section',null,'projects-imported'),cards=element('div',null,'projects-list');section.setAttribute('aria-labelledby','projects-imported-title');
        const title=element('h3','Do seu backup');title.id='projects-imported-title';
        section.append(element('p','CONTINUE DE ONDE PAROU','eyebrow'),title,element('p','Seus projetos vieram com as fontes. Confira cada um para retomar a organização como rascunho.','muted'),cards);
        for(const project of importados){const card=element('article',null,'project-card');card.append(element('span','Revisão necessária','project-state'),element('h4',project.nome),element('p',`${project.fontes.length} ${project.fontes.length===1?'fonte para conferir':'fontes para conferir'}`,'muted'),action('Conferir fontes',()=>reviewImported(project.id),'secondary'));cards.append(card);}
        target.append(section);
      }
      target.append(element('p','Organizar um projeto não confirma acordo comercial. Acesso às mensagens continua sujeito às suas permissões.','muted'));
    }catch(e){if(r===listRevision)target.replaceChildren(element('p',e.message,'muted'),action('Tentar novamente',window.carregarProjetos06,'secondary'));}
  };
  async function render(id,r){
    const [{projeto},history]=await Promise.all([api(endpoint+'/item?'+new URLSearchParams({id})),api(endpoint+'/timeline?'+new URLSearchParams({id,limite:'20'}))]);if(!valid(r))return;
    if(!projeto)throw Error('Projeto indisponível. Confira suas fontes e permissões.');
    const body=frame(projeto.nome);body.append(element('p',states[projeto.estado]||projeto.estado,'resolver-state'),element('p','Contexto organizado por você. O acordo comercial ainda precisa ser conferido nas conversas.','resolver-intro'));
    const buttons=element('div',null,'button-row project-actions');
    const update=(path,label)=>buttons.append(action(label,async()=>{try{await api(endpoint+'/'+path,{id,confirmar:true});if(valid(r)){await render(id,r);void window.carregarProjetos06();}}catch(e){error(e,r);}},'secondary'));
    if(projeto.estado==='rascunho')update('confirmar','Confirmar organização');
    if(projeto.estado==='arquivado')update('restaurar','Restaurar rascunho');else update('arquivar','Arquivar projeto');
    body.append(buttons,element('h3','Fontes deste projeto'));
    for(const source of projeto.fontes){
      const box=element('section',null,'resolver-sources');box.append(element('small',(source.base?'Fonte de criação':'Fonte vinculada')+' · '+date(source.recebidoEm)),element('blockquote',source.trecho));
      if(source.truncada)box.append(element('p','Prévia parcial. Abra a mensagem para ler o conteúdo completo.','muted'));
      for(const warning of source.avisos||[])box.append(element('p',typeof warning==='string'?warning:'Confira a transcrição na fonte.','muted'));
      const row=element('div',null,'button-row');row.append(action('Abrir mensagem',async()=>{dialog.close();await window.abrirFonteTarefa(source.eventoId);},'text-button'));
      if(!source.base&&projeto.estado!=='arquivado')row.append(action('Desvincular fonte',async()=>{try{await api(endpoint+'/desvincular',{id,fonteId:source.id});if(valid(r)){await render(id,r);void window.carregarProjetos06();}}catch(e){error(e,r);}},'text-button'));
      box.append(row);body.append(box);
    }
    if(projeto.fontesIndisponiveis)body.append(element('p',`${projeto.fontesIndisponiveis} fontes indisponíveis neste contexto.`,'muted'));
    const timeline=element('section',null,'resolver-timeline');timeline.append(element('h3','Histórico do projeto'));const list=element('ol');timeline.append(list);body.append(timeline);
    const labels={criado:'Rascunho criado',confirmado:'Organização confirmada',arquivado:'Projeto arquivado',restaurado:'Rascunho restaurado',fonte_vinculada:'Fonte vinculada',fonte_desvinculada:'Fonte desvinculada',importado_revisado:'Fontes do backup revisadas'};
    const append=items=>{for(const item of items){const li=element('li');li.append(element('b',labels[item.tipo]||'Registro'),element('time',date(item.quando)));if(item.fonteIndisponivel)li.append(element('p','Fonte indisponível no contexto atual.'));list.append(li);}};append(history.timeline);
    if(history.antes){let before=history.antes;const more=action('Ver registros anteriores',async()=>{try{const next=await api(endpoint+'/timeline?'+new URLSearchParams({id,limite:'20',antes:before}));if(valid(r)){append(next.timeline);before=next.antes;more.hidden=!before;}}catch(e){error(e,r);}},'secondary');timeline.append(more);}
  }
  async function open(id){opener=document.activeElement;dataRevision=revisaoDadosVisiveis;const r=++revision;if(!dialog.open)dialog.showModal();frame('Abrindo projeto…');try{await render(id,r);}catch(e){error(e,r);}}
  async function reviewImported(id){
    opener=document.activeElement;dataRevision=revisaoDadosVisiveis;const r=++revision;if(!dialog.open)dialog.showModal();frame('Conferindo as fontes…');
    try{
      const {previa}=await api(endpoint+'/importados/previa',{id});if(!valid(r))return;
      const body=frame(previa.projeto.nome,'PROJETOS · DO SEU BACKUP');
      body.append(element('p','Retome o contexto, depois o trabalho.','resolver-intro'),element('p','Importado em '+date(previa.projeto.importacao.importadoEm),'muted'));
      for(const source of previa.fontes){
        const box=element('section',null,'resolver-sources');box.append(element('small','Fonte E'+source.eventoId+' · '+date(source.recebidoEm)),element('blockquote',source.trecho));
        if(source.truncada)box.append(element('p','Prévia parcial. Abra a mensagem para ler o conteúdo completo.','muted'));
        for(const warning of source.avisos||[])box.append(element('p',typeof warning==='string'?warning:'Confira a transcrição na fonte.','muted'));
        box.append(action('Abrir mensagem',async()=>{dialog.close();await window.abrirFonteTarefa(source.eventoId);},'text-button'));body.append(box);
      }
      if(previa.projeto.fontesIndisponiveis)body.append(element('p',`${previa.projeto.fontesIndisponiveis} fontes indisponíveis não serão retomadas.`,'muted'));
      body.append(element('p','Isso mantém o histórico e retoma o projeto como rascunho. Não confirma um acordo nem reativa acesso de assistentes ou pastas.','project-import-notice'));
      const form=element('form',null,'project-import-form'),label=element('label',null,'project-import-consent'),check=element('input'),save=element('button','Retomar rascunho','primary');
      check.type='checkbox';check.id='project-import-confirm';check.required=true;check.checked=false;
      label.append(check,element('span','Conferi as fontes e quero retomar este rascunho.'));save.type='submit';save.disabled=true;
      check.onchange=()=>{save.disabled=!check.checked;};form.append(label,save);body.append(form);
      form.onsubmit=async event=>{
        event.preventDefault();if(save.disabled||!check.checked)return;save.disabled=true;check.disabled=true;
        try{const {projeto}=await api(endpoint+'/importados/revalidar',{previaId:previa.previaId,confirmar:true});if(valid(r)){await render(projeto.id,r);void window.carregarProjetos06();}}
        catch(e){error(e,r);}
      };
    }catch(e){error(e,r);}
  }
  window.abrirProjetoDeAcoes=async acaoIds=>{
    opener=document.activeElement;dataRevision=revisaoDadosVisiveis;const r=++revision;
    if(!dialog.open)dialog.showModal();frame('Reunindo os trechos revisados…');
    try{
      const {previa}=await api(endpoint+'/acoes/previa',{acaoIds});if(!valid(r))return;
      const body=frame('Um projeto a partir do combinado.','PROJETOS · AÇÕES REVISADAS');
      body.append(element('p','Estes trechos ficam ligados ao projeto. Nenhuma conversa inteira é incluída.','muted'));
      for(const item of previa.acoes){
        const proof=element('section',null,'resolver-sources');
        proof.append(element('small','Fonte E'+item.eventoId+' · '+date(item.recebidoEm)),element('blockquote',item.trecho));
        for(const warning of item.avisos||[])proof.append(element('p',typeof warning==='string'?warning:'Confira a transcrição na fonte.','muted'));
        proof.append(action('Conferir mensagem',async()=>{dialog.close();await window.abrirFonteTarefa(item.eventoId);},'text-button'));body.append(proof);
      }
      const form=element('form',null,'project-create-form'),label=element('label','Nome do projeto'),name=element('input');
      name.id='project-name';name.maxLength=160;name.required=true;name.placeholder='Ex.: Novo produto com Guilherme';label.append(name);
      const natureLabel=element('label','Como você descreve o contexto?'),nature=element('select');nature.id='project-nature';
      for(const [id,title]of Object.entries(natures))nature.append(new Option(title,id));natureLabel.append(nature);
      const save=element('button','Criar rascunho de projeto','primary');save.type='submit';
      form.append(label,natureLabel,element('p','Você escolhe o agrupamento. O rascunho pode ser arquivado e não confirma um acordo comercial.','muted'),save);body.append(form);
      form.onsubmit=async event=>{
        event.preventDefault();if(save.disabled)return;save.disabled=true;
        try{
          const {projeto}=await api(endpoint+'/acoes/rascunho',{previaId:previa.id,nome:name.value.trim(),natureza:nature.value,confirmar:true});
          if(valid(r)){await render(projeto.id,r);void window.carregarProjetos06();}
        }catch(e){error(e,r);}finally{save.disabled=false;}
      };
    }catch(e){error(e,r);}
  };
  window.abrirProjetoDaFonte=async message=>{
    opener=document.activeElement;dataRevision=revisaoDadosVisiveis;const r=++revision;if(!dialog.open)dialog.showModal();frame('Confira a fonte');
    try{
      const [source,{projetos}]=await Promise.all([api('/api/v3/fonte?id='+message.id),api(endpoint)]);if(!valid(r))return;
      const body=frame('Dê um lugar a este contexto.','PROJETOS · FONTE SELECIONADA'),proof=element('section',null,'resolver-sources');proof.append(element('b',source.conversa_nome||'Mensagem de origem'),element('blockquote',source.texto||''));body.append(proof);
      const excerptLabel=element('label','Trecho literal · opcional'),excerpt=element('textarea');excerpt.rows=3;excerpt.maxLength=4000;excerpt.id='project-excerpt';excerptLabel.append(excerpt);body.append(excerptLabel,element('p','Deixe o trecho vazio para vincular esta mensagem inteira.','muted'));
      const selection=()=>({eventoId:source.id,...(excerpt.value.trim()?{trecho:excerpt.value}: {})});
      const form=element('form',null,'project-create-form'),label=element('label','Nome do projeto'),name=element('input');name.id='project-name';name.maxLength=160;name.required=true;name.placeholder='Ex.: Consultoria da Ana';label.append(name);
      const natureLabel=element('label','O que aparece na mensagem?'),nature=element('select');nature.id='project-nature';for(const [id,name]of Object.entries(natures))nature.append(new Option(name,id));natureLabel.append(nature);
      const save=element('button','Criar rascunho de projeto','primary');save.type='submit';form.append(label,natureLabel,element('p','O rascunho reúne fontes e pode ser arquivado. Não confirma que o acordo foi aceito.','muted'),save);body.append(form);
      const creationKey=crypto.randomUUID();form.onsubmit=async event=>{event.preventDefault();if(save.disabled)return;save.disabled=true;try{const {projeto}=await api(endpoint+'/rascunho',{nome:name.value.trim(),natureza:nature.value,fontes:[selection()],chave:creationKey});if(valid(r)){await render(projeto.id,r);void window.carregarProjetos06();}}catch(e){error(e,r);}finally{save.disabled=false;}};
      const available=projetos.filter(p=>p.estado!=='arquivado');if(available.length){
        const existing=element('details',null,'project-link-existing');existing.append(element('summary','Vincular a um projeto existente'));
        const form=element('form'),label=element('label','Projeto'),select=element('select');select.id='project-existing';for(const p of available)select.append(new Option(p.nome,p.id));label.append(select);
        const save=element('button','Vincular fonte ao projeto','secondary');save.type='submit';form.append(label,save);existing.append(form);body.append(existing);
        form.onsubmit=async event=>{event.preventDefault();if(save.disabled)return;save.disabled=true;try{await api(endpoint+'/vincular',{id:select.value,...selection()});if(valid(r)){await render(select.value,r);void window.carregarProjetos06();}}catch(e){error(e,r);}finally{save.disabled=false;}};
      }
    }catch(e){error(e,r);}
  };
  dialog.addEventListener('close',()=>{revision++;dialog.replaceChildren();if(opener?.isConnected)opener.focus({preventScroll:true});});
  dialog.addEventListener('keydown',event=>{if(event.key!=='Tab')return;const closed=[...dialog.querySelectorAll('details:not([open])')];const nodes=[...dialog.querySelectorAll('button,input,textarea,select,summary')].filter(n=>!n.disabled&&n.getClientRects().length&&!closed.some(d=>d.contains(n)&&d.querySelector('summary')!==n));if(!nodes.length)return;if(event.shiftKey&&(document.activeElement===nodes[0]||!nodes.includes(document.activeElement))){event.preventDefault();nodes.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0].focus();}});
  const clean=window.limparNegocios;window.limparNegocios=()=>{listRevision++;revision++;target.replaceChildren();if(dialog.open)dialog.close();clean?.();};
})();
