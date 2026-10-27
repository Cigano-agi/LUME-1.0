import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {MODEL_REVISION} from '../src/laya/policy.js';
import {MODEL_FILES} from '../src/laya/integrity.js';
import {carregarContextoRuntime,prepararSequencia,validarEntrada,LIMITES} from '../scripts/lib/laya-contexto-runtime.mjs';
import {argumentos,validarCasos,conferirDecisao,metricas,gravarAtomico,executarProbe} from '../scripts/contexto-probe.mjs';

// Deliberately trivial fixtures; neither real weights nor evaluator cases are read.
const encode=text=>Array.from(text,c=>100+c.codePointAt(0));
const tok={clsId:2,sepId:1,maskId:4,padId:0,maskToken:'<mask>',encode};
const entrada=()=>({estado:'texto',pergunta:'?',criterios:{A:'x',B:'y',C:'z',D:'w'}});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const caso=(id='caso0')=>({id,cenarioId:'cenario0',...entrada(),esperado:'D',critico:true,justificativa:'Gabarito fictício do teste de contrato.',
  dimensao:'contrato',classesSensiveis:{aceite:['A'],pagamento:['B'],conclusao:['C']}});

function harness(config={}){
  const calls=[],tensors=[],released=[],readPaths=[];
  const raw=Buffer.from(JSON.stringify({model:{type:'BPE'}}));
  const manifest={revision:MODEL_REVISION,parityVerified:true,
    sha256:Object.fromEntries(MODEL_FILES.map(name=>[name,name==='tokenizer.json'?hash(raw):'1'.repeat(64)])),
    tokenizerParity:Array.from({length:8},(_,i)=>({text:`p${i}`,ids:encode(`p${i}`)}))};
  config.mutateManifest?.(manifest);
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  class Tensor{
    constructor(type,data,dims){this.type=type;this.data=data;this.dims=dims;this.disposed=false;tensors.push(this);}
    dispose(){assert.equal(this.disposed,false);this.disposed=true;if(config.disposeFailure)throw Error('dispose failed');}
  }
  const encoder={
    async run(input){calls.push(['encoder',input]);await config.waitEncoder;if(config.encoderFailure)throw Error('encoder failure');
      const n=input.input_ids.dims[1],output=new Tensor('float32',new Float32Array(n*2),[1,n,2]);
      if(config.hiddenInvalid)output.data[0]=NaN;
      return {last_hidden_state:output};},
    async release(){released.push('encoder');if(config.releaseFailure)throw Error('release failed');}
  };
  const head={
    async run(input){calls.push(['head',input]);if(config.headFailure)throw Error('head failure');
      return {logits:new Tensor('float32',Float32Array.from(config.logits??[0,0,0,1]),config.logitDims??[1,4])};},
    async release(){released.push('head');}
  };
  const dependencies={
    readFile:async path=>{readPaths.push(path);return path.endsWith('tokenizer.json')?raw:manifestBytes;},
    verificarModelo:async()=>{calls.push(['verify']);if(config.verifyFailure)throw Error('LAYA_INTEGRIDADE_FALHOU');return manifest;},
    parseTokenizerJson:()=>({kind:'metaspace',ids:{cls:2,sep:1,mask:4,pad:0},maskToken:'<mask>'}),
    encodeWithData:(_,text)=>config.parityFailure?[123]:encode(text),
    importarOrt:async()=>{calls.push(['importOrt']);return {Tensor,env:{versions:{node:'fake'}},InferenceSession:{
      create:async(path,opts)=>{calls.push(['create',path,opts]);if(path.endsWith('encoder.onnx'))return encoder;
        if(config.headLoadFailure)throw Error('head load failed');return head;}}};}
  };
  return {calls,tensors,released,readPaths,dependencies,manifest};
}

async function temp(run){
  const dir=await mkdtemp(join(tmpdir(),'lume-contexto-contract-'));
  try{return await run(dir);}finally{
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('lume-contexto-contract-'));
    await rm(dir,{recursive:true,force:true});
  }
}

