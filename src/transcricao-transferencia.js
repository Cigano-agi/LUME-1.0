import {tratarTranscricao,validarRespostasTranscricao} from './qualidade-transcricao.js';
import {gravarTranscricao} from './transcricao.js';
import {prepararMetadadosAudio,validarMetadadosAudio} from './audio-desktop-arquivos.js';
export function validarTranscricaoTransferencia(t){
  if(t===null)return;
  const falha=()=>{throw new Error('Transcrição do pacote incompatível.');};
  if(!t||typeof t!=='object'||![
    'estado,modelo,quando,respostas,texto,textoOriginal',
    'estado,metadadosAudio,modelo,quando,respostas,texto,textoOriginal'
  ].includes(Object.keys(t).sort().join(','))||!['transcrito','vazio','erro'].includes(t.estado))falha();
  validarMetadadosAudio(t.metadadosAudio??null);
  if(t.metadadosAudio){const m=t.metadadosAudio,original=m.trechos.length?m.trechos.map(p=>p.texto.trim()).join(' '):'(sem fala)';
    if(original!==t.textoOriginal||t.modelo!=='whisper.cpp/'+m.versaoMotor)falha();
  }
  const texto=v=>v===null||typeof v==='string'&&v.length<=100000;
  if(!texto(t.texto)||!texto(t.textoOriginal)||(t.modelo!==null&&(typeof t.modelo!=='string'||t.modelo.length>200))||(t.quando!==null&&(typeof t.quando!=='string'||t.quando.length>80||!Number.isFinite(Date.parse(t.quando)))))falha();
  if(t.estado==='transcrito'?typeof t.texto!=='string'||!t.texto.trim():t.texto!==null)falha();
  if(t.textoOriginal===null){if(t.respostas!==null)falha();return;}
  if(!validarRespostasTranscricao(t.respostas)||t.respostas.some(r=>r.textoOriginal.length>100000)||t.respostas.at(-1).textoOriginal!==t.textoOriginal||t.texto!==(t.estado==='erro'?null:tratarTranscricao(t.textoOriginal)))falha();
}
export function lerTranscricaoTransferencia(db,e){
  const cols=db.prepare('PRAGMA table_info(transcricoes)').all().map(c=>c.name);
  if(!['conversa_id','origem_id','texto','estado'].every(c=>cols.includes(c)))return null;
  const row=db.prepare(`SELECT ${['texto','estado','modelo','quando','texto_original','respostas_json','audio_metadados_json'].map(c=>cols.includes(c)?c:'NULL AS '+c).join(',')} FROM transcricoes WHERE conversa_id=? AND origem_id=?`).get(e.conversa_id,e.origem_id);
  if(!row)return null;
  let respostas=null;try{if(row.respostas_json!==null)respostas=JSON.parse(row.respostas_json);}catch{throw new Error('Respostas de transcrição inválidas.');}
  let metadadosAudio=null;try{if(row.audio_metadados_json!==null)metadadosAudio=JSON.parse(row.audio_metadados_json);}catch{throw new Error('Metadados de áudio incompatíveis.');}
  if(metadadosAudio&&(metadadosAudio.fonte?.conversaId!==e.conversa_id||metadadosAudio.fonte?.origemId!==e.origem_id))throw new Error('Metadados não correspondem à fonte do áudio.');
  const t={texto:row.texto,estado:row.estado,modelo:row.modelo,quando:row.quando,textoOriginal:row.texto_original,respostas,
    ...(metadadosAudio?{metadadosAudio}:{})};validarTranscricaoTransferencia(t);return t;
}
export function gravarTranscricaoTransferida(db,e){
  const t=e.transcricao;if(!t)return;
  validarTranscricaoTransferencia(t);prepararMetadadosAudio(db);
  if(t.metadadosAudio&&(t.metadadosAudio.fonte.conversaId!==e.conversa_id||t.metadadosAudio.fonte.origemId!==e.origem_id))throw new Error('Metadados não correspondem à fonte do áudio.');
  gravarTranscricao(db,{conversaId:e.conversa_id,origemId:e.origem_id,...t,erro:t.estado==='erro'?'Falha registrada na origem.':undefined});
  db.prepare('UPDATE transcricoes SET audio_metadados_json=? WHERE conversa_id=? AND origem_id=?').run(t.metadadosAudio?JSON.stringify(t.metadadosAudio):null,e.conversa_id,e.origem_id);
}
