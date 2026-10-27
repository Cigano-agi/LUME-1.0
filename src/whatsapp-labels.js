import {createHash} from 'node:crypto';
import {LEITURA_SQL} from './leitura-sql.js';

export const TABELAS_WHATSAPP_LABELS=Object.freeze([
  'whatsapp_labels',
  'whatsapp_label_associacoes',
  'whatsapp_label_observacoes'
]);
const INSTANCIAS=new WeakMap();
export const invalidarWhatsAppLabels=db=>INSTANCIAS.get(db)?.invalidarSessao()??false;

const LIMITE_ID=200,LIMITE_NOME=200;
const chavesExatas=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const texto=(value,max=LIMITE_ID)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tuplaValida=s=>s&&texto(s.contaId)&&Number.isSafeInteger(s.geracao)&&s.geracao>0&&texto(s.sessaoId);
const mesmaTupla=(a,b)=>Boolean(a&&b&&a.contaId===b.contaId&&a.geracao===b.geracao&&a.sessaoId===b.sessaoId);

function labelValida(label){
  const opcionais=label&&Object.hasOwn(label,'predefinedId')?['predefinedId']:[];
  return chavesExatas(label,['id','name','color','deleted',...opcionais])&&texto(label.id)&&typeof label.name==='string'&&label.name.length<=LIMITE_NOME&&Number.isInteger(label.color)&&label.color>=0&&label.color<=19&&typeof label.deleted==='boolean'&&(!opcionais.length||label.predefinedId===undefined||texto(label.predefinedId));
}

function associacaoValida(evento){
  if(!chavesExatas(evento,['association','type'])||!['add','remove'].includes(evento.type))return false;
  const a=evento.association;
  if(a?.type==='label_jid')return chavesExatas(a,['type','chatId','labelId'])&&texto(a.chatId)&&texto(a.labelId);
  if(a?.type==='label_message')return chavesExatas(a,['type','chatId','messageId','labelId'])&&texto(a.chatId)&&texto(a.messageId)&&texto(a.labelId);
  return false;
}

