import {createHash,randomUUID} from 'node:crypto';
import {assinaturaFonte} from '../tarefas-esquema.js';

const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const falha=(mensagem,codigo)=>Object.assign(new Error(mensagem),{codigo});
const indisponivel=()=>falha('Projeto importado indisponível. Confira as fontes e permissões atuais.','PROJETO_IMPORTADO_INDISPONIVEL');
const desatualizada=()=>falha('As fontes ou o projeto mudaram. Abra uma nova prévia.','PREVIA_DESATUALIZADA');
const validadeMs=5*60*1000;
const aviso='Confira as fontes atuais. A confirmação recupera somente a organização local como rascunho. Permissões, pastas, estado comercial e aceite não são recuperados.';
function campos(pedido,permitidos){
  if(!pedido||typeof pedido!=='object'||Array.isArray(pedido)||Object.keys(pedido).some(k=>!permitidos.includes(k)))
    throw falha('Confira os campos da revisão do projeto.','PROJETO_INVALIDO');
}
const temProcedencia=db=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_ciclo_importacoes'").get());
const procedencia=(db,tabela,id)=>db.prepare('SELECT * FROM lume_ciclo_importacoes WHERE tabela=? AND registro_id=?').get(tabela,String(id));
function originalValida(p){
  try{
    const e=JSON.parse(p?.estado_original);
    return e&&Object.keys(e).sort().join(',')==='invalidada,removida,versao'&&e.versao===1&&e.invalidada===0&&e.removida===0;
  }catch{return false;}
}
function mesmaImportacao(p,origem){return p&&p.backup_sha256===origem.backup_sha256&&p.importado_em===origem.importado_em;}
function identidadeExata(db,f){
  const e=db.prepare('SELECT * FROM desktop_fontes WHERE id=?').get(f.evento_id);
  return e&&typeof e.texto==='string'&&e.texto.trim()&&assinaturaFonte(e)===f.assinatura&&
    Number.isSafeInteger(f.inicio)&&f.inicio>=0&&Number.isSafeInteger(f.tamanho)&&f.tamanho>0&&
    f.inicio+f.tamanho<=e.texto.length&&
    (f.selecao==='trecho'||f.selecao==='evento'&&f.inicio===0&&f.tamanho===e.texto.length);
}

/** Chamado pela captura: carrega a invalidação local para o próximo perfil.
 * Uma procedência desconhecida jamais vira nativa só por estar sem conteúdo. */
export function estadoFonteParaBackup(db,f){
  const imp=temProcedencia(db)?procedencia(db,'lume_projetos_fontes',f.id):null;
  if(!imp)return JSON.stringify({versao:1,invalidada:f.invalidada,removida:f.removida});
  let original;
  try{original=JSON.parse(imp.estado_original);}catch{return null;}
  if(!original||Object.keys(original).sort().join(',')!=='invalidada,removida,versao'||original.versao!==1||
    ![0,1].includes(original.invalidada)||![0,1].includes(original.removida))return null;
  const guarda=db.prepare('SELECT bloqueada FROM lume_projetos_importados_guardas WHERE fonte_id=?').get(f.id);
  return JSON.stringify({versao:1,invalidada:Math.max(original.invalidada,guarda?.bloqueada===0&&identidadeExata(db,f)?0:1),
    removida:Math.max(original.removida,f.removida)});
}

/** Exclusivo do Backup.restaurar, dentro da transação e após todos os resets.
 * O chamador já validou um acervo vazio e inseriu os markers desta importação.
 * Nunca chamar no startup, na prévia, na captura ou ao conceder leitura. */
export function finalizarRestauracaoProjetos(db){
  for(const f of db.prepare('SELECT * FROM lume_projetos_fontes').all()){
    const imp=procedencia(db,'lume_projetos_fontes',f.id),projeto=procedencia(db,'lume_projetos_comerciais',f.projeto_id);
    const apta=projeto&&mesmaImportacao(imp,projeto)&&originalValida(imp)&&!f.removida&&f.invalidada===1&&identidadeExata(db,f);
    db.prepare('UPDATE lume_projetos_importados_guardas SET versao=lower(hex(randomblob(16))),bloqueada=? WHERE fonte_id=?').run(apta?0:1,f.id);
  }
}

