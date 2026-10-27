import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,lstat,rename,unlink,statfs} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

function validarManifesto(m){
  if(!m||!/^[-\w]+\/[-\w.]+$/.test(m.model)||!/^[a-f0-9]{40}$/.test(m.revision)||!Array.isArray(m.files)||!m.files.length||m.files.length>32)throw Error('Manifesto de modelo inválido.');
  const nomes=new Set();let bytes=0;
  for(const f of m.files){
    if(!f||typeof f.name!=='string'||!/^([\w-]+\/)*[\w-]+\.[\w-]+$/.test(f.name)||nomes.has(f.name)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>4*1024**3||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Arquivo de modelo inválido.');
    nomes.add(f.name);bytes+=f.bytes;
  }
  return{model:m.model,revision:m.revision,files:m.files.map(f=>({...f})),bytes};
}

// Fixed public files, pinned digest, local paths only. Never accepts a URL from the UI.
export class ArquivosModeloLocal {
  constructor({diretorio,manifesto,fetch:baixar=globalThis.fetch}={}){
    if(typeof diretorio!=='string'||!diretorio)throw Error('Diretório do modelo não configurado.');
    this.manifesto=validarManifesto(manifesto);this.raiz=resolve(diretorio);this.diretorio=join(this.raiz,this.manifesto.revision);this.fetch=baixar;this.ocupado=false;this.controller=null;
    this.progresso={etapa:'nao-verificado',bytes:0,total:this.manifesto.bytes,arquivo:null,erro:null};
  }
  estado(){return{...this.progresso,ocupado:this.ocupado,modelo:this.manifesto.model,revisao:this.manifesto.revision};}
  cancelar(){this.controller?.abort();}
  async caminho(nome,{criar=false}={}){
    if(!this.manifesto.files.some(f=>f.name===nome))throw Error('Arquivo fora do manifesto.');
    const partes=[this.raiz,this.manifesto.revision,...nome.split('/')];let path='';
    for(let i=0;i<partes.length;i++){
      path=i===0?partes[i]:join(path,partes[i]);const ultimo=i===partes.length-1;
      let info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(criar&&!ultimo&&!info){await mkdir(path,{recursive:i===0});info=await lstat(path);}
      if(info?.isSymbolicLink()||info&&(!ultimo&&!info.isDirectory()||ultimo&&!info.isFile()))throw Error('Caminho do modelo não é um arquivo local seguro.');
    }
    return path;
  }
  async conferir(f,signal){
    signal.throwIfAborted();const path=await this.caminho(f.name),info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!info||info.size!==f.bytes)return false;
    const hash=createHash('sha256');for await(const chunk of createReadStream(path)){signal.throwIfAborted();hash.update(chunk);}
    return hash.digest('hex')===f.sha256;
  }
  async executar(baixar){
    if(this.ocupado)throw Error('Já há uma preparação do modelo em andamento.');
    this.ocupado=true;this.controller=new AbortController();const signal=this.controller.signal;
    this.progresso={etapa:'verificando',bytes:0,total:this.manifesto.bytes,arquivo:null,erro:null};
    try{
      for(const f of this.manifesto.files){
        signal.throwIfAborted();this.progresso.arquivo=f.name;this.progresso.etapa='verificando';
        if(await this.conferir(f,signal)){this.progresso.bytes+=f.bytes;continue;}
        if(!baixar)throw Error('Modelo ausente, incompleto ou alterado. Prepare os arquivos novamente.');
        const path=await this.caminho(f.name,{criar:true});
        const disk=await statfs(dirname(path));if(disk.bavail*disk.bsize<f.bytes+64*1024**2)throw Error('Falta espaço livre para preparar este modelo.');
        const temporary=path+'.part-'+randomUUID(),hash=createHash('sha256'),antes=this.progresso.bytes;let recebidos=0;
        this.progresso.etapa='baixando';
        try{
          const resposta=await this.fetch(`https://huggingface.co/${this.manifesto.model}/resolve/${this.manifesto.revision}/${f.name}`,{signal:AbortSignal.any([signal,AbortSignal.timeout(1200000)])});
          if(!resposta.ok||!resposta.body)throw Error('Não consegui baixar o modelo. Confira sua conexão e tente novamente.');
          const conferirBytes=new Transform({transform:(chunk,enc,done)=>{recebidos+=chunk.length;if(recebidos>f.bytes)return done(Error('O arquivo recebido ultrapassa o tamanho esperado.'));hash.update(chunk);this.progresso.bytes=antes+recebidos;done(null,chunk);}});
          await pipeline(Readable.fromWeb(resposta.body),conferirBytes,createWriteStream(temporary,{flags:'wx'}),{signal});
          if(recebidos!==f.bytes||hash.digest('hex')!==f.sha256)throw Error('O arquivo recebido não passou na verificação. Tente preparar novamente.');
          signal.throwIfAborted();await this.caminho(f.name);await rename(temporary,path);
        }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
      }
      signal.throwIfAborted();this.progresso.etapa='pronto';this.progresso.arquivo=null;return this.estado();
    }catch(e){this.progresso.etapa=signal.aborted?'cancelado':'falha';this.progresso.erro=signal.aborted?'Preparação cancelada. Os arquivos completos foram preservados.':e.message;throw Error(this.progresso.erro);}
    finally{this.ocupado=false;this.controller=null;}
  }
  async instalar({confirmar=false}={}){if(confirmar!==true)throw Error('Confirme o tamanho e o download antes de preparar o modelo.');await this.executar(true);return this.estado();}
  async verificar(){await this.executar(false);return this.estado();}
}
