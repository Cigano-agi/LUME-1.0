import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {CAMPOS} from '../src/sintese-contexto/contrato.js';
import {conferirRecorte,esquema,mensagens,expandir,aceitarTermino} from '../scripts/lib/sintese-dev-composicao.mjs';
import {argumentosServidor,requisicao,interpretarSSE,ambienteMinimo,processo,encerrarProcesso} from '../scripts/lib/sintese-dev-runtime.mjs';
import {CASOS} from '../scripts/lib/sintese-dev-casos.mjs';
const fontes=[{id:'E1',autor:'Teste A',data:'2026-09-26T13:00:00Z',texto:'Vou revisar o índice; ainda não concluí.'}];
const blank=()=>Object.fromEntries(CAMPOS.map(c=>[c,null]));
test('expande referencias mantendo texto integral e contrato existente congelado',()=>{
  const out={...blank(),proximoPasso:{t:'Teste A vai revisar o índice.',f:['E1']}};
  const r=expandir(JSON.stringify(out),fontes);
  assert.equal(r.estado,'interpretado');assert.equal(r.cartao.proximoPasso.citacoes[0].trecho,fontes[0].texto);
  assert.equal(r.cartao.proximoPasso.citacoes[0].inicio,0);assert.equal(r.cartao.proximoPasso.citacoes[0].fim,fontes[0].texto.length);
  assert.ok(Object.isFrozen(r.cartao.proximoPasso.citacoes));
});
test('insuficiente fica vazio, sem fabricar identidade a partir de metadado',()=>assert.equal(expandir(JSON.stringify(blank()),fontes).estado,'insuficiente'));
test('recusa fontes ausentes, duplicadas, campos extras, texto vazio e formatos inesperados',()=>{
  for(const value of [{t:'a',f:['E2']},{t:'a',f:['E1','E1']},{t:'a',f:['E1'],executar:true},{t:'',f:['E1']},{t:'a',f:[]},['a','E1']]){
    assert.throws(()=>expandir(JSON.stringify({...blank(),quem:value}),fontes));
  }
  assert.throws(()=>expandir(JSON.stringify({...blank(),executar:'x'}),fontes));
  assert.throws(()=>expandir('```json\n{}\n```',fontes));
});
test('recusa entrada extensa por fonte, soma ou quantidade sem truncar',()=>{
  assert.throws(()=>conferirRecorte([{...fontes[0],texto:'x'.repeat(701)}]));
  assert.throws(()=>conferirRecorte(Array.from({length:4},(_,i)=>({...fontes[0],id:`E${i+1}`,texto:'x'.repeat(650)}))));
  assert.throws(()=>conferirRecorte(Array.from({length:9},(_,i)=>({...fontes[0],id:`E${i+1}`}))));
  assert.equal(conferirRecorte(fontes)[0].texto,fontes[0].texto);
});
test('estrutura fechada permite apenas IDs do recorte e conserva cinco campos',()=>{
  const s=esquema(fontes);assert.deepEqual(s.required,[...CAMPOS]);assert.equal(s.additionalProperties,false);
  assert.deepEqual(s.properties.quem.anyOf[1].properties.f.items.enum,['E1']);
});
test('prompt recebe somente fontes, nunca rubrica ou instrucoes convertidas em sistema',()=>{
  for(const c of CASOS){const p=mensagens(c.fontes);assert.equal(p.length,2);assert.deepEqual(JSON.parse(p[1].content),{fontes:c.fontes});assert.ok(!JSON.stringify(p).includes(c.rubrica));}
  assert.throws(()=>mensagens(fontes,3));
});
test('citação literal não aprova afirmação falsa: gate semântico continua separado',()=>{
  const r=expandir(JSON.stringify({...blank(),acontecimento:{t:'Teste A concluiu a revisão.',f:['E1']}}),fontes);
  assert.equal(r.estado,'interpretado'); // Deliberately false statement still passes structure.
});
test('termino exige stop; length, EOF, ferramenta e raciocinio são recusados',()=>{
  aceitarTermino([{choices:[{finish_reason:'stop'}]}]);
  for(const rows of [[],[{choices:[{finish_reason:'length'}]}],[{choices:[{delta:{reasoning_content:'x'}}]},{choices:[{finish_reason:'stop'}]}],[{choices:[{delta:{tool_calls:[{}]}}]},{choices:[{finish_reason:'stop'}]}]])assert.throws(()=>aceitarTermino(rows));
});
test('SSE preserva unicode, rejeita EOF truncado e eventos depois do DONE',()=>{
  const frame='data: '+JSON.stringify({choices:[{index:0,delta:{content:'ação'},finish_reason:null}]})+'\r\n\r\n';
  const stop='data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\r\n\r\n';
  assert.equal(interpretarSSE(frame+stop+'data: [DONE]\r\n\r\n').raw,'ação');
  assert.throws(()=>interpretarSSE(frame+stop));assert.throws(()=>interpretarSSE(frame+stop+'data: [DONE]\n\n'+frame));
});
test('encerramento exige saída confirmada, recusa timeout e remove listeners',async()=>{
  const p=()=>Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});
  const normal=p();normal.kill=()=>queueMicrotask(()=>normal.emit('close',0));
  await encerrarProcesso(normal);assert.equal(normal.listenerCount('close'),0);
  const hung=p();hung.kill=()=>false;
  await assert.rejects(encerrarProcesso(hung,{esperaMs:5}),/DEV_ENCERRAMENTO_NAO_CONFIRMADO/);
  assert.equal(hung.listenerCount('close'),0);
  const failed=p();failed.kill=()=>{throw Error('falha sintética');};
  await assert.rejects(encerrarProcesso(failed),/falha sintética/);assert.equal(failed.listenerCount('close'),0);
  await encerrarProcesso(undefined);
  await encerrarProcesso({exitCode:0,signalCode:null,kill(){throw Error('já encerrado');}});
});
test('servidor sempre loopback, CPU, offline, limitado e sem UI; ambiente sem credenciais herdadas',()=>{
  const a=argumentosServidor('fixed.gguf',38201,'a'.repeat(64));
  for(const [key,value] of [['--host','127.0.0.1'],['--device','none'],['--gpu-layers','0'],['--threads','4'],['--parallel','1'],['--cache-ram','0']])assert.equal(a[a.indexOf(key)+1],value);
  assert.ok(a.includes('--offline'));assert.ok(a.includes('--no-webui'));
  assert.throws(()=>argumentosServidor('x',80,'a'.repeat(64)));assert.throws(()=>argumentosServidor('x',38000,'external-key'));
  assert.deepEqual(Object.keys(ambienteMinimo('work')).sort(),['PATH','SystemRoot','TEMP','TMP','WINDIR'].sort());
  const request=requisicao(fontes,1);assert.equal(request.chat_template_kwargs.enable_thinking,false);assert.equal(request.cache_prompt,false);assert.equal(request.max_tokens,512);
});
test('runner de desenvolvimento não aceita conjunto ou perfil por argumento',async()=>{
  const runner=fileURLToPath(new URL('../scripts/sintese-dev-benchmark.mjs',import.meta.url));
  for(const argv of [['--profile','external'],['3','--cpu-exclusiva-confirmada'],['1','--cpu-exclusiva-confirmada','--cases=outside']]){
    const r=await processo(process.execPath,[runner,...argv]);assert.notEqual(r.code,0);assert.match(r.stderr,/USE: node scripts\/sintese-dev-benchmark/);
  }
});
