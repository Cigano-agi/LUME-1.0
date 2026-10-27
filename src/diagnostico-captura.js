import {diaLocal} from './relogio.js';
import {LEITURA_SQL} from './leitura-sql.js';

// Read-only inventory. A persisted message proves receipt of that message only;
// totals cannot establish that WhatsApp delivered the complete history.
export function diagnosticarCaptura(db,{agora=new Date(),dias=8}={}){
  if(!Number.isInteger(dias)||dias<1||dias>31)throw new TypeError('Período inválido');
  const hoje=diaLocal(agora);
  const inicio=diaLocal(new Date(agora.getTime()-(dias-1)*86400000));
  const tabelas=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
  const diaria=db.prepare(`SELECT e.dia_local dia,COUNT(*) recebidas,
    COUNT(DISTINCT e.conversa_id) conversas,
    SUM(CASE WHEN ${LEITURA_SQL} THEN 1 ELSE 0 END) legiveis,
    SUM(CASE WHEN e.tipo='audio' THEN 1 ELSE 0 END) audios
    FROM eventos e WHERE e.dia_local BETWEEN ? AND ? GROUP BY e.dia_local ORDER BY e.dia_local`).all(inicio,hoje);
  const conversas=db.prepare(`SELECT e.conversa_id id,COALESCE(g.nome,c.nome,e.conversa_id) nome,
    COUNT(*) recebidas,MAX(e.recebido_em) ultima,
    SUM(CASE WHEN ${LEITURA_SQL} THEN 1 ELSE 0 END) legiveis,
    SUM(CASE WHEN e.tipo='audio' AND (e.texto IS NULL OR trim(e.texto)='') THEN 1 ELSE 0 END) audiosSemTexto
    FROM eventos e LEFT JOIN grupos_app g ON g.id=e.conversa_id
    LEFT JOIN conversas_app c ON c.id=e.conversa_id
    WHERE e.dia_local BETWEEN ? AND ?
    GROUP BY e.conversa_id ORDER BY recebidas DESC,e.conversa_id LIMIT 30`).all(inicio,hoje);
  const ultima=db.prepare('SELECT id,conversa_id,recebido_em FROM eventos ORDER BY recebido_em DESC,id DESC LIMIT 1').get()??null;
  const pausada=tabelas.has('desktop_config')?db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get()?.valor==='1':null;
  const erros=tabelas.has('etapas')?db.prepare(`SELECT etapa,estado,COUNT(*) total FROM etapas
    WHERE evento_id IN(SELECT id FROM eventos WHERE dia_local BETWEEN ? AND ?)
    AND estado IN('erro','falhou','pendente') GROUP BY etapa,estado ORDER BY total DESC LIMIT 20`).all(inicio,hoje):[];
  return {inicio,hoje,ultima,pausada,diaria,conversas,erros,
    limite:'Contagens mostram mensagens salvas, não a cobertura completa do WhatsApp. Compare IDs e horários de mensagens conhecidas com a fonte original.'};
}
