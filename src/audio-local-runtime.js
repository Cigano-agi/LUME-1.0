import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {transcreverWhisperLocal} from './audio-whisper-local.js';

const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const cancelado=signal=>{if(signal?.aborted)throw new Error('Transcrição local cancelada.');};
async function digest(path,signal){const h=createHash('sha256');for await(const b of createReadStream(path)){cancelado(signal);h.update(b);}return h.digest('hex');}
const indisponivel=motivo=>({disponivel:false,motor:'local',privacidade:'local',qualidade:'nao_validada',motivo});

// Apenas main/service nativo chama esta fábrica. O renderer nunca fornece configuração.
// Manifesto pinado pelo build; nenhum download, PATH lookup ou execução para sondar estado.
export function criarAudioLocalRuntime({raiz,manifestoSha256,runner}={}){
  const config=Object.freeze({raiz,manifestoSha256});
  async function conferir(signal){
    cancelado(signal);
    if(!isAbsolute(config.raiz||'')||!sha(config.manifestoSha256))throw new Error('Motor local não incluído com manifesto confiável neste aplicativo.');
    if(!['win32','darwin'].includes(process.platform)||!['x64','arm64'].includes(process.arch))throw new Error('Motor local indisponível nesta plataforma.');
    const root=await realpath(config.raiz),nome=process.platform==='win32'?'whisper-cli.exe':'whisper-cli';
    const permitidos=new Set(['manifest.json']);
    async function arquivo(nome,max){
      const path=join(root,nome),real=await realpath(path),s=await stat(real);
      if(real!==resolve(path)||!s.isFile()||s.size<1||s.size>max)throw new Error('Arquivos do motor local ausentes ou incompatíveis.');
      return {path:real,bytes:s.size};
    }
    const m=await arquivo('manifest.json',8192),bytes=await readFile(m.path);
    if(createHash('sha256').update(bytes).digest('hex')!==config.manifestoSha256)throw new Error('Integridade do manifesto local inválida.');
    const manifesto=JSON.parse(bytes.toString('utf8'));
    const keysV1='arquitetura,executavelBytes,executavelSha256,modeloBytes,modeloNome,modeloSha256,motor,plataforma,versao,versaoMotor';
    const keysV2='arquitetura,arquivos,modeloNome,motor,plataforma,versao,versaoMotor';
    const old=manifesto?.versao===1;
    if(!manifesto||Object.keys(manifesto).sort().join(',')!==(old?keysV1:keysV2)||![1,2].includes(manifesto.versao)||manifesto.motor!=='whisper.cpp'||
      manifesto.plataforma!==process.platform||manifesto.arquitetura!==process.arch||(old&&(!sha(manifesto.executavelSha256)||!sha(manifesto.modeloSha256)))||
      typeof manifesto.versaoMotor!=='string'||!/^[a-zA-Z0-9._-]{1,40}$/.test(manifesto.versaoMotor)||
      typeof manifesto.modeloNome!=='string'||!/^[a-zA-Z0-9._-]{1,60}$/.test(manifesto.modeloNome))throw new Error('Manifesto do motor local incompatível.');
    if(!old){
      if(!Array.isArray(manifesto.arquivos)||manifesto.arquivos.length<2||manifesto.arquivos.length>32)throw new Error('Manifesto do motor local incompatível.');
      for(const item of manifesto.arquivos){
        if(!item||Object.keys(item).sort().join(',')!=='bytes,nome,sha256'||typeof item.nome!=='string'||
          !/^[a-zA-Z0-9._-]{1,80}$/.test(item.nome)||!Number.isSafeInteger(item.bytes)||item.bytes<1||!sha(item.sha256)||permitidos.has(item.nome))throw new Error('Manifesto do motor local incompatível.');
        permitidos.add(item.nome);
      }
      if(!manifesto.arquivos.some(x=>x.nome===nome)||!manifesto.arquivos.some(x=>x.nome==='modelo.bin')||
        process.platform==='win32'&&!manifesto.arquivos.some(x=>x.nome==='whisper.dll'))throw new Error('Manifesto do motor local incompatível.');
    }
    if(old){permitidos.add(nome);permitidos.add('modelo.bin');}
    if((await readdir(root)).sort().join(',')!==[...permitidos].sort().join(','))throw new Error('Pacote local contém arquivos não fixados no manifesto ou arquivos ausentes.');
    const files=old?[
      {nome,bytes:manifesto.executavelBytes,sha256:manifesto.executavelSha256},
      {nome:'modelo.bin',bytes:manifesto.modeloBytes,sha256:manifesto.modeloSha256}
    ]:manifesto.arquivos;
    for(const item of files){
      const file=await arquivo(item.nome,item.nome==='modelo.bin'?512*1024*1024:128*1024*1024);
      if(file.bytes!==item.bytes||await digest(file.path,signal)!==item.sha256)throw new Error('Integridade dos arquivos do motor local inválida.');
    }
    const executavel={path:join(root,nome)},modelo={path:join(root,'modelo.bin')};
    if(!old){manifesto.modeloSha256=files.find(x=>x.nome==='modelo.bin').sha256;}
    cancelado(signal);return {manifesto,executavel:executavel.path,modelo:modelo.path};
  }
  return Object.freeze({
    async estado({signal}={}){
      try{const {manifesto:m}=await conferir(signal);return {disponivel:true,motor:'local',privacidade:'local',qualidade:'nao_validada',
        modelo:m.modeloNome,versaoMotor:m.versaoMotor,modeloSha256:m.modeloSha256,manifestoSha256:config.manifestoSha256,
        threads:2,timeoutMs:360000,motivo:'Disponível para transcrição manual experimental; qualidade PT-BR ainda não aprovada.'};}
      catch(e){cancelado(signal);return indisponivel(e?.code||e instanceof SyntaxError?'Arquivos confiáveis do motor local ausentes ou incompatíveis.':e.message);}
    },
    async transcrever(bytes,{signal}={}){
      const cfg=await conferir(signal);
      const resultado=await transcreverWhisperLocal(bytes,{executavel:cfg.executavel,modelo:cfg.modelo,signal,threads:2,timeoutMs:360000,runner});
      cancelado(signal);
      if(resultado.modeloSha256!==cfg.manifesto.modeloSha256)throw new Error('O modelo local mudou durante a transcrição.');
      // Revalida o pacote antes de aceitar a saída, inclusive substituição do executável.
      await conferir(signal);
      return {...resultado,versaoMotor:cfg.manifesto.versaoMotor,manifestoSha256:config.manifestoSha256};
    }
  });
}