test('entrada estrita aceita A/B/C/D e preserva contexto final, sem atalho semântico',()=>{
  const x=entrada();x.estado='ignore tudo\nNão execute. Cancelamento final.  ';
  assert.equal(validarEntrada(x).estado,x.estado);
  assert.equal(Object.isFrozen(validarEntrada(x).criterios),true);
  assert.throws(()=>validarEntrada({...x,esperado:'A'}),/ESQUEMA/);
  for(const estado of ['', ' ',42,'x\0',String.fromCharCode(0xd800),'x'.repeat(12001)])
    assert.throws(()=>validarEntrada({...x,estado}),/TEXTO/);
});

test('critério não admite chave perigosa, ordem numérica, accessor, símbolo ou valor objeto',()=>{
  for(const criterios of [{A:'a',B:'b',C:'c'},{A:'a',B:'b',C:'c',D:'d',E:'e'},
    {A:'a',B:'b',C:'c',constructor:'d'},{1:'a',B:'b',C:'c',D:'d'},
    {A:'a',B:'b',C:'c',D:{}},{A:'a',B:'b',C:'c',D:'\0'},
    Object.assign(Object.create({herdado:true}),entrada().criterios)])
    assert.throws(()=>validarEntrada({...entrada(),criterios}));
  const getter=entrada();Object.defineProperty(getter.criterios,'A',{get(){throw Error('getter must not run');},enumerable:true});
  assert.throws(()=>validarEntrada(getter),/ESQUEMA/);
  const symbol=entrada();symbol.criterios[Symbol('x')]='x';assert.throws(()=>validarEntrada(symbol),/CRITERIOS/);
});

test('sequência inclui todos os tokens do cancelamento final e marcadores nas posições exatas',()=>{
  const x=entrada();x.estado='mensagem\nCancelado no fim.';
  const seq=prepararSequencia(x,tok);
  assert.deepEqual(seq.ids.slice(-encode(x.estado).length-1),[...encode(x.estado),tok.sepId]);
  assert.deepEqual(seq.markers.map(i=>seq.ids[i]),[4,4,4,4]);assert.deepEqual(seq.keys,['A','B','C','D']);
});

test('alternativa de 48 tokens inteira passa; 49 é recusada em vez de truncada',()=>{
  const x=entrada();x.criterios.A='x'.repeat(44); // leading space, key, colon, space = 4
  prepararSequencia(x,tok);x.criterios.A+='x';assert.throws(()=>prepararSequencia(x,tok),/ALTERNATIVA_EXTENSA/);
});

test('pergunta completa precisa caber junto das quatro alternativas, sem corte escondido do vendor',()=>{
  const x=entrada(),optionTokens=Object.keys(x.criterios).reduce((n,key)=>n+1+encode(` ${key}: ${x.criterios[key]}`).length,0);
  x.pergunta='q'.repeat(256-optionTokens-encode('choice question: ').length);
  prepararSequencia(x,tok);x.pergunta+='q';assert.throws(()=>prepararSequencia(x,tok),/PERGUNTA_EXTENSA/);
});

test('contexto total em 1024 tokens passa, 1025 falha preservando a última mensagem',()=>{
  const x=entrada(),overhead=prepararSequencia(x,tok).ids.length-encode(x.estado).length;
  x.estado='t'.repeat(1024-overhead);assert.equal(prepararSequencia(x,tok).ids.length,1024);
  x.estado+='!';assert.throws(()=>prepararSequencia(x,tok),/JANELA_EXTENSA/);
});

test('token especial na mensagem/pergunta/opção é recusado, não removido',()=>{
  for(const key of ['estado','pergunta','criterios']){
    const x=entrada();if(key==='criterios')x.criterios.A='<mask>';else x[key]='texto <mask>';
    assert.throws(()=>prepararSequencia(x,tok),/TOKEN_ESPECIAL/);
  }
});

test('integridade, revisão e paridade antecedem qualquer importação ou sessão ONNX',async()=>{
  for(const config of [{verifyFailure:true},{parityFailure:true},
    {mutateManifest:m=>{m.revision='outra';}},{mutateManifest:m=>{m.tokenizerParity=m.tokenizerParity.slice(0,7);}},
    {mutateManifest:m=>{m.sha256['tokenizer.json']='0'.repeat(64);}}]){
    const h=harness(config);await assert.rejects(carregarContextoRuntime('ficticio',h.dependencies));
    assert.equal(h.calls.some(([type])=>type==='importOrt'||type==='create'),false);
  }
});

