import {createHash} from 'node:crypto';
import {LEITURA_SQL} from '../leitura-sql.js';

export const hashFontesVendas=fontes=>createHash('sha256').update(JSON.stringify(fontes)).digest('hex');
export const idsFontesValidos=ids=>Array.isArray(ids)&&ids.length>0&&ids.length<=20&&ids.every(id=>Number.isSafeInteger(id)&&id>0)&&new Set(ids).size===ids.length;

// Contrato de leitura único para a tela e a exportação. Não migra nem altera DB.
export function lerFontesVendas(db,conversaId,ids) {
  return db.prepare(`SELECT e.id,e.texto,e.recebido_em,e.autor_e_dono FROM desktop_fontes e
    WHERE e.conversa_id=? AND e.texto IS NOT NULL AND trim(e.texto)<>'' AND ${LEITURA_SQL}
    ${ids?`AND e.id IN (${ids.map(()=>'?').join(',')})`:''}
    ORDER BY e.recebido_em DESC,e.id DESC LIMIT 20`).all(conversaId,...(ids??[])).reverse().map(f=>({...f}));
}

export function revisaoVendas(db,conversaId) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_vendas_revisoes'").get())return null;
  return db.prepare('SELECT revisao FROM lume_vendas_revisoes WHERE conversa_id=?').get(conversaId)?.revisao??null;
}

export function conferirAvaliacaoVendas(db,row,avaliacao) {
  const candidatas=lerFontesVendas(db,row.conversa_id);
  const fontes=idsFontesValidos(avaliacao?.fontes)?lerFontesVendas(db,row.conversa_id,avaliacao.fontes):[];
  const recorte=avaliacao?.recorte;
  return {candidatas,fontes,
    fonteAlterada:!fontes.length||row.assinatura!==hashFontesVendas(fontes),
    contextoAlterado:!avaliacao||avaliacao.desatualizada===true||Boolean(avaliacao.importacao)||
      hashFontesVendas(candidatas)!==(recorte?.assinatura_janela??row.assinatura)||
      revisaoVendas(db,row.conversa_id)!==(recorte?.revisao??null)};
}
