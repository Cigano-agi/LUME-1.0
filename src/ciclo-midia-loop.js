import {processarUmaMidiaCiclo} from './ciclo-midia-worker.js';

// Um único serviço local controla a concorrência; cada claim continua atômico no SQLite.
export class CicloMidiaLoop{
  constructor(db,{arquivos,baixar,podeProcessar=()=>true,limite=2,intervaloMs=1500,onError=()=>{}}={}){
    if(!Number.isSafeInteger(limite)||limite<1||limite>2)throw new TypeError('Concorrência de mídia inválida');
    this.db=db;this.arquivos=arquivos;this.baixar=baixar;this.podeProcessar=podeProcessar;
    this.limite=limite;this.intervaloMs=intervaloMs;this.onError=onError;
    this.trabalhos=new Set();this.cursor=0;this.parado=true;this.timer=null;
    this.controller=new AbortController();
  }
  iniciar(){
    if(!this.parado)return;
    if(this.controller.signal.aborted)this.controller=new AbortController();
    this.arquivos.recuperar();
    this.parado=false;
    this.timer=setInterval(()=>this.tick(),this.intervaloMs);
    this.timer.unref?.();
    this.tick();
  }
  tick(){
    if(this.parado||!this.podeProcessar())return;
    while(this.trabalhos.size<this.limite){
      // Promise.resolve evita fechar o banco antes de terminar uma chamada já iniciada.
      const trabalho=Promise.resolve().then(()=>processarUmaMidiaCiclo(this.db,{
        arquivos:this.arquivos,baixar:this.baixar,cursor:this.cursor,signal:this.controller.signal,
        podeProcessar:this.podeProcessar}));
      this.trabalhos.add(trabalho);
      void trabalho.then(resultado=>{
        if(resultado?.estado==='continuar')this.cursor=Math.max(this.cursor,resultado.cursor);
        else if(resultado===null)this.cursor=0;
      },error=>this.onError(error)).finally(()=>this.trabalhos.delete(trabalho));
    }
  }
  async parar(){
    if(this.parado)return;
    this.parado=true;
    clearInterval(this.timer);this.timer=null;
    this.controller.abort();
    await Promise.allSettled([...this.trabalhos]);
  }
}