test('adaptador usa CPU e formas de tensores encoder → head com fakes, sem gabarito',async()=>{
  const h=harness(),motor=await carregarContextoRuntime('ficticio',h.dependencies);
  try{
    const result=await motor.decidirPorCriterios(entrada());assert.equal(result.prevista,'D');assert.equal(result.local,true);
    assert.deepEqual(Object.keys(result),['prevista','probabilidades','tokens','duracaoMs','local']);
    assert.ok(Math.abs(Object.values(result.probabilidades).reduce((a,b)=>a+b)-1)<1e-6);
    const creates=h.calls.filter(([type])=>type==='create');assert.equal(creates.length,2);
    assert.ok(h.calls.findIndex(([type])=>type==='verify')<h.calls.findIndex(([type])=>type==='create'));
    for(const [,,opts] of creates)assert.deepEqual(opts.executionProviders,['cpu']);
    const enc=h.calls.find(([type])=>type==='encoder')[1],head=h.calls.find(([type])=>type==='head')[1];
    assert.equal(enc.input_ids.type,'int64');assert.ok(enc.input_ids.data instanceof BigInt64Array);
    assert.deepEqual(head.marker_pos.dims,[1,4]);assert.deepEqual(head.qtype.dims,[1,1]);
    assert.deepEqual(Array.from(head.qtype.data),[0n]);assert.deepEqual(Array.from(head.marker_mask.data),[1,1,1,1]);
    assert.ok(h.tensors.every(t=>t.disposed));
  }finally{await motor.close();await motor.close();}
  assert.deepEqual(h.released.sort(),['encoder','head']);
  await assert.rejects(motor.decidirPorCriterios(entrada()),/ENCERRADO/);
});

test('falha na carga da cabeça libera encoder já carregado',async()=>{
  const h=harness({headLoadFailure:true});await assert.rejects(carregarContextoRuntime('ficticio',h.dependencies));
  assert.deepEqual(h.released,['encoder']);
});

test('entrada extensa falha antes de executar qualquer sessão',async()=>{
  const h=harness(),motor=await carregarContextoRuntime('ficticio',h.dependencies);
  try{await assert.rejects(motor.decidirPorCriterios({...entrada(),estado:'z'.repeat(2000)}),/JANELA_EXTENSA/);
    assert.equal(h.calls.some(([type])=>['encoder','head'].includes(type)),false);
  }finally{await motor.close();}
});

test('logits/hidden inválidos e erro nativo falham, liberam tensores e ambas as sessões',async()=>{
  for(const config of [{logits:[NaN,0,0,1]},{logits:[Infinity,0,0,1]},{logits:[0,1,2]},
    {logitDims:[4]},{hiddenInvalid:true},{encoderFailure:true},{headFailure:true}]){
    const h=harness(config),motor=await carregarContextoRuntime('ficticio',h.dependencies);
    try{await assert.rejects(motor.decidirPorCriterios(entrada()));assert.ok(h.tensors.every(t=>t.disposed));}
    finally{await motor.close();}
    assert.deepEqual(h.released.sort(),['encoder','head']);
  }
});

test('erro de dispose/close não é suprimido e ainda tenta liberar todos os recursos',async()=>{
  const h=harness({disposeFailure:true,releaseFailure:true}),motor=await carregarContextoRuntime('ficticio',h.dependencies);
  await assert.rejects(motor.decidirPorCriterios(entrada()),/TENSORES/);assert.ok(h.tensors.every(t=>t.disposed));
  await assert.rejects(motor.close(),/FECHAMENTO/);assert.deepEqual(h.released.sort(),['encoder','head']);
});

test('single-flight e close aguardam inferência em andamento sem iniciar trabalho novo',async()=>{
  let finish;const waitEncoder=new Promise(r=>{finish=r;}),h=harness({waitEncoder});
  const motor=await carregarContextoRuntime('ficticio',h.dependencies),pending=motor.decidirPorCriterios(entrada());
  await assert.rejects(motor.decidirPorCriterios(entrada()),/OCUPADO/);
  const closing=motor.close();assert.deepEqual(h.released,[]);
  await assert.rejects(motor.decidirPorCriterios(entrada()),/ENCERRADO/);
  finish();await pending;await closing;assert.deepEqual(h.released.sort(),['encoder','head']);
});

