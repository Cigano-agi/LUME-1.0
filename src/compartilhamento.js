import { createHash, createPublicKey, createPrivateKey, sign, verify, randomUUID } from 'node:crypto';
import { garantirEsquema } from './permissao.js';
import { diaLocal } from './relogio.js';
import {eventoExcluido} from './exclusoes.js';
import { Privacidade } from './privacidade.js';
import { LEITURA_SQL, PROJETO_SQL } from './leitura-sql.js';
import {lerTranscricaoTransferencia,validarTranscricaoTransferencia,gravarTranscricaoTransferida} from './transcricao-transferencia.js';
import {prepararEsquemaTranscricao} from './transcricao.js';
export { COMPARTILHADO_SQL, PROJETO_SQL } from './leitura-sql.js';

export const MAX_PACOTE = 8 * 1024 * 1024;
const MAX_EVENTOS = 10000;
const hash = value => createHash('sha256').update(value).digest('hex');
const objeto = x => x && typeof x === 'object' && !Array.isArray(x);
const texto = (x,max=200) => typeof x==='string' && x.trim().length>0 && x.length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(x);
const iso = x => typeof x==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString()===x;
const exact = (x,keys) => objeto(x) && Object.keys(x).sort().join('|')===keys.slice().sort().join('|');
function exigir(ok,mensagem) { if(!ok)throw new Error(mensagem); }
export function canonico(value) {
  if(Array.isArray(value))return '['+value.map(canonico).join(',')+']';
  if(objeto(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonico(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function fingerprint(chavePublica) {
  const key=chavePublica?.type==='public'?chavePublica:createPublicKey(chavePublica);
  exigir(key.asymmetricKeyType==='ed25519','A chave precisa ser Ed25519.');
  return hash(key.export({type:'spki',format:'der'}));
}
export function assinarPacote(conteudo,chavePrivada) {
  const key=chavePrivada?.type==='private'?chavePrivada:createPrivateKey(chavePrivada);
  exigir(key.asymmetricKeyType==='ed25519','A chave precisa ser Ed25519.');
  const chave_publica=createPublicKey(key).export({type:'spki',format:'pem'});
  const pacote={conteudo,chave_publica,assinatura:sign(null,Buffer.from(canonico(conteudo)),key).toString('base64')};
  verificarPacote(pacote);
  return pacote;
}
export function verificarPacote(entrada) {
  let p=entrada;
  if(typeof p==='string') { exigir(Buffer.byteLength(p)<=MAX_PACOTE,'Arquivo excede 8 MB. Divida o projeto.');try{p=JSON.parse(p);}catch{throw new Error('Arquivo JSON inválido.');} }
  exigir(exact(p,['conteudo','chave_publica','assinatura']),'Formato de pacote inválido.');
  exigir(Buffer.byteLength(JSON.stringify(p))<=MAX_PACOTE,'Arquivo excede 8 MB. Divida o projeto.');
  const c=p.conteudo;
  exigir(exact(c,['versao','id','origem','projeto','destinatario','eventos']) && ['assessor-f10-v1','assessor-f10-v2'].includes(c.versao) && /^[a-f0-9-]{36}$/.test(c.id),'Versão ou identificação inválida.');
  exigir(exact(c.origem,['pessoa','maquina','exportado_em']) && texto(c.origem.pessoa,80) && texto(c.origem.maquina,100) && iso(c.origem.exportado_em),'Origem inválida.');
  exigir(exact(c.projeto,['id','nome']) && texto(c.projeto.id) && texto(c.projeto.nome,100) && texto(c.destinatario,100),'Projeto ou destinatário inválido.');
  exigir(Array.isArray(c.eventos) && c.eventos.length>0 && c.eventos.length<=MAX_EVENTOS,'Escolha de 1 a 10.000 fontes por arquivo.');
  const ids=new Set();
  for(const e of c.eventos) {
    exigir(exact(e,['conversa_id','conversa_nome','origem_id','autor_id','tipo','texto','recebido_em',...(c.versao==='assessor-f10-v2'?['transcricao']:[])]), 'Evento com campos inesperados.');
    exigir(texto(e.conversa_id) && texto(e.conversa_nome,200) && texto(e.origem_id) && (e.autor_id===null||texto(e.autor_id)) && texto(e.tipo,80) && (e.texto===null||typeof e.texto==='string'&&e.texto.length<=100000) && iso(e.recebido_em),'Evento inválido.');
    const id=JSON.stringify([e.conversa_id,e.origem_id]);exigir(!ids.has(id),'Pacote contém fonte repetida.');ids.add(id);
    if(c.versao==='assessor-f10-v2')validarTranscricaoTransferencia(e.transcricao);
  }
  exigir(texto(p.chave_publica,200) && typeof p.assinatura==='string' && /^[A-Za-z0-9+/]{86}==$/.test(p.assinatura),'Assinatura inválida.');
  let fp;
  try {fp=fingerprint(p.chave_publica);exigir(verify(null,Buffer.from(canonico(c)),p.chave_publica,Buffer.from(p.assinatura,'base64')),'Assinatura inválida.');}
  catch{throw new Error('Assinatura inválida. O arquivo foi alterado ou a chave não é válida.');}
  // Cópia impede mutação do objeto original entre prévia e consumo.
  return {pacote:JSON.parse(JSON.stringify(p)),fingerprint:fp,digest:hash(canonico(p))};
}

export function prepararCompartilhamento(db) {
  const cols=db.prepare('PRAGMA table_info(eventos)').all();
  if(!cols.some(c=>c.name==='origem_compartilhamento'))db.exec('ALTER TABLE eventos ADD COLUMN origem_compartilhamento TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS f10_projetos(id TEXT PRIMARY KEY,nome TEXT NOT NULL,criado_em TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS f10_conversas(projeto_id TEXT NOT NULL REFERENCES f10_projetos(id) ON DELETE CASCADE,conversa_id TEXT NOT NULL,PRIMARY KEY(projeto_id,conversa_id));
    CREATE TABLE IF NOT EXISTS f10_origens(fingerprint TEXT PRIMARY KEY,pessoa TEXT NOT NULL,maquina TEXT NOT NULL,chave_publica TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS f10_procedencias(evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL REFERENCES f10_origens(fingerprint),pacote_id TEXT NOT NULL,projeto_id TEXT NOT NULL REFERENCES f10_projetos(id),
      exportado_em TEXT NOT NULL,importado_em TEXT NOT NULL,pessoa TEXT,maquina TEXT,PRIMARY KEY(evento_id,fingerprint,pacote_id,projeto_id));
    CREATE TABLE IF NOT EXISTS f10_recebidos(digest TEXT NOT NULL,projeto_id TEXT NOT NULL REFERENCES f10_projetos(id),fingerprint TEXT NOT NULL,recebido_em TEXT NOT NULL,PRIMARY KEY(digest,projeto_id));
    CREATE TABLE IF NOT EXISTS f10_revogadas(fingerprint TEXT PRIMARY KEY,revogado_em TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS f10_conversas_importadas(conversa_id TEXT PRIMARY KEY);`);
  const procedencias=db.prepare('PRAGMA table_info(f10_procedencias)').all();
  for(const c of ['pessoa','maquina'])if(!procedencias.some(col=>col.name===c))db.exec(`ALTER TABLE f10_procedencias ADD COLUMN ${c} TEXT`);
}
// Importação é autorização para a contribuição exata, nunca para o grupo inteiro.
const visivel=LEITURA_SQL;
const eventosIguais=(a,b)=>['conversa_id','origem_id','autor_id','tipo','texto','recebido_em'].every(k=>a[k]===b[k]);

export class Compartilhamento {
  constructor(db,{privacidade=null}={}){this.db=db;this.privacidade=privacidade||new Privacidade(db);garantirEsquema(db);prepararCompartilhamento(db);}
  projetos(){return this.db.prepare('SELECT * FROM f10_projetos ORDER BY nome').all();}
  criarProjeto({nome,conversas=[]}={}) {
    exigir(texto(nome,100)&&Array.isArray(conversas)&&conversas.length<=1000,'Nome ou conversas inválidas.');
    for(const id of conversas)exigir(texto(id)&&this.db.prepare('SELECT 1 FROM conversas_app WHERE id=?').get(id),'Conversa não encontrada.');
    const id='contexto-'+randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {this.db.prepare('INSERT INTO f10_projetos VALUES(?,?,?)').run(id,nome.trim(),new Date().toISOString());
      for(const c of new Set(conversas))this.db.prepare('INSERT INTO f10_conversas VALUES(?,?)').run(id,c);
      this.db.exec('COMMIT');return {id,nome};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  prepararExportacao({projeto,pessoa,maquina,destinatario}={}) {
    exigir(texto(projeto)&&texto(pessoa,80)&&texto(maquina,100)&&texto(destinatario,100),'Escolha projeto, remetente e destinatário.');
    const p=this.db.prepare('SELECT id,nome FROM f10_projetos WHERE id=? UNION ALL SELECT id,nome FROM projetos WHERE id=? LIMIT 1').get(projeto,projeto);
    exigir(p,'Projeto não encontrado.');
    const eventos=this.db.prepare(`SELECT e.conversa_id,COALESCE(c.nome,e.conversa_id) conversa_nome,e.origem_id,e.autor_id,e.tipo,e.texto,e.recebido_em
      FROM eventos e LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE ${PROJETO_SQL} AND ${visivel} ORDER BY e.id LIMIT ?`).all(projeto,projeto,projeto,MAX_EVENTOS+1).map(e=>({...e,transcricao:lerTranscricaoTransferencia(this.db,e)}));
    exigir(eventos.length>0,'Este projeto não tem fontes permitidas para exportar.');
    exigir(eventos.length<=MAX_EVENTOS,'Mais de 10.000 fontes: divida em projetos menores.');
    const conteudo={versao:'assessor-f10-v2',id:randomUUID(),origem:{pessoa,maquina,exportado_em:new Date().toISOString()},projeto:p,destinatario,eventos};
    exigir(Buffer.byteLength(JSON.stringify(conteudo))<MAX_PACOTE-1024,'Mais de 8 MB: divida em projetos menores.');return conteudo;
  }
  conferirAtual(conteudo) {
    const atual=this.prepararExportacao({projeto:conteudo.projeto.id,pessoa:conteudo.origem.pessoa,maquina:conteudo.origem.maquina,destinatario:conteudo.destinatario});
    exigir(canonico(atual.eventos)===canonico(conteudo.eventos)&&canonico(atual.projeto)===canonico(conteudo.projeto),'As fontes ou permissões mudaram. Confira uma nova prévia.');
  }
  previa(entrada) {
    const v=verificarPacote(entrada),c=v.pacote.conteudo;
    return {fingerprint:v.fingerprint,remetente:c.origem,projeto:c.projeto,destinatario:c.destinatario,total:c.eventos.length,
      eventos:c.eventos,revogada:Boolean(this.db.prepare('SELECT 1 FROM f10_revogadas WHERE fingerprint=?').get(v.fingerprint))};
  }
  importar(entrada,{projeto,fingerprintConfirmada,dry=false}={}) {
    const {pacote:p,fingerprint:fp,digest}=verificarPacote(entrada),c=p.conteudo;
    exigir(typeof fingerprintConfirmada==='string'&&fingerprintConfirmada.replace(/[\s:]/g,'').toLowerCase()===fp,'Confirme a impressão digital recebida do remetente por outro canal.');
    if(c.eventos.some(e=>e.transcricao))prepararEsquemaTranscricao(this.db);
    this.db.exec(dry?'BEGIN':'BEGIN IMMEDIATE');
    try {
    exigir(texto(projeto)&&this.db.prepare('SELECT 1 FROM f10_projetos WHERE id=?').get(projeto),'Escolha um projeto local.');
    exigir(!this.db.prepare('SELECT 1 FROM f10_revogadas WHERE fingerprint=?').get(fp),'Este remetente foi removido. A reimportação está bloqueada.');
    exigir(!c.eventos.some(e=>eventoExcluido(this.db,e.conversa_id,e.origem_id)),'O pacote contém fonte já excluída neste perfil. Nada foi importado.');
    if(this.db.prepare('SELECT 1 FROM f10_recebidos WHERE digest=? AND projeto_id=?').get(digest,projeto)){this.db.exec('COMMIT');return {novos:0,existentes:c.eventos.length,repetido:true};}
    const get=this.db.prepare('SELECT * FROM eventos WHERE conversa_id=? AND origem_id=?');
    // Todo conflito é resolvido ANTES da primeira gravação; não substitui evidência nativa.
    const matches=c.eventos.map(e=>{const old=get.get(e.conversa_id,e.origem_id);exigir(!old||eventosIguais(old,e)&&(c.versao==='assessor-f10-v1'||canonico(lerTranscricaoTransferencia(this.db,old))===canonico(e.transcricao)),'Há uma fonte com o mesmo identificador e conteúdo diferente. Nada foi importado.');return old;});
    const result={novos:matches.filter(e=>!e).length,existentes:matches.filter(Boolean).length,repetido:false};
    if(dry){this.db.exec('COMMIT');return result;}
    const now=new Date().toISOString();
      this.db.prepare('INSERT OR IGNORE INTO f10_origens VALUES(?,?,?,?)').run(fp,c.origem.pessoa,c.origem.maquina,p.chave_publica);
      c.eventos.forEach((e,i)=>{
        let id=matches[i]?.id;
        if(!id) {
          id=Number(this.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,do_proprio_bot,tipo,bruto,texto,recebido_em,dia_local,permissao)
            VALUES(?,?,'entrada',?,0,0,?,?,?,?,?,'compartilhado')`).run(e.conversa_id,e.origem_id,e.autor_id,e.tipo,JSON.stringify({formato:c.versao==='assessor-f10-v2'?'f10-evento-v2':'f10-evento-v1',...e}),e.texto,e.recebido_em,diaLocal(new Date(e.recebido_em))).lastInsertRowid);
          gravarTranscricaoTransferida(this.db,e);
        }
        const novaConversa=this.db.prepare('INSERT OR IGNORE INTO conversas_app(id,nome) VALUES(?,?)').run(e.conversa_id,e.conversa_nome).changes;
        if(novaConversa)this.db.prepare('INSERT OR IGNORE INTO f10_conversas_importadas VALUES(?)').run(e.conversa_id);
        this.db.prepare('INSERT OR IGNORE INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em,pessoa,maquina) VALUES(?,?,?,?,?,?,?,?)').run(id,fp,c.id,projeto,c.origem.exportado_em,now,c.origem.pessoa,c.origem.maquina);
        this.atualizarProcedencia(id);
      });
      this.db.prepare('INSERT INTO f10_recebidos VALUES(?,?,?,?)').run(digest,projeto,fp,now);
      this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  atualizarProcedencia(id) {
    const lista=this.db.prepare(`SELECT f.fingerprint,COALESCE(f.pessoa,o.pessoa) pessoa,COALESCE(f.maquina,o.maquina) maquina,f.exportado_em,f.importado_em,f.pacote_id,f.projeto_id
      FROM f10_procedencias f JOIN f10_origens o USING(fingerprint) WHERE f.evento_id=? ORDER BY f.fingerprint,f.pacote_id,f.projeto_id`).all(id);
    this.db.prepare('UPDATE eventos SET origem_compartilhamento=? WHERE id=?').run(lista.length?JSON.stringify(lista):null,id);
  }
  origens(){return this.db.prepare(`SELECT o.fingerprint,o.pessoa,o.maquina,COUNT(DISTINCT f.evento_id) fontes FROM f10_origens o JOIN f10_procedencias f USING(fingerprint) GROUP BY o.fingerprint ORDER BY o.pessoa`).all();}
  prepararRemocao({fingerprint}={}) {return this.privacidade.preparar({origem:fingerprint});}
  removerOrigem({fingerprint:fp,confirmar,id}={}) {
    exigir(confirmar==='REMOVER' && /^[a-f0-9]{64}$/.test(fp),'Digite REMOVER para confirmar.');
    // API direta conserva a chamada existente; desktop exige uma previa exibida.
    const previa=id?this.privacidade.previas.get(id):null;
    if(id)exigir(previa?.filtro.origem===fp,'Previa de outra origem ou expirada.');
    return this.privacidade.excluir({id:id||this.prepararRemocao({fingerprint:fp}).id,confirmar});
  }
}
