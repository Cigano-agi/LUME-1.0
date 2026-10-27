import {randomUUID} from 'node:crypto';
import {LEITURA_SQL,LEITURA_PESSOAL_SQL} from './leitura-sql.js';
import {prepararTarefas,assinaturaFonte,HASH_FONTE_SQL} from './tarefas-esquema.js';
import {diaLocal} from './relogio.js';
import {normalizarTag} from './comandos-whatsapp.js';

export const ETAPAS_NEGOCIO={interesse:'Interesse',proposta:'Proposta',conversa:'Conversa em andamento',fechado:'Fechado',encerrado:'Encerrado'};
export const NEGOCIOS_BACKUP=['desktop_negocios','desktop_negocios_historico'];
export const NEGOCIO_ATUAL_SQL=`(COALESCE(${LEITURA_SQL},0) AND n.assinatura=${HASH_FONTE_SQL})`;
export const NEGOCIO_ATUAL_PESSOAL_SQL=`(COALESCE(${LEITURA_PESSOAL_SQL},0) AND n.assinatura=${HASH_FONTE_SQL})`;
const dataValida=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v&&v>='2000-01-01'&&v<='2100-12-31';
const campos=['titulo','etapa','valor_centavos','proximo_contato'];
const leituraComo=alias=>LEITURA_PESSOAL_SQL.replace(/\be\./gu,`${alias}.`);
function chaveTag(valor){
  if(valor===undefined||valor===null||valor==='')return'';
  if(typeof valor!=='string')throw new Error('Tag inválida.');
  const tag=normalizarTag(valor);if(!tag.valida)throw new Error('Tag inválida.');return tag.chave;
}
function validarCampos(n){
  if(typeof n.titulo!=='string'||!n.titulo.trim()||n.titulo.length>160||/[\x00-\x1f]/.test(n.titulo))throw new Error('Dê um nome ao negócio, com até 160 caracteres.');
  if(!Object.hasOwn(ETAPAS_NEGOCIO,n.etapa))throw new Error('Escolha uma etapa da lista.');
  if(n.valor_centavos!==null&&(!Number.isSafeInteger(n.valor_centavos)||n.valor_centavos<0||n.valor_centavos>99999999999))throw new Error('Informe um valor em reais válido ou deixe vazio.');
  if(n.proximo_contato!==null&&!dataValida(n.proximo_contato))throw new Error('Escolha uma data válida entre 2000 e 2100 ou deixe vazio.');
  if(['fechado','encerrado'].includes(n.etapa)&&n.proximo_contato!==null)throw new Error('Retire o próximo contato ao fechar ou encerrar o negócio.');
}
export function prepararNegocios(db){
  prepararTarefas(db);
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_negocios(
    id TEXT PRIMARY KEY,evento_id INTEGER NOT NULL UNIQUE REFERENCES eventos(id) ON DELETE CASCADE,
    assinatura TEXT NOT NULL,titulo TEXT NOT NULL,etapa TEXT NOT NULL CHECK(etapa IN('interesse','proposta','conversa','fechado','encerrado')),
    valor_centavos INTEGER,proximo_contato TEXT,revisao INTEGER NOT NULL,criado_em TEXT NOT NULL,atualizado_em TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS desktop_negocios_historico(
    negocio_id TEXT NOT NULL REFERENCES desktop_negocios(id) ON DELETE CASCADE,revisao INTEGER NOT NULL,
    titulo TEXT NOT NULL,etapa TEXT NOT NULL,valor_centavos INTEGER,proximo_contato TEXT,confirmado_em TEXT NOT NULL,
    PRIMARY KEY(negocio_id,revisao));
    CREATE INDEX IF NOT EXISTS desktop_negocios_contato ON desktop_negocios(proximo_contato);`);
}
export function validarBackupNegocios(t){
  const erro=()=>{throw new Error('Negócios ou histórico incompatíveis no backup.');};
  const ids=new Set(),fontes=new Set(),eventos=new Set(t.eventos.map(e=>e.id)),registros=new Map();
  const timestamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
  for(const n of t.desktop_negocios){
    validarCampos(n);
    if(typeof n.id!=='string'||!/^[a-f0-9-]{36}$/.test(n.id)||ids.has(n.id)||!eventos.has(n.evento_id)||fontes.has(n.evento_id)||!/^[a-f0-9]{64}$/.test(n.assinatura)||!Number.isSafeInteger(n.revisao)||n.revisao<1||!timestamp(n.criado_em)||!timestamp(n.atualizado_em))erro();
    ids.add(n.id);fontes.add(n.evento_id);registros.set(n.id,{n,h:[]});
  }
  for(const h of t.desktop_negocios_historico){
    validarCampos(h);const r=registros.get(h.negocio_id);
    if(!r||!Number.isSafeInteger(h.revisao)||h.revisao<1||h.revisao>r.n.revisao||!timestamp(h.confirmado_em))erro();
    r.h.push(h);
  }
  for(const {n,h} of registros.values()){
    h.sort((a,b)=>a.revisao-b.revisao);
    if(!h.length||h.at(-1).revisao!==n.revisao||h.at(-1).confirmado_em!==n.atualizado_em||campos.some(c=>h.at(-1)[c]!==n[c])||h.some((r,i)=>i&&r.revisao!==h[i-1].revisao+1))erro();
  }
}

export class NegociosDesktop {
  constructor(db,{agora=()=>new Date()}={}){this.db=db;this.agora=agora;this.previas=new Map();prepararNegocios(db);}
  fonte(id){
    if(!Number.isSafeInteger(id)||id<1)throw new Error('Escolha uma mensagem de origem.');
    const e=this.db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND ${LEITURA_PESSOAL_SQL}`).get(id);
    if(!e)throw new Error('Fonte indisponível. Atualize suas conversas.');return e;
  }
  preparar({fonte}={}){
    const e=this.fonte(fonte),n=this.db.prepare('SELECT * FROM desktop_negocios WHERE evento_id=?').get(fonte),assinatura=assinaturaFonte(e),revisar=Boolean(n&&n.assinatura!==assinatura);
    const id=randomUUID();for(const [k,p]of this.previas)if(p.expira<this.agora().getTime())this.previas.delete(k);
    if(this.previas.size>=50)this.previas.delete(this.previas.keys().next().value);
    this.previas.set(id,{fonte,assinatura,revisao:n?.revisao||0,expira:this.agora().getTime()+300000,revisar});
    return {id,fonte,etapas:ETAPAS_NEGOCIO,revisar,negocio:revisar?null:n||null,historico:!n||revisar?[]:this.db.prepare('SELECT * FROM desktop_negocios_historico WHERE negocio_id=? ORDER BY revisao DESC LIMIT 20').all(n.id),historicoTotal:!n||revisar?0:this.db.prepare('SELECT count(*) n FROM desktop_negocios_historico WHERE negocio_id=?').get(n.id).n};
  }
  salvar({previa,confirmar,revisar=false,titulo,etapa,valor_centavos=null,proximo_contato=null}={}){
    if(confirmar!==true)throw new Error('Confira os dados e confirme para salvar.');
    const p=this.previas.get(previa);if(!p||p.expira<this.agora().getTime())throw new Error('Revisão expirada. Abra a mensagem novamente.');
    if(p.revisar&&revisar!==true)throw new Error('Confirme o recomeço após a mudança da fonte.');
    const valores={titulo,etapa,valor_centavos,proximo_contato};validarCampos(valores);valores.titulo=titulo.trim();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const e=this.fonte(p.fonte),old=this.db.prepare('SELECT * FROM desktop_negocios WHERE evento_id=?').get(p.fonte);
      if(assinaturaFonte(e)!==p.assinatura||(old?.revisao||0)!==p.revisao)throw new Error('A fonte ou o negócio mudou. Abra novamente antes de salvar.');
      const now=this.agora().toISOString(),id=old?.id||randomUUID(),revisao=(old?.revisao||0)+1;
      if(old&&p.revisar)this.db.prepare('DELETE FROM desktop_negocios_historico WHERE negocio_id=?').run(id);
      this.db.prepare(`INSERT INTO desktop_negocios VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET assinatura=excluded.assinatura,titulo=excluded.titulo,etapa=excluded.etapa,valor_centavos=excluded.valor_centavos,proximo_contato=excluded.proximo_contato,revisao=excluded.revisao,atualizado_em=excluded.atualizado_em`).run(id,p.fonte,p.assinatura,...campos.map(c=>valores[c]),revisao,old?.criado_em||now,now);
      this.db.prepare('INSERT INTO desktop_negocios_historico VALUES(?,?,?,?,?,?,?)').run(id,revisao,...campos.map(c=>valores[c]),now);
      this.db.exec('COMMIT');this.previas.delete(previa);return {id,revisao};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  listar({conversa='',etapa='todas',pagina=1,paginaRevisoes=1,contatos=false,tag=''}={}){
    if(typeof conversa!=='string'||conversa.length>200||!(etapa==='todas'||Object.hasOwn(ETAPAS_NEGOCIO,etapa))||!Number.isSafeInteger(pagina)||pagina<1||!Number.isSafeInteger(paginaRevisoes)||paginaRevisoes<1||typeof contatos!=='boolean')throw new Error('Filtro de negócios inválido.');
    const chave=chaveTag(tag),filtros=[LEITURA_PESSOAL_SQL],args=[];
    if(conversa){filtros.push('e.conversa_id=?');args.push(conversa);}
    if(chave){
      filtros.push(`EXISTS(SELECT 1 FROM lume_tags_entidades te
        JOIN lume_tags lt ON lt.id=te.tag_id
        JOIN lume_comandos lc ON lc.id=te.comando_id
        JOIN eventos origem ON origem.id=lc.evento_id AND origem.conversa_id=lc.conversa_id AND origem.origem_id=lc.origem_id
        WHERE te.entidade_tipo='negocio' AND te.entidade_id=n.id AND te.estado='ativa'
          AND lt.chave=? AND ${leituraComo('origem')})`);
      args.push(chave);
    }
    // Fontes alteradas têm apenas um convite para nova revisão; campos antigos não saem do banco.
    const pendentes=`FROM desktop_negocios n CROSS JOIN desktop_fontes e ON e.id=n.evento_id WHERE ${filtros.join(' AND ')} AND n.assinatura<>${HASH_FONTE_SQL}${chave?' AND 0':''}`;
    const totalRevisoes=this.db.prepare(`SELECT count(*) n ${pendentes}`).get(...args).n,paginasRevisoes=Math.max(1,Math.ceil(totalRevisoes/6)),numeroRevisoes=Math.min(paginaRevisoes,paginasRevisoes);
    const revisoes=this.db.prepare(`SELECT n.evento_id ${pendentes} ORDER BY n.evento_id LIMIT 6 OFFSET ?`).all(...args,(numeroRevisoes-1)*6);
    if(etapa!=='todas'){filtros.push('n.etapa=?');args.push(etapa);}
    if(contatos)filtros.push("n.proximo_contato IS NOT NULL AND n.etapa NOT IN('fechado','encerrado')");
    filtros.push(NEGOCIO_ATUAL_PESSOAL_SQL);const base=`FROM desktop_negocios n CROSS JOIN desktop_fontes e ON e.id=n.evento_id WHERE ${filtros.join(' AND ')}`;
    const total=this.db.prepare(`SELECT count(*) n ${base}`).get(...args).n,paginas=Math.max(1,Math.ceil(total/6)),numero=Math.min(pagina,paginas);
    const negocios=this.db.prepare(`SELECT n.*,e.conversa_id ${base} ORDER BY n.proximo_contato IS NULL,n.proximo_contato,n.atualizado_em DESC,n.id LIMIT 6 OFFSET ?`).all(...args,(numero-1)*6);
    return {negocios,revisoes,paginaRevisoes:{numero:numeroRevisoes,paginas:paginasRevisoes,total:totalRevisoes},etapas:ETAPAS_NEGOCIO,hoje:diaLocal(this.agora()),pagina:{numero,paginas,total}};
  }
}
