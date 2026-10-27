import {join,basename} from 'node:path';
import {mkdirSync,existsSync,writeFileSync,readFileSync,readdirSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Privacidade} from './privacidade.js';
import {gravarTranscricao} from './transcricao.js';
import {validarAudioWav} from './audio-desktop-contrato.js';
import {conferirSaidaWhisper} from './audio-whisper-local.js';

export function prepararMetadadosAudio(db){
  if(!db.prepare('PRAGMA table_info(transcricoes)').all().some(c=>c.name==='audio_metadados_json'))db.exec('ALTER TABLE transcricoes ADD COLUMN audio_metadados_json TEXT');
}
export function validarMetadadosAudio(m){
  if(m===null)return true;
  const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),exato=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===keys;
  const erro=()=>{throw new Error('Metadados de áudio local incompatíveis.');};
  const {analiseSinal,inferenciaExecutada,motivoSemFala,...base}=m??{};
  if(!exato(base,'audioSha256,consentimento,duracaoAudioMs,fonte,idioma,manifestoSha256,modeloSha256,motor,origem,qualidade,trechos,versao,versaoMotor')||
    m.versao!==1||m.motor!=='whisper.cpp'||m.origem!=='local'||m.idioma!=='pt'||m.qualidade!=='nao_validada'||
    typeof m.versaoMotor!=='string'||!/^[a-zA-Z0-9._-]{1,40}$/.test(m.versaoMotor)||
    !hash(m.audioSha256)||!hash(m.modeloSha256)||!hash(m.manifestoSha256)||!Number.isFinite(m.duracaoAudioMs)||m.duracaoAudioMs<=0||m.duracaoAudioMs>300000||
    !exato(m.fonte,'assinatura,conversaId,origemId')||!hash(m.fonte.assinatura)||
    ![m.fonte.conversaId,m.fonte.origemId].every(v=>typeof v==='string'&&v.length>0&&v.length<=1000)||
    !exato(m.consentimento,'confirmadoEm,tipo,vinculoConfirmado')||m.consentimento.tipo!=='processamento_local'||m.consentimento.vinculoConfirmado!==true||
    typeof m.consentimento.confirmadoEm!=='string'||!Number.isFinite(Date.parse(m.consentimento.confirmadoEm))||!Array.isArray(m.trechos))erro();
  for(const t of m.trechos)if(!exato(t,'fimMs,inicioMs,texto'))erro();
  if(['analiseSinal','inferenciaExecutada','motivoSemFala'].some(k=>Object.hasOwn(m,k))){
    if(!exato(analiseSinal,'duracaoAudioMs,metodo,silencioDigital,totalAmostras')||analiseSinal.metodo!=='pcm_s16le_zero_exato_v1'||
      typeof analiseSinal.silencioDigital!=='boolean'||typeof inferenciaExecutada!=='boolean'||
      !Number.isSafeInteger(analiseSinal.totalAmostras)||analiseSinal.totalAmostras<=0||
      analiseSinal.duracaoAudioMs!==m.duracaoAudioMs||analiseSinal.totalAmostras!==Math.round(m.duracaoAudioMs*16)||
      inferenciaExecutada===analiseSinal.silencioDigital)erro();
    if(analiseSinal.silencioDigital?(m.trechos.length!==0||motivoSemFala!=='silencio_digital_pcm_zero'):
      m.trechos.length?Object.hasOwn(m,'motivoSemFala'):motivoSemFala!=='motor_sem_trechos')erro();
  }
  conferirSaidaWhisper({result:{language:m.idioma},transcription:m.trechos.map(t=>({offsets:{from:t.inicioMs,to:t.fimMs},text:t.texto}))},{duracaoMs:m.duracaoAudioMs});
  return true;
}

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class AudioArquivos {
  constructor(db,arquivos){this.db=db;this.arquivos=arquivos;this.journals=join(arquivos.raiz,'.audio-operacoes');prepararMetadadosAudio(db);}
  caminho(id){if(!uuid.test(id))throw new Error('Registro de áudio inválido.');return this.arquivos.conferir(join(this.arquivos.anexos,'audio-'+id+'.wav'));}
  journal(id){if(!uuid.test(id))throw new Error('Registro de áudio inválido.');return this.arquivos.conferir(join(this.journals,id+'.json'),this.journals);}
  emUso(path){
    new Privacidade(this.db).schemaConhecido({consultaAnexos:true});
    for(const [table,col]of[['transcricoes','arquivo'],['caixas_jobs','arquivo_caminho'],['caixas_inventario','arquivo_conversa']]){
      if(this.db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===col)&&this.db.prepare(`SELECT 1 FROM ${table} WHERE lower(${col})=lower(?)`).get(path))return true;
    }return false;
  }
  finalizar(id){
    const path=this.journal(id),op=JSON.parse(readFileSync(path,'utf8'));
    if(!op||op.id!==id||Object.keys(op).sort().join(',')!=='anterior,id'||op.anterior!==null&&!uuid.test(op.anterior))throw new Error('Registro de áudio incompatível.');
    for(const key of new Set([id,op.anterior].filter(Boolean))){const audio=this.caminho(key);if(existsSync(audio)&&!this.emUso(audio))unlinkSync(audio);}
    unlinkSync(path);
  }
  recuperar(){
    const result={concluidas:0,pendentes:0};
    // conferir verifica inclusive links no diretório pai, sem confiar no journal.
    this.journal('00000000-0000-0000-0000-000000000000');
    if(!existsSync(this.journals))return result;
    for(const name of readdirSync(this.journals))try{const id=name.slice(0,-5);if(name!==id+'.json'||!uuid.test(id))throw new Error('Registro inválido');this.finalizar(id);result.concluidas++;}catch{result.pendentes++;}
    return result;
  }
  salvar({evento,bytes,original,modelo,metadados=null,duracaoMs,conferir=()=>{}}){
    validarMetadadosAudio(metadados);
    validarAudioWav(bytes);const id=randomUUID(),path=this.caminho(id),journal=this.journal(id);
    const old=this.db.prepare('SELECT arquivo FROM transcricoes WHERE conversa_id=? AND origem_id=?').get(evento.conversa_id,evento.origem_id)?.arquivo;
    let anterior=null;
    if(old){const match=/^audio-([a-f0-9-]+)\.wav$/.exec(basename(old));if(match&&uuid.test(match[1])&&this.caminho(match[1])===old)anterior=match[1];}
    mkdirSync(this.arquivos.anexos,{recursive:true});mkdirSync(this.journals,{recursive:true});this.caminho(id);this.journal(id);
    writeFileSync(journal,JSON.stringify({id,anterior}),{flag:'wx',mode:0o600});let commit=false;
    try{
      writeFileSync(path,bytes,{flag:'wx',mode:0o600});this.db.exec('BEGIN IMMEDIATE');
      try{
        conferir();gravarTranscricao(this.db,{conversaId:evento.conversa_id,origemId:evento.origem_id,arquivo:path,quando:evento.recebido_em,textoOriginal:original,modelo,duracaoMs});
        this.db.prepare('UPDATE transcricoes SET arquivo=?,audio_metadados_json=? WHERE conversa_id=? AND origem_id=?').run(path,metadados===null?null:JSON.stringify(metadados),evento.conversa_id,evento.origem_id);
        this.db.exec('COMMIT');commit=true;
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }finally{
      try{this.finalizar(id);}catch(error){if(!commit)throw error;}
    }
    return {limpezaPendente:existsSync(journal)};
  }
}
