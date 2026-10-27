import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {criarEncerramentoDesktop} from '../desktop/encerramento.js';

const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('corta de imediato, inicia todas as drenagens e fecha DB por ultimo',async()=>{
  const a=defer(),b=defer(),eventos=[];
  const fechar=criarEncerramentoDesktop({cortar:()=>eventos.push('corte'),drenar:[()=>{eventos.push('a');return a.promise;},()=>{eventos.push('b');return b.promise;}],fecharBanco:()=>eventos.push('db'),sair:codigo=>eventos.push(`exit:${codigo}`)});
  const primeiro=fechar(),segundo=fechar();assert.equal(primeiro,segundo);assert.deepEqual(eventos,['corte','a','b']);
  a.resolve();await Promise.resolve();assert.equal(eventos.includes('db'),false);
  b.resolve();await primeiro;assert.deepEqual(eventos,['corte','a','b','db','exit:0']);
});

test('falha espera os demais finalizers e nao fecha DB nem sai com zero',async()=>{
  const a=defer(),b=defer(),eventos=[];
  const fechar=criarEncerramentoDesktop({cortar:()=>eventos.push('corte'),drenar:[()=>a.promise,()=>b.promise],fecharBanco:()=>eventos.push('db'),sair:codigo=>eventos.push(`exit:${codigo}`)});
  const fim=fechar();a.reject(Error('falha sintetica'));await Promise.resolve();assert.deepEqual(eventos,['corte']);
  b.resolve();await assert.rejects(fim,/falha sintetica/);assert.deepEqual(eventos,['corte']);
});

test('entrypoint usa drenagem terminal de HTTP, semantica e transporte',async()=>{
  const codigo=await readFile(new URL('../desktop/service.js',import.meta.url),'utf8');
  assert.match(codigo,/criarEncerramentoDesktop/);
  assert.match(codigo,/server\.encerrar\(\)/);
  assert.match(codigo,/semantica\.encerrar\(\)/);
  assert.match(codigo,/conexao\.encerrar\(\)/);
  assert.match(codigo,/\(\)=>preparoLaya/);
  assert.match(codigo,/pendente\.reject\(new Error\('O Lume está encerrando\.'/);
  assert.match(codigo,/if\(ready&&!fechando\)filaLaya\.sinalizar\(\)/);
  assert.match(codigo,/if\(fechando\)return;/);
  assert.doesNotMatch(codigo,/server\.closeAllConnections\(\)/);
});

test('helper de encerramento integra o pacote desktop',async()=>{
  const pacote=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.ok(pacote.build.files.includes('desktop/encerramento.js'));
});
