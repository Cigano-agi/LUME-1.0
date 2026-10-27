(()=>{
  const $=id=>document.getElementById(id);let installations=[],feedbacks=[],feedbackTotal=0,feedbackPage=0,feedbackNextCursor=null,feedbackCursors=[null],feedbackRequest=0;
  const labels={ativo:'Pulso recente',desatualizado:'Desatualizado',sem_contato:'Sem pulso recente',erro_atualizacao:'Erro na atualização',apenas_feedback:'Somente feedback',revogada:'Revogada'};
  const api=async(url,options={})=>{const response=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const body=await response.json().catch(()=>({erro:'RESPOSTA_INVALIDA'}));if(!response.ok)throw Object.assign(new Error(body.erro||'ERRO'),{status:response.status});return body;};
  const date=value=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
  function render(){
    const filter=$('filter').value,items=filter?installations.filter(i=>i.estado===filter):installations;
    $('active').textContent=installations.filter(i=>i.estado==='ativo').length;$('old').textContent=installations.filter(i=>i.estado==='desatualizado').length;$('silent').textContent=installations.filter(i=>i.estado==='sem_contato').length;$('errors').textContent=installations.filter(i=>i.estado==='erro_atualizacao').length;$('feedback-only').textContent=installations.filter(i=>i.estado==='apenas_feedback').length;
    $('rows').replaceChildren(...items.map(item=>{const tr=document.createElement('tr');for(const [label,value] of [['Pessoa',item.rotulo],['Sistema',`${item.plataforma==='darwin'?'macOS':'Windows'} · ${item.arquitetura}`],['Versão',item.versao],['Último registro',date(item.ultimoContatoEm)]]){const td=document.createElement('td');td.dataset.label=label;td.textContent=value;tr.append(td);}const td=document.createElement('td'),badge=document.createElement('span');td.dataset.label='Estado';badge.className='status '+item.estado;badge.textContent=labels[item.estado]||item.estado;td.append(badge);tr.append(td);return tr;}));$('empty').hidden=items.length>0;
  }
  const criar=(tag,texto,classe)=>{const node=document.createElement(tag);if(texto!==undefined)node.textContent=texto;if(classe)node.className=classe;return node;};
  const options=(select,values)=>{const old=select.value;select.replaceChildren(new Option('Todas',''),...values.map(value=>new Option(value,value)),...(old&&!values.includes(old)?[new Option(`${old} (sem relatos)`,old)]:[]));select.value=old;};
  function filtrosFeedback(){const dados={};for(const [key,id]of Object.entries({etapa:'feedback-stage',severidade:'feedback-severity',estado:'feedback-state',versao:'feedback-version',plataforma:'feedback-platform'}))if($(id).value)dados[key]=$(id).value;return dados;}
  function renderFeedback(){
    const itens=feedbacks;$('feedback-total').textContent=String(feedbackTotal);$('feedback-empty').hidden=itens.length>0;
    $('feedback-prev').disabled=feedbackPage===0;$('feedback-next').disabled=!feedbackNextCursor;$('feedback-page-label').textContent=`Página ${feedbackPage+1}`;
    $('feedback-rows').replaceChildren(...itens.map(item=>{
      const card=criar('article',undefined,'feedback-item');
      const head=criar('div',undefined,'feedback-item-head');
      head.append(criar('strong',item.rotulo||'Instalação do beta'),criar('span',`${item.plataforma==='darwin'?'macOS':'Windows'} · ${item.versao} · ${date(item.criadoEm)}`));
      const meta=criar('p',`${{onboarding:'Primeiro acesso',hoje:'Hoje',conexao:'Conexão',organiza:'Organizar',ajustes:'Ajustes'}[item.etapa]||item.etapa} · ${{erro:'Problema',ideia:'Ideia',elogio:'Funcionou'}[item.categoria]||item.categoria}${item.utilidade?` · Utilidade: ${{util:'sim',parcial:'em parte',nao_util:'ainda não'}[item.utilidade]}`:''} · ${item.contatoAutorizado===true?'Pode contatar pelo convite':'Sem autorização para contato'}`,'feedback-meta');
      const relato=criar('p',item.relato,'feedback-text');
      const controls=criar('div',undefined,'feedback-controls');
      const estado=criar('select');estado.setAttribute('aria-label','Estado do feedback');
      for(const [value,label] of [['novo','Novo'],['em_analise','Em análise'],['resolvido','Resolvido']])estado.add(new Option(label,value));estado.value=item.estado;
      const severidade=criar('select');severidade.setAttribute('aria-label','Prioridade do feedback');
      for(const [value,label] of [['alta','Alta'],['media','Média'],['baixa','Baixa']])severidade.add(new Option(label,value));severidade.value=item.severidade;
      const salvar=criar('button','Salvar triagem','secondary');salvar.type='button';
      salvar.onclick=async()=>{salvar.disabled=true;$('feedback-status').textContent='Salvando triagem…';try{await api(`/api/v1/admin/feedback/${encodeURIComponent(item.id)}/revisar`,{method:'POST',body:JSON.stringify({estado:estado.value,severidade:severidade.value})});await loadFeedback({page:feedbackPage,cursor:feedbackCursors[feedbackPage]});$('feedback-status').textContent='Triagem salva.';}catch{$('feedback-status').textContent='Não foi possível salvar a triagem.';}finally{salvar.disabled=false;}};
      const confirmar=criar('input');confirmar.type='checkbox';confirmar.setAttribute('aria-label','Confirmar exclusão deste feedback');
      const apagar=criar('button','Excluir relato','danger');apagar.type='button';apagar.disabled=true;confirmar.onchange=()=>apagar.disabled=!confirmar.checked;
      apagar.onclick=async()=>{apagar.disabled=true;$('feedback-status').textContent='Excluindo relato…';try{await api(`/api/v1/admin/feedback/${encodeURIComponent(item.id)}/excluir`,{method:'POST',body:'{}'});await loadFeedback({page:feedbackPage,cursor:feedbackCursors[feedbackPage]});if(!feedbacks.length&&feedbackPage>0)await loadFeedback({page:feedbackPage-1,cursor:feedbackCursors[feedbackPage-1]});$('feedback-status').textContent='Relato excluído da Central.';}catch{$('feedback-status').textContent='Não foi possível excluir o relato.';apagar.disabled=false;}};
      const deleteWrap=criar('div',undefined,'feedback-delete');deleteWrap.append(confirmar,criar('span','Confirmar exclusão'),apagar);
      controls.append(estado,severidade,salvar,deleteWrap);card.append(head,meta,relato,controls);return card;
    }));
  }
  async function loadFeedback({page=0,cursor=null}={}){
    const sequence=++feedbackRequest,params=new URLSearchParams(filtrosFeedback());if(cursor)params.set('cursor',cursor);
    const data=await api('/api/v1/admin/feedback'+(params.size?'?'+params:''));
    if(sequence!==feedbackRequest)return;
    feedbacks=Array.isArray(data.itens)?data.itens:[];feedbackTotal=Number.isSafeInteger(data.total)?data.total:feedbacks.length;
    feedbackPage=page;feedbackNextCursor=data.proximoCursor||null;feedbackCursors=feedbackCursors.slice(0,page+1);feedbackCursors[page]=cursor;if(feedbackNextCursor)feedbackCursors[page+1]=feedbackNextCursor;
    options($('feedback-version'),Array.isArray(data.versoes)?data.versoes:[]);
    const inicio=feedbacks.length?page*(data.tamanhoPagina||20)+1:0,fim=inicio?inicio+feedbacks.length-1:0;
    $('feedback-status').textContent=feedbackTotal?`Mostrando ${inicio}–${fim} de ${feedbackTotal} relatos neste filtro.`:'Nenhum relato neste filtro.';
    renderFeedback();
  }
  async function load(){
    try{const data=await api('/api/v1/admin/instalacoes');installations=data.instalacoes;$('login').hidden=true;$('dashboard').hidden=false;$('updated').textContent=`Versão atual do beta: ${data.versaoAtual||'a definir'} · conferido agora`;render();await loadFeedback().catch(()=>{$('feedback-status').textContent='Não foi possível carregar os relatos agora. Tente atualizar.';});}
    catch(error){if(error.status===401){$('login').hidden=false;$('dashboard').hidden=true;return;}throw error;}
  }
  $('login-form').onsubmit=async event=>{event.preventDefault();$('login-error').textContent='';try{await api('/api/v1/admin/sessao',{method:'POST',body:JSON.stringify({senha:$('senha').value})});$('senha').value='';await load();}catch{$('login-error').textContent='Não foi possível entrar. Confira a senha.';}};
  $('invite-form').onsubmit=async event=>{event.preventDefault();$('central-status').textContent='';try{const data=await api('/api/v1/admin/convites',{method:'POST',body:JSON.stringify({rotulo:$('label').value})});$('invite-code').textContent=data.codigo;$('invite-result').hidden=false;$('label').value='';}catch{$('central-status').textContent='Não foi possível criar o convite agora.';}};
  $('copy').onclick=async()=>{await navigator.clipboard.writeText($('invite-code').textContent);$('copy').textContent='Copiado';setTimeout(()=>$('copy').textContent='Copiar',1500);};
  $('refresh').onclick=load;$('filter').onchange=render;
  for(const id of ['feedback-stage','feedback-severity','feedback-state','feedback-version','feedback-platform'])$(id).onchange=()=>loadFeedback().catch(()=>{$('feedback-status').textContent='Não foi possível aplicar o filtro. Tente atualizar.';});
  $('feedback-prev').onclick=()=>loadFeedback({page:feedbackPage-1,cursor:feedbackCursors[feedbackPage-1]}).catch(()=>{$('feedback-status').textContent='Não foi possível abrir a página anterior.';});
  $('feedback-next').onclick=()=>loadFeedback({page:feedbackPage+1,cursor:feedbackNextCursor}).catch(()=>{$('feedback-status').textContent='Não foi possível abrir a próxima página.';});
  $('feedback-export').onclick=async()=>{
    const button=$('feedback-export'),filtros=filtrosFeedback(),itens=[],ids=new Set();let cursor=null,totalEsperado=null;
    button.disabled=true;$('feedback-status').textContent='Preparando exportação do filtro…';
    try{
      do{const params=new URLSearchParams(filtros);if(cursor)params.set('cursor',cursor);const data=await api('/api/v1/admin/feedback'+(params.size?'?'+params:''));if(!Array.isArray(data.itens)||!Number.isSafeInteger(data.total)||itens.length+data.itens.length>10000||totalEsperado!==null&&data.total!==totalEsperado)throw Error('EXPORTACAO_INCOMPLETA');totalEsperado=data.total;for(const item of data.itens){if(ids.has(item.id))throw Error('EXPORTACAO_REPETIDA');ids.add(item.id);itens.push(item);}cursor=data.proximoCursor||null;$('feedback-status').textContent=`Preparando exportação: ${itens.length} de ${data.total} relatos…`;}while(cursor);
      if(itens.length!==totalEsperado)throw Error('EXPORTACAO_INCOMPLETA');
      if(!itens.length){$('feedback-status').textContent='Nenhum relato neste filtro para exportar.';return;}
      const url=URL.createObjectURL(new Blob([JSON.stringify({exportadoEm:new Date().toISOString(),filtros,itens},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`lume-feedback-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);$('feedback-status').textContent=`Exportação de ${itens.length} relato${itens.length===1?'':'s'} solicitada.`;
    }catch{$('feedback-status').textContent='Não foi possível exportar todos os relatos deste filtro. Nenhum arquivo parcial foi gerado.';}finally{button.disabled=false;}
  };
  load().catch(()=>{$('login-error').textContent='A central não respondeu agora.';});
})();