export function prepararWhatsAppLabels(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_labels (
      conta_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      cor INTEGER NOT NULL,
      predefined_id TEXT,
      removida INTEGER NOT NULL CHECK(removida IN (0,1)),
      conflito INTEGER NOT NULL DEFAULT 0 CHECK(conflito IN (0,1)),
      primeira_observacao_id INTEGER NOT NULL,
      ultima_observacao_id INTEGER NOT NULL,
      PRIMARY KEY(conta_id,label_id)
    );
    CREATE TABLE IF NOT EXISTS whatsapp_label_associacoes (
      conta_id TEXT NOT NULL,
      conversa_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      viu_adicao INTEGER NOT NULL DEFAULT 0 CHECK(viu_adicao IN (0,1)),
      viu_remocao INTEGER NOT NULL DEFAULT 0 CHECK(viu_remocao IN (0,1)),
      conflito INTEGER NOT NULL DEFAULT 0 CHECK(conflito IN (0,1)),
      primeira_observacao_id INTEGER NOT NULL,
      ultima_observacao_id INTEGER NOT NULL,
      PRIMARY KEY(conta_id,conversa_id,message_id,label_id)
    );
    CREATE TABLE IF NOT EXISTS whatsapp_label_observacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conta_id TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('definicao','associacao')),
      conversa_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      nome TEXT,
      cor INTEGER,
      predefined_id TEXT,
      removida INTEGER CHECK(removida IS NULL OR removida IN (0,1)),
      acao TEXT CHECK(acao IS NULL OR acao IN ('add','remove')),
      assinatura TEXT NOT NULL,
      observada_em TEXT NOT NULL,
      UNIQUE(conta_id,assinatura)
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_label_obs_conversa ON whatsapp_label_observacoes(conversa_id,message_id,id);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_label_assoc_label ON whatsapp_label_associacoes(conta_id,label_id);
  `);
  const colunas=tabela=>new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map(x=>x.name));
  if(!colunas('whatsapp_labels').has('predefined_id'))db.exec('ALTER TABLE whatsapp_labels ADD COLUMN predefined_id TEXT');
  if(!colunas('whatsapp_label_observacoes').has('predefined_id'))db.exec('ALTER TABLE whatsapp_label_observacoes ADD COLUMN predefined_id TEXT');
}

const normalizarObservacao=r=>r.tipo==='definicao'
  ?{tipo:'definicao',id:r.label_id,name:r.nome,color:r.cor,deleted:Boolean(r.removida),predefinedId:r.predefined_id}
  :{tipo:'associacao',acao:r.acao,association:{type:r.message_id?'label_message':'label_jid',chatId:r.conversa_id,messageId:r.message_id,labelId:r.label_id}};

function projeçõesDasObservacoes(observacoes){
  const labels=new Map(),associacoes=new Map();
  for(const r of [...observacoes].sort((a,b)=>a.id-b.id)){
    if(r.tipo==='definicao'){
      const chave=`${r.conta_id}\u0000${r.label_id}`,anterior=labels.get(chave);
      const mudou=Boolean(anterior&&(anterior.nome!==r.nome||anterior.cor!==r.cor||anterior.predefined_id!==r.predefined_id||anterior.removida!==r.removida));
      labels.set(chave,{conta_id:r.conta_id,label_id:r.label_id,nome:r.nome,cor:r.cor,predefined_id:r.predefined_id,removida:r.removida,conflito:Number(Boolean(r.removida||mudou||anterior?.conflito)),primeira_observacao_id:anterior?.primeira_observacao_id??r.id,ultima_observacao_id:r.id});
      continue;
    }
    const chave=`${r.conta_id}\u0000${r.conversa_id}\u0000${r.message_id}\u0000${r.label_id}`,anterior=associacoes.get(chave),add=Number(r.acao==='add'),remove=Number(r.acao==='remove');
    const definicao=labels.get(`${r.conta_id}\u0000${r.label_id}`),semDefinicao=!definicao||definicao.removida===1;
    const conflito=Number(Boolean(semDefinicao||remove||anterior?.conflito||anterior&&(anterior.viu_adicao&&!add||anterior.viu_remocao&&!remove)));
    associacoes.set(chave,{conta_id:r.conta_id,conversa_id:r.conversa_id,message_id:r.message_id,label_id:r.label_id,viu_adicao:Number(Boolean(anterior?.viu_adicao||add)),viu_remocao:Number(Boolean(anterior?.viu_remocao||remove)),conflito,primeira_observacao_id:anterior?.primeira_observacao_id??r.id,ultima_observacao_id:r.id});
  }
  return {labels:[...labels.values()],associacoes:[...associacoes.values()]};
}

const linhaIgual=(a,b,campos)=>campos.every(c=>a[c]===b[c]);

export function validarBackupWhatsAppLabels(tabelas){
  for(const nome of TABELAS_WHATSAPP_LABELS)if(!Array.isArray(tabelas?.[nome]))throw new Error('Tabela de labels observadas invalida.');
  const bit=v=>v===0||v===1;
  for(const r of tabelas.whatsapp_labels)if(!texto(r.conta_id)||!texto(r.label_id)||typeof r.nome!=='string'||r.nome.length>LIMITE_NOME||!Number.isInteger(r.cor)||r.cor<0||r.cor>19||r.predefined_id!==null&&!texto(r.predefined_id)||!bit(r.removida)||!bit(r.conflito)||!Number.isSafeInteger(r.primeira_observacao_id)||!Number.isSafeInteger(r.ultima_observacao_id))throw new Error('Definicao de label observada invalida.');
  for(const r of tabelas.whatsapp_label_associacoes)if(!texto(r.conta_id)||!texto(r.conversa_id)||typeof r.message_id!=='string'||r.message_id.length>LIMITE_ID||!texto(r.label_id)||!bit(r.viu_adicao)||!bit(r.viu_remocao)||!bit(r.conflito)||!Number.isSafeInteger(r.primeira_observacao_id)||!Number.isSafeInteger(r.ultima_observacao_id))throw new Error('Associacao de label observada invalida.');
  for(const r of tabelas.whatsapp_label_observacoes){
    const comum=Number.isSafeInteger(r.id)&&r.id>0&&texto(r.conta_id)&&['definicao','associacao'].includes(r.tipo)&&typeof r.conversa_id==='string'&&r.conversa_id.length<=LIMITE_ID&&typeof r.message_id==='string'&&r.message_id.length<=LIMITE_ID&&texto(r.label_id)&&typeof r.assinatura==='string'&&/^[a-f0-9]{64}$/.test(r.assinatura)&&Number.isFinite(Date.parse(r.observada_em));
    const campos=r.tipo==='definicao'?r.conversa_id===''&&r.message_id===''&&typeof r.nome==='string'&&r.nome.length<=LIMITE_NOME&&Number.isInteger(r.cor)&&r.cor>=0&&r.cor<=19&&(r.predefined_id===null||texto(r.predefined_id))&&bit(r.removida)&&r.acao===null:texto(r.conversa_id)&&r.nome===null&&r.cor===null&&r.predefined_id===null&&r.removida===null&&['add','remove'].includes(r.acao);
    if(!comum||!campos)throw new Error('Observacao de label invalida.');
  }
  const observacoes=new Map(),assinaturas=new Set();
  for(const r of tabelas.whatsapp_label_observacoes){const chave=`${r.conta_id}\u0000${r.assinatura}`;if(observacoes.has(r.id)||assinaturas.has(chave)||r.assinatura!==hash(normalizarObservacao(r)))throw new Error('Observacoes de label duplicadas ou adulteradas.');observacoes.set(r.id,r);assinaturas.add(chave);}
  const derivadas=projeçõesDasObservacoes(tabelas.whatsapp_label_observacoes),camposLabel=['conta_id','label_id','nome','cor','predefined_id','removida','conflito','primeira_observacao_id','ultima_observacao_id'],camposAssociacao=['conta_id','conversa_id','message_id','label_id','viu_adicao','viu_remocao','conflito','primeira_observacao_id','ultima_observacao_id'];
  const ordenar=(a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b));
  const recebidasLabels=[...tabelas.whatsapp_labels].sort(ordenar),recebidasAssociacoes=[...tabelas.whatsapp_label_associacoes].sort(ordenar);
  derivadas.labels.sort(ordenar);derivadas.associacoes.sort(ordenar);
  if(recebidasLabels.length!==derivadas.labels.length||recebidasLabels.some((r,i)=>!linhaIgual(r,derivadas.labels[i],camposLabel)))throw new Error('Projecao de label incompatível com as observacoes.');
  if(recebidasAssociacoes.length!==derivadas.associacoes.length||recebidasAssociacoes.some((r,i)=>!linhaIgual(r,derivadas.associacoes[i],camposAssociacao)))throw new Error('Projecao de associacao incompatível com as observacoes.');
}

export class WhatsAppLabels{
  #ativa=null;#consentida=null;
  constructor(db){this.db=db;prepararWhatsAppLabels(db);INSTANCIAS.set(db,this);}
  ativarSessao(sessao){if(!tuplaValida(sessao))throw new TypeError('Sessao de labels invalida.');if(!mesmaTupla(this.#ativa,sessao))this.#consentida=null;this.#ativa={...sessao};return this.sessao();}
  invalidarSessao(sessao=null){if(sessao&&!mesmaTupla(this.#ativa,sessao))return false;this.#ativa=null;this.#consentida=null;return true;}
  sessao(){return this.#ativa?{...this.#ativa}:null;}
  consentir(sessao,leitura){if(typeof leitura!=='boolean')throw new TypeError('Consentimento de leitura invalido.');if(!tuplaValida(sessao)||!mesmaTupla(this.#ativa,sessao))throw Object.assign(new Error('Conta desktop ativa indisponivel.'),{code:'SESSAO_LABELS_INDISPONIVEL'});this.#consentida=leitura?{...sessao}:null;return {disponivel:true,leitura,contaId:sessao.contaId};}
  #autorizada(sessao){return tuplaValida(sessao)&&mesmaTupla(this.#ativa,sessao)&&mesmaTupla(this.#consentida,sessao);}
  observarLabel(sessao,label){if(!this.#autorizada(sessao)||!labelValida(label))return false;return this.#transacao(sessao,'definicao',label);}
  observarAssociacao(sessao,evento){if(!this.#autorizada(sessao)||!associacaoValida(evento))return false;return this.#transacao(sessao,'associacao',evento);}
  #transacao(sessao,tipo,payload){
    if(!this.#autorizada(sessao))return false;
    const a=tipo==='associacao'?payload.association:null;
    const normalizado=tipo==='definicao'?{tipo,id:payload.id,name:payload.name,color:payload.color,deleted:payload.deleted,predefinedId:payload.predefinedId??null}:{tipo,acao:payload.type,association:{type:a.type,chatId:a.chatId,messageId:a.messageId??'',labelId:a.labelId}};
    const assinatura=hash(normalizado),agora=new Date().toISOString();let gravou=false;
    this.db.exec('SAVEPOINT whatsapp_labels_observar');
    try{
      if(!this.#autorizada(sessao)){this.db.exec('RELEASE whatsapp_labels_observar');return false;}
      const info=this.db.prepare(`INSERT OR IGNORE INTO whatsapp_label_observacoes(conta_id,tipo,conversa_id,message_id,label_id,nome,cor,predefined_id,removida,acao,assinatura,observada_em) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(sessao.contaId,tipo,a?.chatId??'',a?.messageId??'',a?.labelId??payload.id,tipo==='definicao'?payload.name:null,tipo==='definicao'?payload.color:null,tipo==='definicao'?payload.predefinedId??null:null,tipo==='definicao'?Number(payload.deleted):null,tipo==='associacao'?payload.type:null,assinatura,agora);
      if(!info.changes){this.db.exec('RELEASE whatsapp_labels_observar');return false;}
      gravou=true;const id=Number(info.lastInsertRowid);
      if(tipo==='definicao'){
        const anterior=this.db.prepare('SELECT * FROM whatsapp_labels WHERE conta_id=? AND label_id=?').get(sessao.contaId,payload.id);
        const predefinedId=payload.predefinedId??null;
        const conflito=Number(Boolean(payload.deleted||anterior&&(anterior.nome!==payload.name||anterior.cor!==payload.color||anterior.predefined_id!==predefinedId||anterior.removida!==Number(payload.deleted))));
        this.db.prepare(`INSERT INTO whatsapp_labels(conta_id,label_id,nome,cor,predefined_id,removida,conflito,primeira_observacao_id,ultima_observacao_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(conta_id,label_id) DO UPDATE SET nome=excluded.nome,cor=excluded.cor,predefined_id=excluded.predefined_id,removida=excluded.removida,conflito=MAX(whatsapp_labels.conflito,excluded.conflito),ultima_observacao_id=excluded.ultima_observacao_id`).run(sessao.contaId,payload.id,payload.name,payload.color,predefinedId,Number(payload.deleted),conflito,id,id);
      }else{
        const anterior=this.db.prepare('SELECT * FROM whatsapp_label_associacoes WHERE conta_id=? AND conversa_id=? AND message_id=? AND label_id=?').get(sessao.contaId,a.chatId,a.messageId??'',a.labelId);
        const add=Number(payload.type==='add'),remove=Number(payload.type==='remove');
        const definicao=this.db.prepare('SELECT removida FROM whatsapp_labels WHERE conta_id=? AND label_id=?').get(sessao.contaId,a.labelId);
        const semDefinicao=!definicao||definicao.removida===1;
        const conflito=Number(semDefinicao||remove||Boolean(anterior&&(anterior.viu_adicao&&!add||anterior.viu_remocao&&!remove)));
        this.db.prepare(`INSERT INTO whatsapp_label_associacoes(conta_id,conversa_id,message_id,label_id,viu_adicao,viu_remocao,conflito,primeira_observacao_id,ultima_observacao_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(conta_id,conversa_id,message_id,label_id) DO UPDATE SET viu_adicao=MAX(whatsapp_label_associacoes.viu_adicao,excluded.viu_adicao),viu_remocao=MAX(whatsapp_label_associacoes.viu_remocao,excluded.viu_remocao),conflito=MAX(whatsapp_label_associacoes.conflito,excluded.conflito),ultima_observacao_id=excluded.ultima_observacao_id`).run(sessao.contaId,a.chatId,a.messageId??'',a.labelId,add,remove,conflito,id,id);
      }
      this.db.exec('RELEASE whatsapp_labels_observar');
      return gravou;
    }catch(error){
      this.db.exec('ROLLBACK TO whatsapp_labels_observar; RELEASE whatsapp_labels_observar');
      throw error;
    }
  }
  estado(sessao=this.#ativa){
    const conectada=Boolean(sessao&&mesmaTupla(this.#ativa,sessao)),leitura=conectada&&mesmaTupla(this.#consentida,sessao);
    if(!leitura)return {disponivel:conectada,leitura:false,contaId:conectada?sessao.contaId:null,labels:[],associacoes:[],conflito:false};
    const tem=t=>Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
    const recorte=tem('f10_procedencias')&&tem('politicas_conversa')?LEITURA_SQL:"e.permissao IN ('minha','dirigida')";
    const associacoes=this.db.prepare(`SELECT a.* FROM whatsapp_label_associacoes a WHERE a.conta_id=? AND ((a.message_id='' AND EXISTS(SELECT 1 FROM eventos e WHERE e.conversa_id=a.conversa_id AND ${recorte})) OR (a.message_id<>'' AND EXISTS(SELECT 1 FROM eventos e WHERE e.conversa_id=a.conversa_id AND e.origem_id=a.message_id AND ${recorte}))) ORDER BY a.ultima_observacao_id,a.conversa_id,a.message_id,a.label_id`).all(sessao.contaId);
    const ids=[...new Set(associacoes.map(a=>a.label_id))],labels=ids.length?this.db.prepare(`SELECT * FROM whatsapp_labels WHERE conta_id=? AND label_id IN (${ids.map(()=>'?').join(',')}) ORDER BY ultima_observacao_id,label_id`).all(sessao.contaId,...ids):[];
    return {disponivel:true,leitura:true,contaId:sessao.contaId,labels,associacoes,conflito:[...labels,...associacoes].some(x=>x.conflito===1)};
  }
}
