import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { conferirPerfilTeste, conferirBancoPerfil } from './perfil-teste.js';
import { cabecalhoWav, MAX_PARTE_PCM, UUID } from './contrato.js';
import { selecionarDireitosSessao, iterarExportacaoSessao, validarPublicacaoSessao } from './direitos-selecao.js';

const codigos = new Set(['ENTRADA','FECHADO','DIREITO','AUSENTE','CONFLITO','INTEGRIDADE','LIMITE','CANCELADO','IO']);
const erro = (code, message) => Object.assign(new Error(message), { code });
const hash = () => createHash('sha256');
const mesmo = (a,b) => a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs;
const mesmoArquivo = (a,b) => a.dev===b.dev && a.ino===b.ino && a.size===b.size &&
  a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs && a.nlink===b.nlink;
const identidade = (a,b) => a.dev===b.dev && a.ino===b.ino && a.isDirectory()===b.isDirectory() && a.isFile()===b.isFile();
const dentro = (root,p) => { const rel=relative(root,p); return !!rel && rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel); };
const abortar = signal => { if(signal?.aborted) throw erro('CANCELADO','Exportação cancelada.'); };
const ceder = () => new Promise(resolve => setImmediate(resolve));
function validarPasta(root,p,permitirRaiz=false) {
  if(typeof p!=='string'||!isAbsolute(p))throw erro('ENTRADA','Destino inválido.');
  const abs=resolve(p),rel=relative(root,abs);
  if((!permitirRaiz&&!dentro(root,abs))||(permitirRaiz&&rel!==''&&!dentro(root,abs)))
    throw erro('ENTRADA','Destino inválido.');
  let atual=root;
  for(const parte of rel.split(sep).filter(Boolean)){
    atual=join(atual,parte);
    const s=lstatSync(atual);
    if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(atual)!==atual)
      throw erro('FECHADO','Pasta de destino inválida.');
  }
  const s=lstatSync(abs);
  if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(abs)!==abs)
    throw erro('FECHADO','Pasta de destino inválida.');
  return {path:abs,stat:s};
}
function conferirPasta(p,stat){
  const agora=lstatSync(p);
  if(!identidade(agora,stat)||agora.isSymbolicLink()||realpathSync(p)!==p)
    throw erro('IO','Pasta mudou durante a exportação.');
}
function conferirArquivo(path,stat){
  const atual=lstatSync(path,{bigint:true});
  if(!atual.isFile()||atual.isSymbolicLink()||atual.nlink!==1n||
    !mesmoArquivo(atual,stat)||realpathSync(path)!==path)
    throw erro('INTEGRIDADE','Arquivo exportado mudou.');
}
async function validarArquivo(path,bytes,sha256,signal){
  let fd;
  try{
    const antes=lstatSync(path,{bigint:true});
    if(!antes.isFile()||antes.isSymbolicLink()||antes.nlink!==1n||
      antes.size!==BigInt(bytes)||realpathSync(path)!==path)
      throw erro('INTEGRIDADE','Arquivo exportado inválido.');
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const aberto=fstatSync(fd,{bigint:true});
    if(!aberto.isFile()||!mesmoArquivo(antes,aberto))throw erro('INTEGRIDADE','Arquivo exportado mudou.');
    const digest=hash(),bloco=Buffer.alloc(64*1024);let lidos=0;
    while(lidos<bytes){
      abortar(signal);
      const n=readSync(fd,bloco,0,Math.min(bloco.length,bytes-lidos),lidos);
      if(n<=0)throw erro('INTEGRIDADE','Arquivo exportado truncado.');
      digest.update(bloco.subarray(0,n));lidos+=n;
      await ceder();
    }
    const depois=fstatSync(fd,{bigint:true});
    conferirArquivo(path,antes);
    if(!mesmoArquivo(antes,depois)||digest.digest('hex')!==sha256)
      throw erro('INTEGRIDADE','Arquivo exportado não confere.');
    return antes;
  }finally{if(fd!==undefined)closeSync(fd);}
}
function chamar(hook,...args){
  if(hook===undefined)return;
  if(typeof hook!=='function'||hook.constructor?.name==='AsyncFunction')throw erro('ENTRADA','Teste inválido.');
  const r=hook(...args);
  if(r&&typeof r.then==='function')throw erro('ENTRADA','Teste assíncrono recusado.');
}
function escreverCompleto(fd,bytes,escritor=writeSync){
  for(let i=0;i<bytes.length;){const n=escritor(fd,bytes,i,bytes.length-i);if(!Number.isSafeInteger(n)||n<=0||n>bytes.length-i)throw erro('IO','Escrita incompleta.');i+=n;}
}
function novoArquivo(path,registrar,escrever){
  const fd=openSync(path,'wx',0o600);
  try{registrar(path,fstatSync(fd),'arquivo');escrever(fd);fsyncSync(fd);}finally{closeSync(fd);}
}
function limpar(criados,pai){
  let pendente=false;
  for(const x of [...criados].reverse()){
    try{
      const parent=dirname(x.path), dono=criados.find(y=>y.path===parent)??(pai?.path===parent?pai:null);
      if(!dono){pendente=true;continue;}
      conferirPasta(parent,dono.stat);
      const atual=lstatSync(x.path);
      if(!identidade(atual,x.stat)||atual.isSymbolicLink()) {pendente=true;continue;}
      if(x.tipo==='arquivo')unlinkSync(x.path);else rmdirSync(x.path);
    }catch{pendente=true;}
  }
  return pendente;
}
async function copiarAudio(parte,origem,destino,registrar,signal,hooks){
  if(!UUID.test(parte.id)||parte.caminho!==parte.id+'.wav'||parte.estado!=='salva'||
    !Number.isSafeInteger(parte.posicao)||parte.posicao<0||!Number.isFinite(parte.duracao_ms)||
    parte.duracao_ms<=0||parte.duracao_ms>60000||!/^[a-f0-9]{64}$/.test(parte.sha256))
    throw erro('INTEGRIDADE','Parte inválida.');
  const path=join(origem,parte.id+'.wav');
  let fd;
  try{
    const antes=lstatSync(path);
    if(!antes.isFile()||antes.isSymbolicLink()||antes.size<46||antes.size>MAX_PARTE_PCM+44||
      realpathSync(path)!==path)throw erro('INTEGRIDADE','Original inválido.');
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const aberto=fstatSync(fd);
    if(!mesmo(antes,aberto)||!aberto.isFile())throw erro('INTEGRIDADE','Original mudou.');
    const cab=Buffer.alloc(44),n=readSync(fd,cab,0,44,0),pcm=antes.size-44;
    if(n!==44||pcm<2||pcm%2||!cab.equals(cabecalhoWav(pcm))||
      Math.abs(pcm/32-parte.duracao_ms)>0.001)throw erro('INTEGRIDADE','WAV inválido.');
    let total=0;const digest=hash(),bloco=Buffer.alloc(64*1024);
    const out=openSync(destino,'wx',0o600);
    try{
      registrar(destino,fstatSync(out),'arquivo');
      while(total<antes.size){
        abortar(signal);
        const got=readSync(fd,bloco,0,Math.min(bloco.length,antes.size-total),total);
        if(got<=0)throw erro('INTEGRIDADE','Original truncado.');
        const chunk=bloco.subarray(0,got);digest.update(chunk);escreverCompleto(out,chunk,hooks?.escrever);total+=got;
        chamar(hooks?.aposChunk);
        await ceder();
      }
      fsyncSync(out);
    }finally{closeSync(out);}
    const depois=fstatSync(fd),pathDepois=lstatSync(path);
    if(total!==antes.size||!mesmo(antes,depois)||!mesmo(antes,pathDepois)||
      realpathSync(path)!==path||digest.digest('hex')!==parte.sha256)
      throw erro('INTEGRIDADE','Original mudou ou está corrompido.');
    return {caminho:'audio/'+parte.id+'.wav',bytes:total,sha256:parte.sha256};
  }catch(e){if(e.code==='ENOENT'||e.code==='ELOOP')throw erro('INTEGRIDADE','Original indisponível.');throw e;}
  finally{if(fd!==undefined)closeSync(fd);}
}

