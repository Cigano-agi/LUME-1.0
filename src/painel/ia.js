// HTML fixo do produto. Toda entrada do usuário/modelo usa textContent.
const perguntaPainel = document.createElement('section');
perguntaPainel.className = 'panel ia-panel';
perguntaPainel.innerHTML = `<div class="panel-title"><div><p class="eyebrow">PERGUNTE AO LUME</p><h2>O que você quer saber?</h2></div><span class="pill">COM AS MENSAGENS USADAS</span></div>
<p id="ia-summary" class="muted">As perguntas são opcionais. A busca por palavras continua funcionando sem IA.</p>
<form id="ia-question-form"><label for="ia-question">Escreva como falaria com uma pessoa</label><textarea id="ia-question" rows="2" maxlength="600" required placeholder="Ex.: o que ficou para eu fazer hoje?"></textarea>
<div class="ia-filters"><div><label for="ia-conversation">Conversa</label><select id="ia-conversation"><option value="">Todas com IA autorizada</option></select></div><div><label for="ia-period">Período · Brasília</label><select id="ia-period"><option value="hoje">Hoje</option><option value="ontem">Ontem</option><option value="semana" selected>Esta semana</option><option value="30dias">Últimos 30 dias</option><option value="tudo">Todo o histórico recebido</option></select></div></div>
<div class="button-row"><button class="primary" id="ia-prepare">Ver mensagens usadas →</button><button type="button" class="text-button" id="ia-open-settings">Ativar perguntas</button></div></form>
<p id="ia-progress" role="status" aria-live="polite"></p><div id="ia-preview" hidden></div><div id="ia-answer" aria-live="polite"></div>`;
$('memory').insertBefore(perguntaPainel, $('search-form'));
const modoConsulta=element('div',null,'ia-filters');
modoConsulta.innerHTML='<div><label for="ia-mode">Como encontrar as fontes</label><select id="ia-mode"><option value="lexical">Por palavras · local</option><option value="hibrido">Palavras + significado · local</option><option value="denso">Por significado · local</option></select></div>';
$('ia-question-form').insertBefore(modoConsulta,$('ia-question-form').querySelector('.button-row'));
const contextoConsulta=element('label',null,'check ia-context-choice');
contextoConsulta.innerHTML='<input id="ia-neighbors" type="checkbox" checked><span>Incluir mensagens próximas para conferir a sequência<small>Até 15 minutos antes/depois, na mesma conversa e dentro do recorte. Você confere cada trecho antes de enviar. Proximidade não garante que seja o mesmo assunto.</small></span>';
$('ia-question-form').insertBefore(contextoConsulta,$('ia-question-form').querySelector('.button-row'));
const modoLocal=element('div',null,'filter-line');
modoLocal.innerHTML='<label for="local-search-mode">Busca local, sem Gemini</label><select id="local-search-mode"><option value="lexical">Por palavras</option><option value="denso">Por significado</option></select>';
$('memory').insertBefore(modoLocal,$('search-form'));
$('local-search-mode').onchange=()=>run(()=>search());
const configPainel = document.createElement('section'); configPainel.className = 'panel settings-card';
configPainel.innerHTML = `<h2>IA opcional, com limite</h2><p>As perguntas usam Gemini, do Google, só quando você confirma o envio. Autorize cada conversa abaixo. A permissão de leitura continua valendo.</p>
<form id="ia-config-form"><label for="ia-key">Sua chave Gemini</label><input id="ia-key" type="password" autocomplete="off" maxlength="200" placeholder="Cole sua chave; ela não será exibida novamente"><p id="ia-key-status" class="muted"></p>
<label for="ia-limit">Limite diário deste aplicativo · US$</label><input id="ia-limit" type="number" min="0" max="20" step="0.01" value="0.50" required>
<label class="check"><input id="ia-enabled" type="checkbox"><span>Ativar IA para perguntas e sugestões</span></label>
<label class="check"><input id="ia-ack" type="checkbox"><span>Entendo que pergunta e fontes escolhidas serão enviadas ao Google. Na modalidade gratuita, o provedor pode usar conteúdo para melhorar seus produtos; confira as condições da sua conta. Posso revogar os próximos envios.</span></label>
<div class="button-row"><button class="primary">Salvar configuração</button><button type="button" class="secondary" id="ia-remove-key">Remover chave e desativar</button></div></form>
<p id="ia-budget" class="muted"></p><p>O limite contabiliza reservas conservadoras, inclusive pedidos com erro. Ele não controla gastos de outros programas nem substitui a fatura do Google.</p>
<h3>Conversas que podem usar IA</h3><p>Autorizar uma conversa não liga a automação. Perguntas e geração manual de tarefas mostram os trechos antes do envio; sugestões automáticas exigem autorização adicional na seção própria. Revogar não remove do provedor dados já enviados.</p><div id="ia-policies"></div>`;
window.registrarAjuste(configPainel,'settings-ai','work');
const semanticaPainel=element('section',null,'panel settings-card');
semanticaPainel.innerHTML='<h2>Busca por significado, neste computador</h2><p>Encontre fontes mesmo usando outras palavras. Ativar baixa um modelo público de aproximadamente 135 MB do Hugging Face. As mensagens são processadas localmente; o download não envia suas conversas.</p><div class="button-row"><button class="secondary" id="semantic-enable">Baixar modelo e ativar</button><button class="text-button" id="semantic-pause">Pausar indexação</button></div><p id="semantic-progress" role="status" aria-live="polite"></p><p class="muted">Os resultados são aproximações de significado, não prova de que uma resposta é verdadeira. A busca por palavras continua disponível.</p>';
window.registrarAjuste(semanticaPainel,'settings-semantic','work');
let consultaSemantica=null;
function estadoSemantica(){
  if(consultaSemantica)return consultaSemantica;
  consultaSemantica=(async()=>{
  const s=await api('/api/v3/semantica');
  $('semantic-enable').disabled=s.disponivel===false||['baixando','carregando'].includes(s.etapa);
  $('semantic-progress').textContent=s.disponivel===false?'Modelo local indisponível neste ambiente.':`${s.etapa} · ${s.indexados} de ${s.total} fontes indexadas${s.arquivo?' · '+s.arquivo:''}${s.percentual!=null?' · '+s.percentual+'%':''}${s.erro?' · '+s.erro:''}`;
  return s;
  })().finally(()=>{consultaSemantica=null;});
  return consultaSemantica;
}
$('semantic-enable').onclick=()=>run(async()=>{await api('/api/v3/semantica/ativar',{baixar:true});await estadoSemantica();},$('semantic-enable'));
$('semantic-pause').onclick=()=>run(async()=>{await api('/api/v3/semantica/pausar',{});await estadoSemantica();},$('semantic-pause'));
setInterval(()=>{if(!$('settings').hidden&&!document.hidden&&semanticaPainel.getClientRects().length)run(estadoSemantica);},2500);
let previaIA = null,revisaoIA=0;
const usdIA = v => 'US$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
window.limparIA = () => { revisaoIA++;previaIA = null; $('ia-preview').hidden = true; $('ia-preview').replaceChildren(); $('ia-answer').replaceChildren(); $('ia-progress').textContent = ''; };
window.carregarIA = async () => {
  const revisao=revisaoDadosVisiveis;
  try {
    const estado = await api('/api/v3/ia/estado');
    await estadoSemantica();
    if(revisao!==revisaoDadosVisiveis)return;
    $('ia-summary').textContent = estado.habilitada ? `Perguntas ativadas · ${usdIA(estado.reservadoUSD)} reservados hoje de ${usdIA(estado.limiteUSD)}. Você vê as mensagens antes do envio.` : 'Perguntas desativadas. Ative quando quiser receber uma resposta; a busca por palavras continua disponível.';
    $('ia-prepare').disabled = !estado.habilitada;
    $('ia-enabled').checked = estado.habilitada; $('ia-limit').value = estado.limiteUSD;
    $('ia-key-status').textContent = !estado.protecaoDisponivel ? 'A proteção de credenciais não está disponível neste ambiente.' : estado.chaveConfigurada ? 'Chave guardada com proteção do sistema. Acesso ao provedor será conferido na primeira pergunta.' : 'A chave será guardada com proteção do sistema operacional.';
    $('ia-budget').textContent = `Reservado hoje: ${usdIA(estado.reservadoUSD)} · limite ${usdIA(estado.limiteUSD)} · tabela conferida em ${estado.preco.conferidoEm}.`;
    const selected = $('ia-conversation').value;
    $('ia-conversation').replaceChildren(new Option('Todas com IA autorizada', ''));
    for (const c of estado.conversas.filter(c => c.permitida)) $('ia-conversation').append(new Option(c.nome,c.id));
    if ([...$('ia-conversation').options].some(o => o.value === selected)) $('ia-conversation').value = selected;
    if (!estado.conversas.length) empty($('ia-policies'), 'Nenhuma conversa ainda.', 'Conecte o WhatsApp ou guarde uma nota primeiro.');
    else $('ia-policies').replaceChildren(...estado.conversas.map(c => {
      const label = element('label', null, 'check ia-policy'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(c.permitida); checkbox.setAttribute('aria-label', 'Autorizar IA para ' + c.nome);
      checkbox.onchange = () => run(async () => { try { await api('/api/v3/ia/permissao', { conversa: c.id, permitida: checkbox.checked }); window.limparIA(); window.limparTarefas?.(); await window.carregarIA(); await window.carregarConfigTarefas?.(); } catch(e) { checkbox.checked = !checkbox.checked; throw e; } },checkbox);
      label.append(checkbox,element('span',c.nome)); return label;
    }));
  } catch(e) { $('ia-summary').textContent = e.message; $('ia-prepare').disabled = true; }
};
$('ia-open-settings').onclick = () => run(() => window.abrirAjuste('settings-ai'));
$('ia-config-form').onsubmit = e => { e.preventDefault(); run(async () => {
  const data = { habilitada: $('ia-enabled').checked, limiteUSD: Number($('ia-limit').value), cienteEnvio: $('ia-ack').checked };
  if ($('ia-key').value.trim()) data.chave = $('ia-key').value.trim();
  try { await api('/api/v3/ia/config',data); window.limparIA(); $('ia-ack').checked = false; feedback('Configuração salva. Autorize as conversas que podem usar IA.'); }
  finally { $('ia-key').value = ''; await window.carregarIA(); }
},e.submitter); };
$('ia-remove-key').onclick = () => run(async () => { await api('/api/v3/ia/remover-chave',{}); window.limparIA(); window.limparTarefas?.(); await window.carregarIA(); await window.carregarConfigTarefas?.(); feedback('Chave removida e IA desativada.'); },$('ia-remove-key'));
for (const id of ['ia-question','ia-conversation','ia-period','ia-mode','ia-neighbors']) $(id).addEventListener('input',window.limparIA);
$('ia-question-form').onsubmit = e => { e.preventDefault(); run(async () => {
  window.limparIA();const revisao=revisaoIA; $('ia-progress').textContent = 'Buscando fontes autorizadas neste computador…';
  try {
    const p = await api('/api/v3/ia/preparar', { pergunta: $('ia-question').value, conversa: $('ia-conversation').value, periodo: $('ia-period').value, modo: $('ia-mode').value,contextoProximo:$('ia-neighbors').checked });
    if(revisao!==revisaoIA)return;
    if (p.insuficiente) { $('ia-progress').textContent = p.aviso; return; }
    previaIA = p; $('ia-progress').textContent = 'Prévia pronta. Nada enviado ainda.';
    const box = $('ia-preview'); box.hidden = false;
    box.append(element('h3', 'Confira o que será enviado'),element('p',p.aviso),element('p',`${p.fontes.length} fontes · reserva máxima estimada ${usdIA(p.reservaUSD)} · válida por 5 minutos.`));
    if(p.contexto?.ativado)box.append(element('p',`${p.contexto.adicionadas} ${p.contexto.adicionadas===1?'mensagem próxima acrescentada':'mensagens próximas acrescentadas'}. Esse contexto pode esclarecer ou contrariar o trecho encontrado; não prova que um combinado continua válido.`,'muted'));
    if(p.cobertura && p.recuperacao!=='lexical')box.append(element('p',`Busca ${p.recuperacao==='hibrido'?'por palavras e significado':'por significado'} · índice com ${p.cobertura.indexados}/${p.cobertura.total} fontes. Fontes aproximadas podem não responder à pergunta.`,'muted'));
    box.append(...p.fontes.map(f => { const row = element('details',null,'ia-evidence'); row.append(element('summary',`${f.fonte} · ${f.conversa_nome} · ${date(f.recebido_em)}${f.contextoProximo?' · contexto próximo':''}`),element('p',f.texto),element('small',`${f.autor_nome} · origem ${f.origem_id}${f.truncada ? ' · trecho parcial' : ''}`)); if(f.contextoProximo)row.append(element('small',`${f.contextoProximo.posicao==='antes'?'Antes':'Depois'} de ${f.contextoProximo.fonte} · ${Math.round(f.contextoProximo.intervaloSegundos/60)} min de distância. Confira se trata do mesmo assunto.`)); avisosDeFonte(row,f.avisos);return row; }));
    const controls=element('div',null,'button-row');controls.append(action('Confirmar envio e perguntar', enviarPerguntaIA, 'primary'), action('Cancelar', async () => window.limparIA()));box.append(controls);
  } catch(e) { if(revisao!==revisaoIA)return;$('ia-progress').textContent = e.message; throw e; }
},e.submitter); };
async function enviarPerguntaIA() {
  const p = previaIA,revisao=revisaoIA; if (!p) return;
  previaIA = null; $('ia-preview').hidden = true; $('ia-progress').textContent = 'Consultando Gemini com as fontes confirmadas…';
  try {
    const r = await api('/api/v3/ia/responder', { id: p.id, confirmar: true });
    if(revisao!==revisaoIA)return;
    const box = $('ia-answer'); box.replaceChildren(element('h3',r.insuficiente ? 'Faltou evidência.' : 'O que suas fontes indicam'),element('p',r.aviso,'muted'));
    for (const a of r.afirmacoes) {
      const f = r.fontes.find(f => f.fonte === a.fonte), row = element('article',null,'ia-claim');
      row.append(element('p',a.texto),element('blockquote',a.trecho),action(`${a.fonte} · Conferir fonte →`,async () => {
        const atual = await api('/api/v3/fonte?id='+f.id);
        if(revisao!==revisaoIA)return;
        window.lumeSetMemoryMode?.('search');
        $('results').replaceChildren(source(atual)); $('more').hidden = true;
        $('results').scrollIntoView({ behavior: 'auto', block: 'center' });
      })); box.append(row);
    }
    $('ia-progress').textContent = `Consulta encerrada · reserva ${usdIA(r.reservaUSD)}. A resposta não é salva em histórico de chat.`;
  } catch(e) { if(revisao!==revisaoIA)return;$('ia-answer').replaceChildren(); $('ia-progress').textContent = e.message; throw e; }
  finally { await window.carregarIA(); }
}
// Revisão de leitura invalida o conteúdo já mostrado nesta janela.
$('policies').addEventListener('change',window.limparIA);
