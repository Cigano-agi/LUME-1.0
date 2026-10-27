// Estrutura fixa. Mensagens, nomes e saída do modelo entram somente por textContent.
const tarefasPainel=element('section',null,'panel tarefas-panel');
tarefasPainel.innerHTML=`<div class="panel-title"><div><p class="eyebrow">DA CONVERSA PARA A AÇÃO</p><h2>O que ficou para fazer?</h2></div><span class="pill">VOCÊ REVISA</span></div>
<ol class="tarefas-passos"><li><b>1</b> Confira as fontes</li><li><b>2</b> Gere sugestões</li><li><b>3</b> Aceite ou descarte</li></ol>
<p id="tarefas-estado" class="muted"></p><form id="tarefas-form"><div class="ia-filters"><div><label for="tarefas-conversa">Conversa autorizada para IA</label><select id="tarefas-conversa" required><option value="">Escolha uma conversa</option></select></div><div><label for="tarefas-periodo">Período · Brasília</label><select id="tarefas-periodo"><option value="hoje">Hoje</option><option value="semana" selected>Esta semana</option><option value="30dias">Últimos 30 dias</option><option value="tudo">Todo o histórico recebido</option></select></div></div><div class="button-row"><button id="tarefas-preparar" class="primary">Conferir fontes →</button><button type="button" id="tarefas-configurar" class="text-button">Configurar IA e automação</button></div></form>
<p id="tarefas-progresso" role="status" aria-live="polite"></p><div id="tarefas-previa" hidden></div>
<div class="tarefas-lista-head"><h3>Sugestões para revisar</h3><select id="tarefas-filtro" aria-label="Estado das sugestões"><option value="pendente">A revisar</option><option value="aceita">Aceitas</option><option value="descartada">Descartadas</option></select></div><p class="muted">Mais recentes primeiro. Essa ordem não indica prioridade. Confira a conversa: uma ação pode já ter sido concluída fora deste recorte.</p><div id="tarefas-sugestoes"></div><button id="tarefas-mais" class="secondary" hidden>Mais sugestões</button>
<section class="command-destination" aria-labelledby="tarefas-comandos-heading"><h3 id="tarefas-comandos-heading">Tarefas do WhatsApp</h3><p class="muted">Criadas por comando e separadas das sugestões de IA.</p><div id="tarefas-comandos-filtro"></div><div id="tarefas-comandos"></div><p id="tarefas-comandos-total" class="muted" role="status"></p><button id="tarefas-comandos-mais" type="button" class="secondary" hidden>Mais tarefas do WhatsApp</button></section>`;
$('task-options').append(tarefasPainel);
const tarefasConfig=element('section',null,'panel settings-card');
tarefasConfig.innerHTML=`<h2>Sugestões automáticas, se você quiser</h2><p>Com o aplicativo aberto, analisa mensagens novas das conversas escolhidas e guarda sugestões para revisar. Não aceita tarefas, não responde no WhatsApp e não marca nada como concluído.</p><p id="tarefas-auto-status" role="status"></p>
<details id="tarefas-auto-details"><summary>Escolher conversas e limite</summary><form id="tarefas-auto-form"><label for="tarefas-auto-max">Máximo de lotes por dia · 1 a 10</label><input id="tarefas-auto-max" type="number" min="1" max="10" step="1" value="2" required><p class="muted">Até 32 fontes novas por lote, com até 16 fontes de contexto. Intervalo mínimo de 5 minutos; usa o mesmo orçamento diário das perguntas. Tentativas com erro também contam e pausam a automação. Só considera mensagens recebidas após autorizar cada conversa, nos últimos 30 dias.</p><div id="tarefas-auto-conversas"></div><label class="check"><input id="tarefas-auto-ativa" type="checkbox"><span>Ativar sugestões automáticas nas conversas marcadas.</span></label><label class="check"><input id="tarefas-auto-aceite" type="checkbox"><span>Autorizo o envio automático desses trechos ao Google, sem conferir cada lote antes. Entendo o uso do meu orçamento de IA e que preciso revisar as sugestões.</span></label><button class="primary">Salvar automação</button></form></details><button id="tarefas-auto-pausar" class="secondary">Pausar automação agora</button><p class="muted">Mudar permissões, excluir dados ou restaurar backup pausa a automação. Alterar o limite ou as conversas exige novo aceite para mantê-la ativa.</p>`;
window.registrarAjuste(tarefasConfig,'settings-tasks','work');
let revisaoTarefas=0,previaTarefas=null,cursorTarefas=null,tarefasCarregando=false,assinaturaListaTarefas='',paginasTarefas=1,revisaoTarefasComando=0,cursorTarefasComando=null;
const tarefasApi=(acao,data)=>api('/api/v3/tarefas/'+acao,data);
const progressoTarefas=text=>{$('tarefas-progresso').textContent=text;};
function limparPreviaTarefas(){revisaoTarefas++;previaTarefas=null;$('tarefas-previa').hidden=true;$('tarefas-previa').replaceChildren();progressoTarefas('');}
window.limparTarefas=()=>{limparPreviaTarefas();assinaturaListaTarefas='';cursorTarefas=null;paginasTarefas=1;revisaoTarefasComando++;cursorTarefasComando=null;tarefasTagFilter?.clear();$('tarefas-sugestoes').replaceChildren();$('tarefas-mais').hidden=true;$('tarefas-comandos').replaceChildren();$('tarefas-comandos-total').textContent='Atualize para consultar as tarefas por comando.';$('tarefas-comandos-mais').hidden=true;};
const tarefasTagFilter=window.criarFiltroTags({id:'tarefas-comandos-tag',label:'Filtrar tarefas por tag',tipos:['tarefa'],target:$('tarefas-comandos-filtro'),onChange:async()=>{revisaoTarefasComando++;cursorTarefasComando=null;await window.carregarTarefasComando();}});
const estadoComando={feito:'Feito',revisar:'Precisa revisar',nao_reconhecido:'Não reconhecido',nao_executado:'Não reconhecido',origem_removida:'Origem removida'};
function tarefaComandoCard(item){const card=element('article',null,'command-card');card.append(element('span',estadoComando[item.estado]||'Precisa revisar','command-state'),element('h4',item.efeito?.texto||'Tarefa para revisar'),element('small',date(item.criadoEm)),action('Abrir origem',()=>window.abrirFonteComando(item.eventoId),'secondary'));return card;}
window.carregarTarefasComando=async({append=false}={})=>{
 const request=++revisaoTarefasComando,dataRevision=revisaoDadosVisiveis;if(!append){cursorTarefasComando=null;$('tarefas-comandos').replaceChildren(element('p','Carregando tarefas do WhatsApp…','muted'));}
 try{await tarefasTagFilter.load({notify:false});if(request!==revisaoTarefasComando)return;const params=new URLSearchParams({tipo:'tarefa',limite:'20'});if(tarefasTagFilter.value)params.set('tag',tarefasTagFilter.value);if(append&&cursorTarefasComando)params.set('cursor',cursorTarefasComando);const result=await api('/api/v3/comandos?'+params);if(request!==revisaoTarefasComando||dataRevision!==revisaoDadosVisiveis)return;if(!append)$('tarefas-comandos').replaceChildren();if(!result.comandos.length&&!append)empty($('tarefas-comandos'),'Nenhuma tarefa por comando neste filtro.','Use #lume_tarefa no seu próprio WhatsApp.');else $('tarefas-comandos').append(...result.comandos.map(tarefaComandoCard));cursorTarefasComando=result.proximoCursor;$('tarefas-comandos-total').textContent=`${number(result.total)} tarefas por comando`;$('tarefas-comandos-mais').hidden=!cursorTarefasComando;}
 catch(error){if(request===revisaoTarefasComando){$('tarefas-comandos').replaceChildren(element('p',error.message),action('Tentar novamente',async()=>{await window.carregarTarefasComando();$('tarefas-comandos-heading').tabIndex=-1;$('tarefas-comandos-heading').focus();},'secondary'));$('tarefas-comandos-total').textContent='Não foi possível atualizar.';}throw error;}
};
window.abrirFonteTarefa=async id=>{
 const revisao=revisaoDadosVisiveis,rev=revisaoTarefas,navegacao=revisaoNavegacao,atual=await api('/api/v3/fonte?id='+id);
 if(revisao!==revisaoDadosVisiveis||rev!==revisaoTarefas||navegacao!==revisaoNavegacao)return;
 window.lumeSetMemoryMode?.('search');const destino=await show('memory');if(revisao!==revisaoDadosVisiveis||rev!==revisaoTarefas||destino!==revisaoNavegacao)return;window.lumeSetMemoryMode?.('search');
 revisaoBusca++;$('results').replaceChildren(source(atual));$('more').hidden=true;$('search-context').textContent='Fonte E'+id+' · '+atual.conversa_nome;$('results').scrollIntoView({block:'start'});
};
function cartaoSugestao(s){
 const card=element('article',null,'tarefa-sugestao');card.dataset.sugestao=s.id;
 card.append(element('small',s.tipo+' · '+s.conversa_nome+' · '+date(s.recebido_em)),element('h3',s.resumo),element('blockquote',s.trecho));
 if(s.prazo_citado)card.append(element('p','Prazo citado: “'+s.prazo_citado+'”. Confira a data na conversa.','muted'));
 const row=element('div',null,'button-row');row.append(action('Conferir fonte E'+s.evento_id,()=>window.abrirFonteTarefa(s.evento_id)));
 if(s.estado==='pendente')for(const[acao,label,cls]of[['aceitar','Aceitar tarefa','secondary'],['descartar','Descartar','text-button']])row.append(action(label,async()=>{
   const rev=revisaoTarefas,r=await tarefasApi('decidir',{id:s.id,acao});if(rev!==revisaoTarefas)return;
   assinaturaListaTarefas='';paginasTarefas=1;await window.carregarTarefas();await overview();progressoTarefas(acao==='aceitar'?'Revisão registrada. '+r.aviso:'Sugestão descartada. A mensagem de origem foi preservada.');
 },cls));
 else row.append(element('small',s.estado==='aceita'?'Revisada e aceita em '+date(s.revisada_em):'Descartada em '+date(s.revisada_em)));
 card.append(row);return card;
}
window.carregarTarefas=async({append=false,automatico=false}={})=>{
 if(tarefasCarregando||automatico&&(paginasTarefas>1||previaTarefas||tarefasPainel.contains(document.activeElement)))return;
 tarefasCarregando=true;const rev=revisaoTarefas,dadosRev=revisaoDadosVisiveis,filtro=$('tarefas-filtro').value;
 try{
  const params=new URLSearchParams({estado:filtro});if(append&&cursorTarefas)params.set('antes',cursorTarefas);
  const[s,r]=await Promise.all([tarefasApi('estado'),api('/api/v3/tarefas?'+params)]);
  if(rev!==revisaoTarefas||dadosRev!==revisaoDadosVisiveis||filtro!==$('tarefas-filtro').value)return;
  $('tarefas-estado').textContent=(s.iaHabilitada?'IA disponível · ':'Ative a IA e autorize uma conversa em Ajustes. ')+(s.ativa?'Automação ativa · '+s.lotesHoje+'/'+s.maxLotesDia+' lotes hoje.':'Automação desligada. Cada geração manual exige confirmação.');
  $('tarefas-preparar').disabled=!s.iaHabilitada||s.ocupado;
  const select=$('tarefas-conversa'),old=select.value;select.replaceChildren(new Option('Escolha uma conversa',''));for(const c of s.conversas.filter(c=>c.ia))select.append(new Option(c.nome,c.id));select.value=[...select.options].some(o=>o.value===old)?old:'';
  const signature=JSON.stringify([filtro,r.sugestoes]);
  if(append){$('tarefas-sugestoes').append(...r.sugestoes.map(cartaoSugestao));paginasTarefas++;assinaturaListaTarefas='';}
  else if(signature!==assinaturaListaTarefas){paginasTarefas=1;assinaturaListaTarefas=signature;if(!r.sugestoes.length)empty($('tarefas-sugestoes'),'Nenhuma sugestão neste estado.',filtro==='pendente'?'Escolha uma conversa e confira as fontes para começar. Sugestões com fontes alteradas ou sem permissão ficam indisponíveis.':'As revisões que você fizer aparecerão aqui.');else $('tarefas-sugestoes').replaceChildren(...r.sugestoes.map(cartaoSugestao));}
  cursorTarefas=r.proximoAntes;$('tarefas-mais').hidden=!r.mais;
  if(!automatico)await window.carregarTarefasComando();
 }finally{tarefasCarregando=false;}
};
window.carregarConfigTarefas=async()=>{
 const rev=revisaoTarefas,dadosRev=revisaoDadosVisiveis,s=await tarefasApi('estado');if(rev!==revisaoTarefas||dadosRev!==revisaoDadosVisiveis)return;
 $('tarefas-auto-status').textContent=(s.ativa?'Ativa':'Desligada')+' · '+s.lotesHoje+'/'+s.maxLotesDia+' lotes tentados hoje.'+(s.erro?' '+s.erro:'');
 $('tarefas-auto-max').value=s.maxLotesDia;$('tarefas-auto-ativa').checked=s.ativa;$('tarefas-auto-aceite').checked=false;
 const authorized=s.conversas.filter(c=>c.ia);$('tarefas-auto-conversas').replaceChildren(...authorized.map(c=>{const label=element('label',null,'check ia-policy'),input=element('input');input.type='checkbox';input.value=c.id;input.checked=Boolean(c.automatica);input.setAttribute('aria-label','Automação para '+c.nome);label.append(input,element('span',c.nome));return label;}));
 if(!authorized.length)$('tarefas-auto-conversas').append(element('p','Autorize as conversas na seção de IA para selecioná-las aqui.'));
};
$('tarefas-configurar').onclick=()=>run(()=>window.abrirAjuste('settings-tasks'));
for(const id of ['tarefas-conversa','tarefas-periodo'])$(id).addEventListener('change',limparPreviaTarefas);
$('tarefas-filtro').onchange=()=>{window.limparTarefas();run(()=>window.carregarTarefas());};
$('tarefas-mais').onclick=()=>run(()=>window.carregarTarefas({append:true}),$('tarefas-mais'));
$('tarefas-comandos-mais').onclick=()=>run(()=>window.carregarTarefasComando({append:true}),$('tarefas-comandos-mais'));
$('tarefas-form').onsubmit=e=>{e.preventDefault();run(async()=>{
 limparPreviaTarefas();const rev=revisaoTarefas;progressoTarefas('Preparando fontes neste computador…');
 try{const p=await tarefasApi('preparar',{conversa:$('tarefas-conversa').value,periodo:$('tarefas-periodo').value});if(rev!==revisaoTarefas)return;
  if(p.vazio){progressoTarefas(p.aviso);return;}previaTarefas=p;progressoTarefas('Prévia pronta. Nada enviado ainda.');
  const box=$('tarefas-previa');box.hidden=false;box.replaceChildren(element('h3','Confira antes de gerar'),element('p',p.total+' fontes novas + '+p.contexto+' de contexto · reserva máxima estimada '+usdIA(p.reservaUSD)),element('p',p.aviso));
  if(p.mais)box.append(element('p','Há mais fontes para analisar. Este lote contém as 32 mais recentes ainda não analisadas; você pode preparar outro depois.','tarefas-alerta'));
  for(const f of p.fontes){const d=element('details',null,'ia-evidence');d.append(element('summary',f.fonte+' · '+(f.analisar?'Nova para análise':'Contexto')+' · '+date(f.recebido_em)+(f.truncada?' · parcial':'')),element('p',f.texto));avisosDeFonte(d,f.avisos);box.append(d);}
  box.append(action('Confirmar envio e gerar sugestões',async()=>{
   if(!previaTarefas)return;const id=previaTarefas.id,revision=revisaoTarefas;previaTarefas=null;box.hidden=true;progressoTarefas('Gerando sugestões com as fontes confirmadas…');
   try{const r=await tarefasApi('gerar',{id,confirmar:true});if(revision!==revisaoTarefas)return;assinaturaListaTarefas='';$('tarefas-filtro').value='pendente';await window.carregarTarefas();progressoTarefas(r.novos+' novas sugestões · '+r.analisadas+' fontes analisadas. '+r.aviso+(r.mais?' Há mais fontes: prepare outro lote quando quiser.':''));}
   catch(err){if(revision!==revisaoTarefas)return;progressoTarefas(err.message);throw err;}
  },'primary'),action('Cancelar',limparPreviaTarefas));
 }catch(err){if(rev!==revisaoTarefas)return;progressoTarefas(err.message);throw err;}
},e.submitter);};
$('tarefas-auto-form').onsubmit=e=>{e.preventDefault();run(async()=>{
 const data={ativa:$('tarefas-auto-ativa').checked,maxLotesDia:Number($('tarefas-auto-max').value),conversas:[...$('tarefas-auto-conversas').querySelectorAll('input:checked')].map(i=>i.value),cienteEnvioAutomatico:$('tarefas-auto-aceite').checked};
 await tarefasApi('config',data);window.limparIA?.();window.limparTarefas();await window.carregarConfigTarefas();feedback(data.ativa?'Automação ativada. Novas mensagens poderão ser enviadas nos limites escolhidos.':'Automação desligada.');
},e.submitter);};
$('tarefas-auto-pausar').onclick=()=>run(async()=>{await tarefasApi('pausar',{});window.limparIA?.();window.limparTarefas();await window.carregarConfigTarefas();feedback('Automação pausada; análises pendentes foram canceladas.');},$('tarefas-auto-pausar'));
