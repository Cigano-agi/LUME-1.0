import {CASOS,ESTADOS,novoRelato,validarRelato,resumoRelato,hojeLocal} from './beta-model.js';
const root=document.getElementById('beta-page'),el=id=>root.querySelector('#beta-'+id),dialog=root.closest('dialog');
let relato=novoRelato(),etapa=0,inicio=null,geracao=0;
const avisar=text=>{el('status').textContent=text;};
for(const [group,keys] of Object.entries({preparar:['instalacao','primeiroAcesso','whatsapp'],acao:['fontes','ia'],semana:['reconexao','dados','backup','compartilhamento']}))for(const key of keys){
  const wrap=document.createElement('div'),label=document.createElement('label'),select=document.createElement('select');
  label.htmlFor=select.id='beta-case-'+key;label.textContent=CASOS[key];
  for(const [value,text] of Object.entries(ESTADOS)){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
  wrap.append(label,select);el('cases-'+group).append(wrap);
}
const textFields={participante:'participante',sistema:'sistema',versao:'versaoAplicativo',plataforma:'plataforma',week:'inicioSemana'};
const feedbackFields={utilidade:'utilidade',atrapalhou:'atrapalhou',faltou:'faltou','other-name':'outroNome','name-reason':'motivoNome',value:'valorPercebido'};
function coletar(){
  for(const [id,key] of Object.entries(textFields))relato[key]=el(id).value;
  for(const [id,key] of Object.entries(feedbackFields))relato.feedback[key]=el(id).value;
  for(const key of Object.keys(CASOS))relato.casos[key]=el('case-'+key).value;
  relato.feedback.nome=root.querySelector('[name=beta-nome]:checked').value;
  relato.diasUso=[1,2,3].map(n=>el('day'+n).value).filter(Boolean);
  Object.assign(relato.primeiraAcao,{historicoDisponivel:el('history').checked,fonteConferida:el('source').checked,ajuda:el('help').value});
}
function preencher(){
  for(const [id,key] of Object.entries(textFields))el(id).value=relato[key];
  for(const [id,key] of Object.entries(feedbackFields))el(id).value=relato.feedback[key];
  for(const key of Object.keys(CASOS))el('case-'+key).value=relato.casos[key];
  for(const input of root.querySelectorAll('[name=beta-nome]'))input.checked=input.value===relato.feedback.nome;
  for(const n of [1,2,3])el('day'+n).value=relato.diasUso[n-1]||'';
  el('history').checked=relato.primeiraAcao.historicoDisponivel;el('source').checked=relato.primeiraAcao.fonteConferida;el('help').value=relato.primeiraAcao.ajuda;atualizar();
}
function resumo(){
  if(inicio!==null)throw Error('Finalize a medição antes de baixar ou retomar um registro.');
  const r=resumoRelato(validarRelato(relato));
  const primeira=r.primeiraAcaoNoPrazo===null?'Primeira ação ainda não medida.':r.primeiraAcaoNoPrazo?'Ação com fonte encontrada em até 5 minutos, sem ajuda, conforme seu relato.':'Critério da primeira ação ainda não atingido: tempo, fonte ou ajuda precisam ser considerados.';
  el('summary').textContent=`${primeira} Uso registrado em ${relato.diasUso.length} de 3 dias. ${r.etapasTestadas} etapas testadas; ${r.etapasComFalha} com dificuldade. É um relato manual, não liberação do produto.`;
  el('readable').textContent=[`Participante: ${relato.participante||'não informado'}`,`Computador: ${relato.plataforma} · ${relato.sistema||'versão não informada'}`,`Lume: ${relato.versaoAplicativo||'não informado'}`,`Resultado: ${relato.primeiraAcao.resultado} · tempo: ${relato.primeiraAcao.segundos??'não medido'} s · ajuda: ${relato.primeiraAcao.ajuda}`,`Fonte conferida: ${relato.primeiraAcao.fonteConferida?'sim':'não'}`,`Semana: ${relato.inicioSemana} · dias de uso: ${relato.diasUso.join(', ')||'nenhum registrado'}`,...Object.entries(CASOS).map(([k,label])=>`${label}: ${ESTADOS[relato.casos[k]]}`),`Voltaria: ${relato.feedback.utilidade}`,`Dificuldade: ${relato.feedback.atrapalhou||'não informada'}`,`Faltou: ${relato.feedback.faltou||'não informado'}`,`Nome: ${relato.feedback.nome} · outra sugestão: ${relato.feedback.outroNome}`,`Motivo: ${relato.feedback.motivoNome}`,`Valor percebido: ${relato.feedback.valorPercebido}`].join('\n');
}
function atualizar(){
  const a=relato.primeiraAcao;
  el('start').disabled=inicio!==null||!a.historicoDisponivel||!dialog;el('history').disabled=inicio!==null||a.resultado!=='nao-testado';
  el('found').disabled=el('stopped').disabled=inicio===null;el('import').disabled=inicio!==null;
  el('start').textContent=a.resultado==='nao-testado'?'Começar a busca':'Refazer medição';
  const seconds=inicio===null?(a.segundos||0):Math.max(0,Math.floor((Date.now()-inicio)/1000));
  el('timer').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  el('measurement').textContent=inicio!==null?'Cronômetro em andamento. Feche o guia para consultar sua memória e reabra quando terminar.':a.resultado==='nao-testado'?'Medição ainda não iniciada.':`${a.resultado==='encontrada'?'Ação encontrada':'Busca interrompida'} em ${seconds} segundos. Confira fonte e ajuda no registro.`;
  el('platform-note').textContent=['linux','outro'].includes(relato.plataforma)?'Esta plataforma não faz parte do primeiro beta. Registre sua necessidade.':relato.plataforma==='macos'?'macOS está no beta. O instalador Mac ainda precisa ser produzido e validado; registre também Intel ou Apple Silicon.':relato.plataforma==='windows'?'Windows está no beta. O novo instalador ainda precisa ser validado em máquina limpa.':'O beta inclui Windows e macOS. Os novos instaladores ainda precisam de validação.';
  el('week').max=hojeLocal();for(const n of [1,2,3]){el('day'+n).min=relato.inicioSemana;el('day'+n).max=hojeLocal();}
  try{resumo();el('export').disabled=false;}catch(error){el('summary').textContent=error.message;el('readable').textContent='Corrija o registro para conferir o resumo.';el('export').disabled=true;}
}
function mostrar(next,focus=true){etapa=next;root.classList.toggle('beta-progress',etapa>0);for(const p of root.querySelectorAll('[data-beta-panel]'))p.hidden=Number(p.dataset.betaPanel)!==etapa;for(const b of root.querySelectorAll('[data-beta-step]')){if(Number(b.dataset.betaStep)===etapa)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');}el('prev').disabled=etapa===0;el('next').hidden=etapa===3;el('page-number').textContent=`Etapa ${etapa+1} de 4`;if(focus){root.querySelector(`[data-beta-panel="${etapa}"] h2`).focus({preventScroll:true});if(dialog)dialog.scrollTop=0;else window.scrollTo(0,0);}}
for(const b of root.querySelectorAll('[data-beta-step]'))b.addEventListener('click',()=>mostrar(Number(b.dataset.betaStep)));
el('prev').addEventListener('click',()=>mostrar(Math.max(0,etapa-1)));el('next').addEventListener('click',()=>mostrar(Math.min(3,etapa+1)));
el('form').addEventListener('submit',event=>event.preventDefault());
el('form').addEventListener('input',()=>{geracao++;coletar();atualizar();});el('form').addEventListener('change',()=>{coletar();atualizar();});
el('start').addEventListener('click',()=>{coletar();if(!dialog||!relato.primeiraAcao.historicoDisponivel||inicio!==null)return;inicio=Date.now();Object.assign(relato.primeiraAcao,{resultado:'nao-testado',iniciadaEm:new Date(inicio).toISOString(),encerradaEm:null,segundos:null,fonteConferida:false,ajuda:'nao-informada'});el('source').checked=false;el('help').value='nao-informada';atualizar();avisar('Medição iniciada. Consulte no app e reabra o guia para registrar o resultado.');});
function encerrar(resultado){if(inicio===null)return;const fim=Math.max(inicio,Date.now());if(fim-inicio>86400000){inicio=null;relato.primeiraAcao=novoRelato().primeiraAcao;preencher();avisar('A medição ultrapassou 24 horas. Inicie outra quando puder testar.');return;}coletar();Object.assign(relato.primeiraAcao,{resultado,encerradaEm:new Date(fim).toISOString(),segundos:Math.floor((fim-inicio)/1000)});inicio=null;atualizar();avisar('Resultado registrado nesta aba. Você pode baixar o feedback na etapa 4.');}
el('found').addEventListener('click',()=>encerrar('encontrada'));el('stopped').addEventListener('click',()=>encerrar('nao-encontrada'));
setInterval(()=>{if(inicio!==null)atualizar();},1000);
el('export').addEventListener('click',()=>{
  try{coletar();resumo();relato.criadoEm=new Date().toISOString();const body=JSON.stringify(validarRelato(relato),null,2),url=URL.createObjectURL(new Blob([body],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`assessor-feedback-${crypto.randomUUID()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);avisar('Download solicitado. Confira se o arquivo foi salvo. Nada foi enviado ao responsável pelo teste.');}catch(error){avisar(error.message);}
});
el('send').addEventListener('click',async()=>{
  coletar();
  if(!dialog||typeof window.abrirFeedbackLume!=='function'){
    avisar('Abra este guia dentro do aplicativo Lume para enviar um relato ao time. Você ainda pode baixar a cópia local.');
    return;
  }
  const partes=[relato.feedback.atrapalhou,relato.feedback.faltou].map(valor=>String(valor||'').trim()).filter(Boolean);
  const texto=partes.join('\n\n').slice(0,2000);
  dialog.close();
  try{
    if(!await window.abrirFeedbackLume('ajustes'))throw new Error('Não foi possível abrir o formulário de feedback.');
    const campo=document.getElementById('central-feedback-text');
    if(campo&&texto&&!campo.value.trim()){
      campo.value=texto;
      campo.dispatchEvent(new Event('input',{bubbles:true}));
    }
    const utilidade=document.getElementById('central-feedback-utility');
    const valor={voltaria:'util',talvez:'parcial','nao-voltaria':'nao_util'}[relato.feedback.utilidade];
    if(utilidade&&valor&&!utilidade.value){utilidade.value=valor;utilidade.dispatchEvent(new Event('change',{bubbles:true}));}
  }catch(error){dialog.showModal();avisar(error.message||'Não foi possível abrir o feedback.');}
});
el('import').addEventListener('change',async()=>{
  const file=el('import').files[0];if(!file)return;
  const importGeneration=++geracao;
  try{if(inicio!==null)throw Error('Finalize a medição antes de retomar outro registro.');if(file.size>65536)throw Error('Arquivo maior que 64 KB. Escolha um feedback do Lume ou do antigo Assessor.');const parsed=validarRelato(JSON.parse(await file.text()));if(inicio!==null||geracao!==importGeneration)throw Error('O registro mudou durante a leitura. Escolha o arquivo novamente.');geracao++;relato=parsed;preencher();mostrar(3);avisar('Registro reaberto. Confira os dados; nenhuma etapa foi executada automaticamente.');}catch(error){avisar(error instanceof SyntaxError?'Arquivo inválido. Seu registro atual foi preservado.':error.message+' Seu registro atual foi preservado.');}finally{el('import').value='';}
});
el('clear').addEventListener('click',()=>{geracao++;inicio=null;relato=novoRelato();preencher();mostrar(0);avisar('Registro desta aba limpo. Arquivos baixados anteriormente permanecem.');});
for(const link of root.querySelectorAll('[data-beta-return]'))if(dialog)link.addEventListener('click',event=>{event.preventDefault();dialog.close();});
if(dialog)el('standalone').hidden=true;
preencher();mostrar(0,false);
const startedGeneration=geracao;
fetch('/api/v3/versao').then(r=>r.ok?r.json():null).then(data=>{if(data?.desktop&&typeof data.versao==='string'&&geracao===startedGeneration&&!el('versao').value){el('versao').value=data.versao;coletar();atualizar();}}).catch(()=>{});
