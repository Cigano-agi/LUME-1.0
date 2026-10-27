/** Revisão textual de um trecho do notetaker local. Sem acesso direto a áudio ou dispositivos. */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const h=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inteiro=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const textoValido=v=>typeof v==='string'&&v.isWellFormed();
const pontos=v=>[...v].length;

export function validarTextoCorrecao(valor){
  const bruto=typeof valor==='string'?valor:'';
  if(!textoValido(bruto))return {valido:false,texto:'',pontos:pontos(bruto)};
  const texto=bruto.trim();
  const n=pontos(texto);
  return {valido:!!texto&&n<=4000&&new TextEncoder().encode(texto).length<=16000,texto,pontos:n};
}

export function validarTrechoRevisao(dto,id){
  if(!dto||typeof dto!=='object'||Array.isArray(dto)||dto.id!==id||!UUID.test(id)||
    !inteiro(dto.eventoId,1)||!inteiro(dto.revisao)||!textoValido(dto.textoGerado)||
    !textoValido(dto.textoExibido)||!dto.textoGerado.trim()||!dto.textoExibido.trim()||
    !(dto.textoCorrigido===null||textoValido(dto.textoCorrigido))||
    dto.textoExibido!==(dto.textoCorrigido??dto.textoGerado))return false;
  if(dto.ultimaCorrecao!==null&&(!dto.ultimaCorrecao||typeof dto.ultimaCorrecao.ator!=='string'||typeof dto.ultimaCorrecao.em!=='string'))return false;
  if(!dto.evidencia||!['integra','original_indisponivel'].includes(dto.evidencia.estado)||
    !UUID.test(dto.evidencia.parteId||'')||!inteiro(dto.evidencia.inicioMs)||
    !inteiro(dto.evidencia.fimMs)||dto.evidencia.fimMs<=dto.evidencia.inicioMs)return false;
  return true;
}

function validarPagina(p){
  return p&&Array.isArray(p.correcoes)&&p.correcoes.length<=20&&
    (p.antes===null||inteiro(p.antes,1))&&p.correcoes.every(c=>
      inteiro(c.id,1)&&inteiro(c.revisao,1)&&textoValido(c.textoAnterior)&&
      textoValido(c.textoNovo)&&typeof c.ator==='string'&&typeof c.corrigidoEm==='string');
}