function carregar(service,id,{revisado=false}={}){
  const {db}=service;
  if(typeof id!=='string'||!id||id.length>200||!temProcedencia(db))return null;
  const p=db.prepare('SELECT * FROM lume_projetos_comerciais WHERE id=?').get(id);
  const origem=procedencia(db,'lume_projetos_comerciais',id);
  if(!p||!origem||!['rascunho','confirmado','arquivado'].includes(origem.estado_original)||
    !/^[a-f0-9]{64}$/.test(origem.backup_sha256)||!Number.isFinite(Date.parse(origem.importado_em)))return null;
  const historico=db.prepare('SELECT * FROM lume_projetos_historico WHERE projeto_id=? ORDER BY id').all(id);
  const decisoes=historico.filter(h=>h.tipo==='importado_revisado'&&!procedencia(db,'lume_projetos_historico',h.id));
  if(revisado?!decisoes.length:decisoes.length||p.estado!=='rascunho')return null;
  const links=db.prepare('SELECT * FROM lume_projetos_fontes WHERE projeto_id=? ORDER BY criada_em,id').all(id);
  const fontes=[],identidades=[],permitidas=[];
  for(const f of links){
    const imp=procedencia(db,'lume_projetos_fontes',f.id);
    const guarda=db.prepare('SELECT * FROM lume_projetos_importados_guardas WHERE fonte_id=?').get(f.id);
    // Nunca retirar invalidada antes de provar sua causa no backup e a autoridade
    // persistente deste perfil. Uma base inelegível esconde inclusive o nome.
    const elegivel=mesmaImportacao(imp,origem)&&originalValida(imp)&&guarda?.bloqueada===0&&
      !f.removida&&f.invalidada===(revisado?0:1);
    const fonte=elegivel?service._lerFonte({...f,invalidada:0}):null;
    const selecaoValida=fonte&&Number.isSafeInteger(f.inicio)&&f.inicio>=0&&Number.isSafeInteger(f.tamanho)&&f.tamanho>0&&
      (f.selecao==='trecho'||f.selecao==='evento'&&f.inicio===0&&f.tamanho===service._evento(f.evento_id).texto.length);
    if(f.base&&!selecaoValida)return null;
    if(selecaoValida){fontes.push({...fonte,importacao:{importadoEm:imp.importado_em,backupSha256:imp.backup_sha256}});permitidas.push(f.id);}
    identidades.push([f,imp??null,guarda??null]);
  }
  if(links.filter(f=>f.base).length!==p.bases_total||fontes.filter(f=>f.base).length!==p.bases_total)return null;
  const projeto={...service._publico({p,links,fontes}),importacao:{importadoEm:origem.importado_em,
    backupSha256:origem.backup_sha256,estadoOriginal:origem.estado_original,revisaoNecessaria:!revisado}};
  return {projeto,permitidas,assinatura:hash([p,origem,identidades,historico]),decisao:decisoes.at(-1)?.id};
}

export function listarImportados(service,pedido={}){
  campos(pedido,['limite']);const {limite=100}=pedido;
  if(!Number.isSafeInteger(limite)||limite<1||limite>200)throw falha('Limite inválido.','PROJETO_INVALIDO');
  if(!temProcedencia(service.db))return [];
  return service._transacao(()=>{
    const saida=[];
    for(const row of service.db.prepare("SELECT id FROM lume_projetos_comerciais WHERE estado='rascunho' ORDER BY atualizado_em DESC,id").iterate()){
      const atual=carregar(service,row.id);if(atual)saida.push(atual.projeto);if(saida.length>=limite)break;
    }
    return saida;
  });
}

export function prepararImportado(service,pedido={}){
  campos(pedido,['id']);
  const atual=service._transacao(()=>carregar(service,pedido.id));if(!atual)throw indisponivel();
  const agora=service.agora().getTime(),expiraEm=agora+validadeMs,previaId=randomUUID();
  for(const [id,p] of service.previasImportados)if(p.expiraEm<=agora)service.previasImportados.delete(id);
  while(service.previasImportados.size>=16)service.previasImportados.delete(service.previasImportados.keys().next().value);
  service.previasImportados.set(previaId,{id:pedido.id,assinatura:atual.assinatura,expiraEm});
  return {previaId,expiraEm:new Date(expiraEm).toISOString(),projeto:atual.projeto,fontes:atual.projeto.fontes,aviso};
}

export function revalidarImportado(service,pedido={}){
  campos(pedido,['previaId','confirmar']);
  if(pedido.confirmar!==true)throw falha('Confirme as fontes e a recuperação do rascunho.','CONFIRMACAO_NECESSARIA');
  const previa=service.previasImportados.get(pedido.previaId);
  if(!previa||previa.expiraEm<=service.agora().getTime()){
    service.previasImportados.delete(pedido.previaId);
    throw falha('Abra uma nova prévia do projeto importado.','PREVIA_EXPIRADA');
  }
  try{
    const resultado=service._transacao(()=>{
      const atual=carregar(service,previa.id,{revisado:Boolean(previa.decisao)});
      if(!atual||atual.assinatura!==previa.assinatura)throw desatualizada();
      if(previa.decisao)return {atual,alterado:false};
      for(const id of atual.permitidas)service.db.prepare('UPDATE lume_projetos_fontes SET invalidada=0 WHERE id=?').run(id);
      service.db.prepare("UPDATE lume_projetos_comerciais SET estado='rascunho' WHERE id=?").run(previa.id);
      service._registrar(previa.id,'importado_revisado');
      const depois=carregar(service,previa.id,{revisado:true});
      if(!depois||depois.projeto.estado!=='rascunho'||JSON.stringify(depois.permitidas)!==JSON.stringify(atual.permitidas))throw desatualizada();
      return {atual:depois,alterado:true};
    });
    previa.assinatura=resultado.atual.assinatura;previa.decisao=resultado.atual.decisao;
    return {...resultado.atual.projeto,revalidado:true,alterado:resultado.alterado};
  }catch(e){service.previasImportados.delete(pedido.previaId);throw e;}
}
