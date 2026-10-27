// Inference must not turn forwarded, imported or unreadable third-party text
// into the owner's task. The raw Baileys envelope is local and never logged.
export function mensagemEncaminhada(bruto){
  if(typeof bruto!=='string'||bruto.length>1_000_000)return true;
  let envelope;
  try{envelope=JSON.parse(bruto);}catch{return true;}
  let message=envelope?.mensagem?.message;
  for(let i=0;i<8&&message;i++){
    const next=message.ephemeralMessage?.message??message.viewOnceMessage?.message??
      message.viewOnceMessageV2?.message??message.documentWithCaptionMessage?.message;
    if(!next)break;message=next;
  }
  const context=message?.extendedTextMessage?.contextInfo??message?.imageMessage?.contextInfo??
    message?.videoMessage?.contextInfo??message?.documentMessage?.contextInfo;
  return context?.isForwarded===true||Number.isFinite(context?.forwardingScore)&&context.forwardingScore>0;
}

export function autoriaParaLaya(fonte){
  if(fonte?.permissao==='compartilhado'||mensagemEncaminhada(fonte?.bruto))return 'terceiro';
  if(fonte?.autor_e_dono===1)return 'proprio';
  return 'outro';
}
