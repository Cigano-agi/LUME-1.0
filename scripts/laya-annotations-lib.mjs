import {createHash} from 'node:crypto';

const id=/^[a-z0-9_-]{3,40}$/i;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const keys=(value,allowed,required=allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(value,k));
const risk=new Set(['condition','negation','completed','payment','acceptance','prompt_injection','cancellation','uncertainty','none']);
export const hasSensitivePattern=text=>{
  if(/(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/|\bBearer\s+[A-Za-z0-9._~-]{8,}|\b(?:sk-|ghp_|AKIA)[A-Za-z0-9_-]{8,})/iu.test(text))return true;
  for(const match of text.matchAll(/\+?\d[\d\s().-]{8,}\d/gu)){
    const digits=match[0].replace(/\D/g,'');
    if(digits.length>=10&&digits.length<=14)return true;
  }
  return false;
};

export function validarAnotacoes(data){
  if(!keys(data,['schema','purpose','dataKind','reviewedAt','approvedByOwner','items'])||data.schema!=='lume-laya-annotations-v1'||data.purpose!=='local-model-improvement'||!['synthetic','real_authorized'].includes(data.dataKind)||!date(data.reviewedAt)||data.approvedByOwner!==true||!Array.isArray(data.items)||data.items.length<3||data.items.length>5000)throw Error('CONJUNTO_INVALIDO');
  const ids=new Set(),items=[];
  for(const item of data.items){
    if(!keys(item,['id','personKey','conversationKey','channel','author','text','critical','risks','actions','rightsConfirmed'])||
      !id.test(item.id)||!id.test(item.personKey)||!id.test(item.conversationKey)||ids.has(item.id)||
      !['dm','group'].includes(item.channel)||!['self','other','third_party'].includes(item.author)||
      typeof item.text!=='string'||item.text.length<8||item.text.length>2000||
      typeof item.critical!=='boolean'||!Array.isArray(item.risks)||item.risks.length<1||item.risks.some(x=>!risk.has(x))||
      item.risks.includes('none')&&item.risks.length>1||!Array.isArray(item.actions)||item.actions.length>8||
      item.rightsConfirmed!==true||hasSensitivePattern(item.text))throw Error(`ANOTACAO_INVALIDA:${String(item?.id||'sem_id')}`);
    ids.add(item.id);
    for(const action of item.actions){
      if(!keys(action,['type','span'])||!['request','promise'].includes(action.type)||typeof action.span!=='string'||action.span.length<8||action.span.length>300||item.text.split(action.span).length!==2)throw Error(`ACAO_INVALIDA:${item.id}`);
    }
    if(item.author==='third_party'&&item.actions.length)throw Error(`AUTORIA_INVALIDA:${item.id}`);
    items.push({...item,risks:[...new Set(item.risks)],actions:item.actions.map(x=>({...x}))});
  }
  return {schema:data.schema,purpose:data.purpose,dataKind:data.dataKind,reviewedAt:data.reviewedAt,approvedByOwner:true,items};
}

export function dividirAnotacoes(data){
  const valid=validarAnotacoes(data),parent=new Map();
  const find=x=>{if(!parent.has(x))parent.set(x,x);if(parent.get(x)!==x)parent.set(x,find(parent.get(x)));return parent.get(x);};
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(b,a);};
  for(const item of valid.items)union(`p:${item.personKey}`,`c:${item.conversationKey}`);
  const groups=new Map();
  for(const item of valid.items){const key=find(`p:${item.personKey}`);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  if(groups.size<3)throw Error('GRUPOS_INSUFICIENTES');
  const ranked=[...groups.values()].sort((a,b)=>{
    const hash=items=>createHash('sha256').update(items.map(x=>x.id).sort().join('|')).digest('hex');
    return hash(a).localeCompare(hash(b));
  });
  const n=ranked.length,nTest=Math.max(1,Math.round(n*.2)),nValidation=Math.max(1,Math.round(n*.2));
  const test=ranked.slice(0,nTest).flat(),validation=ranked.slice(nTest,nTest+nValidation).flat(),train=ranked.slice(nTest+nValidation).flat();
  const stats=rows=>({items:rows.length,critical:rows.filter(x=>x.critical).length,actions:rows.reduce((v,x)=>v+x.actions.length,0),personKeys:new Set(rows.map(x=>x.personKey)).size});
  const coverage={
    dm:test.some(x=>x.channel==='dm'),group:test.some(x=>x.channel==='group'),
    self:test.some(x=>x.author==='self'),other:test.some(x=>x.author==='other'),thirdParty:test.some(x=>x.author==='third_party'),
    request:test.some(x=>x.actions.some(a=>a.type==='request')),promise:test.some(x=>x.actions.some(a=>a.type==='promise')),
    noAction:test.some(x=>x.actions.length===0),multipleActions:test.some(x=>x.actions.length>=2),
    condition:test.some(x=>x.risks.includes('condition')),negation:test.some(x=>x.risks.includes('negation')),
    completed:test.some(x=>x.risks.includes('completed')),payment:test.some(x=>x.risks.includes('payment')),
    acceptance:test.some(x=>x.risks.includes('acceptance')),promptInjection:test.some(x=>x.risks.includes('prompt_injection')),
    cancellation:test.some(x=>x.risks.includes('cancellation')),uncertainty:test.some(x=>x.risks.includes('uncertainty'))
  };
  const minimumEvaluationVolume=valid.dataKind==='real_authorized'&&test.length>=100&&test.filter(x=>x.critical).length>=20&&coverage.request&&coverage.noAction;
  const trainingBalanced=[train,validation].every(rows=>rows.some(x=>x.actions.length>0)&&rows.some(x=>x.actions.length===0));
  const splitOfText=new Map(),duplicatedAcrossSplits=new Set();
  for(const [split,rows]of Object.entries({train,validation,test}))for(const row of rows){
    const fingerprint=row.text.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/gu,' ').trim();
    if(splitOfText.has(fingerprint)&&splitOfText.get(fingerprint)!==split)duplicatedAcrossSplits.add(fingerprint);
    else splitOfText.set(fingerprint,split);
  }
  const summary={train:stats(train),validation:stats(validation),test:stats(test),minimumEvaluationVolume,scenarioCoverage:coverage,trainingBalanced,crossSplitDuplicateTexts:duplicatedAcrossSplits.size,readyForBlindEvaluation:minimumEvaluationVolume&&Object.values(coverage).every(Boolean)&&trainingBalanced&&duplicatedAcrossSplits.size===0};
  return {schema:'lume-laya-partitions-v1',dataKind:valid.dataKind,sourceSha256:createHash('sha256').update(JSON.stringify(valid)).digest('hex'),reviewedAt:valid.reviewedAt,summary,train,validation,test};
}
