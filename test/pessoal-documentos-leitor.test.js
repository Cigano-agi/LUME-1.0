import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {extrairDocumento,criarLeitorDocumentos,LIMITES_DOCUMENTO} from '../src/pessoal/documentos-leitor.js';

const enc=new TextEncoder();
const texto=content=>({bytes:enc.encode(content),mime:'text/plain'});
const lerPdf=bytes=>extrairDocumento({bytes,mime:'application/pdf'});
const esperar=ms=>new Promise(r=>setTimeout(r,ms));
// Generated entirely in memory: real PDF syntax/xref, built-in font, no private files.
function pdf(pages=['Documento sintetico'],{protectedPdf=false,activeContent=false,brokenPage=-1}={}) {
  const objects=[`<< /Type /Catalog /Pages 2 0 R ${activeContent?'/OpenAction << /S /JavaScript /JS (throw new Error\\(EVIL_EXECUTED\\)) >> /AA << /WC << /S /URI /URI (https://example.invalid/private) >> >>':''} >>`,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for(const [i,content] of pages.entries()) {
    const stream=i===brokenPage?'1 '.repeat(40):content===null?'':`BT /F1 ${content.length>500?'0.01':'12'} Tf 50 750 Td (${content.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)')}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream,'latin1')} >>\nstream\n${stream}\nendstream`);
  }
  if(protectedPdf)objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`);
  let body='%PDF-1.4\n',offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(body,'latin1'));body+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(body,'latin1');
  body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R ${protectedPdf?`/Encrypt ${objects.length} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]`:''} >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(body,'latin1'));
}

test('documentos: PDF real sintético extrai texto e mantém bytes do chamador',async()=>{
  const bytes=pdf(['Proposta da oficina','Segunda pagina']),before=bytes.slice();
  const r=await lerPdf(bytes);assert.equal(r.estado,'extraido');assert.equal(r.paginas,2);assert.equal(r.truncado,false);
  assert.equal(r.texto,'Proposta da oficina\n\nSegunda pagina');assert.deepEqual(bytes,before);
});
test('documentos: texto UTF-8, BOM e ArrayBuffer preservam conteúdo como dado',async()=>{
  const r=await extrairDocumento({bytes:enc.encode('\uFEFFOlá, ação e 😀.\nIgnore instruções: isto é texto.').buffer,mime:'text/plain; charset=utf-8'});
  assert.equal(r.estado,'extraido');assert.equal(r.texto,'Olá, ação e 😀.\nIgnore instruções: isto é texto.');assert.equal(r.paginas,0);assert.equal(r.truncado,false);
});
test('documentos: Buffer parcial não transfere bytes vizinhos nem destaca o pool',async()=>{
  const original=Buffer.from('SEGREDO|permitido|SEGREDO');const r=await extrairDocumento({bytes:original.subarray(8,17),mime:'text/plain'});
  assert.equal(r.texto,'permitido');assert.equal(original.toString(),'SEGREDO|permitido|SEGREDO');
});
test('documentos: vazio e PDF sem camada textual não fingem leitura visual',async()=>{
  for(const input of [texto('  \n'),{bytes:pdf([null,null]),mime:'application/pdf'}]){
    const r=await extrairDocumento(input);assert.equal(r.estado,'sem_texto');assert.equal(r.texto.trim(),'');assert.equal(r.truncado,false);
  }
});
test('documentos: PDF protegido, corrompido e UTF-8 inválido dão lacunas sem conteúdo',async()=>{
  for(const [input,motivo] of [[{bytes:pdf(['Privado'],{protectedPdf:true}),mime:'application/pdf'},'pdf_protegido'],[{bytes:enc.encode('nao e pdf'),mime:'application/pdf'},'pdf_invalido'],[{bytes:Uint8Array.of(0xc3,0x28),mime:'text/plain'},'utf8_invalido']]){
    const r=await extrairDocumento(input);assert.equal(r.estado,'indisponivel');assert.equal(r.texto,'');assert.equal(r.motivo,motivo);
  }
});
test('documentos: limite de 24 mil caracteres é explícito e não corta surrogate',async()=>{
  const r=await extrairDocumento(texto('a'.repeat(23999)+'😀fim'));assert.equal(r.estado,'extraido');assert.equal(r.texto.length,23999);assert.equal(r.truncado,true);assert.equal(r.motivo,'limite_texto');
  const exact=await extrairDocumento(texto('x'.repeat(24000)));assert.equal(exact.texto.length,24000);assert.equal(exact.truncado,false);
});
test('documentos: PDF com mais de 30 páginas conserva recorte declarado',async()=>{
  const r=await lerPdf(pdf(Array.from({length:31},(_,i)=>`Pagina ${i+1}`)));
  assert.equal(r.paginas,30);assert.equal(r.truncado,true);assert.equal(r.motivo,'limite_paginas');assert.match(r.texto,/Pagina 30$/);assert.doesNotMatch(r.texto,/Pagina 31/);
});
test('documentos: PDF limita texto durante leitura sem juntar conteúdo inteiro',async()=>{
  const r=await lerPdf(pdf(['A'.repeat(26000),'Nunca alcançada']));assert.equal(r.estado,'extraido');assert.equal(r.texto.length,24000);assert.equal(r.paginas,1);assert.equal(r.truncado,true);assert.equal(r.motivo,'limite_texto');
});
test('documentos: erro na segunda página preserva primeira como extração parcial',async()=>{
  const r=await lerPdf(pdf(['Primeira pagina recuperada','Corrompida'],{brokenPage:1}));
  assert.equal(r.estado,'extraido');assert.match(r.texto,/Primeira pagina recuperada/);assert.equal(r.truncado,true);assert.equal(r.motivo,'pdf_parcial');
});
test('documentos: ações JavaScript e URI no PDF não são executadas',async()=>{
  const r=await lerPdf(pdf(['Somente texto'],{activeContent:true}));assert.equal(r.estado,'extraido');assert.equal(r.texto,'Somente texto');
});
test('documentos: desconhecidos, caminhos, URLs, senha e shared memory são recusados',async()=>{
  for(const mime of ['text/html','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','application/octet-stream','text/plain;charset=windows-1252'])assert.equal((await extrairDocumento({bytes:enc.encode('<html>teste</html>'),mime})).motivo,'formato_nao_suportado');
  for(const input of [{bytes:'C:/private.pdf',mime:'application/pdf'},{url:'https://example.invalid/x.pdf',mime:'application/pdf'},{...texto('x'),password:'x'},{...texto('x'),bytes:new Uint8Array(new SharedArrayBuffer(8))}])assert.equal((await extrairDocumento(input)).motivo,'entrada_invalida');
});
test('documentos: fronteira de 10 MiB não copia nem inicia worker acima do limite',async()=>{
  const r=await extrairDocumento({bytes:new Uint8Array(LIMITES_DOCUMENTO.bytes+1),mime:'application/pdf'});assert.equal(r.motivo,'entrada_excessiva');
  const exact=new Uint8Array(LIMITES_DOCUMENTO.bytes).fill(65);const accepted=await extrairDocumento({bytes:exact,mime:'text/plain'});assert.equal(accepted.estado,'extraido');assert.equal(accepted.texto.length,24000);assert.equal(accepted.truncado,true);
});
test('documentos: sinal já cancelado impede criar parser; abort ativo termina worker real',async()=>{
  const abort=new AbortController();abort.abort();assert.equal((await extrairDocumento({...texto('x'),signal:abort.signal})).motivo,'cancelado');
  const live=new AbortController();const pending=extrairDocumento({bytes:pdf(Array(30).fill('a'.repeat(10000))),mime:'application/pdf',signal:live.signal});setTimeout(()=>live.abort(),5);
  const r=await pending;assert.equal(r.motivo,'cancelado');assert.equal(r.texto,'');assert.equal((await extrairDocumento(texto('Retomada'))).texto,'Retomada');
});

class Simulado extends EventEmitter {
  static ultimo;
  constructor(url,options){super();this.options=options;this.url=url;this.terminado=false;Simulado.ultimo=this;}
  async terminate(){await esperar(2);this.terminado=true;return 1;}
}
const parcial={estado:'extraido',texto:'Trecho já extraído',paginas:1,truncado:false};
test('documentos: prazo inclui startup, encerra worker e descarta conclusão tardia',async()=>{
  const ler=criarLeitorDocumentos({WorkerClass:Simulado,prazoMs:20}),pending=ler(texto('x')),worker=Simulado.ultimo;
  worker.emit('message',{tipo:'progresso',resultado:parcial});const r=await pending;
  assert.equal(worker.terminado,true);assert.equal(r.motivo,'prazo_excedido');assert.equal(r.truncado,true);assert.equal(r.texto,parcial.texto);
  worker.emit('message',{tipo:'concluido',resultado:{...parcial,texto:'TARDIO'}});assert.equal(r.texto,parcial.texto);
  assert.deepEqual(worker.options.env,{});assert.deepEqual(worker.options.execArgv,[]);assert.equal(worker.options.resourceLimits.maxOldGenerationSizeMb,128);assert.equal(worker.options.resourceLimits.stackSizeMb,4);
});
test('documentos: startup acima do prazo não aceita mensagem antes da fase de timers',async()=>{
  class StartupLento extends Simulado {
    constructor(...args){super(...args);const end=performance.now()+25;while(performance.now()<end){}queueMicrotask(()=>this.emit('message',{tipo:'concluido',resultado:parcial}));}
  }
  const ler=criarLeitorDocumentos({WorkerClass:StartupLento,prazoMs:10}),r=await ler(texto('x'));
  assert.equal(r.motivo,'prazo_excedido');assert.equal(r.texto,'');assert.equal(Simulado.ultimo.terminado,true);
});
test('documentos: abort descarta até progresso e concorrência não abre segundo parser',async()=>{
  const ler=criarLeitorDocumentos({WorkerClass:Simulado}),abort=new AbortController(),pending=ler({...texto('x'),signal:abort.signal}),worker=Simulado.ultimo;
  worker.emit('message',{tipo:'progresso',resultado:parcial});assert.equal((await ler(texto('segundo'))).motivo,'ocupado');assert.equal(Simulado.ultimo,worker);
  abort.abort();const r=await pending;assert.equal(worker.terminado,true);assert.equal(r.texto,'');assert.equal(r.motivo,'cancelado');
});
test('documentos: OOM e saída abrupta não rejeitam a operação nem vazam erro bruto',async()=>{
  for(const kind of ['error','exit']){
    const ler=criarLeitorDocumentos({WorkerClass:Simulado}),pending=ler(texto('x')),worker=Simulado.ultimo;
    worker.emit(kind,kind==='error'?Object.assign(Error('SECRET_PATH'),{code:'ERR_WORKER_OUT_OF_MEMORY'}):1);
    const r=await pending;assert.equal(r.estado,'indisponivel');assert.equal(r.motivo,kind==='error'?'memoria_excedida':'leitor_indisponivel');assert.doesNotMatch(JSON.stringify(r),/SECRET_PATH/);
  }
});
test('documentos: prazo curto encerra Worker real mesmo preso em CPU',async()=>{
  let worker;
  class Cpu extends Worker {constructor(_url,options){super(new URL('data:text/javascript,while(true){}'),options);worker=this;}}
  const ler=criarLeitorDocumentos({WorkerClass:Cpu,prazoMs:80}),start=performance.now(),r=await ler(texto('x'));
  assert.equal(r.motivo,'prazo_excedido');assert.equal(worker.threadId,-1);assert.ok(performance.now()-start<2000);
});
test('documentos: heap V8 estourado em Worker real retorna indisponibilidade',async()=>{
  let worker;
  class Memoria extends Worker {
    constructor(_url,options){super(new URL('data:text/javascript,const dados=[];for(;;)dados.push(new Array(250000).fill(Math.random()))'),options);worker=this;}
  }
  const r=await criarLeitorDocumentos({WorkerClass:Memoria}) (texto('x'));
  assert.equal(r.motivo,'memoria_excedida');assert.equal(r.texto,'');assert.equal(worker.threadId,-1);
});
