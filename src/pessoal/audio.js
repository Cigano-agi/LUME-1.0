import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DesktopAudio} from '../desktop-audio.js';
import {assinaturaFonte} from '../tarefas-esquema.js';
import {LEITURA_PESSOAL_SQL} from '../leitura-sql.js';

export class AudioPessoal {
  constructor(db,{arquivos,audioLocal,converter,ativo=()=>false}={}) {
    this.db=db;this.arquivos=arquivos;this.converter=converter;this.ativo=ativo;this.busy=false;
    this.audio=new DesktopAudio(db,{arquivos,audioLocal});
  }
  async transcrever(eventoId,{signal}={}) {
    if(this.busy||!this.ativo()||signal?.aborted)throw Error('AUDIO_LOCAL_INDISPONIVEL');
    const fonte=()=>this.db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND e.tipo='audio' AND ${LEITURA_PESSOAL_SQL}`).get(eventoId);
    const original=fonte();if(!original)throw Error('AUDIO_FONTE_INDISPONIVEL');
    if(original.transcricao_meta&&JSON.parse(original.transcricao_meta).estado==='transcrito')return {existente:true};
    const item=this.db.prepare('SELECT * FROM ciclo_midias WHERE evento_id=?').get(eventoId);
    if(!item)throw Error('AUDIO_ORIGINAL_PENDENTE');
    const path=this.arquivos.conferir(item.caminho),size=statSync(path).size;
    if(size<1||size>20*1024*1024||size!==item.tamanho)throw Error('AUDIO_ORIGINAL_INVALIDO');
    const bytes=readFileSync(path);
    if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('AUDIO_ORIGINAL_INVALIDO');
    const signature=assinaturaFonte(original);
    const conferir=()=>{const current=fonte();if(signal?.aborted||!this.ativo()||!current||assinaturaFonte(current)!==signature)throw Error('AUDIO_FONTE_ALTERADA');};
    this.busy=true;let preview;
    const abort=()=>{if(preview)this.audio.cancelar({id:preview.id});};
    signal?.addEventListener('abort',abort,{once:true});
    try {
      const pcm=await this.converter(bytes.toString('base64'));conferir();
      preview=await this.audio.preparar({fonte:eventoId,base64:pcm.base64,nome:'Áudio WhatsApp',confirmarVinculo:true,motor:'local'});conferir();
      const result=await this.audio.transcrever({id:preview.id,confirmar:true});
      this.db.prepare("UPDATE etapas SET estado='concluida',resultado=?,atualizado_em=?,lease_token=NULL,lease_ate=NULL WHERE evento_id=? AND etapa='transcricao'")
        .run(JSON.stringify({motor:'local',qualidade:'nao_validada'}),new Date().toISOString(),eventoId);
      return result;
    }finally {signal?.removeEventListener('abort',abort);if(preview)this.audio.cancelar({id:preview.id});this.busy=false;}
  }
}
