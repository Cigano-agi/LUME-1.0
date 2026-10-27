// Áudio é decodificado/reduzido localmente. Nenhum envio ao provedor ocorre neste arquivo.
async function audioPCM(file){
  if(!file?.size||file.size>20*1024*1024)throw new Error('Escolha um áudio de até 20 MB e cinco minutos.');
  const ctx=new AudioContext();let decoded;
  try{decoded=await ctx.decodeAudioData(await file.arrayBuffer());}catch{throw new Error('Não consegui abrir este áudio. Selecione um arquivo de áudio compatível com este computador.');}finally{await ctx.close();}
  if(!Number.isFinite(decoded.duration)||decoded.duration<=0||decoded.duration>300)throw new Error('Escolha um áudio com até cinco minutos.');
  const render=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000),source=render.createBufferSource();source.buffer=decoded;source.connect(render.destination);source.start();
  const rendered=await render.startRendering(),samples=rendered.getChannelData(0),bytes=new Uint8Array(44+samples.length*2),view=new DataView(bytes.buffer);
  const text=(at,s)=>[...s].forEach((c,i)=>view.setUint8(at+i,c.charCodeAt(0)));
  text(0,'RIFF');view.setUint32(4,bytes.length-8,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++){const v=Math.max(-1,Math.min(1,samples[i]));view.setInt16(44+i*2,Math.round(v*(v<0?32768:32767)),true);}
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
}
const paineisAudio=new Set();
window.abrirTranscricao=async(message,box)=>{
  if(box.querySelector('.audio-panel'))return;
  const panel=element('section',null,'panel audio-panel'),heading=element('h3','Transcrever esta mensagem');heading.tabIndex=-1;
  const status=element('p','Selecione o arquivo da mensagem. Preparar e ouvir são ações locais.','muted');status.setAttribute('role','status');
  const disponibilidade=element('p','Conferindo os motores disponíveis neste computador…','muted');
  const motorLabel=element('label','Onde transcrever'),motor=element('select');motor.id='audio-motor-'+message.id;motorLabel.htmlFor=motor.id;
  for(const [value,text]of [['local','Local · experimental'],['gemini','Gemini · Google']]){const option=element('option',text);option.value=value;motor.append(option);}motor.value='local';
  let motores={};
  const mostrarMotor=()=>{const estado=motores[motor.value];disponibilidade.textContent=estado?.disponivel
    ?(motor.value==='local'?'O áudio fica neste computador. Qualidade experimental: confira nomes, valores e prazos.':'Ao confirmar, o áudio será enviado ao Google. Exige Gemini e autorização da conversa; pode haver custo.')
    :(estado?.motivo||'Motor indisponível nesta instalação. Nenhum serviço alternativo será acionado.');};
  const label=element('label','Arquivo de áudio'),input=element('input'),checkLabel=element('label',null,'check'),check=element('input');input.type='file';input.accept='audio/*,.opus,.m4a,.ogg,.wav,.mp3';input.id='audio-file-'+message.id;label.htmlFor=input.id;check.type='checkbox';checkLabel.append(check,element('span','Conferi: este arquivo corresponde ao áudio desta mensagem.'));
  const player=element('audio');player.controls=true;player.preload='metadata';player.hidden=true;player.setAttribute('aria-label','Ouvir áudio selecionado');
  const preview=element('div');let generation=0,url=null,id=null,file=null,ended=false;
  const current=()=>!ended&&panel.isConnected;
  const select=chosen=>{file=chosen;if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(file);player.src=url;player.hidden=false;check.checked=false;preview.replaceChildren();status.textContent='Arquivo selecionado: '+file.name+'. Confira a reprodução e o vínculo com a mensagem.';};
  const finish=()=>{ended=true;generation++;if(url)URL.revokeObjectURL(url);player.pause();player.removeAttribute('src');observer.disconnect();paineisAudio.delete(finish);if(id)api('/api/v3/audio/cancelar',{id}).catch(()=>{});};
  const observer=new MutationObserver(()=>{if(!panel.isConnected)finish();});
  input.onchange=()=>{generation++;if(id)api('/api/v3/audio/cancelar',{id}).catch(()=>{});id=null;if(input.files[0])select(input.files[0]);};
  motor.onchange=()=>{generation++;if(id)api('/api/v3/audio/cancelar',{id}).catch(()=>{});id=null;preview.replaceChildren();mostrarMotor();};
  const existing=action('Usar áudio já guardado',async()=>{const g=++generation;const local=await api('/api/v3/audio/ler',{fonte:message.id});if(!current()||g!==generation)return;const data=Uint8Array.from(atob(local.base64),c=>c.charCodeAt(0));select(new File([data],local.nome,{type:'audio/wav'}));});
  const download=action('Buscar áudio no WhatsApp',async()=>{
    const g=++generation;if(id)await api('/api/v3/audio/cancelar',{id});if(!current()||g!==generation)return;id='download:'+message.id;status.textContent='Buscando o arquivo no WhatsApp. Nada será enviado ao Google.';
    try{const local=await api('/api/v3/audio/baixar',{fonte:message.id});if(!current()||g!==generation)return;id=null;const data=Uint8Array.from(atob(local.base64),c=>c.charCodeAt(0));select(new File([data],local.nome,{type:local.mime}));}
    catch(error){if(current()&&g===generation){id=null;status.textContent=error.message;}throw error;}
  });
  const prepare=action('Preparar transcrição',async()=>{
    if(!file||!check.checked)throw new Error('Selecione e confira o áudio desta mensagem.');
    const g=++generation,revisao=revisaoDadosVisiveis,escolhido=motor.value;status.textContent='Preparando áudio localmente…';
    try{
    const estado=await api('/api/v3/audio');
    if(!current()||g!==generation||revisao!==revisaoDadosVisiveis)return;
    motores=estado.motores||{};mostrarMotor();
    if(motores[escolhido]?.disponivel!==true){status.textContent=escolhido==='gemini'?'Transcrição indisponível. Configure o Gemini em Ajustes → IA.':(motores.local?.motivo||'Motor local indisponível nesta instalação. Nenhum áudio foi enviado.');return;}
    const base64=await audioPCM(file);if(!current()||g!==generation||revisao!==revisaoDadosVisiveis)return;
    const p=await api('/api/v3/audio/preparar',{fonte:message.id,nome:file.name,base64,confirmarVinculo:true,motor:escolhido});
    if(!current()||g!==generation||revisao!==revisaoDadosVisiveis){await api('/api/v3/audio/cancelar',{id:p.id});return;}id=p.id;
    status.textContent='Pronto para conferir. Nenhum áudio foi enviado ao Google.';
    preview.replaceChildren(element('h3',p.motor==='local'?'Confira antes de transcrever':'Confira antes de enviar'),element('p',p.nome+' · '+p.segundos.toFixed(1)+' segundos'),element('p',message.conversa_nome+' · '+date(message.recebido_em)),element('p',p.motor==='local'?'Neste computador · '+p.modelo+' · sem chamada paga ao provedor':'Google · '+p.modelo+' · reserva de até US$ '+p.reservaUSD.toFixed(4)),element('p',p.aviso));
    if(p.substitui)preview.append(element('p','Já existe uma transcrição: ela será substituída somente se esta operação terminar com sucesso.'));
    preview.append(action('Confirmar e transcrever',async()=>{
      if(!current()||g!==generation)return;input.disabled=true;motor.disabled=true;check.disabled=true;prepare.disabled=true;existing.disabled=true;download.disabled=true;status.textContent=p.motor==='local'?'Transcrevendo neste computador… Você pode cancelar.':'Transcrevendo… Você pode cancelar. A reserva permanece se o envio já começou.';
      try{const r=await api('/api/v3/audio/transcrever',{id:p.id,confirmar:true});if(!current()||g!==generation||revisao!==revisaoDadosVisiveis)return;id=null;status.textContent=r.aviso+(r.limpezaPendente?' Há arquivos pendentes de limpeza nas Configurações.':'');preview.replaceChildren(action('Conferir resultado',async()=>{const atual=await api('/api/v3/fonte?id='+r.fonte);if(current()&&revisao===revisaoDadosVisiveis)box.replaceWith(source(atual));},'primary'));}
      catch(error){if(current()&&g===generation){status.textContent=error.message;preview.replaceChildren();throw error;}}
      finally{if(current()){input.disabled=false;motor.disabled=false;check.disabled=false;prepare.disabled=false;existing.disabled=false;download.disabled=false;}}
    },'primary'));
    }catch(error){if(current()&&g===generation)status.textContent=error.message;throw error;}
  },'secondary');
  const cancel=action('Cancelar transcrição',async()=>{const active=id;id=null;finish();panel.remove();if(active){const r=await api('/api/v3/audio/cancelar',{id:active});feedback(r.aviso);}else feedback('Preparação cancelada.');});
  panel.append(heading,element('p',message.conversa_nome+' · '+date(message.recebido_em)),motorLabel,motor,disponibilidade,download,label,input,existing,player,checkLabel,prepare,status,preview,cancel);box.append(panel);observer.observe(document.body,{childList:true,subtree:true});paineisAudio.add(finish);heading.focus();
  try{const estado=await api('/api/v3/audio');if(current()){motores=estado.motores||{};mostrarMotor();}}catch{if(current())disponibilidade.textContent='Não foi possível conferir os motores. Tente preparar novamente; nenhum áudio foi enviado.';}
};
const limparAntesAudio=window.limparDadosVisiveis;
window.limparDadosVisiveis=(...args)=>{for(const finish of [...paineisAudio])finish();limparAntesAudio?.(...args);};