test('CLI exige quatro flags e SHA-256, não tem caminhos padrão nem sobrescrita de entrada/modelo',()=>{
  const valid=['--model-dir','./modelo','--cases','./casos.json','--output','./saida.json','--expected-cases-sha256','A'.repeat(64)];
  assert.equal(argumentos(valid).expectedCasesSha256,'a'.repeat(64));
  for(const args of [[],valid.slice(0,6),[...valid,'--extra','x'],[...valid.slice(0,6),'--output','outra'],
    [...valid.slice(0,7),'bad'],['--model-dir','./modelo','--cases','./casos.json','--output','./modelo/nova.json',...valid.slice(6)],
    ['--model-dir','./modelo','--cases','./casos.json','--output','./casos.json',...valid.slice(6)]])assert.throws(()=>argumentos(args));
});

test('schema de casos fechado separa entrada de metadados e aceita classes sensíveis por tipo',()=>{
  const [c]=validarCasos([caso()]);assert.deepEqual(Object.keys(c.entrada),['estado','pergunta','criterios']);
  assert.equal(c.gabarito.esperado,'D');assert.deepEqual(c.gabarito.classesSensiveis.aceite,['A']);
  for(const value of [{casos:[caso()]},[],[caso(),caso()],[{...caso(),esperado:'E'}],[{...caso(),critico:'true'}],
    [{...caso(),dimensao:[]}],[{...caso(),classesSensiveis:[]}],
    [{...caso(),classesSensiveis:{aceite:['E'],pagamento:[],conclusao:[]}}],[{...caso(),extra:'x'}]])assert.throws(()=>validarCasos(value));
});

test('validação de saída recusa abstenção estrutural, número não finito, probabilidade ou classe incoerente',()=>{
  const ok={prevista:'D',probabilidades:{A:0,B:0,C:0,D:1},tokens:4,duracaoMs:2,local:true};
  conferirDecisao(ok,entrada(),4);
  for(const x of [{...ok,prevista:null},{...ok,abstencao:true},{...ok,tokens:5},{...ok,duracaoMs:NaN},
    {...ok,local:false},{...ok,prevista:'A'},{...ok,probabilidades:{A:0,B:0,C:0,D:.5}}])assert.throws(()=>conferirDecisao(x,entrada(),4));
});

test('métricas incluem incompletude no denominador e falso estado por dimensão',()=>{
  const base={...caso(),dimensao:'contrato',estado:'executado',correta:false,decisao:{prevista:'A'}};
  const result=metricas([base,{...base,id:'2',estado:'nao_executado',decisao:null},{...base,id:'3',correta:true,decisao:{prevista:'D'}}]);
  assert.equal(result.global.acuracia,1/3);assert.equal(result.global.incompletas,1);
  assert.equal(result.porDimensao.contrato.falsosEstados.aceite,1);assert.equal(result.global.acuraciaCritica,1/3);
});

