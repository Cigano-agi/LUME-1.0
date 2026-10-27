import {LEITURA_SQL,PROJETO_SQL} from './leitura-sql.js';
import {IA_SQL} from './recuperacao.js';
import {trechoRelevante,unidadesConsulta} from './trechos-recuperacao.js';

export const CONTEXTO_PROXIMO=Object.freeze({sementes:4,minutos:15,maxExtras:8});
function recorteSQL(filtro){
  const where=[LEITURA_SQL,IA_SQL,"e.texto IS NOT NULL AND trim(e.texto)<>''",'e.dia_local<=?'],args=[filtro.ate];
  if(filtro.desde){where.push('e.dia_local>=?');args.push(filtro.desde);}
  if(filtro.conversa){where.push('e.conversa_id=?');args.push(filtro.conversa);}
  if(filtro.projeto){where.push(PROJETO_SQL);args.push(filtro.projeto,filtro.projeto,filtro.projeto);}
  return {visible:where.join(' AND '),args};
}
export function conferirRecorteConsulta(db,fontes,filtro){
  const {visible,args}=recorteSQL(filtro),ids=fontes.map(e=>e.id);
  const total=db.prepare(`SELECT COUNT(*) total FROM desktop_fontes e WHERE ${visible} AND e.id IN (${ids.map(()=>'?').join(',')})`).get(...args,...ids).total;
  if(total!==ids.length)throw new Error('O recorte de fontes mudou. Confira uma nova prévia.');
}
// Adjacent readable messages can qualify an earlier statement. Adjacency is
// not proof of topic, truth, authority or completion; every extra is previewed.
export function contextoProximo(db,seeds,filtro){
  if(!seeds.length)return seeds;
  const result=[...seeds],ids=new Set(seeds.map(e=>e.id)),units=unidadesConsulta(filtro.pergunta);
  const {visible,args}=recorteSQL(filtro);
  const select=`SELECT e.id,e.conversa_id,e.origem_id,e.texto,e.transcricao_meta,e.recebido_em,e.permissao,e.projeto_id,e.origem_compartilhamento,e.autor_id,e.autor_e_dono,
    CASE WHEN e.autor_e_dono=1 THEN 'Você' ELSE COALESCE(e.autor_id,'Não identificado') END autor_nome,
    COALESCE(g.nome,c.nome,e.conversa_id) conversa_nome FROM desktop_fontes e
    LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id`;
  const current=db.prepare(`SELECT e.id FROM desktop_fontes e WHERE ${visible} AND e.id=? AND e.conversa_id=?`);
  const queries=['antes','depois'].map(pos=>{
    const operator=pos==='antes'?'<':'>',order=pos==='antes'?'DESC':'ASC';
    return {pos,query:db.prepare(`${select} WHERE ${visible} AND e.conversa_id=?
      AND julianday(e.recebido_em) BETWEEN julianday(?,'-15 minutes') AND julianday(?,'+15 minutes')
      AND (julianday(e.recebido_em)${operator}julianday(?) OR (julianday(e.recebido_em)=julianday(?) AND e.id${operator}?))
      ORDER BY julianday(e.recebido_em) ${order},e.id ${order} LIMIT 1`)};
  });
  for(const seed of seeds.slice(0,CONTEXTO_PROXIMO.sementes)){
    if(!current.get(...args,seed.id,seed.conversa_id))continue;
    for(const {pos,query}of queries){
      const row=query.get(...args,seed.conversa_id,seed.recebido_em,seed.recebido_em,seed.recebido_em,seed.recebido_em,seed.id);
      if(!row||ids.has(row.id))continue;
      const intervaloSegundos=Math.abs(new Date(row.recebido_em)-new Date(seed.recebido_em))/1000;
      if(!Number.isFinite(intervaloSegundos)||intervaloSegundos>CONTEXTO_PROXIMO.minutos*60)continue;
      ids.add(row.id);result.push({...row,...trechoRelevante(row.texto,units),contextoProximo:{fonte:'E'+seed.id,posicao:pos,intervaloSegundos}});
    }
  }
  return result;
}
