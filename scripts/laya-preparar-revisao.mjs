// Separa candidatos locais de DMs para revisão humana. Nunca treina ou chama modelo.
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {mkdir,realpath,writeFile,unlink} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {LEITURA_SQL} from '../src/leitura-sql.js';
import {hasSensitivePattern} from './laya-annotations-lib.mjs';

const root=resolve(import.meta.dirname,'..');
const inside=(parent,child)=>{const r=relative(parent,child);return r===''||!r.startsWith('..')&&!isAbsolute(r);};
const direct=id=>typeof id==='string'&&/^[^@\s]+@(lid|s\.whatsapp\.net|c\.us)$/.test(id);
const pseudonym=(prefix,salt,id)=>prefix+createHash('sha256').update(salt).update(id).digest('hex').slice(0,20);

export function selecionarRevisao(db,{salt,maxItems=5000,perConversation=8}={}){
  if(!Buffer.isBuffer(salt)||salt.length<16||!Number.isInteger(maxItems)||maxItems<1||maxItems>5000||!Number.isInteger(perConversation)||perConversation<1||perConversation>50)throw Error('PARAMETROS_REVISAO_INVALIDOS');
  const candidateLimit=Math.min(20000,maxItems*4);
  const rows=db.prepare(`WITH elegiveis AS (
    SELECT e.id,e.conversa_id,e.direcao,e.autor_e_dono,e.texto,e.recebido_em,
      ROW_NUMBER() OVER (PARTITION BY e.conversa_id ORDER BY e.id DESC) posicao
    FROM eventos e WHERE e.tipo='texto' AND e.permissao IN ('minha','dirigida')
      AND e.texto IS NOT NULL AND length(trim(e.texto)) BETWEEN 8 AND 2000
      AND ${LEITURA_SQL}
      AND (e.conversa_id LIKE '%@lid' OR e.conversa_id LIKE '%@s.whatsapp.net' OR e.conversa_id LIKE '%@c.us')
  ) SELECT id,conversa_id,direcao,autor_e_dono,texto,recebido_em
    FROM elegiveis WHERE posicao<=? ORDER BY posicao,id DESC LIMIT ?`).all(perConversation,candidateLimit);
  const selected=[],conversations=new Set(),candidateConversations=new Set(rows.filter(row=>direct(row.conversa_id)).map(row=>row.conversa_id));let sensitiveSkipped=0;
  for(const row of rows){
    if(!direct(row.conversa_id))continue;
    if(hasSensitivePattern(row.texto)){sensitiveSkipped++;continue;}
    const conversationKey=pseudonym('c',salt,row.conversa_id);
    conversations.add(conversationKey);
    selected.push({id:'s'+row.id,sourceId:row.id,personKey:pseudonym('p',salt,row.conversa_id),conversationKey,channel:'dm',author:row.direcao==='saida'||row.autor_e_dono===1?'self':'other',text:row.texto,receivedAt:row.recebido_em,reviewed:false});
    if(selected.length>=maxItems)break;
  }
  return{schema:'lume-laya-review-selection-v1',purpose:'manual-review-before-model-use',dataKind:'local_dm_unreviewed',generatedAt:new Date().toISOString(),
    selection:{maxItems,perConversation,candidateConversations:candidateConversations.size,selected:selected.length,selectedConversations:conversations.size,sensitiveSkipped,mayBeTruncated:rows.length>=candidateLimit||selected.length>=maxItems},items:selected};
}

export async function prepararRevisao({databasePath,outputPath,maxItems=5000,perConversation=8}={}){
  if(!databasePath||!outputPath)throw Error('CAMINHOS_REVISAO_AUSENTES');
  const output=resolve(outputPath),base=resolve(root,'work','laya-private','revisoes-dm'),rel=relative(base,output);
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||!output.endsWith('.json')||existsSync(output))throw Error('SAIDA_PRIVADA_INVALIDA_OU_EXISTENTE');
  await mkdir(dirname(output),{recursive:true});
  const [rootReal,baseReal,dirReal]=await Promise.all([realpath(root),realpath(base),realpath(dirname(output))]);
  if(!inside(rootReal,baseReal)||!inside(baseReal,dirReal))throw Error('SAIDA_FORA_DO_WORK_PRIVADO');
  if(process.platform==='win32'){
    try{
      const owner=execFileSync('whoami',[],{encoding:'utf8'}).trim();
      if(!owner)throw Error('USUARIO_LOCAL_AUSENTE');
      execFileSync('icacls',[baseReal,'/grant:r',`${owner}:(OI)(CI)F`],{stdio:'ignore'});
      execFileSync('icacls',[baseReal,'/inheritance:r'],{stdio:'ignore'});
    }catch{throw Error('PROTECAO_DIRETORIO_PRIVADO_FALHOU');}
  }
  const db=new DatabaseSync(resolve(databasePath),{readOnly:true});
  let result;
  try{result=selecionarRevisao(db,{salt:randomBytes(32),maxItems,perConversation});}
  finally{db.close();}
  await writeFile(output,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
  if(process.platform==='win32'){
    try{
      const owner=execFileSync('whoami',[],{encoding:'utf8'}).trim();
      if(!owner)throw Error('USUARIO_LOCAL_AUSENTE');
      execFileSync('icacls',[output,'/grant:r',`${owner}:(F)`],{stdio:'ignore'});
      execFileSync('icacls',[output,'/inheritance:r'],{stdio:'ignore'});
    }catch{await unlink(output);throw Error('PROTECAO_ARQUIVO_PRIVADO_FALHOU');}
  }
  return{written:true,selected:result.selection.selected,candidateConversations:result.selection.candidateConversations,selectedConversations:result.selection.selectedConversations,sensitiveSkipped:result.selection.sensitiveSkipped,mayBeTruncated:result.selection.mayBeTruncated};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [databasePath,outputPath,rights,review,...extra]=process.argv.slice(2);
  if(rights!=='--confirm-participant-rights'||review!=='--confirm-local-review'||extra.length)throw Error('Uso: node scripts/laya-preparar-revisao.mjs BANCO.db work/laya-private/revisoes-dm/revisao.json --confirm-participant-rights --confirm-local-review');
  prepararRevisao({databasePath,outputPath}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