export function montarRevisaoTrecho(container,{trechoId,obterToken,fetchImpl=globalThis.fetch,onSaved,onClose}={}){
  if(!container||typeof container.addEventListener!=='function')throw new TypeError('Contêiner DOM obrigatório');
  if(typeof obterToken!=='function'||typeof fetchImpl!=='function')throw new TypeError('Token e fetch obrigatórios');
  let destroyed=false,epoch=0,base=null,rascunho='',conflito=false,atual=null,locked=false,initialBusy=false,
    busy=false,historico=[],antes=null,historyBusy=false,historyRefreshPending=false,historyError='',message='',kind='info';
  const aborters=new Set();
  const alive=e=>!destroyed&&epoch===e;
  const abortAll=()=>{for(const a of aborters)a.abort();aborters.clear();};
  const path=UUID.test(trechoId||'')?`/api/v3/notetaker/trechos/${trechoId}`:null;
  const forbidden=(response,data)=>response.status===403||response.status===404||['DIREITO','FECHADO','AUSENTE'].includes(data?.codigo);
  const setMessage=(text,tone='info')=>{message=text;kind=tone;const node=container.querySelector('.nt-review-status');if(node){node.textContent=text;node.dataset.tone=tone;}};
  function deny(){
    epoch++;abortAll();base=null;rascunho='';atual=null;historico=[];antes=null;conflito=false;busy=false;historyBusy=false;historyRefreshPending=false;historyError='';locked=true;
    message='Este trecho não está disponível para revisão.';kind='error';render();
    if(typeof onClose==='function')onClose({trechoId,motivo:'indisponivel'});
  }
  async function request(url,{method='GET',body}={}){
    const controller=new AbortController();aborters.add(controller);
    try{
      const token=obterToken();
      if(typeof token!=='string'||!token)throw Error('token local indisponível');
      const response=await fetchImpl(url,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
        headers:{'x-assessor-token':token,...(body?{'content-type':'application/json; charset=utf-8'}:{})},
        ...(body?{body:JSON.stringify(body)}:{})});
      let data;try{data=await response.json();}catch{data=null;}
      return {response,data};
    }finally{aborters.delete(controller);}
  }
  const evidence=()=>base?.evidencia?.estado==='integra'
    ?`Áudio original íntegro · ${base.evidencia.inicioMs}–${base.evidencia.fimMs} ms`
    :'Áudio indisponível. A correção fica identificada como texto humano; a fonte em áudio não está comprovada.';
  function updateEditor(){
    const check=validarTextoCorrecao(rascunho);
    const field=container.querySelector('#nt-review-text');if(field)field.disabled=busy;
    const counter=container.querySelector('.nt-review-count');if(counter)counter.textContent=`${check.pontos} / 4000 caracteres do texto guardado`;
    const save=container.querySelector('[data-review-action="save"]');if(save)save.disabled=busy||conflito||!check.valido;
    const error=container.querySelector('.nt-review-validation');if(error){error.textContent=!check.valido&&rascunho?'Escreva um texto válido de até 4.000 caracteres.':check.valido&&rascunho!==check.texto?'Espaços nas bordas serão removidos ao guardar.':'';error.dataset.tone=check.valido?'note':'error';}
  }
  function renderHistory(){
    const list=container.querySelector('.nt-review-history-list');if(!list)return;
    list.replaceChildren();
    if(!historico.length){const p=document.createElement('p');p.textContent='Nenhuma correção anterior.';list.append(p);}
    for(const item of historico){
      const details=document.createElement('details');details.className='nt-review-history-item';
      const summary=document.createElement('summary');
      const when=new Date(item.corrigidoEm);
      summary.textContent=`Revisão ${item.revisao} · ${item.ator==='local:owner'?'Correção humana local':item.ator} · ${Number.isNaN(when.getTime())?'Data indisponível':when.toLocaleString('pt-BR')}`;
      const old=document.createElement('p');old.textContent=`Antes: ${item.textoAnterior}`;
      const next=document.createElement('p');next.textContent=`Depois: ${item.textoNovo}`;
      details.append(summary,old,next);list.append(details);
    }
    const next=container.querySelector('[data-review-action="history-more"]');if(next){next.hidden=antes===null&&!historyError;next.disabled=historyBusy;next.textContent=historyError?'Tentar carregar histórico':'Carregar página seguinte';}
    const status=container.querySelector('.nt-review-history-status');if(status)status.textContent=historyError||(historyBusy?'Carregando histórico…':'');
  }
  function render(){
    if(destroyed)return;
    if(!base){
      container.innerHTML=`<section class="nt-review" aria-label="Revisão do trecho"><div class="nt-review-shell"><p class="nt-review-kicker">LUME · REUNIÕES</p><h1>Revisar trecho</h1><p class="nt-review-status" data-tone="${kind}" role="status">${h(message||'Abrindo trecho…')}</p><button type="button" class="nt-review-button" data-review-action="retry" ${path&&!locked&&!initialBusy?'':'hidden'}>Tentar novamente</button><button type="button" class="nt-review-button" data-review-action="cancel">Voltar</button></div></section>`;
      return;
    }
    const correction=base.textoCorrigido!==null?'Correção humana':'Texto gerado';
    const conflictHtml=conflito?`<section class="nt-review-conflict" aria-label="Conflito de versão"><h2>A versão mudou</h2><p>Seu rascunho foi preservado. Confira a versão atual antes de decidir.</p>${atual?`<div class="nt-review-compare"><div><strong>Versão atual</strong><p class="nt-review-current"></p></div><div><strong>Seu rascunho</strong><p class="nt-review-draft"></p></div></div><div class="nt-review-actions"><button type="button" class="nt-review-button nt-review-button--primary" data-review-action="use-draft">Usar meu rascunho nesta versão</button><button type="button" class="nt-review-button" data-review-action="discard">Descartar rascunho</button></div>`:`<button type="button" class="nt-review-button" data-review-action="check-current">Conferir versão atual</button>`}</section>`:'';
    const recheckHtml=kind==='error'&&!conflito?'<button type="button" class="nt-review-button" data-review-action="recheck">Reler trecho</button>':'';
    container.innerHTML=`<section class="nt-review" aria-label="Revisão do trecho"><div class="nt-review-shell"><header class="nt-review-header"><div><p class="nt-review-kicker">LUME · REUNIÕES / REVISÃO</p><h1>Revisar trecho</h1><p class="nt-review-lead">Confira o original e guarde sua correção.</p></div><span class="nt-review-local">Neste dispositivo</span></header><div class="nt-review-layout"><main class="nt-review-main"><div class="nt-review-source"><span class="nt-review-tag">${correction}</span><p class="nt-review-display"></p><p class="nt-review-evidence"></p></div><label class="nt-review-label" for="nt-review-text">Sua correção</label><textarea id="nt-review-text" class="nt-review-text" rows="7" aria-describedby="nt-review-count nt-review-validation"></textarea><div class="nt-review-field-foot"><span id="nt-review-count" class="nt-review-count"></span><span id="nt-review-validation" class="nt-review-validation"></span></div><p class="nt-review-status" data-tone="${kind}" role="status">${h(message)}</p>${conflictHtml}<div class="nt-review-actions"><button type="button" class="nt-review-button nt-review-button--primary" data-review-action="save">Guardar correção</button>${recheckHtml}<button type="button" class="nt-review-button" data-review-action="cancel">Cancelar</button></div></main><aside class="nt-review-side"><details class="nt-review-detail"><summary>Texto original gerado</summary><p class="nt-review-original"></p></details><details class="nt-review-detail"><summary>Histórico de correções</summary><div class="nt-review-history-list"></div><p class="nt-review-history-status" role="status"></p><button type="button" class="nt-review-button" data-review-action="history-more" hidden>Carregar página seguinte</button></details></aside></div></div></section>`;
    container.querySelector('.nt-review-display').textContent=base.textoExibido;
    container.querySelector('.nt-review-evidence').textContent=evidence();
    container.querySelector('.nt-review-original').textContent=base.textoGerado;
    container.querySelector('#nt-review-text').value=rascunho;
    if(atual){container.querySelector('.nt-review-current').textContent=atual.textoExibido;container.querySelector('.nt-review-draft').textContent=rascunho;}
    updateEditor();renderHistory();
  }
  async function loadInitial(){
    if(locked||initialBusy||base)return;
    if(!path){setMessage('Identificador do trecho inválido.','error');render();return;}
    const e=epoch;initialBusy=true;setMessage('Abrindo trecho…');render();
    try{
      const {response,data}=await request(path);if(!alive(e))return;
      if(forbidden(response,data)){deny();return;}
      if(!response.ok||!validarTrechoRevisao(data,trechoId)){setMessage('Não foi possível abrir o trecho. Tente novamente.','error');return;}
      base=data;rascunho=data.textoExibido;message='';render();loadHistory(true);
    }catch{if(alive(e))setMessage('Sem confirmação da leitura. Tente novamente.','error');}
    finally{if(alive(e)){initialBusy=false;if(!base)render();}}
  }
  async function loadHistory(reset=false){
    if(!base||historyBusy)return;
    if(!reset&&antes===null)return;
    historyBusy=true;historyError='';renderHistory();const e=epoch;
    try{
      const query=reset?'?limite=20':`?limite=20&antes=${antes}`;
      const {response,data}=await request(`${path}/correcoes${query}`);if(!alive(e))return;
      if(forbidden(response,data)){deny();return;}
      if(!response.ok||!validarPagina(data)){historyError='Histórico indisponível. Tente novamente.';return;}
      historico=reset?data.correcoes:[...historico,...data.correcoes];antes=data.antes;
    }catch{if(alive(e))historyError='Histórico indisponível. Tente novamente.';}
    finally{if(alive(e)){historyBusy=false;renderHistory();if(historyRefreshPending){historyRefreshPending=false;loadHistory(true);}}}
  }
  async function save(){
    if(!base||busy||conflito)return;
    const check=validarTextoCorrecao(rascunho);if(!check.valido){updateEditor();setMessage('Revise o texto antes de guardar.','error');return;}
    const expected=base.revisao,e=epoch;busy=true;updateEditor();setMessage('Guardando correção…');
    try{
      const {response,data}=await request(path,{method:'PATCH',body:{texto:rascunho,revisaoEsperada:expected,confirmar:true}});if(!alive(e))return;
      if(forbidden(response,data)){deny();return;}
      if(response.status===409){conflito=true;atual=null;message='A versão mudou. Seu rascunho foi preservado.';kind='error';render();return;}
      if(!response.ok||!validarTrechoRevisao(data,trechoId)||data.textoExibido!==check.texto||
        data.revisao!==(data.repetida===true?expected:expected+1)){
        setMessage('Sem confirmação de salvamento. Seu rascunho foi preservado; releia antes de tentar.','error');render();return;
      }
      base=data;rascunho=data.textoExibido;message=data.repetida===true?'O texto já estava guardado.':'Correção guardada neste dispositivo.';kind='success';render();
      if(historyBusy)historyRefreshPending=true;else loadHistory(true);
      if(typeof onSaved==='function'&&alive(e)){try{onSaved(data);}catch{ /* callback externo não altera recibo persistido */ }}
    }catch{if(alive(e)){setMessage('Sem confirmação de salvamento. Seu rascunho foi preservado; releia antes de tentar.','error');render();}}
    finally{if(alive(e)){busy=false;updateEditor();}}
  }
  async function checkCurrent(){
    if(!conflito||busy)return;busy=true;const e=epoch;setMessage('Lendo versão atual…');
    try{
      const {response,data}=await request(path);if(!alive(e))return;
      if(forbidden(response,data)){deny();return;}
      if(!response.ok||!validarTrechoRevisao(data,trechoId)){setMessage('Não foi possível conferir a versão atual. Tente novamente.','error');return;}
      atual=data;message='Compare os dois textos e escolha como continuar.';kind='info';render();
    }catch{if(alive(e))setMessage('Não foi possível conferir a versão atual. Tente novamente.','error');}
    finally{if(alive(e)){busy=false;updateEditor();}}
  }
  async function recheck(){
    if(!base||busy)return;busy=true;const e=epoch;setMessage('Relendo trecho…');
    try{
      const {response,data}=await request(path);if(!alive(e))return;
      if(forbidden(response,data)){deny();return;}
      if(!response.ok||!validarTrechoRevisao(data,trechoId)){setMessage('Não foi possível reler o trecho. Tente novamente.','error');render();return;}
      if(data.revisao!==base.revisao){conflito=true;atual=data;message='A versão mudou. Compare antes de continuar.';kind='error';}
      else{base=data;message='Versão conferida. Seu rascunho foi preservado.';kind='info';}
      render();
    }catch{if(alive(e)){setMessage('Não foi possível reler o trecho. Tente novamente.','error');render();}}
    finally{if(alive(e)){busy=false;updateEditor();}}
  }
  const handleClick=event=>{
    const button=event.target.closest?.('[data-review-action]');if(!button||!container.contains(button)||button.disabled)return;
    const action=button.dataset.reviewAction;
    if(action==='save')save();
    else if(action==='retry')loadInitial();
    else if(action==='history-more')loadHistory(antes===null);
    else if(action==='check-current')checkCurrent();
    else if(action==='recheck')recheck();
    else if(action==='use-draft'&&atual){base=atual;atual=null;conflito=false;message='Rascunho pronto para guardar nesta versão.';kind='info';render();container.querySelector('#nt-review-text')?.focus();}
    else if(action==='discard'&&atual){base=atual;rascunho=atual.textoExibido;atual=null;conflito=false;message='Rascunho descartado. Versão atual carregada.';kind='info';render();}
    else if(action==='cancel'){const callback=onClose;destruir();if(typeof callback==='function')callback({trechoId,motivo:'cancelado'});}
  };
  const handleInput=event=>{if(event.target?.id!=='nt-review-text')return;rascunho=event.target.value;updateEditor();const comparison=container.querySelector('.nt-review-draft');if(comparison)comparison.textContent=rascunho;if(message&&kind==='error')setMessage('');};
  function destruir(){if(destroyed)return;destroyed=true;epoch++;abortAll();container.removeEventListener('click',handleClick);container.removeEventListener('input',handleInput);container.replaceChildren();base=null;atual=null;rascunho='';historico=[];}
  container.addEventListener('click',handleClick);container.addEventListener('input',handleInput);
  render();loadInitial();
  return {destruir};
}
