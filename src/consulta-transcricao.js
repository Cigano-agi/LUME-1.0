import {sinaisTextoModelo,validarRespostasTranscricao} from './qualidade-transcricao.js';
import {TEXTO_EXIBICAO_SQL} from './fontes-desktop.js';
export function projecaoTranscricoes(db) {
  const colunas=db.prepare('PRAGMA table_info(transcricoes)').all().map(c=>c.name);
  return {colunas:['conversa_id','origem_id','texto','estado'].every(c=>colunas.includes(c))?colunas:[],join:'',texto:TEXTO_EXIBICAO_SQL};
}
export function qualidadeFonte(db,e,{detalhes=false,colunas=projecaoTranscricoes(db).colunas}={}) {
  const extra={avisos:sinaisTextoModelo(e.texto)};
  if(!colunas.length)return extra;
  const row=db.prepare(`SELECT texto,estado,${colunas.includes('modelo')?'modelo':'NULL AS modelo'},${colunas.includes('motivo')?'motivo':'NULL AS motivo'},${colunas.includes('texto_original')?'texto_original':'NULL AS texto_original'},${colunas.includes('respostas_json')?'respostas_json':'NULL AS respostas_json'} FROM transcricoes WHERE conversa_id=? AND origem_id=?`).get(e.conversa_id,e.origem_id);
  if(!row)return extra;
  if(e.tipo==='documento'&&row.modelo?.startsWith('documento-local:')){
    extra.documento={estado:row.estado==='transcrito'?'extraido':row.estado==='vazio'?'sem_texto':'indisponivel',parcial:row.modelo.endsWith(':parcial'),motivo:row.motivo};
    return extra;
  }
  const sinais=sinaisTextoModelo(row.texto_original??row.texto);
  extra.transcricao={estado:row.estado,originalDisponivel:row.texto_original!==null,sinais};
  if(detalhes){
    let respostas=null;try{const parsed=JSON.parse(row.respostas_json);if(validarRespostasTranscricao(parsed))respostas=parsed;}catch{}
    Object.assign(extra.transcricao,{textoTratado:row.texto,textoOriginal:row.texto_original,respostas});
  }
  return extra;
}
