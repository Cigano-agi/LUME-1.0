import {createHash} from 'node:crypto';
import {LEITURA_SQL} from './leitura-sql.js';
import {prepararFontes} from './fontes-desktop.js';

export const TABELAS_TAREFAS=['desktop_tarefas_config','desktop_tarefas_conversas','desktop_tarefas_analises','desktop_tarefas_lotes','desktop_tarefas_sugestoes','desktop_tarefas_fontes'];
export const TAREFAS_BACKUP=['desktop_tarefas_analises','desktop_tarefas_lotes','desktop_tarefas_sugestoes','desktop_tarefas_fontes'];

export const assinaturaFonte=e=>createHash('sha256').update(JSON.stringify([e.texto,e.permissao,e.conversa_id,e.origem_id,e.recebido_em,e.projeto_id,e.origem_compartilhamento,e.autor_id,e.autor_e_dono,...(e.transcricao_meta?[e.transcricao_meta]:[])])).digest('hex');
export const HASH_FONTE_SQL='desktop_tarefa_hash(e.texto,e.permissao,e.conversa_id,e.origem_id,e.recebido_em,e.projeto_id,e.origem_compartilhamento,e.autor_id,e.autor_e_dono,e.transcricao_meta)';
export const SUGESTAO_ATUAL_SQL=`(s.fontes_total>0 AND s.fontes_total=(SELECT COUNT(*) FROM desktop_tarefas_fontes tf WHERE tf.sugestao_id=s.id) AND NOT EXISTS(SELECT 1 FROM desktop_tarefas_fontes tf LEFT JOIN desktop_fontes e ON e.id=tf.evento_id WHERE tf.sugestao_id=s.id AND (e.id IS NULL OR NOT COALESCE(${LEITURA_SQL},0) OR tf.assinatura<>${HASH_FONTE_SQL})))`;

export function validarBackupTarefas(t){
  const erro=()=>{throw new Error('Sugestões ou fontes de tarefas incompatíveis no backup.');};
  const texto=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max;
  const data=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
  const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const eventos=new Map(t.eventos.map(e=>[e.id,e])),itens=new Map(t.itens_crm.map(i=>[i.id,i]));
  const sugestoes=new Map(),porSugestao=new Map(),chaves=new Set();
  for(const s of t.desktop_tarefas_sugestoes){
    const e=eventos.get(s.evento_id),i=itens.get(s.item_id),chave=JSON.stringify([s.evento_id,s.tipo]);
    if(!texto(s.id,200)||sugestoes.has(s.id)||chaves.has(chave)||!e||!['compromisso','pendencia'].includes(s.tipo)||!texto(s.resumo,500)||!texto(s.trecho,1800)||s.trecho.trim().length<8||typeof s.prazo_citado!=='string'||s.prazo_citado.length>200||!Number.isInteger(s.fontes_total)||s.fontes_total<1||s.fontes_total>48||!['pendente','aceita','descartada'].includes(s.estado)||!data(s.criada_em)||s.revisada_em!==null&&!data(s.revisada_em)||s.item_id!==null&&(!i||s.estado!=='aceita'||i.conversa_id!==e.conversa_id||i.origem_id!==e.origem_id||i.tipo!==s.tipo))erro();
    sugestoes.set(s.id,s);chaves.add(chave);porSugestao.set(s.id,new Set());
  }
  for(const f of t.desktop_tarefas_fontes){
    const s=sugestoes.get(f.sugestao_id),e=eventos.get(f.evento_id),ids=porSugestao.get(f.sugestao_id);
    if(!s||!e||!hash(f.assinatura)||ids.has(f.evento_id)||e.conversa_id!==eventos.get(s.evento_id).conversa_id)erro();
    ids.add(f.evento_id);
  }
  for(const s of sugestoes.values()){const ids=porSugestao.get(s.id);if(ids.size!==s.fontes_total||!ids.has(s.evento_id))erro();}
  const analisadas=new Set();
  for(const a of t.desktop_tarefas_analises){if(!eventos.has(a.evento_id)||analisadas.has(a.evento_id)||!hash(a.assinatura)||!data(a.analisado_em))erro();analisadas.add(a.evento_id);}
  const lotes=new Set();
  for(const l of t.desktop_tarefas_lotes){if(!texto(l.id,200)||lotes.has(l.id)||typeof l.dia!=='string'||!/^\d{4}-\d\d-\d\d$/.test(l.dia)||!['manual','automatico'].includes(l.modo)||!['iniciado','concluido','incerto'].includes(l.estado)||!data(l.criado_em)||l.terminado_em!==null&&!data(l.terminado_em))erro();lotes.add(l.id);}
}

export function prepararTarefas(db){
  prepararFontes(db);
  db.function('desktop_tarefa_hash',{deterministic:true},(texto,permissao,conversa_id,origem_id,recebido_em,projeto_id,origem_compartilhamento,autor_id,autor_e_dono,transcricao_meta)=>assinaturaFonte({texto,permissao,conversa_id,origem_id,recebido_em,projeto_id,origem_compartilhamento,autor_id,autor_e_dono,transcricao_meta}));
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_tarefas_config(id INTEGER PRIMARY KEY CHECK(id=1),ativa INTEGER NOT NULL DEFAULT 0,max_lotes_dia INTEGER NOT NULL DEFAULT 2,ultima_tentativa_em TEXT,erro TEXT);
    INSERT OR IGNORE INTO desktop_tarefas_config(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS desktop_tarefas_conversas(conversa_id TEXT PRIMARY KEY,decidido_em TEXT NOT NULL,depois_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS desktop_tarefas_analises(evento_id INTEGER PRIMARY KEY REFERENCES eventos(id) ON DELETE CASCADE,assinatura TEXT NOT NULL,analisado_em TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS desktop_tarefas_lotes(id TEXT PRIMARY KEY,dia TEXT NOT NULL,modo TEXT NOT NULL CHECK(modo IN('manual','automatico')),estado TEXT NOT NULL CHECK(estado IN('iniciado','concluido','incerto')),criado_em TEXT NOT NULL,terminado_em TEXT);
    CREATE TABLE IF NOT EXISTS desktop_tarefas_sugestoes(id TEXT PRIMARY KEY,evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,tipo TEXT NOT NULL CHECK(tipo IN('compromisso','pendencia')),resumo TEXT NOT NULL,trecho TEXT NOT NULL,prazo_citado TEXT NOT NULL,fontes_total INTEGER NOT NULL,estado TEXT NOT NULL DEFAULT 'pendente' CHECK(estado IN('pendente','aceita','descartada')),criada_em TEXT NOT NULL,revisada_em TEXT,item_id INTEGER REFERENCES itens_crm(id) ON DELETE SET NULL,UNIQUE(evento_id,tipo));
    CREATE TABLE IF NOT EXISTS desktop_tarefas_fontes(sugestao_id TEXT NOT NULL REFERENCES desktop_tarefas_sugestoes(id) ON DELETE CASCADE,evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,assinatura TEXT NOT NULL,PRIMARY KEY(sugestao_id,evento_id));
    CREATE INDEX IF NOT EXISTS desktop_tarefas_fontes_evento ON desktop_tarefas_fontes(evento_id);
    CREATE INDEX IF NOT EXISTS desktop_tarefas_lotes_dia ON desktop_tarefas_lotes(dia,modo);`);
  if(!db.prepare('PRAGMA table_info(desktop_tarefas_config)').all().some(c=>c.name==='ultima_conversa_id'))db.exec('ALTER TABLE desktop_tarefas_config ADD COLUMN ultima_conversa_id TEXT');
}
