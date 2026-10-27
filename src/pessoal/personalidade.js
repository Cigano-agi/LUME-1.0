import {createHash} from 'node:crypto';
import {prepararFontes} from '../fontes-desktop.js';
import {assinaturaFonte} from '../tarefas-esquema.js';
import {validarConversa,leituraPessoalSql,lacunaFonte} from './contexto.js';

function textoLimpo(texto){
  const semMarcacao=texto.normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu,c=>c==='\n'?'\n':c==='\t'?' ':'')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu,'')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu,'')
    .replace(/<[^>]*>/gu,'').replace(/!\[([^\]]*)\]\([^)]*\)/gu,'$1')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/gu,'$1 ($2)')
    .replace(/^[ \t]*(?:#{1,6}\s+|>\s*|[-*+]\s+)/gmu,'');
  // Markdown delimiters are removed from prose; URL paths keep literal underscores.
  return semMarcacao.split(/(https?:\/\/[^\s<>]+)/gu).map((parte,i)=>i%2?parte:parte.replace(/[*_`~]/gu,''))
    .join('').replace(/\n{3,}/gu,'\n\n').trim();
}
// Fail on overflow instead of silently dropping a promise from the fifth balloon.
export function sanitizarBaloes(entrada){
  const partes=typeof entrada==='string'?[entrada]:entrada;
  if(!Array.isArray(partes)||partes.length<1||partes.length>4||partes.some(p=>typeof p!=='string'||p.length>6000))throw new Error('Resposta deve conter de 1 a 4 balões de até 6000 caracteres.');
  const limpos=partes.map(textoLimpo);
  if(limpos.some(p=>!p)||limpos.reduce((n,p)=>n+p.length,0)>12000)throw new Error('Resposta vazia ou longa demais.');
  return limpos;
}
const chave=id=>'pessoal:correcoes:'+createHash('sha256').update(id).digest('hex');

export class PersonalidadePessoal {
  constructor(db){this.db=db;prepararFontes(db);db.exec('CREATE TABLE IF NOT EXISTS desktop_config(chave TEXT PRIMARY KEY,valor TEXT NOT NULL)');}
  exemplos({conversaId,remoto=true}={}){
    validarConversa(conversaId);
    const rows=this.db.prepare(`WITH candidatos AS MATERIALIZED (SELECT id FROM eventos WHERE conversa_id=? AND autor_e_dono=1 AND do_proprio_bot=0 ORDER BY recebido_em DESC,id DESC LIMIT 100)
      SELECT e.id,e.conversa_id,e.origem_id,e.tipo,e.texto,e.permissao,e.recebido_em,e.projeto_id,e.origem_compartilhamento,e.autor_id,e.autor_e_dono,e.transcricao_meta
      FROM candidatos k JOIN desktop_fontes e ON e.id=k.id WHERE ${leituraPessoalSql(this.db,remoto)} AND e.tipo='texto' AND length(e.texto)<=1200 ORDER BY e.recebido_em DESC,e.id DESC LIMIT 12`).all(conversaId);
    return rows.filter(e=>!lacunaFonte(e)).slice(0,8).map(e=>({id:e.id,conversaId:e.conversa_id,texto:e.texto,data:e.recebido_em,assinatura:assinaturaFonte(e)}));
  }
  _permitida(conversaId,remoto){
    validarConversa(conversaId);
    return Boolean(this.db.prepare(`SELECT 1 FROM desktop_fontes e WHERE e.conversa_id=? AND ${leituraPessoalSql(this.db,remoto)} LIMIT 1`).get(conversaId));
  }
  corrigir({conversaId,texto}={}){
    if(typeof texto!=='string'||!texto.trim()||texto.length>1000)throw new Error('Correção deve ter até 1000 caracteres.');
    if(!this._permitida(conversaId,false))throw new Error('Conversa indisponível para correção.');
    const limpa=textoLimpo(texto);if(!limpa)throw new Error('Correção vazia.');
    const anteriores=this.correcoes({conversaId});
    const correcoes=[...anteriores.filter(c=>c.texto!==limpa),{texto:limpa,data:new Date().toISOString()}].slice(-20);
    this.db.prepare('INSERT INTO desktop_config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(chave(conversaId),JSON.stringify({conversaId,correcoes}));
    return {conversaId,correcoes};
  }
  correcoes({conversaId,remoto=false}={}){
    if(!this._permitida(conversaId,remoto))return [];
    const row=this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(chave(conversaId));
    if(!row||row.valor.length>30000)return [];
    try{const dado=JSON.parse(row.valor);return dado.conversaId===conversaId&&Array.isArray(dado.correcoes)?dado.correcoes.filter(c=>typeof c.texto==='string'&&c.texto.length<=1000&&typeof c.data==='string').slice(-20):[];}catch{return [];}
  }
}
