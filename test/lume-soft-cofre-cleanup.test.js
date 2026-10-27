import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
const source=fs.readFileSync(new URL('../desktop/segredos.cjs',import.meta.url),'utf8');
const providers=[
 {name:'Gemini',file:'gemini.seguro',write:'gravar',read:'ler',remove:'remover',state:'estado',value:'chave_sintetica_123456789'},
 {name:'OpenRouter',file:'openrouter.seguro',write:'openrouter-gravar',read:'openrouter-ler',remove:'openrouter-remover',state:'openrouter-estado',value:'sk-or-v1-'+'a'.repeat(64)},
 {name:'Telegram',file:'telegram.seguro',write:'telegram-gravar',read:'telegram-ler',remove:'telegram-remover',state:'telegram-estado',value:'123456789:'+'A'.repeat(40)},
 ...['chatgpt','github','clickup'].map(name=>({name,file:'lume-'+name+'.seguro',write:name+'-gravar',read:name+'-ler',remove:name+'-remover',state:name+'-estado',value:name==='chatgpt'?JSON.stringify({version:1,accounts:[]}):'credencial_sintetica_123456789'})),
];
function fixture(t){
 const dir=fs.mkdtempSync(join(tmpdir(),'lume-cofre-fault-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const faults={rename:false,cleanup:false,existsBlind:false,partialWrite:false},cipher=new Map();let n=0;
 const safe={isEncryptionAvailable:()=>true,encryptString:value=>{const id='CIFRA-'+ ++n;cipher.set(id,value);return Buffer.from(id);},decryptString:value=>cipher.get(value.toString())};
 const error=()=>Object.assign(new Error('Falha sintética de filesystem'),{code:'EPERM'});
 const mocked={...fs,existsSync:path=>faults.existsBlind?false:fs.existsSync(path),
  writeFileSync(path,bytes,options){if(faults.partialWrite){fs.writeFileSync(path,bytes.subarray(0,2),options);throw Object.assign(new Error('Escrita parcial sintética'),{code:'EIO'});}return fs.writeFileSync(path,bytes,options);},
  renameSync(from,to){if(faults.rename)throw error();return fs.renameSync(from,to);},unlinkSync(path){if(faults.cleanup&&path.endsWith('.tmp'))throw error();return fs.unlinkSync(path);}};
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,require:name=>name==='node:fs'?mocked:require(name),process,Buffer});
 return {dir,faults,cofre:module.exports.criarCofre(dir,safe)};
}
for(const provider of providers)test('cofre '+provider.name+': falha de troca preserva cifra anterior e não deixa temporário',t=>{
 const {dir,faults,cofre}=fixture(t),target=join(dir,provider.file);
 cofre.executar(provider.write,provider.value);const previous=fs.readFileSync(target);
 faults.rename=true;assert.throws(()=>cofre.executar(provider.write,provider.value),{code:'EPERM'});
 assert.deepEqual(fs.readFileSync(target),previous);assert.equal(cofre.executar(provider.read),provider.value);
 assert.equal(fs.existsSync(target+'.tmp'),false);
 assert.equal(fs.readFileSync(target,'utf8').includes(provider.value),false);
});
for(const provider of providers)test('cofre '+provider.name+': remover inclui resíduo cifrado e falha explicitamente se limpeza for recusada',t=>{
 const {dir,faults,cofre}=fixture(t),target=join(dir,provider.file);
 cofre.executar(provider.write,provider.value);fs.writeFileSync(target+'.tmp','CIFRA-ORFA');
 faults.cleanup=true;assert.throws(()=>cofre.executar(provider.remove),{code:'EPERM'});
 assert.equal(cofre.executar(provider.state).configurada,true,'não confirma remoção parcial');
 faults.cleanup=false;assert.deepEqual({...cofre.executar(provider.remove)},{ok:true});
 assert.equal(fs.existsSync(target),false);assert.equal(fs.existsSync(target+'.tmp'),false);
 assert.equal(cofre.executar(provider.state).configurada,false);
 fs.writeFileSync(target+'.tmp','CIFRA-ORFA');cofre.executar(provider.remove);
 assert.equal(fs.existsSync(target+'.tmp'),false,'limpa mesmo sem arquivo definitivo');
});
test('cofre F10: criação recusada remove temporário sem criar identidade ou afetar credenciais',t=>{
 const {dir,faults,cofre}=fixture(t);faults.rename=true;
 assert.throws(()=>cofre.executar('f10-criar'),{code:'EPERM'});
 assert.equal(fs.existsSync(join(dir,'compartilhamento.seguro')),false);
 assert.equal(fs.existsSync(join(dir,'compartilhamento.seguro.tmp')),false);
 assert.equal(cofre.executar('f10-estado').criada,false);
});
test('cofre: existsSync inconclusivo não serve como prova de remoção',t=>{
 const {dir,faults,cofre}=fixture(t),target=join(dir,'gemini.seguro');
 cofre.executar('gravar',providers[0].value);fs.writeFileSync(target+'.tmp','CIFRA-ORFA');
 faults.existsBlind=true;faults.cleanup=true;
 assert.throws(()=>cofre.executar('remover'),{code:'EPERM'});
 faults.cleanup=false;cofre.executar('remover');
 assert.equal(fs.existsSync(target),false);assert.equal(fs.existsSync(target+'.tmp'),false);
});
test('cofre: escrita parcial rejeita e limpa temporário sem substituir destino anterior',t=>{
 const {dir,faults,cofre}=fixture(t),target=join(dir,'gemini.seguro');
 cofre.executar('gravar',providers[0].value);const previous=fs.readFileSync(target);
 faults.partialWrite=true;assert.throws(()=>cofre.executar('gravar',providers[0].value),{code:'EIO'});
 assert.deepEqual(fs.readFileSync(target),previous);assert.equal(fs.existsSync(target+'.tmp'),false);
});
test('cofre: falhas de troca e limpeza ficam explícitas até a remoção poder concluir',t=>{
 const {dir,faults,cofre}=fixture(t),target=join(dir,'gemini.seguro');
 cofre.executar('gravar',providers[0].value);const previous=fs.readFileSync(target);
 faults.rename=true;faults.cleanup=true;
 assert.throws(()=>cofre.executar('gravar',providers[0].value),{code:'EPERM'});
 assert.deepEqual(fs.readFileSync(target),previous);assert.match(fs.readFileSync(target+'.tmp','utf8'),/^CIFRA-/);
 assert.throws(()=>cofre.executar('remover'),{code:'EPERM'});
 faults.cleanup=false;cofre.executar('remover');
 assert.equal(fs.existsSync(target),false);assert.equal(fs.existsSync(target+'.tmp'),false);
});