test('recibo atômico nunca substitui existente, inclusive dois escritores concorrentes',async()=>temp(async dir=>{
  const path=join(dir,'recibo.json'),results=await Promise.allSettled([gravarAtomico(path,{id:1}),gravarAtomico(path,{id:2})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const before=await readFile(path,'utf8');await assert.rejects(gravarAtomico(path,{id:3}),{code:'EEXIST'});
  assert.equal(await readFile(path,'utf8'),before);assert.deepEqual(await readdir(dir),['recibo.json']);
}));

function loaderFake({failAt=0,closeFailure=false}={}){
  const received=[];let count=0,closed=0;
  return {received,get closed(){return closed;},load:async()=>({modelo:{revision:'fake',manifestSha256:'0'.repeat(64)},
    validar:()=>({tokens:10}),decidirPorCriterios:async input=>{
      received.push(input);count++;if(count===failAt)throw Error('private text must not enter logs');
      return {prevista:'D',probabilidades:{A:0,B:0,C:0,D:1},tokens:10,duracaoMs:0,local:true};},
    close:async()=>{closed++;if(closeFailure)throw Error('CONTEXTO_FECHAMENTO_FALHOU');}})};
}
async function probeFiles(dir,casos=[caso()]){
  const cases=join(dir,'entrada-ficticia.json'),bytes=Buffer.from(JSON.stringify(casos));await writeFile(cases,bytes);
  return {cases,output:join(dir,'recibo.json'),modelDir:join(dir,'modelo-inexistente'),expectedCasesSha256:hash(bytes)};
}

test('CLI fake prova separação gabarito, recibo/hashes, logs mínimos e ausência de aprovação',async()=>temp(async dir=>{
  const opts=await probeFiles(dir,[caso(),caso('caso1')]),fake=loaderFake(),logs=[];
  const result=await executarProbe(opts,{carregar:fake.load,log:row=>logs.push(row)});
  assert.equal(result.completo,true);assert.equal(result.passou,false);assert.equal(fake.closed,1);
  assert.equal(result.metricas.global.corretas,2);assert.equal(result.tempos.quente.quantidade,1);
  assert.equal(result.hashes.casos,opts.expectedCasesSha256);assert.equal(Object.keys(result.hashes.codigo).length,6);
  assert.equal(result.rede.chamadasDoAdaptador,0);
  for(const input of fake.received)assert.deepEqual(Object.keys(input),['estado','pergunta','criterios']);
  for(const row of logs)assert.deepEqual(Object.keys(row),['id','duracaoMs']);
  assert.equal(JSON.parse(await readFile(opts.output,'utf8')).completo,true);
}));

test('hash incorreto ou schema inválido produz incompleto sem carregar motor',async()=>temp(async dir=>{
  for(const [i,invalid] of ['hash','schema'].entries()){
    const opts=await probeFiles(dir,invalid==='schema'?{casos:[caso()]}:[caso()]);opts.output=join(dir,`erro${i}.json`);
    if(invalid==='hash')opts.expectedCasesSha256='0'.repeat(64);
    let loaded=false;const result=await executarProbe(opts,{carregar:async()=>{loaded=true;throw Error('must not load');}});
    assert.equal(loaded,false);assert.equal(result.completo,false);assert.equal(result.passou,false);
    assert.equal(result.erros[0].etapa,'casos');
  }
}));

test('todos os tokens são validados antes da primeira inferência, e erro fecha o motor',async()=>temp(async dir=>{
  const opts=await probeFiles(dir,[caso(),caso('caso1')]);let validados=0,inferencias=0,closed=0;
  const result=await executarProbe(opts,{carregar:async()=>({modelo:{fake:true},
    validar:()=>{if(++validados===2)throw Error('CONTEXTO_JANELA_EXTENSA');return {tokens:10};},
    decidirPorCriterios:async()=>{inferencias++;},close:async()=>{closed++;}})});
  assert.equal(inferencias,0);assert.equal(closed,1);assert.equal(result.completo,false);
  assert.equal(result.metricas.global.incompletas,2);assert.equal(result.erros[0].etapa,'validacao_tokens');
}));

test('falha de inferência ou fechamento nunca aprova e preserva resultado parcial',async()=>temp(async dir=>{
  for(const [i,config] of [{failAt:2},{closeFailure:true}].entries()){
    const opts=await probeFiles(dir,[caso(),caso('caso1')]);opts.output=join(dir,`parcial${i}.json`);
    const fake=loaderFake(config),result=await executarProbe(opts,{carregar:fake.load});
    assert.equal(fake.closed,1);assert.equal(result.completo,false);assert.equal(result.passou,false);
    assert.equal(result.metricas.global.corretas,config.failAt?1:2);
    assert.ok(!JSON.stringify(result.erros).includes('private text'));
  }
}));

test('saída existente interrompe CLI antes de ler casos ou carregar modelo',async()=>temp(async dir=>{
  const output=join(dir,'existente.json');await writeFile(output,'original');let loaded=false;
  await assert.rejects(executarProbe({output,cases:'inexistente',modelDir:'inexistente'},
    {carregar:async()=>{loaded=true;}}),/SAIDA_EXISTENTE/);
  assert.equal(loaded,false);assert.equal(await readFile(output,'utf8'),'original');
}));
