// Scoring shared by the offline evaluation and the local runtime.
// A score alone never grants product approval.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function carregarCabecaAprovada(modelDir,policy,revision){
  if(policy?.approvedForActions!==true||!/^[a-f0-9]{64}$/.test(policy.modelSha256??''))throw Error('LAYA_QUALIDADE_PENDENTE');
  let artifact;
  try{artifact=JSON.parse(await readFile(join(modelDir,'domain-head.json'),'utf8'));}
  catch{throw Error('LAYA_CABECA_DOMINIO_AUSENTE');}
  const model=validarCabecaDominio(artifact?.model,revision);
  const digest=createHash('sha256').update(JSON.stringify(model)).digest('hex');
  if(digest!==policy.modelSha256||artifact.summary?.modelSha256!==digest||
    model.approvedForProduct!==true||artifact.summary?.approvedForProduct!==true)
    throw Error('LAYA_CABECA_DOMINIO_NAO_APROVADA');
  return model;
}

export function validarCabecaDominio(model,revision){
  const dimension=model?.mean?.length;
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  if(model?.schema!=='lume-laya-domain-head-v1'||model.encoderRevision!==revision||
    !['author-channel-message-span-v1','author-channel-message-span-owner-v2'].includes(model.inputTemplate)||
    model.classes?.join(',')!=='none,pedido,compromisso'||
    !Number.isInteger(model.maxTokens)||model.maxTokens<16||model.maxTokens>512||
    !finite(model.threshold)||model.threshold<0||model.threshold>1||
    !Number.isInteger(dimension)||dimension<1||dimension>2048||
    !Array.isArray(model.scale)||model.scale.length!==dimension||
    !Array.isArray(model.weights)||model.weights.length!==3||
    !Array.isArray(model.bias)||model.bias.length!==3||
    !model.mean.every(finite)||!model.scale.every(x=>finite(x)&&x>0)||
    !model.weights.every(row=>Array.isArray(row)&&row.length===dimension&&row.every(finite))||
    !model.bias.every(finite))throw Error('LAYA_CABECA_DOMINIO_INVALIDA');
  return model;
}

export function avaliarCabecaDominio(model,feature,tipo){
  if(!['pedido','compromisso'].includes(tipo)||!feature||feature.length!==model.mean.length||
    !Array.from(feature).every(Number.isFinite))throw Error('LAYA_VETOR_DOMINIO_INVALIDO');
  const logits=model.classes.map((_,k)=>{
    let sum=model.bias[k];
    for(let j=0;j<feature.length;j++){
      const standardized=(feature[j]-model.mean[j])/model.scale[j];
      sum+=model.weights[k][j]*Math.max(-5,Math.min(5,standardized));
    }
    return sum;
  });
  if(!logits.every(Number.isFinite))throw Error('LAYA_VETOR_DOMINIO_INVALIDO');
  const max=Math.max(...logits),exp=logits.map(x=>Math.exp(x-max));
  const total=exp.reduce((a,b)=>a+b,0),probabilities=exp.map(x=>x/total);
  const winner=probabilities.indexOf(Math.max(...probabilities));
  return {aceita:model.classes[winner]===tipo&&probabilities[model.classes.indexOf(tipo)]>=model.threshold,
    classe:model.classes[winner],score:probabilities[model.classes.indexOf(tipo)]};
}
