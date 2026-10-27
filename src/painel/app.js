const $ = id => document.getElementById(id);
let token, perfil, page = 'today', conversa = '', cursor = null, connecting = false, refreshing = false, qrVersaoVista = 0;
let toastTimer;
let revisaoDadosVisiveis=0, revisaoBusca=0;
let revisaoResumo=0, paginaAcoes=1, assinaturaFila='',filaAcoesAtual=null;
let tagHoje='',filtroTagsHoje=null;
let revisaoNavegacao=0;
let estadoConexaoAnterior;
const number = n => new Intl.NumberFormat('pt-BR').format(n);
const date = text => text ? new Date(text).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Sem data';
function feedback(text) {
  const node=$('feedback');node.textContent=text;clearTimeout(toastTimer);
  if(window.lumeToast)window.lumeToast(node,true);else node.hidden=false;
  toastTimer=setTimeout(()=>{if(window.lumeToast)window.lumeToast(node,false);else node.hidden=true;},4500);
}
function atualizarTexto(id,texto,assinatura=texto){
  const node=typeof id==='string'?$(id):id;if(!node||node.textContent===texto)return false;
  node.textContent=texto;window.lumeChanged?.(node,assinatura);return true;
}
function atualizarConexaoCabecalho(estado,rotulo,compacto){
  const controle=$('connection');
  controle.dataset.state=estado;
  controle.setAttribute('aria-label',rotulo);
  controle.replaceChildren(
    element('span',null,'connection-dot'),
    element('span',rotulo,'connection-label'),
    element('span',compacto,'connection-compact-label')
  );
  controle.querySelector('.connection-dot').setAttribute('aria-hidden','true');
}
async function api(path, body) {
  const headers = token ? { 'X-Assessor-Token': token } : {};
  const signal=AbortSignal.timeout(body===undefined?45000:125000);
  let response;
  try {response = await fetch(path, body === undefined ? { headers,signal } : { method: 'POST',signal, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });}
  catch(error){if(signal.aborted)throw new Error(body===undefined?'Esta consulta demorou. Tente atualizar novamente.':'A operação demorou. Confira o estado antes de repetir.');throw error;}
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.erro || 'Não foi possível concluir. Tente novamente.');
    error.status = response.status;
    error.code = typeof value.codigo === 'string' ? value.codigo : null;
    throw error;
  }
  return value;
}
function element(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
const tiposAcao=Object.freeze({lead:'Oportunidade',compromisso:'Compromisso',pendencia:'Pendência',decisao:'Decisão'});
function tipoAcao(tipo,label){return{chave:Object.hasOwn(tiposAcao,tipo)?tipo:'acao',label:tiposAcao[tipo]||label||'Ação'};}
const ajustesCatalogo=Object.freeze({
  'ls-activity':{grupo:'data',ordem:15},'ls-gallery':{grupo:'appearance',ordem:15},
  'settings-whatsapp':{grupo:'connections',ordem:10},'mcp-panel':{grupo:'connections',ordem:28},'pessoal-panel':{grupo:'connections',ordem:24},'telegram-hoje-panel':{grupo:'connections',ordem:25},'central-panel':{grupo:'connections',ordem:30},
  'settings-reading':{grupo:'work',ordem:10},'settings-ai':{grupo:'work',ordem:20},'settings-semantic':{grupo:'work',ordem:30},'settings-actions':{grupo:'work',ordem:35},'settings-tasks':{grupo:'work',ordem:40},'lembretes-panel':{grupo:'work',ordem:50},'settings-note':{grupo:'work',ordem:60},
  'settings-guide':{grupo:'appearance',ordem:10},'dados-panel':{grupo:'data',ordem:20},'f10-panel':{grupo:'data',ordem:30},'atualizacoes-panel':{grupo:'data',ordem:40},'novidades-panel':{grupo:'data',ordem:50},'settings-about':{grupo:'data',ordem:60}
});
function registrarAjuste(card,id,grupo){
  const contrato=ajustesCatalogo[id];
  if(!card||!contrato||contrato.grupo!==grupo)throw new Error('Cartão de Ajustes sem destino conhecido: '+id);
  const destino=$('settings-group-'+grupo+'-cards');
  if(!destino)throw new Error('Grupo de Ajustes ausente: '+grupo);
  card.id=id;card.dataset.settingsCard='';card.dataset.settingsGroup=grupo;card.dataset.settingsOrder=String(contrato.ordem);
  destino.append(card);
  [...destino.querySelectorAll(':scope > .settings-card')].sort((a,b)=>Number(a.dataset.settingsOrder)-Number(b.dataset.settingsOrder)).forEach(node=>destino.append(node));
  return card;
}
window.registrarAjuste=registrarAjuste;
function mostrarEscolhasAjustes({focar=false}={}){
  const home=$('settings-home');if(!home)return;
  home.hidden=false;
  document.querySelectorAll('[data-settings-group-panel]').forEach(group=>group.hidden=true);
  document.querySelectorAll('.settings-choice[data-settings-group]').forEach(button=>button.setAttribute('aria-expanded','false'));
  if(focar){home.scrollIntoView({block:'start'});$('settings-choice-connections')?.focus({preventScroll:true});}
}
function abrirGrupoAjustes(grupo,{focarTitulo=false}={}){
  const panel=$('settings-group-'+grupo),button=document.querySelector(`.settings-choice[data-settings-group="${grupo}"]`);
  if(!panel||!button)return false;
  $('settings-home').hidden=true;
  document.querySelectorAll('[data-settings-group-panel]').forEach(group=>group.hidden=group!==panel);
  document.querySelectorAll('.settings-choice[data-settings-group]').forEach(choice=>choice.setAttribute('aria-expanded',String(choice===button)));
  if(focarTitulo){const heading=panel.querySelector('.settings-group-title');heading?.focus({preventScroll:true});panel.scrollIntoView({block:'start'});}
  window.lumeReveal?.(panel);
  void carregarGrupoAjustes(grupo).catch(error=>feedback(error.message));
  return true;
}
let carregamentoCentralAjustes=Promise.resolve();
const carregamentosAjustes=new Map();
function carregarGrupoAjustes(grupo){
  if(carregamentosAjustes.has(grupo))return carregamentosAjustes.get(grupo);
  const loaders=grupo==='connections'
    ?[status,()=>window.carregarPessoal?.(),()=>window.carregarTelegram?.(),()=>window.carregarMcp?.(),()=>{carregamentoCentralAjustes=Promise.resolve(window.carregarCentral?.());return carregamentoCentralAjustes;}]
    :grupo==='work'?[settings,()=>window.carregarIA?.(),()=>window.carregarConfigTarefas?.(),()=>window.carregarPermissoesAcoes06?.(),()=>window.carregarLembretes?.()]
    :grupo==='appearance'?[]
    :[()=>window.carregarCompartilhamento?.(),()=>window.carregarDados?.(),()=>window.carregarAtualizacoes?.(),()=>window.carregarNovidades?.()];
  const loading=Promise.allSettled(loaders.map(load=>Promise.resolve().then(load))).then(results=>{
    const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  }).finally(()=>carregamentosAjustes.delete(grupo));
  carregamentosAjustes.set(grupo,loading);return loading;
}
window.abrirAjuste=async id=>{
  const contrato=ajustesCatalogo[id];if(!contrato)return false;
  const carregamento=show('settings',{manterAjuste:true});
  const card=$(id);if(!card||!abrirGrupoAjustes(contrato.grupo))return false;
  window.lumeScrollIntoView?.(card,{smooth:true,block:'start'})||card.scrollIntoView({block:'start'});
  const target=card.querySelector('h2')||card;target.tabIndex=-1;target.focus({preventScroll:true});
  if(id==='central-panel'){
    void carregamento.catch(error=>feedback(error.message||'Alguns ajustes não carregaram. O feedback continua disponível.'));
    await carregamentoCentralAjustes;
    return true;
  }
  await carregamento;
  await carregarGrupoAjustes(contrato.grupo);
  return true;
};
document.querySelectorAll('.settings-choice[data-settings-group]').forEach(button=>button.onclick=()=>abrirGrupoAjustes(button.dataset.settingsGroup,{focarTitulo:true}));
document.querySelectorAll('[data-settings-back]').forEach(button=>button.onclick=()=>mostrarEscolhasAjustes({focar:true}));
for(const card of document.querySelectorAll('[data-settings-card]')){
  if(card.id==='settings-guide')$('settings-group-appearance-cards').append(card);
  const contrato=ajustesCatalogo[card.id];
  if(!contrato||contrato.grupo!==card.dataset.settingsGroup)throw new Error('Contrato de Ajustes inválido: '+card.id);
}
function action(text, fn, cls = 'text-button') { const b = element('button', text, cls); b.type = 'button'; b.onclick = () => run(fn, b); return b; }
async function run(fn, button) { if (button) button.disabled = true; try { await fn(); } catch (e) { feedback(e.message); } finally { if (button) button.disabled = false; } }
function empty(target, title, description) { const box = element('div', null, 'empty'); box.append(element('span', '⌁', 'empty-icon'), element('h3', title), element('p', description)); target.replaceChildren(box); }
function avisosDeFonte(box,avisos=[]){
  if(!avisos.length)return;
  const aviso=element('div',null,'transcript-warning');aviso.append(element('b','Possível texto acrescentado por modelo'));
  for(const texto of avisos)aviso.append(element('p',texto));
  aviso.append(element('small','Sinais automáticos podem errar. Confira a fonte; ausência de aviso não prova fidelidade.'));box.append(aviso);
}
function source(message) {
  const box = element('article', null, 'source');
  const head = element('div', null, 'source-head');
  head.append(element('b', message.conversa_nome), element('time', date(message.recebido_em)));
  const text = element('p', message.texto||(message.tipo==='audio'?'Áudio sem transcrição.':null));
  box.append(head, text, element('small', `${message.autor_nome || 'Autor não identificado'} · ${message.permissao === 'minha' ? 'Sua mensagem' : message.permissao === 'dirigida' ? 'Dirigida a você' : message.permissao === 'compartilhado' ? 'Compartilhado' : 'Leitura ampliada'} · Mensagem ${message.origem_id}`));
  avisosDeFonte(box,message.transcricao?.sinais||message.avisos);
  if(message.documento)box.append(element('p',message.documento.estado==='extraido'?
    (message.documento.parcial?'Texto extraído parcialmente do documento. Confira o arquivo original.':'Texto extraído localmente do documento. Confira o arquivo original.'):
    (message.documento.estado==='sem_texto'?'Documento preservado, sem texto legível disponível.':'Documento preservado; leitura do conteúdo indisponível.'),'muted'));
  if(message.transcricao){
    box.append(element('p',message.transcricao.originalDisponivel?'Transcrição automática · original retornado pelo modelo disponível.':'Original retornado pelo modelo não preservado neste registro.','muted'));
    const detalhe=element('div',null,'transcript-proof');
    box.append(action('Conferir transcrição',async()=>{
      const revisao=revisaoDadosVisiveis;
      const atual=await api('/api/v3/fonte?id='+message.id);
      if(revisao!==revisaoDadosVisiveis||!box.isConnected)return;
      detalhe.replaceChildren();const t=atual.transcricao;
      if(!t){detalhe.append(element('p','Transcrição indisponível. Atualize a busca.'));return;}
      detalhe.append(element('h3','Texto tratado'),element('p',t.textoTratado??'Sem texto transcrito.'),element('h3','Original retornado pelo modelo'),element('p',t.textoOriginal??'Original não preservado neste registro.'));
      if(JSON.stringify(t.sinais)!==JSON.stringify(message.transcricao.sinais))avisosDeFonte(detalhe,t.sinais);
      detalhe.append(element('small','O original é a resposta textual do modelo, não uma prova de que essas palavras foram faladas.'));
      if(t.respostas?.length>1)for(const [i,r]of t.respostas.entries()){const d=element('details');d.append(element('summary','Resposta da tentativa '+(i+1)),element('p',r.textoOriginal));detalhe.append(d);}
      detalhe.append(action('Fechar comparação',()=>detalhe.replaceChildren()));
    }),detalhe);
  }
  const row = element('div',null,'button-row source-actions'); row.append(action('Abrir conversa →', () => openConversation(message.conversa_id, message.conversa_nome))); box.append(row);
  if(message.tipo==='audio')row.append(action(message.transcricao?'Transcrever novamente':'Transcrever áudio',()=>window.abrirTranscricao?.(message,box)));
  if(message.origem_compartilhamento){const origens=JSON.parse(message.origem_compartilhamento);box.append(element('small','Recebido por compartilhamento · '+[...new Set(origens.map(o=>o.pessoa+' · '+date(o.exportado_em)))].join('; ')));}
  if(Number.isSafeInteger(message.id)){row.append(action('Acompanhar negócio',()=>window.abrirNegocio?.(message.id)),action('Adicionar a projeto',()=>window.abrirProjetoDaFonte?.(message)),action('Criar nota vinculada',()=>window.notaVinculada(message)),action('Apagar do Lume',()=>window.excluirFonte(message.id)));}
  return box;
}
const leiturasModoMemoria=new Map();
window.carregarModoMemoria=()=>{
  const modo=$('memory').dataset.mode||'search';
  if(leiturasModoMemoria.has(modo))return leiturasModoMemoria.get(modo);
  const loaders={search:search,conversations:()=>window.carregarConversas?.(),contacts:()=>window.LumeUm?.pessoas?.()??window.carregarContatos?.(),
    ask:()=>window.carregarIA?.(),businesses:()=>window.carregarNegocios?.('memory'),
    projects:()=>window.carregarProjetos06?.(),commands:()=>window.carregarComandos?.()};
  const leitura=Promise.resolve().then(()=>loaders[modo]?.()).finally(()=>{if(leiturasModoMemoria.get(modo)===leitura)leiturasModoMemoria.delete(modo);});
  leiturasModoMemoria.set(modo,leitura);return leitura;
};
async function show(view,{manterAjuste=false,focarTitulo=false}={}) {
  if(view==='contacts'){window.lumeSetMemoryMode?.('contacts');view='memory';}
  if(!document.getElementById(view)?.classList.contains('view'))return revisaoNavegacao;
  const navigation=++revisaoNavegacao;
  const changed=page!==view;
  page = view;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== view);
  document.querySelectorAll('.sidebar nav button').forEach(b => {
    const active=b.dataset.view===view;
    b.classList.toggle('active',active);
    if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  });
  $('current-page').textContent = { today: 'Agora', memory: 'Memória', sales:'Vendas', deliveries:'Projetos', graph: 'Relações da memória', settings: 'Ajustes' }[view];
  window.dispatchEvent(new CustomEvent('lume:navigate',{detail:{view}}));
  // A route starts at its heading. Do this before async loading, never after a
  // user may already have scrolled; focus is kept separate from viewport motion.
  if(changed)window.scrollTo({top:0,behavior:'instant'});
  window.lumeSyncNavigation?.();
  if(view==='settings'&&!manterAjuste)mostrarEscolhasAjustes();
  const heading=$(view).querySelector('.page-heading h1,.page-heading h2');
  window.lumeReveal?.($(view).querySelector('.page-heading'));
  if(focarTitulo&&heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
  if(['today','sales','deliveries'].includes(view)&&window.LumeVivo){await window.LumeVivo.carregar(view);return navigation;}
  if (view === 'today') { window.configurarFiltroHoje?.(); await window.recarregarFiltroHoje?.(); await overview(); }
  if (view === 'memory') await window.carregarModoMemoria();
  if (view === 'graph') await graph();
  if (view === 'today') await window.carregarTarefas?.();
  if (view === 'today') await window.carregarAcoes06?.();
  if (view === 'today') await window.carregarNegocios?.(view);
  return navigation;
}
window.abrirHojeDoAviso=async()=>{if(page==='today'&&!$('today').hidden)return;await show('today');};
const resumosEmCurso=new Map();
let ultimaAtualizacaoHoje=0;
function overview() {
  const chave=JSON.stringify([revisaoDadosVisiveis,tagHoje,$('tasks-order').value,paginaAcoes]);
  if(resumosEmCurso.has(chave))return resumosEmCurso.get(chave);
  // Only the current selection shares work. Returning A→B→A starts a new A;
  // an abandoned promise must never reactivate B or suppress the last choice.
  resumosEmCurso.clear();
  const leitura=lerResumoHoje().then(resultado=>{ultimaAtualizacaoHoje=Date.now();return resultado;})
    .finally(()=>{if(resumosEmCurso.get(chave)===leitura)resumosEmCurso.delete(chave);});
  resumosEmCurso.set(chave,leitura);return leitura;
}
window.navegarLume=(view,options)=>show(view,options);
async function lerResumoHoje() {
  const revisao=revisaoDadosVisiveis, consulta=++revisaoResumo;
  const params=new URLSearchParams({ordem:$('tasks-order').value,pagina:paginaAcoes});
  if(tagHoje)params.set('tag',tagHoje);
  const clareza=await window.carregarClareza?.();
  if(revisao!==revisaoDadosVisiveis||consulta!==revisaoResumo)return;
  $('tasks').setAttribute('aria-busy','true');
  let data;
  try { data = await api('/api/v3/resumo?'+params); }
  catch(error) {
    if(revisao!==revisaoDadosVisiveis||consulta!==revisaoResumo)return;
    assinaturaFila='';filaAcoesAtual=null;$('tasks-count').textContent='Não foi possível atualizar as ações.';
    for(const id of ['stat-actions','stat-messages','stat-conversations','stat-today'])$(id).textContent='…';
    $('home-activity-title').textContent='Não foi possível atualizar';
    $('home-activity-detail').textContent='Seus dados continuam neste computador. Tente novamente.';
    $('home-last-source').textContent='Última atualização indisponível';
    $('tasks-prev').disabled=true;$('tasks-next').disabled=true;
    empty($('tasks'),'Não consegui carregar esta lista.','Tente novamente para conferir suas ações atuais.');
    $('tasks').append(action('Tentar novamente',overview,'secondary'));
    throw error;
  } finally { if(consulta===revisaoResumo)$('tasks').setAttribute('aria-busy','false'); }
  if(revisao!==revisaoDadosVisiveis||consulta!==revisaoResumo)return;
  atualizarTexto('stat-messages',number(data.mensagens),data.mensagens);atualizarTexto('stat-conversations',number(data.conversas),data.conversas);atualizarTexto('stat-today',number(data.hoje),data.hoje);
  window.atualizarPrimeirosPassos?.({mensagens:data.mensagensWhatsapp});
  const ultimaFonte=data.ultimaMensagemEm ? 'Última mensagem salva · '+date(data.ultimaMensagemEm) : 'Nenhuma mensagem salva ainda';
  atualizarTexto('last-sync',ultimaFonte);atualizarTexto('home-last-source',ultimaFonte);
  if(!data.mensagens){
    atualizarTexto('home-activity-title','Pronto para receber a primeira conversa');
    atualizarTexto('home-activity-detail','Conecte o WhatsApp para o Lume começar a acompanhar.');
  }else if(data.hoje){
    atualizarTexto('home-activity-title',number(data.hoje)+' '+(data.hoje===1?'mensagem nova hoje':'mensagens novas hoje'),data.hoje);
    atualizarTexto('home-activity-detail','O Lume guardou essas mensagens neste computador.');
  }else{
    atualizarTexto('home-activity-title','Nenhuma mensagem nova hoje');
    atualizarTexto('home-activity-detail','Nenhuma mensagem nova hoje. O histórico salvo continua disponível.');
  }
  const fila=data.fila;paginaAcoes=fila.pagina;filaAcoesAtual={...fila,quantidade:data.tarefas.length};
  atualizarTexto('stat-actions',number(clareza?.prioridades?.total??fila.total),clareza?.prioridades?.total??fila.total);
  const legacy=$('legacy-actions');
  if(legacy&&!legacy.dataset.manuallyToggled){legacy.open=fila.total>0;}
  $('tasks-rule').textContent=fila.explicacao;
  atualizarResumoAcoes();
  $('tasks-prev').disabled=fila.pagina<=1;$('tasks-next').disabled=fila.pagina>=fila.paginas;
  const assinatura=JSON.stringify([tagHoje,data.tarefas,fila]);
  if(assinatura!==assinaturaFila){
    assinaturaFila=assinatura;
    if (!data.tarefas.length) empty($('tasks'), 'Nenhum próximo passo neste filtro.', 'As sugestões que você aceitar aparecem aqui. Só marque resolvido quando tiver concluído a ação.');
    else $('tasks').replaceChildren(...data.tarefas.map(t => {
      const el = element('article', null, 'source task-action'),tipo=tipoAcao(t.tipo,t.prioridade.tipo);el.dataset.acao=t.id;el.dataset.actionType=tipo.chave;
      el.append(element('span',tipo.label,'action-type-label'),element('small',t.conversa_nome,'action-context'),element('p', t.resumo));
      if(t.origem_tipo==='comando')el.append(element('span',({aberta:'Feito',agendado:'Feito',revisar:'Precisa revisar',origem_removida:'Origem removida'})[t.estado]||'Feito','command-state'));
      const row = element('div', null, 'button-row');
      row.append(action('Ver origem', () => window.abrirFonteTarefa(t.evento_id)), action('Marcar resolvido', async () => { await api('/api/v3/resolver', { id: t.id }); await overview(); }, 'secondary'));
      el.append(row);return el;
    }));
    window.lumeChanged?.($('tasks'),assinatura);
  }
  if (!data.recentes.mensagens.length) empty($('recent'), 'Sua primeira mensagem aparece aqui.', 'Conecte seu WhatsApp em Ajustes ou guarde uma nota.');
  else $('recent').replaceChildren(...data.recentes.mensagens.slice(0, 2).map(source));
}
window.tagHojeAtual=()=>tagHoje;
window.revisaoNavegacaoAtual=()=>revisaoNavegacao;
window.paginaAtual=()=>page;
window.configurarFiltroHoje=()=>{
  if(filtroTagsHoje||!window.criarFiltroTags)return filtroTagsHoje;
  const target=element('div',null,'today-tag-filter');($('today-filter-slot')||$('today')).append(target);
  filtroTagsHoje=window.criarFiltroTags({id:'today-tag',label:'Filtrar ações e lembretes por tag',tipos:['tarefa','lembrete'],target,onChange:async value=>{
    tagHoje=value;paginaAcoes=1;assinaturaFila='';
    await Promise.all([overview(),window.carregarNegocios?.('today')]);
  }});
  return filtroTagsHoje;
};
window.limparFiltroHoje=()=>{tagHoje='';paginaAcoes=1;assinaturaFila='';revisaoResumo++;filtroTagsHoje?.clear();};
window.recarregarFiltroHoje=async()=>{
  window.configurarFiltroHoje();if(!filtroTagsHoje)return false;
  try{await filtroTagsHoje.load({notify:true});tagHoje=filtroTagsHoje.value;return true;}
  catch{tagHoje='';paginaAcoes=1;assinaturaFila='';await Promise.allSettled([overview(),window.carregarNegocios?.('today')]);feedback('Não foi possível atualizar as tags. Mostrando Hoje sem filtro.');return false;}
};
window.limparFilaAcoes=()=>{
  window.limparFiltroHoje?.();revisaoResumo++;paginaAcoes=1;assinaturaFila='';$('tasks').replaceChildren();$('tasks').setAttribute('aria-busy','false');
  $('stat-actions').textContent='…';
  $('tasks-count').textContent='Atualize para consultar o filtro atual.';$('tasks-prev').disabled=true;$('tasks-next').disabled=true;
};
function navegarAcoes(pagina){
  paginaAcoes=pagina;assinaturaFila='';$('tasks').replaceChildren();$('tasks-count').textContent='Carregando ações…';
  $('tasks-prev').disabled=true;$('tasks-next').disabled=true;
  return overview();
}
function atualizarResumoAcoes(){
  const fila=filaAcoesAtual,aberto=$('task-options').open,panel=$('today').querySelector('.attention-panel');
  panel.classList.toggle('task-list-expanded',aberto);
  if(!fila?.total){$('tasks-count').textContent='Nada precisa da sua atenção agora';return;}
  $('tasks-count').textContent=aberto
    ? `${number((fila.pagina-1)*fila.porPagina+1)}-${number((fila.pagina-1)*fila.porPagina+fila.quantidade)} de ${number(fila.total)} itens · página ${number(fila.pagina)} de ${number(fila.paginas)}`
    : `Mostrando até 3 de ${number(fila.total)} itens`;
}
async function openConversation(id, name) { window.lumeSetMemoryMode?.('people'); window.lumeSetPeopleMode?.('conversations'); conversa = id; $('search').value = ''; $('search-context').textContent = name; $('clear-filter').hidden = false; await show('memory'); window.lumeSetMemoryMode?.('people'); window.lumeSetPeopleMode?.('conversations'); }
async function search(append = false) {
  const revisao=revisaoDadosVisiveis,busca=++revisaoBusca;
  const results=$('results');
  const params = new URLSearchParams({ q: $('search').value, conversa });
  for(const key of ['pessoa','assunto','de','ate','tipo']){const value=$('lv-filter-'+key)?.value;if(value)params.set(key,value);}
  if (append && cursor) params.set('antes', cursor);
  const comFiltros=['pessoa','assunto','de','ate','tipo'].some(k=>params.has(k));
  const semantica = $('local-search-mode')?.value === 'denso'&&!comFiltros;
  if(comFiltros)$('search-context').textContent='Filtros aplicados à busca textual local · período em UTC.';
  if (semantica && !$('search').value.trim()) { empty(results,'Busque por uma ideia.','Escreva o que quer encontrar para comparar significados.'); $('more').hidden=true; return; }
  results.setAttribute('aria-busy','true');
  if(!append){
    const state=element('div',null,'conversation-state conversation-skeleton');
    state.append(element('h3','Buscando nas conversas…'),element('p','Só um instante.'));
    results.replaceChildren(state);
  }
  let data;
  try{data=await api((semantica ? '/api/v3/busca-semantica?' : '/api/v3/busca?') + params);}
  catch(error){
    if(revisao!==revisaoDadosVisiveis||busca!==revisaoBusca)return;
    const state=element('div',null,'conversation-state conversation-error');state.setAttribute('role','alert');
    state.append(element('h3','Não foi possível buscar agora.'),element('p','Sua busca anterior não está sendo mostrada como resultado novo.'),action('Tentar novamente',()=>search(append),'secondary'));
    if(append)results.append(state);else results.replaceChildren(state);
    $('more').hidden=true;return;
  }finally{
    if(revisao===revisaoDadosVisiveis&&busca===revisaoBusca)results.setAttribute('aria-busy','false');
  }
  if(revisao!==revisaoDadosVisiveis||busca!==revisaoBusca)return;
  if (semantica) $('search-context').textContent = `Por significado · ${data.cobertura.indexados} de ${data.cobertura.total} fontes indexadas. Resultados aproximados; confira a fonte.`;
  if (!append) results.replaceChildren();
  if (!data.mensagens.length && !append) empty(results, 'Não encontrei uma fonte aqui.', 'Tente um trecho menor ou confira se o histórico já chegou. A busca respeita a política de cada conversa.');
  else results.append(...data.mensagens.map(source));
  cursor = data.proximoAntes; $('more').hidden = !cursor;
}
async function graph() { await window.carregarGrafo?.(); }
async function settings() {
  const revisao=revisaoDadosVisiveis;
  const conversations = await api('/api/v3/conversas');
  if(revisao!==revisaoDadosVisiveis)return;
  $('terms-status').textContent = `Aceite registrado em ${date(perfil.aceitoEm)} · ${perfil.versaoTermos}`;
  if (!conversations.length) empty($('policies'), 'Suas conversas vão aparecer aqui.', 'Depois do pareamento e da chegada do histórico, você pode ajustar o recorte de cada conversa.');
  else $('policies').replaceChildren(...conversations.map(c => { const row = element('div', null, 'policy-row'), select = element('select'); select.setAttribute('aria-label', 'Leitura de ' + c.nome); for (const [v, label] of [['so-minhas', 'Só minhas e dirigidas'], ['tudo', 'Toda a conversa']]) { const option = element('option', label); option.value = v; option.selected = c.politica === v; select.append(option); } select.onchange = () => run(async () => { const anterior = c.politica; try { await api('/api/v3/politica', { conversa: c.id, politica: select.value }); c.politica = select.value; window.limparDadosVisiveis?.(); await settings(); await window.carregarConfigTarefas?.(); feedback('Política atualizada. As próximas consultas usarão este recorte.'); } catch (error) { select.value = anterior; throw error; } }, select); row.append(element('span', c.nome), select); return row; }));
}
async function status() {
  let data;
  try{data=await api('/api/estado');}
  catch(error){
    atualizarConexaoCabecalho('error','Não foi possível atualizar','Falha');
    const homeStatus=$('home-status'),assinatura=['error','Não foi possível atualizar','Tente atualizar em alguns instantes.','Tentar de novo'].join('|');
    if(homeStatus.dataset.motionSignature!==assinatura){homeStatus.dataset.state='error';homeStatus.dataset.motionSignature=assinatura;atualizarTexto('home-status-title','Não foi possível atualizar');atualizarTexto('home-status-detail','Tente atualizar em alguns instantes.');atualizarTexto('home-status-action','Tentar de novo');window.lumeChanged?.(homeStatus,assinatura);}
    window.lumeMascotState?.(homeStatus.querySelector('.lume-mascot'),'alert',assinatura);
    throw error;
  }
  const state = data.conexao;
  const connected = state.estado === 'conectada';
  $('reconnect').hidden=connected;
  $('disconnect').disabled=!['conectada','conectando','reconectando','aguardando_qr'].includes(state.estado);
  const codigoFechamento=Number(state.ultimoFechamento?.codigo);
  const diagnosticoConexao=state.estado==='reconectando'&&Number.isInteger(codigoFechamento)&&codigoFechamento>=100&&codigoFechamento<=599
    ?` Diagnóstico da última tentativa: código ${codigoFechamento}.`:'';
  const label={desconectada:'não conectado',conectando:'conectando…',aguardando_qr:'aguardando o celular',reconectando:'tentando reconectar…',erro:'conexão interrompida',falha:'conexão interrompida',auth_invalida:'precisa conectar novamente',substituida:'conexão substituída'}[state.estado]||'aguardando conexão';
  const problema={erro:'Não consegui conectar agora. Confira a internet e tente gerar o código novamente.',falha:'A conexão parou. Tente gerar o código novamente.',auth_invalida:'O WhatsApp encerrou esta sessão. Gere um novo código e conecte novamente pelo celular.',substituida:'Esta conexão foi aberta em outro lugar. Confira os aparelhos conectados no WhatsApp e tente novamente quando quiser usar o Lume aqui.'}[state.estado];
  const estadoCabecalho=connected?'connected':['conectando','reconectando'].includes(state.estado)?'working':state.estado==='aguardando_qr'?'waiting':problema?'error':'off';
  const rotuloCabecalho=connected?'WhatsApp conectado':estadoCabecalho==='working'?'WhatsApp conectando':estadoCabecalho==='waiting'?'WhatsApp aguardando o celular':estadoCabecalho==='error'?'WhatsApp precisa de atenção':'WhatsApp desconectado';
  const rotuloCompacto={connected:'Rodando',working:'Conectando',waiting:'Aguardando',off:'Desconectado',error:'Falha'}[estadoCabecalho];
  atualizarConexaoCabecalho(estadoCabecalho,rotuloCabecalho,rotuloCompacto);
  $('connection-detail').textContent = connected ? 'Conexão ativa. Confira a última mensagem salva para avaliar a captura; a conexão sozinha não confirma histórico completo.' : 'WhatsApp '+label+'. Conecte para receber novas mensagens.'+diagnosticoConexao;
  const homeStatus=$('home-status'),homeCopy=connected
    ?{state:'connected',title:'WhatsApp conectado',detail:'Confira a última mensagem salva em Atividade. Conexão ativa não confirma captura completa.',action:'Ver conexão'}
    :['conectando','reconectando'].includes(state.estado)
      ?{state:'working',title:'Conectando ao WhatsApp',detail:'O Lume está tentando retomar a leitura.'+diagnosticoConexao,action:'Ver conexão'}
      :state.estado==='aguardando_qr'
        ?{state:'waiting',title:'Falta concluir a conexão',detail:'Escaneie o QR code pelo celular para começar.',action:'Conectar'}
        :problema
          ?{state:'error',title:'A conexão precisa de atenção',detail:problema,action:'Corrigir'}
          :{state:'off',title:'WhatsApp não conectado',detail:'Conecte uma vez para o Lume começar a acompanhar.',action:'Conectar'};
  const assinaturaEstado=[homeCopy.state,homeCopy.title,homeCopy.detail,homeCopy.action].join('|');
  if(homeStatus.dataset.motionSignature!==assinaturaEstado){
    homeStatus.dataset.state=homeCopy.state;homeStatus.dataset.motionSignature=assinaturaEstado;
    $('home-status-title').textContent=homeCopy.title;$('home-status-detail').textContent=homeCopy.detail;$('home-status-action').textContent=homeCopy.action;
    window.lumeChanged?.(homeStatus,assinaturaEstado);
  }
  const conectouAgora=connected&&estadoConexaoAnterior!==undefined&&estadoConexaoAnterior!=='conectada';
  const estadoMascote=problema?'alert':estadoCabecalho==='working'?'processing':estadoCabecalho==='waiting'||estadoCabecalho==='off'?'attentive':conectouAgora?'success':'idle';
  window.lumeMascotState?.(homeStatus.querySelector('.lume-mascot'),estadoMascote,[state.estado,estadoMascote].join('|'));
  estadoConexaoAnterior=state.estado;
  window.atualizarPrimeirosPassos?.({conectada:connected});
  if (connecting) {
    if(problema){mostrarFalhaPareamento(problema);}
    else if (state.qrDisponivel) {
      $('pair-error').hidden=true;$('qr').parentElement.hidden=false;
      const versao=Number(state.qrVersao)||1,renovou=qrVersaoVista>0&&versao!==qrVersaoVista;
      if(versao!==qrVersaoVista){$('qr').src='/api/qr?v='+encodeURIComponent(versao);qrVersaoVista=versao;}
      $('qr').hidden=false;$('qr-status').hidden=true;
      $('qr-renewal').hidden=false;
      $('qr-renewal').textContent=renovou?'QR renovado. Escaneie este código novo. O anterior não funciona mais.':'Depois do primeiro escaneamento, o WhatsApp pode pedir para tocar em Continuar e escanear de novo.';
    } else if(!problema) {
      $('pair-error').hidden=true;$('qr').parentElement.hidden=false;$('qr').hidden=true;$('qr').removeAttribute('src');$('qr-status').hidden=false;$('qr-renewal').hidden=true;
      $('qr-status').textContent = connected ? 'WhatsApp conectado. Vamos encontrar sua primeira conversa.' : label==='conectando…'?'Preparando o código. Aguarde um momento.':'Gere um código para conectar. Ele aparecerá aqui quando estiver pronto.';
    }
    if (connected) { connecting = false; await enter(); feedback('WhatsApp conectado. As fontes vão chegar aos poucos.'); }
  }
}
function limparQr(){
  qrVersaoVista=0;$('qr').hidden=true;$('qr').removeAttribute('src');$('qr-renewal').hidden=true;$('qr-renewal').textContent='';
}
function mostrarFalhaPareamento(mensagem){
  limparQr();$('qr').parentElement.hidden=true;$('qr-status').hidden=true;
  $('pair-error').textContent=mensagem;$('pair-error').hidden=false;$('pair').textContent='Gerar outro QR';
}
function prepararNovoQr(){
  limparQr();$('pair-error').hidden=true;$('pair-error').textContent='';$('qr').parentElement.hidden=false;
  $('qr-status').hidden=false;$('qr-status').textContent='Preparando seu código…';
}
async function enter() {
  const fromOnboarding = !$('onboarding').hidden;
  $('onboarding').hidden = true; $('workspace').hidden = false;
  $('owner-name').textContent = perfil.nome; $('initial').textContent = perfil.nome.charAt(0).toUpperCase();
  $('greeting').textContent = perfil.nome.split(' ')[0] + ', seu dia com clareza.';
  $('date-label').textContent = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
  await show(page); await status();
  void window.LumePreferencias?.carregar();
  if(!perfil.guiaDispensado&&page==='today'&&$('first-use-heading').getClientRects().length)$('first-use-heading').focus({preventScroll:true});
  if(fromOnboarding){window.scrollTo({top:0,behavior:'instant'});document.querySelector('.workspace main')?.scrollTo({top:0,behavior:'instant'});}
}
window.addEventListener('focus',()=>{if(perfil?.aceito)void window.LumePreferencias?.carregar();});
function pairing() {
  connecting=true;$('workspace').hidden=true;$('onboarding').hidden=false;$('terms-step').hidden=true;$('connect-step').hidden=false;
  $('step-label').textContent='ETAPA 2 DE 3 · SEU WHATSAPP';$('pair').textContent='Gerar QR code';prepararNovoQr();$('qr-status').textContent='Seu espaço está pronto. Gere um QR para conectar.';
  document.querySelectorAll('[data-setup-step]').forEach(el=>{if(el.dataset.setupStep==='2')el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});
  $('connect-step').querySelector('h2').focus();window.lumeReveal?.($('connect-step'));
}
document.querySelectorAll('.sidebar nav [data-view]').forEach(b => b.onclick = () => run(() => show(b.dataset.view,{focarTitulo:true})));
$('accept-form').onsubmit = e => { e.preventDefault(); run(async () => { perfil = await api('/api/v3/aceite', { nome: $('owner').value, aceito: $('consent').checked, versao: perfil.versaoTermos }); pairing(); }, e.submitter); };
$('pair').onclick = () => run(async () => {
  prepararNovoQr();
  try {await api('/api/conectar',{});await status();}
  catch{mostrarFalhaPareamento('Não consegui conectar agora. Confira a internet e tente gerar o código novamente.');}
},$('pair'));
$('skip').onclick = () => run(async () => { connecting = false; await enter(); });
$('reconnect').onclick = () => { pairing(); run(status); };
$('disconnect').onclick = () => run(async () => { await api('/api/desconectar', {}); await status(); feedback('Captura pausada. Seu histórico foi preservado.'); }, $('disconnect'));
$('connection').onclick = () => run(() => window.abrirAjuste('settings-whatsapp'));
$('home-status-action').onclick = () => run(() => window.abrirAjuste('settings-whatsapp'), $('home-status-action'));
$('refresh').onclick = () => run(async () => {
  const mascot=$('home-status').querySelector('.lume-mascot');
  window.lumeMascotState?.(mascot,'processing','manual-refresh-'+Date.now());
  try {
    await window.recarregarFiltroHoje?.();await overview();await window.carregarTarefas?.();await window.carregarAcoes06?.();await window.carregarNegocios?.('today');await status();
  } catch(error) {
    // A atualização dos dados pode falhar antes de consultar a conexão. Consulte-a
    // mesmo assim para não deixar o indicador preso em “organizando”.
    try { await status(); } catch { /* status() já publica o estado de alerta */ }
    throw error;
  }
}, $('refresh'));
$('tasks-order').onchange=()=>run(()=>navegarAcoes(1));
$('tasks-prev').onclick=()=>run(()=>navegarAcoes(Math.max(1,paginaAcoes-1)));
$('tasks-next').onclick=()=>run(()=>navegarAcoes(paginaAcoes+1));
$('task-options').ontoggle=atualizarResumoAcoes;
$('open-graph').onclick = () => run(() => show('graph'));
$('open-memory').onclick = () => run(() => show('memory'));
$('search-form').onsubmit = e => { e.preventDefault(); run(() => search(), e.submitter); };
$('more').onclick = () => run(() => search(true), $('more'));
$('clear-filter').onclick = () => run(async () => { conversa = ''; $('search-context').textContent = 'Todas as conversas permitidas · busca textual local'; $('clear-filter').hidden = true; await Promise.all([search(),window.carregarConversas?.(),window.carregarContatos?.(),window.carregarNegocios?.('memory')]); });
$('note-form').onsubmit = e => { e.preventDefault(); run(async () => { await api('/api/v3/nota', { titulo: $('note-title').value, texto: $('note-text').value, fontes:window.fontesDaNota||[] }); $('note-form').reset(); window.fontesDaNota=[];$('nota-vinculo')?.remove();await overview(); feedback('Ideia guardada na sua memória.'); }, e.submitter); };
document.addEventListener('keydown', e => {
  const active=document.activeElement;
  const interactive=active?.closest?.('a[href],button,input,textarea,select,summary,[role="tab"],[contenteditable="true"]');
  if(!interactive&&!document.querySelector('dialog[open]')&&!$('workspace').hidden&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&['1','2','3','4','5'].includes(e.key)){
    e.preventDefault();run(()=>show({1:'today',2:'memory',3:'sales',4:'deliveries',5:'contacts'}[e.key],{focarTitulo:true}));
  }
});
const iniciarInterface=()=>run(async () => { ({ token } = await api('/api/sessao')); perfil = await api('/api/v3/perfil'); if (perfil.aceito) await enter(); else $('onboarding').hidden = false; });
// Defer scripts may still be downloading when session/profile GETs resolve.
// Navigation begins only after every shell and contextual module is registered.
if(document.readyState==='complete')iniciarInterface();
else document.addEventListener('DOMContentLoaded',iniciarInterface,{once:true});
setInterval(() => { if (refreshing || document.hidden) return; refreshing = true; run(async () => { try { await status(); if (!$('workspace').hidden && page === 'today'&&Date.now()-ultimaAtualizacaoHoje>=30000){if(window.LumeVivo){await window.LumeVivo.carregar('today');ultimaAtualizacaoHoje=Date.now();}else{await overview();await window.carregarTarefas?.({automatico:true});await window.carregarAcoes06?.({automatico:true});}} } finally { refreshing = false; } }); }, 6000);
