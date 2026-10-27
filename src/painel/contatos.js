(() => {
  const box=element('section',null,'contact-workspace');box.id='contacts';
  box.innerHTML=`<details id="contact-directory"><summary>Pessoas nas conversas</summary><p class="muted contact-intro">Nomes iguais ficam separados até haver um vínculo registrado.</p><div id="contact-browse"><p id="contact-order" class="contact-order" role="status"></p><div id="contact-list" class="contact-list"></div><div id="contact-pages" class="tasks-pagination"></div><details id="contact-filters" class="contact-filters"><summary>Buscar e filtrar pessoas</summary><form id="contact-filter" class="conversation-filters"><label>Período<select id="contact-period"><option value="semana">Últimos 7 dias</option><option value="30dias">Últimos 30 dias</option><option value="tudo">Todo o histórico salvo</option></select></label><label>Nome do contato<input id="contact-name" maxlength="200" placeholder="Quem você procura?"></label><button class="secondary">Buscar contato</button></form></details></div><section id="contact-detail" hidden aria-label="Ficha do contato"></section></details>`;
  document.querySelector('.conversation-workspace').before(box);
  let revision=0,selected='',listPage=1,conversationPage=1,messagePage=1,businessPage=1,lastList=[];
  const tagSlot=element('div');tagSlot.id='contact-tag-filter';$('contact-filter').insertBefore(tagSlot,$('contact-filter').lastElementChild);
  const tagFilter=window.criarFiltroTags({id:'contact-tag',label:'Tag',tipos:['contato'],target:tagSlot,onChange:async()=>{listPage=1;await load();}});
  const stages={interesse:'Interesse',proposta:'Proposta',conversa:'Conversa em andamento',fechado:'Fechado',encerrado:'Encerrado'};
  function pagination(target,p,move,label,singular=label){
    target.append(element('p',`${number(p.total)} ${p.total===1?singular:label} · página ${p.numero} de ${p.paginas}`,'muted'));
    if(p.paginas<=1)return;
    const row=element('div',null,'button-row'),before=action('Anterior',()=>move(p.numero-1),'secondary'),after=action('Próxima',()=>move(p.numero+1),'secondary');
    before.disabled=p.numero<=1;after.disabled=p.numero>=p.paginas;
    before.setAttribute('aria-label','Página anterior de '+label);after.setAttribute('aria-label','Próxima página de '+label);
    row.append(before,after);target.append(row);
  }
  const focus=()=>{const target=$('contact-heading')||$('contact-directory').querySelector('summary');target.focus();};
  async function open(id){selected=id;conversationPage=1;messagePage=1;businessPage=1;await load();focus();}
  async function load(){
    const captured=++revision,dataRevision=revisaoDadosVisiveis,contact=selected;
    box.hidden=Boolean(conversa);
    const valid=()=>captured===revision&&dataRevision===revisaoDadosVisiveis&&contact===selected&&!conversa;
    $('contact-list').replaceChildren();$('contact-pages').replaceChildren();$('contact-detail').replaceChildren();
    if(conversa)return;
    $('contact-browse').hidden=Boolean(contact);$('contact-detail').hidden=!contact;
    const target=contact?$('contact-detail'):$('contact-list');target.replaceChildren(element('p','Carregando contatos…','muted'));target.setAttribute('aria-busy','true');
    try{
      if(!contact)await tagFilter.load({notify:false});if(!valid())return;
      const q=new URLSearchParams(contact?{contato:contact,paginaConversas:conversationPage,paginaMensagens:messagePage,paginaNegocios:businessPage}:{q:$('contact-name').value,periodo:$('contact-period').value,pagina:listPage,...(tagFilter.value?{tag:tagFilter.value}:{})});
      const d=await api('/api/v3/contatos'+(contact?'/detalhe':'')+'?'+q);if(!valid())return;
      target.replaceChildren();
      if(!contact){
        listPage=d.pagina.numero;lastList=d.contatos;
        const label={semana:'Últimos 7 dias', '30dias':'Últimos 30 dias',tudo:'Todo o histórico salvo'}[d.periodo]||'Período indisponível';
        const format=iso=>new Date(iso).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'});
        const dates=d.janela?.inicio?` · ${format(d.janela.inicio)} a ${format(d.janela.fim)}`:'';
        $('contact-order').textContent=`${label}${dates} (horário deste computador). Primeiro, compromissos confirmados com fonte atual; depois, mensagens no período e última interação.`;
        if(!d.contatos.length)empty(target,'Nenhuma pessoa neste recorte.','Tente outro período ou nome. Só aparecem mensagens que você pode consultar.');
        for(const c of d.contatos){
          const card=element('article',null,'contact-card');
          const head=element('div',null,'contact-card-head'),initials=element('span',c.nome.split(/\s+/u).slice(0,2).map(part=>[...part][0]||'').join('').toLocaleUpperCase('pt-BR'),'contact-initials');initials.setAttribute('aria-hidden','true');
          head.append(initials,element('h3',c.nome));card.append(head);
          if(c.compromissoPendenteComprovado)card.append(element('p','Compromisso confirmado · fonte atual','contact-commitment'));
          if(c.projetoComprovado)card.append(element('p','Projeto confirmado · '+c.projetoComprovado.nome,'contact-project'));
          card.append(element('p',`${number(c.mensagensPeriodo)} ${c.mensagensPeriodo===1?'mensagem':'mensagens'} no período · ${number(c.conversas)} ${c.conversas===1?'conversa':'conversas'} no histórico`,'muted'));
          card.append(element('small','Última interação salva: '+date(c.ultimaMensagemEm)));
          const links=element('div',null,'contact-card-actions');
          if(c.compromissoFonteId)links.append(action('Ver compromisso',()=>window.abrirFonteTarefa(c.compromissoFonteId),'text-button'));
          else if(c.fonteId)links.append(action('Ver mensagem',()=>window.abrirFonteTarefa(c.fonteId),'text-button'));
          if(c.projetoComprovado)links.append(action('Ver fonte do projeto',()=>window.abrirFonteTarefa(c.projetoComprovado.fonteId),'text-button'));
          links.append(action('Ver contato',()=>open(c.id),'secondary'));card.append(links);target.append(card);
        }
        pagination($('contact-pages'),d.pagina,async n=>{listPage=n;await load();focus();},'contatos','contato');
        return;
      }
      conversationPage=d.paginaConversas.numero;messagePage=d.paginaMensagens.numero;businessPage=d.paginaNegocios.numero;
      const head=element('div',null,'conversation-detail-head'),heading=element('h2',d.nome);heading.id='contact-heading';heading.tabIndex=-1;
      head.append(heading,action('Voltar aos contatos',()=>open(''),'secondary'));target.append(head);
      const current=lastList.find(c=>c.id===contact);
      if(current){const period={semana:'últimos 7 dias','30dias':'últimos 30 dias',tudo:'todo o histórico salvo'}[$('contact-period').value];
        target.append(element('p',`${number(current.mensagensPeriodo)} mensagens em ${period} · última interação salva ${date(current.ultimaMensagemEm)}.`, 'muted'));
        if(current.compromissoFonteId)target.append(action('Ver fonte do compromisso',()=>window.abrirFonteTarefa(current.compromissoFonteId),'secondary'));
      }
      if(d.projetoComprovado){
        target.append(element('p','Projeto confirmado · '+d.projetoComprovado.nome,'contact-project'));
        target.append(action('Ver fonte do projeto',()=>window.abrirFonteTarefa(d.projetoComprovado.fonteId),'secondary'));
      }
      const identity=element('details',null,'contact-identity');identity.append(element('summary','Identificação'));for(const id of d.identificadores)identity.append(element('code',id));target.append(identity);
      const groups=element('section',null,'contact-section');groups.id='contact-conversations';groups.append(element('h3','Conversas'));
      for(const c of d.conversas){const row=element('article',null,'contact-row');row.append(element('b',c.nome),element('small',`${number(c.mensagens)} mensagens com este contato`),action('Abrir conversa',()=>openConversation(c.id,c.nome),'secondary'));groups.append(row);}
      pagination(groups,d.paginaConversas,async n=>{conversationPage=n;await load();focus();},'conversas do contato','conversa do contato');
      const businesses=element('section',null,'contact-section');businesses.id='contact-businesses';businesses.append(element('h3','Negócios ligados'),element('p','A ligação é com a mensagem. Confira quem é o cliente.','muted'));
      if(!d.negocios.length)businesses.append(element('p','Nenhum negócio ligado a estas mensagens.','muted'));
      for(const n of d.negocios){const row=element('article',null,'contact-row');row.append(element('b',n.titulo),element('span',stages[n.etapa],'negocio-stage'));if(n.valor_centavos!==null)row.append(element('p',new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n.valor_centavos/100)));row.append(action('Rever negócio',()=>window.abrirNegocio(n.evento_id),'secondary'));businesses.append(row);}
      pagination(businesses,d.paginaNegocios,async n=>{businessPage=n;await load();focus();},'negócios ligados às mensagens','negócio ligado às mensagens');
      const messages=element('section',null,'contact-section');messages.id='contact-messages';messages.append(element('h3','Mensagens'),element('p','Mensagens da pessoa e mensagens da conversa direta com ela.','muted'));
      for(const m of d.mensagens){
        const row=element('article',null,'contact-message'),proof=element('div');proof.hidden=true;
        row.append(element('small',`${m.conversa_nome} · ${date(m.recebido_em)}${m.autor_e_dono?' · Você':''}`));
        if(m.transcricao)row.append(element('small','Transcrição automática · confira o áudio.','contact-transcript-label'));
        row.append(element('p',m.texto||'Mensagem sem texto.'));
        if(m.avisos?.length||m.transcricao?.sinais?.length)row.append(element('small','O texto pode conter algo acrescentado pelo modelo.','contact-transcript-warning'));
        row.append(action('Ver mensagem',async()=>{
          proof.replaceChildren();proof.hidden=false;
          try{const data=await api('/api/v3/fonte?id='+m.id);if(!valid()||!row.isConnected)return;proof.replaceChildren(source(data));proof.tabIndex=-1;proof.focus();}
          catch(e){if(valid())proof.replaceChildren(element('p',e.message));}
        },'secondary'),proof);messages.append(row);
      }
      pagination(messages,d.paginaMensagens,async n=>{messagePage=n;await load();focus();},'mensagens do contato','mensagem do contato');
      target.append(groups,businesses,messages);window.lumeReveal?.(head);
    }catch(e){if(valid()){
      if(!contact)$('contact-order').textContent='Não foi possível conferir o período e a ordem das pessoas.';
      target.replaceChildren(element('p',e.message),action('Tentar novamente',load,'secondary'),...(contact?[action('Voltar aos contatos',()=>open(''),'secondary')]:[]));
    }}
    finally{if(valid())target.setAttribute('aria-busy','false');}
  }
  window.carregarContatos=load;
  window.limparContatos=()=>{revision++;tagFilter.invalidate();selected='';lastList=[];listPage=1;conversationPage=1;messagePage=1;businessPage=1;for(const id of ['contact-list','contact-pages','contact-detail'])$(id).replaceChildren();$('contact-order').textContent='';$('contact-detail').hidden=true;$('contact-browse').hidden=false;};
  $('contact-filter').onsubmit=e=>{e.preventDefault();listPage=1;run(load,e.submitter);};
  $('contact-period').onchange=()=>{listPage=1;run(load,$('contact-period'));};
})();