export async function exportarSessao({dbPath,sessaoId,perfil,destinoPai,confirmar,signal,testHooks}={}){
  if(confirmar!==true||typeof dbPath!=='string'||!UUID.test(sessaoId||'')||
    !perfil||typeof perfil!=='object'||
    (signal!==undefined&&(typeof signal!=='object'||typeof signal.aborted!=='boolean')))
    throw erro('ENTRADA','Pedido de exportação inválido.');
  abortar(signal);
  const root=conferirPerfilTeste({notetakerExperimento:true,...perfil});
  let pai;
  try{pai=validarPasta(root,destinoPai);}catch(e){if(codigos.has(e.code))throw e;throw erro('ENTRADA','Destino inválido.');}
  const audioRoot=join(root,'notetaker-audio');
  if(pai.path===root||pai.path===audioRoot||dentro(audioRoot,pai.path))
    throw erro('ENTRADA','Destino inválido.');
  let db,criados=[],pasta;
  const registrar=(path,stat,tipo)=>criados.push({path,stat,tipo});
  try{
    if(!isAbsolute(dbPath)||lstatSync(dbPath).isSymbolicLink()||realpathSync(dbPath)!==resolve(dbPath))
      throw erro('FECHADO','Banco inválido.');
    db=new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    if(conferirBancoPerfil(db,root)!==resolve(dbPath))throw erro('FECHADO','Banco inválido.');
    if(db.isTransaction)throw erro('CONFLITO','Banco em transação.');
    const mapa=selecionarDireitosSessao(db,sessaoId,perfil);
    if(mapa.bloqueios.exportacao.length)throw erro('INTEGRIDADE','Exportação bloqueada.');
    conferirPasta(pai.path,pai.stat);
    const ar=validarPasta(root,audioRoot);
    abortar(signal);
    pasta=join(pai.path,randomUUID());mkdirSync(pasta,{mode:0o700});
    registrar(pasta,lstatSync(pasta),'diretorio');
    const audio=join(pasta,'audio');mkdirSync(audio,{mode:0o700});
    registrar(audio,lstatSync(audio),'diretorio');
    const dados=join(pasta,'dados.ndjson'),h=hash(),contagens={};let dadosBytes=0;
    const partes=[];
    const dadosFd=openSync(dados,'wx',0o600);registrar(dados,fstatSync(dadosFd),'arquivo');
    const iter=iterarExportacaoSessao(db,mapa,perfil);
    try{
      for(const linha of iter){
        abortar(signal);
        const bytes=Buffer.from(JSON.stringify(linha)+'\n');
        if(bytes.length>4*1024*1024||dadosBytes+bytes.length>256*1024*1024)
          throw erro('LIMITE','Dados acima do limite.');
        for(let offset=0;offset<bytes.length;offset+=64*1024){
          abortar(signal);conferirPasta(pasta,criados[0].stat);
          escreverCompleto(dadosFd,bytes.subarray(offset,Math.min(bytes.length,offset+64*1024)),testHooks?.escrever);
          await ceder();
        }
        h.update(bytes);dadosBytes+=bytes.length;
        contagens[linha.tabela]=(contagens[linha.tabela]??0)+1;
        if(linha.tabela==='notetaker_partes')partes.push(linha.registro);
      }
      fsyncSync(dadosFd);
    }finally{try{iter.return();}finally{closeSync(dadosFd);}}
    if(partes.length>120||partes.length!==mapa.ids.partes.length)throw erro('LIMITE','Partes acima do limite.');
    const audios=[];let audioBytes=0;
    for(const p of partes){
      abortar(signal);conferirPasta(ar.path,ar.stat);conferirPasta(pai.path,pai.stat);
      conferirPasta(pasta,criados[0].stat);conferirPasta(audio,criados[1].stat);
      const item=await copiarAudio(p,audioRoot,join(audio,p.id+'.wav'),registrar,signal,testHooks);
      audioBytes+=item.bytes;
      if(audioBytes>120*(MAX_PARTE_PCM+44))throw erro('LIMITE','Áudio acima do limite.');
      audios.push(item);chamar(testHooks?.aposCopiarAudio);
    }
    abortar(signal);
    const cobertura=mapa.cobertura;
    const completa=cobertura.importacao==='completa'&&cobertura.asr==='concluida';
    const manifesto={schema:1,sessaoId,revisao:mapa.revisao,cobertura:{...cobertura,tipo:completa?'completa':'parcial'},
      contagens,dados:{caminho:'dados.ndjson',bytes:dadosBytes,sha256:h.digest('hex')},audios,
      aviso:'Exportação legível para uso histórico. Não concede permissão para executar ações. A cobertura pode ser parcial quando importação ou transcrição não foi concluída.'};
    const manifestoBytes=Buffer.from(JSON.stringify(manifesto)+'\n');
    conferirPasta(pasta,criados[0].stat);
    const manifestoPath=join(pasta,'manifesto.json'),manifestoHash=hash().update(manifestoBytes).digest('hex');
    novoArquivo(manifestoPath,registrar,fd=>escreverCompleto(fd,manifestoBytes,testHooks?.escrever));
    const arquivos=[{path:dados,bytes:dadosBytes,sha256:manifesto.dados.sha256},
      ...audios.map(x=>({path:join(pasta,x.caminho),bytes:x.bytes,sha256:x.sha256})),
      {path:manifestoPath,bytes:manifestoBytes.length,sha256:manifestoHash}];
    for(const arquivo of arquivos){
      abortar(signal);conferirPasta(pai.path,pai.stat);conferirPasta(pasta,criados[0].stat);
      conferirPasta(audio,criados[1].stat);
      arquivo.stat=await validarArquivo(arquivo.path,arquivo.bytes,arquivo.sha256,signal);
    }
    conferirPasta(pai.path,pai.stat);conferirPasta(pasta,criados[0].stat);
    conferirPasta(audio,criados[1].stat);abortar(signal);
    validarPublicacaoSessao(db,mapa,perfil,()=>{
      chamar(testHooks?.antesMarcador);abortar(signal);conferirPasta(pai.path,pai.stat);
      conferirPasta(pasta,criados[0].stat);conferirPasta(audio,criados[1].stat);
      for(const arquivo of arquivos)conferirArquivo(arquivo.path,arquivo.stat);
      const final=Buffer.from(JSON.stringify({schema:1,manifestoSha256:manifestoHash})+'\n');
      novoArquivo(join(pasta,'CONCLUIDO.json'),registrar,fd=>escreverCompleto(fd,final,testHooks?.escrever));
    });
    return {pasta,manifesto};
  }catch(e){
    const pendente=limpar(criados,pai);
    const code=codigos.has(e?.code)?e.code:'IO';
    const falha=erro(code,code==='IO'?'Falha de arquivo na exportação.':'Exportação não concluída.');
    if(pendente)falha.limpezaPendente=true;
    throw falha;
  }finally{if(db)db.close();}
}
