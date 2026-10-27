(() => {
 const box=element('section',null,'panel settings-card');box.id='atualizacoes-panel';
 box.append(element('p','VERSÃO DO LUME','eyebrow'),element('h2','Atualizações'),element('p','O Lume verifica versões aprovadas. Seus dados continuam neste computador durante a atualização.'));
 const version=element('p');version.id='atualizacoes-versao';
 const status=element('p');status.id='atualizacoes-status';status.setAttribute('role','status');
 const progress=element('progress');progress.id='atualizacoes-progresso';progress.max=100;progress.hidden=true;
 const buttons=element('div',null,'button-row'),primary=element('button','Verificar agora','primary'),later=element('button','Depois','secondary');primary.type=later.type='button';later.hidden=true;buttons.append(primary,later);
 box.append(version,status,progress,buttons,element('p','O Lume só oferece pacotes do seu canal e sistema. Uma falha não bloqueia o uso; você pode tentar novamente.','muted'));
 window.registrarAjuste(box,'atualizacoes-panel','data');

 const notice=element('aside',null,'update-notice');notice.id='atualizacao-aviso';notice.hidden=true;notice.setAttribute('role','region');notice.setAttribute('aria-labelledby','atualizacao-aviso-titulo');
 const noticeCopy=element('div'),noticeEyebrow=element('p','ATUALIZAÇÃO DO LUME','eyebrow'),noticeTitle=element('strong');noticeTitle.id='atualizacao-aviso-titulo';const noticeText=element('p');noticeCopy.append(noticeEyebrow,noticeTitle,noticeText);
 const noticeButtons=element('div',null,'button-row'),noticePrimary=element('button','Atualizar','primary'),noticeLater=element('button','Depois','secondary');noticePrimary.type=noticeLater.type='button';noticeButtons.append(noticePrimary,noticeLater);notice.append(noticeCopy,noticeButtons);document.body.append(notice);

 let current=null,busy=false,dismissedVersion=null;
 const labelErro={ASSINATURA_INVALIDA:'O pacote não passou na verificação de segurança.',RELEASE_INDISPONIVEL:'Nenhuma versão aprovada foi encontrada neste canal.',REDE_INDISPONIVEL:'Sem conexão com o serviço de atualização.',ATUALIZACAO_FALHOU:'Não foi possível concluir a atualização.'};
 const actionFor=d=>d?.estado==='disponivel'?'baixar':d?.estado==='pronta'?'instalar':'verificar';
 const renderNotice=d=>{
  const relevant=['disponivel','baixando','pronta'].includes(d.estado),dismissed=d.versaoNova&&dismissedVersion===d.versaoNova;
  notice.hidden=!relevant||dismissed;if(notice.hidden)return;
  noticeTitle.textContent=d.estado==='pronta'?'Atualização pronta':d.estado==='baixando'?'Baixando atualização':`Nova versão ${d.versaoNova||''}`.trim();
  const pct=Number.isFinite(d.progresso?.percentual)?Math.round(d.progresso.percentual):null;
  noticeText.textContent=d.estado==='pronta'?'Reinicie quando quiser. Seus dados continuam neste computador.':d.estado==='baixando'?(pct===null?'O download está em andamento.':`Download em ${pct}%.`):'Uma versão aprovada está disponível para este computador.';
  noticePrimary.textContent=d.estado==='pronta'?'Reiniciar agora':d.estado==='baixando'?'Baixando…':'Atualizar';noticePrimary.disabled=busy||d.estado==='baixando';noticeLater.disabled=busy;
 };
 const render=d=>{
  current=d;version.textContent=`Versão instalada: ${d.versaoAtual} · canal ${d.canal}`;
  const textos={indisponivel:'Esta instalação ainda não participa das atualizações automáticas.',em_dia:'Você está com a versão mais recente deste canal.',verificando:'Procurando uma versão aprovada…',disponivel:`Versão ${d.versaoNova||'nova'} disponível.`,baixando:'Baixando a atualização…',pronta:`Versão ${d.versaoNova||'nova'} pronta para instalar.`,erro:labelErro[d.codigoErro]||'Não foi possível verificar agora.'};
  status.textContent=textos[d.estado]||textos.indisponivel;
  const pct=d.estado==='baixando'&&Number.isFinite(d.progresso?.percentual)?Math.round(d.progresso.percentual):null;progress.hidden=pct===null;if(pct!==null)progress.value=pct;
  primary.hidden=d.estado==='baixando'||d.estado==='verificando'||d.estado==='indisponivel';primary.textContent=d.estado==='disponivel'?'Baixar atualização':d.estado==='pronta'?'Reiniciar e atualizar':d.estado==='erro'?'Tentar novamente':'Verificar agora';primary.disabled=busy;
  later.hidden=!['disponivel','pronta'].includes(d.estado);later.disabled=busy;renderNotice(d);
 };
 const executar=async acao=>{if(['baixar','instalar'].includes(acao))dismissedVersion=null;busy=true;if(current)render(current);try{render(await api('/api/v3/atualizacoes/'+acao,{}));}catch(error){status.textContent=error.message;}finally{busy=false;if(current)render(current);}};
 const carregar=async silencioso=>{try{render(await api('/api/v3/atualizacoes'));}catch(error){if(!silencioso)status.textContent=error.message;}};
 window.carregarAtualizacoes=()=>carregar(false);
 primary.onclick=()=>executar(actionFor(current));noticePrimary.onclick=()=>executar(actionFor(current));
 const dismiss=()=>{dismissedVersion=current?.versaoNova||null;notice.hidden=true;later.hidden=true;feedback('Você pode atualizar depois em Ajustes.');};later.onclick=dismiss;noticeLater.onclick=dismiss;
 setTimeout(()=>carregar(true),5000);setInterval(()=>{if(!document.hidden)carregar(true);},30000);
})();
