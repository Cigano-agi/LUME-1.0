import {existsSync,lstatSync,realpathSync,mkdirSync,writeFileSync,readFileSync,renameSync,unlinkSync,rmdirSync,readdirSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
const stat=p=>{try{return lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};

// Somente anexos pertencentes ao perfil. Caminhos vindos do banco não são autoridade.
export class ArquivosDados {
  constructor(diretorio){this.raiz=realpathSync(diretorio);this.anexos=join(this.raiz,'anexos');this.fila=join(this.raiz,'.exclusao');}
  conferir(caminho,base=this.anexos){
    if(typeof caminho!=='string'||!isAbsolute(caminho))throw new Error('Arquivo sem caminho absoluto gerido.');
    const p=resolve(caminho),rel=relative(base,p);
    if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('Há arquivo fora dos anexos deste perfil. Nenhum dado foi excluído.');
    let atual=this.raiz;
    for(const parte of relative(this.raiz,p).split(sep)){atual=join(atual,parte);if(stat(atual)?.isSymbolicLink())throw new Error('Link de arquivo não pode ser removido como anexo gerido.');}
    if(stat(p)&&!stat(p).isFile())throw new Error('O anexo precisa ser um arquivo regular.');return p;
  }
  listarAnexos(){
    const paths=[];
    const visitar=dir=>{const info=stat(dir);if(!info)return;if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Diretório de anexos inválido.');
      for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Link não pode ser tratado como anexo gerido.');if(entry.isDirectory())visitar(path);else paths.push(this.conferir(path));}
    };visitar(this.anexos);return paths.sort();
  }
  preparar(id,caminhos){
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Operação de arquivos inválida.');
    const paths=[...new Set(caminhos.filter(Boolean))].map(p=>this.conferir(p)).filter(p=>existsSync(p));
    if(!paths.length)return {id,pares:[]};
    const dir=join(this.fila,id);
    if(existsSync(this.fila)&&lstatSync(this.fila).isSymbolicLink())throw new Error('Diretório de exclusão inválido.');
    mkdirSync(dir,{recursive:true});
    if(lstatSync(dir).isSymbolicLink())throw new Error('Diretório de exclusão inválido.');
    const op={id,pares:paths.map((origem,i)=>({origem,destino:join(dir,i+'.bin')}))};
    writeFileSync(join(dir,'journal.json'),JSON.stringify(op),{flag:'wx',mode:0o600});
    try{for(const pair of op.pares)renameSync(pair.origem,pair.destino);return op;}
    catch(e){this.reverter(op);throw e;}
  }
  validar(op){
    if(!op||!/^[a-f0-9-]{36}$/.test(op.id)||!Array.isArray(op.pares)||op.pares.length>100000)throw new Error('Registro de exclusão inválido.');
    op.pares.forEach((p,i)=>{this.conferir(p.origem);if(p.destino!==join(this.fila,op.id,i+'.bin'))throw new Error('Destino de exclusão inválido.');this.conferir(p.destino,this.fila);});
  }
  limparJournal(op){const d=join(this.fila,op.id);if(existsSync(join(d,'journal.json')))unlinkSync(join(d,'journal.json'));if(existsSync(d))rmdirSync(d);}
  reverter(op){this.validar(op);for(const p of op.pares)if(existsSync(p.destino)){if(existsSync(p.origem))throw new Error('Há um arquivo novo no destino da recuperação. Exclusão pendente de revisão.');renameSync(p.destino,p.origem);}this.limparJournal(op);}
  finalizar(op){this.validar(op);let removidos=0;for(const p of op.pares)if(existsSync(p.destino)){unlinkSync(p.destino);removidos++;}this.limparJournal(op);return removidos;}
  recuperar(db){
    const result={finalizadas:0,revertidas:0,pendentes:0};if(!existsSync(this.fila))return result;
    if(lstatSync(this.fila).isSymbolicLink())throw new Error('Diretório de exclusão inválido.');
    for(const d of readdirSync(this.fila)){
      if(!/^[a-f0-9-]{36}$/.test(d)){result.pendentes++;continue;}
      try{const dir=join(this.fila,d);if(lstatSync(dir).isSymbolicLink())throw new Error('Link');const op=JSON.parse(readFileSync(join(dir,'journal.json'),'utf8'));if(op.id!==d)throw new Error('Registro divergente');
        const receipt=db.prepare('SELECT 1 FROM priv_recibos WHERE id=?').get(d);
        if(receipt){this.finalizar(op);db.prepare("UPDATE priv_recibos SET estado='concluida' WHERE id=?").run(d);result.finalizadas++;}
        else{this.reverter(op);result.revertidas++;}
      }catch{result.pendentes++;}
    }return result;
  }
  iniciarRestauracao(id,total){
    if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isInteger(total)||total<0||total>10000)throw new Error('Restauração de anexos inválida.');
    const dir=join(this.raiz,'.restauracao');if(stat(dir)?.isSymbolicLink())throw new Error('Diretório de restauração inválido.');mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,id+'.json'),JSON.stringify({id,total}),{flag:'wx',mode:0o600});
  }
  finalizarRestauracao(id){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Restauração inválida.');const p=join(this.raiz,'.restauracao',id+'.json');if(stat(join(this.raiz,'.restauracao'))?.isSymbolicLink())throw new Error('Diretório inválido.');if(existsSync(p))unlinkSync(p);}
  reverterRestauracao(id,total){for(let i=0;i<total;i++){const p=this.conferir(join(this.anexos,`restaurado-${id}-${i}.bin`));if(existsSync(p))unlinkSync(p);}this.finalizarRestauracao(id);}
  recuperarRestauracoes(db){const r={finalizadas:0,revertidas:0,pendentes:0},dir=join(this.raiz,'.restauracao');if(!existsSync(dir))return r;if(stat(dir)?.isSymbolicLink())throw new Error('Diretório inválido.');
    for(const name of readdirSync(dir))try{if(!/^[a-f0-9-]{36}\.json$/.test(name)||stat(join(dir,name))?.isSymbolicLink())throw new Error('Journal inválido');const op=JSON.parse(readFileSync(join(dir,name),'utf8'));if(name!==op.id+'.json'||!Number.isInteger(op.total)||op.total<0||op.total>10000)throw new Error('Journal inválido');
      if(db.prepare("SELECT 1 FROM priv_recibos WHERE id=? AND estado='restaurado'").get(op.id)){this.finalizarRestauracao(op.id);r.finalizadas++;}else{this.reverterRestauracao(op.id,op.total);r.revertidas++;}
    }catch{r.pendentes++;}return r;
  }
}
