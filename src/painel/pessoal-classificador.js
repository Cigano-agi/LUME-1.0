(() => {
  const parent=document.getElementById('pessoal-companion')?.parentElement;
  if(!parent)return;
  const box=document.createElement('details');box.id='pessoal-classificador';
  box.innerHTML=`<summary>Organizar com Jev · opcional</summary>
    <p>O Jev sugere o assunto, o andamento e o interesse comercial enquanto o Lume conversa. Você pode conferir as fontes e corrigir a avaliação.</p>
    <p id="classificador-status" role="status">Abra para conferir a conexão.</p>
    <form id="classificador-form">
      <label class="check"><input id="classificador-enabled" type="checkbox" disabled><span>Classificar novas mensagens das conversas autorizadas</span></label>
      <label>Limite mensal em dólares (US$)<input id="classificador-limit" type="number" min="0" max="1" step="0.001" value="0" required disabled></label>
      <p class="muted">Começa desligado, com limite zero. O Lume não faz recarga nem troca de provedor. O limite usa uma reserva conservadora por tentativa, inclusive quando uma chamada falha.</p>
      <p id="classificador-budget" class="muted"></p>
      <label class="check"><input id="classificador-consent" type="checkbox" disabled><span>Autorizo enviar até 20 mensagens por análise à OpenRouter / TypeSafe, nas conversas que liberei para contexto externo, usando somente o saldo e o limite que defini aqui.</span></label>
      <p class="muted">É um serviço separado da assinatura ChatGPT. A classificação não autoriza respostas, não confirma uma venda e não comprova entrega.</p>
      <div class="button-row"><button id="classificador-save" type="submit" class="secondary" disabled>Salvar classificação</button><button id="classificador-refresh" type="button" class="text-button">Atualizar estado</button></div>
    </form>
    <details><summary>Conectar uma chave própria</summary><p>A chave fica no cofre deste computador. Nenhuma credencial de outro aplicativo é importada.</p>
      <form id="classificador-key-form"><label>Chave OpenRouter<input id="classificador-key" type="password" autocomplete="off" maxlength="2048" required></label><button type="submit" class="secondary">Guardar chave no Lume</button></form>
      <button id="classificador-remove" type="button" class="text-button" hidden>Remover chave do Jev</button>
    </details><p id="classificador-result" role="status" aria-live="polite"></p>`;
  parent.insertBefore(box,document.getElementById('pessoal-atendimento'));
  const $=id=>document.getElementById('classificador-'+id);
  const request=(path,body)=>window.lumeConnectionRequest(path,body,{timeout:15000});
  let state=null,busy=false;
  const controls=()=>{
    $('enabled').disabled=busy||!state||(!state.configurada&&!state.enabled);
    $('limit').disabled=busy||!state;
    $('consent').disabled=busy||!state?.configurada;
    $('save').disabled=busy||!state||($('enabled').checked&&(!$('consent').checked||Number($('limit').value)<=0));
    $('refresh').disabled=busy;
    $('key-form').querySelector('button').disabled=busy;
    $('remove').disabled=busy;
  };
  function render(next){
    state=next;$('status').textContent=next.motivo||'Classificação indisponível.';
    $('enabled').checked=next.enabled===true;$('limit').value=String((next.limiteMensalMicrousd||0)/1000000);
    $('consent').checked=false;
    $('budget').textContent=`Reservado neste mês: US$ ${((next.reservadoMicrousd||0)/1000000).toFixed(6)}. Modelo: ${next.modelo||'indisponível'}.`;
    $('remove').hidden=!next.configurada;controls();
  }
  async function action(fn){
    if(busy)return;busy=true;controls();$('result').textContent='Conferindo…';
    try{await fn();$('result').textContent='Estado confirmado.';}
    catch(error){$('result').textContent=(error?.message||'Não foi possível concluir.')+' Atualize o estado antes de repetir.';}
    finally{busy=false;controls();}
  }
  const refresh=()=>action(async()=>render(await request('/api/v3/pessoal/classificador')));
  box.addEventListener('toggle',()=>{if(box.open&&!state&&!busy)void refresh();});
  $('refresh').onclick=()=>void refresh();
  for(const id of ['enabled','limit','consent'])$(id).addEventListener('input',controls);
  $('form').onsubmit=event=>{
    event.preventDefault();if(busy||$('save').disabled)return;
    const enabled=$('enabled').checked,limit=Number($('limit').value);
    if(!Number.isFinite(limit)||limit<0||limit>1||enabled&&(!$('consent').checked||!state?.configurada||limit<=0))return;
    void action(async()=>render(await request('/api/v3/pessoal/classificador',{enabled,confirmar:true,limiteMensalMicrousd:Math.round(limit*1000000)})));
  };
  $('key-form').onsubmit=event=>{
    event.preventDefault();if(busy)return;const chave=$('key').value;$('key').value='';
    void action(async()=>{await request('/api/v3/vendas/jev/configurar',{chave});render(await request('/api/v3/pessoal/classificador'));});
  };
  $('remove').onclick=()=>void action(async()=>{await request('/api/v3/vendas/jev/remover',{});render(await request('/api/v3/pessoal/classificador'));});
})();
