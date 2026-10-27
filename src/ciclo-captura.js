import {chaveConversa,chaveExclusao} from './exclusoes.js';
import {LEITURA_PESSOAL_SQL} from './leitura-sql.js';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,fstatSync,lstatSync,openSync,readSync} from 'node:fs';

// O ciclo é registrado na mesma transação que a origem. Nenhuma destas linhas
// autoriza um provedor, executor ou envio; consumidores precisam reconferir acesso.
const ORDEM=['captura','midia','transcricao','interpretacao','indexacao','projecao'];
const MIDIAS=new Set(['audio','imagem','video','documento','figurinha']);
const LIMITE_HASH_PADRAO=64*1024*1024;

export function agendarCicloFonte(db,{id,tipo,recebidoEm}){
  if(!Number.isSafeInteger(id)||id<1)throw new TypeError('Fonte inválida');
  const iso=recebidoEm instanceof Date?recebidoEm.toISOString():new Date(recebidoEm).toISOString();
  const etapas=['captura'];
  if(MIDIAS.has(tipo))etapas.push('midia');
  if(tipo==='audio')etapas.push('transcricao');
  etapas.push('interpretacao','indexacao','projecao');
  const inserir=db.prepare(`INSERT OR IGNORE INTO etapas
    (evento_id,etapa,estado,tentativas,atualizado_em,proxima_tentativa_em)
    VALUES(?,?,?,?,?,?)`);
  for(const etapa of etapas)inserir.run(id,etapa,etapa==='captura'?'concluida':'pendente',0,iso,etapa==='captura'?null:iso);
}

// Migração incremental do acervo anterior. Cada chamada tem custo limitado e
// pode ser repetida depois de crash; a PK das etapas impede duplicação.
// O cursor acompanha a última fonte EXAMINADA, inclusive quando nenhuma precisa
// de reparo. O chamador deve retomá-lo enquanto restam=true.
export function reconciliarCicloFontes(db,{limite=250,cursor=0}={}){
  if(!Number.isSafeInteger(limite)||limite<1||limite>500)throw new TypeError('Limite inválido');
  if(!Number.isSafeInteger(cursor)||cursor<0)throw new TypeError('Cursor inválido');
  const lote=db.prepare(`WITH janela AS MATERIALIZED (
      SELECT id,conversa_id,origem_id,tipo,recebido_em,permissao FROM eventos
      WHERE id>? ORDER BY id LIMIT ?
    ) SELECT e.id,e.conversa_id,e.origem_id,e.tipo,e.recebido_em,
    CASE WHEN e.tipo NOT IN ('nota','notetaker_trecho')
      AND COALESCE(e.permissao,'') <> 'compartilhado'
      AND NOT EXISTS(SELECT 1 FROM etapas s WHERE s.evento_id=e.id AND s.etapa='captura' AND s.estado='desistida')
      AND (NOT EXISTS(SELECT 1 FROM etapas s WHERE s.evento_id=e.id AND s.etapa='captura')
        OR NOT EXISTS(SELECT 1 FROM etapas s WHERE s.evento_id=e.id AND s.etapa='interpretacao')
        OR NOT EXISTS(SELECT 1 FROM etapas s WHERE s.evento_id=e.id AND s.etapa='indexacao')
        OR NOT EXISTS(SELECT 1 FROM etapas s WHERE s.evento_id=e.id AND s.etapa='projecao')
        OR (e.tipo IN ('audio','imagem','video','documento','figurinha') AND
          NOT EXISTS(SELECT 1 FROM etapas s WHERE s.evento_id=e.id AND s.etapa='midia'))
        OR (e.tipo='audio' AND NOT EXISTS(SELECT 1 FROM etapas s WHERE s.evento_id=e.id AND s.etapa='transcricao')))
    THEN 1 ELSE 0 END AS reconciliar FROM janela e ORDER BY e.id`).all(cursor,limite);
  const fontes=lote.filter(e=>e.reconciliar===1);
  const resultado={reconciliadas:fontes.length,examinadas:lote.length,
    restam:lote.length===limite,cursor:lote.at(-1)?.id??cursor};
  if(!fontes.length)return resultado;
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const e of fontes){
      const excluida=db.prepare('SELECT 1 FROM priv_excluidos WHERE hash=?').get(chaveExclusao(e.conversa_id,e.origem_id))
        ||db.prepare('SELECT 1 FROM priv_conversas_excluidas WHERE hash=?').get(chaveConversa(e.conversa_id));
      if(excluida){
        agendarCicloFonte(db,{id:e.id,tipo:e.tipo,recebidoEm:e.recebido_em});
        db.prepare(`UPDATE etapas SET estado='desistida',ultimo_erro='fonte_excluida',
          proxima_tentativa_em=NULL,lease_token=NULL,lease_ate=NULL,fonte_assinatura=NULL,
          atualizado_em=? WHERE evento_id=? AND estado IN ('pendente','falha','em_curso')`)
          .run(new Date().toISOString(),e.id);
      }else agendarCicloFonte(db,{id:e.id,tipo:e.tipo,recebidoEm:e.recebido_em});
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return resultado;
}

// Descoberta read-only da próxima etapa; NÃO é claim de worker. Antes de ligar
// processamento, implementar lease atômico, recuperação e recibo idempotente.
// A consulta é global, independente de projeto comercial. Autorização vem depois.
export function fontesProntasDoCiclo(db,etapa,{limite=50,agora=new Date()}={}){
  if(!ORDEM.slice(1).includes(etapa))throw new TypeError('Etapa inválida');
  if(!Number.isSafeInteger(limite)||limite<1||limite>500)throw new TypeError('Limite inválido');
  const anterior=etapa==='transcricao'?'midia':ORDEM[ORDEM.indexOf(etapa)-1];
  const iso=agora.toISOString();
  const consulta=db.prepare(`SELECT e.id,e.conversa_id,e.origem_id,e.tipo,e.autor_id,e.permissao,s.estado,s.tentativas
    FROM etapas s JOIN eventos e ON e.id=s.evento_id
    JOIN etapas p ON p.evento_id=e.id AND p.etapa=CASE WHEN ?='interpretacao'
      THEN CASE WHEN e.tipo='audio' THEN 'transcricao' WHEN e.tipo IN ('imagem','video','documento','figurinha') THEN 'midia' ELSE 'captura' END
      ELSE ? END AND p.estado='concluida'
    WHERE s.etapa=? AND s.estado IN ('pendente','falha')
      AND COALESCE(e.permissao,'') <> 'compartilhado'
      AND (s.proxima_tentativa_em IS NULL OR s.proxima_tentativa_em<=?)
    ORDER BY e.id LIMIT ? OFFSET ?`);
  const result=[];let offset=0;
  while(result.length<limite){
    const rows=consulta.all(etapa,anterior,etapa,iso,Math.min(500,limite),offset);
    if(!rows.length)break;
    offset+=rows.length;
    for(const row of rows){
      if(db.prepare('SELECT 1 FROM priv_excluidos WHERE hash=?').get(chaveExclusao(row.conversa_id,row.origem_id)))continue;
      if(db.prepare('SELECT 1 FROM priv_conversas_excluidas WHERE hash=?').get(chaveConversa(row.conversa_id)))continue;
      result.push(row);if(result.length===limite)break;
    }
  }
  return result;
}

function instante(value){
  const date=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(date.getTime()))throw new TypeError('Instante inválido');
  return date.toISOString();
}

export function assinaturaFonteCiclo(row){
  return createHash('sha256').update(JSON.stringify([
    row.conversa_id,row.origem_id,row.tipo,row.bruto,row.texto,row.permissao,
    row.autor_id,row.recebido_em
  ])).digest('hex');
}

function fonteAtual(db,id){
  return db.prepare(`SELECT id,conversa_id,origem_id,tipo,bruto,texto,permissao,autor_id,recebido_em
    FROM eventos WHERE id=?`).get(id);
}

function permitida(db,row){
  return row && row.permissao!=='compartilhado' &&
    !db.prepare('SELECT 1 FROM priv_excluidos WHERE hash=?').get(chaveExclusao(row.conversa_id,row.origem_id)) &&
    !db.prepare('SELECT 1 FROM priv_conversas_excluidas WHERE hash=?').get(chaveConversa(row.conversa_id));
}

function anteriorConcluida(db,id,etapa,tipo){
  const anterior=etapa==='interpretacao'
    ? tipo==='audio'?'transcricao':MIDIAS.has(tipo)?'midia':'captura'
    :ORDEM[ORDEM.indexOf(etapa)-1];
  return db.prepare("SELECT 1 FROM etapas WHERE evento_id=? AND etapa=? AND estado='concluida'").get(id,anterior);
}

// Posse e leitura da revisão acontecem na mesma transação. O lease vencido é
// recuperável após crash; o token impede que o worker antigo confirme depois.
// Um lote de 500 candidatos limita o lock de escrita. `continuar` devolve cursor
// para o chamador repetir, e só null significa varredura esgotada.
export function reclamarEtapaCiclo(db,etapa,{agora=new Date(),duracaoMs=60000,cursor=0,tipo=null}={}){
  if(!ORDEM.slice(1).includes(etapa))throw new TypeError('Etapa inválida');
  if(!Number.isSafeInteger(duracaoMs)||duracaoMs<1000||duracaoMs>3600000)throw new TypeError('Lease inválido');
  if(!Number.isSafeInteger(cursor)||cursor<0)throw new TypeError('Cursor inválido');
  if(tipo!==null&&(!MIDIAS.has(tipo)||etapa!=='midia'))throw new TypeError('Tipo de mídia inválido');
  const iso=instante(agora),vence=new Date(new Date(iso).getTime()+duracaoMs).toISOString();
  // Usa idx_etapas_fila antes do join/lock quando só restam etapas terminais.
  // É apenas um atalho: trabalho inserido depois será visto no próximo tick;
  // a posse e todas as validações continuam dentro da transação abaixo.
  if(!db.prepare(`SELECT 1 FROM etapas WHERE etapa=?
    AND estado IN ('pendente','falha','em_curso') LIMIT 1`).get(etapa))return null;
  db.exec('BEGIN IMMEDIATE');
  try{
    const buscar=db.prepare(`SELECT s.evento_id,s.estado,s.tentativas,s.lease_ate,s.proxima_tentativa_em,e.tipo
      FROM etapas s JOIN eventos e ON e.id=s.evento_id WHERE s.etapa=?
        AND s.evento_id>?
        AND (? IS NULL OR e.tipo=?)
        AND ((s.estado IN ('pendente','falha') AND
          (s.proxima_tentativa_em IS NULL OR s.proxima_tentativa_em<=?))
          OR (s.estado='em_curso' AND s.lease_ate<=?))
      ORDER BY s.evento_id LIMIT 500`);
    const rows=buscar.all(etapa,cursor,tipo,tipo,iso,iso);
    for(const candidate of rows){
        cursor=candidate.evento_id;
        const row=fonteAtual(db,candidate.evento_id);
        if(!permitida(db,row)||!anteriorConcluida(db,candidate.evento_id,etapa,candidate.tipo))continue;
        if(etapa==='midia'&&candidate.estado==='em_curso'&&candidate.tentativas>=3){
          db.prepare(`UPDATE etapas SET estado='desistida',ultimo_erro='midia_tentativas_esgotadas:lease_expirada',
            lease_token=NULL,lease_ate=NULL,fonte_assinatura=NULL,proxima_tentativa_em=NULL,atualizado_em=?
            WHERE evento_id=? AND etapa='midia' AND estado='em_curso' AND lease_ate<=?`)
            .run(iso,candidate.evento_id,iso);
          continue;
        }
        const token=randomUUID(),assinatura=assinaturaFonteCiclo(row);
        const changed=db.prepare(`UPDATE etapas SET estado='em_curso',tentativas=tentativas+1,
          lease_token=?,lease_ate=?,fonte_assinatura=?,atualizado_em=?,ultimo_erro=NULL
          WHERE evento_id=? AND etapa=? AND
          ((estado IN ('pendente','falha') AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em<=?))
            OR (estado='em_curso' AND lease_ate<=?))`).run(token,vence,assinatura,iso,row.id,etapa,iso,iso);
        if(changed.changes!==1)continue;
        db.exec('COMMIT');
        return {estado:'em_curso',eventoId:row.id,etapa,token,leaseAte:vence,fonteAssinatura:assinatura,tentativas:candidate.tentativas+1};
    }
    db.exec('COMMIT');
    return rows.length===500?{estado:'continuar',cursor}:null;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

// apply é síncrono e roda junto do recibo no SQLite. Quem escreve derivados deve
// passar a gravação aqui, para crash não separar efeito e confirmação.
export function concluirEtapaCiclo(db,claim,{agora=new Date(),resultado=null,apply}={}){
  if(!claim||typeof claim.token!=='string'||!ORDEM.slice(1).includes(claim.etapa))throw new TypeError('Claim inválido');
  const iso=instante(agora);
  db.exec('BEGIN IMMEDIATE');
  try{
    const etapa=db.prepare('SELECT * FROM etapas WHERE evento_id=? AND etapa=?').get(claim.eventoId,claim.etapa);
    if(!etapa||etapa.estado!=='em_curso'||etapa.lease_token!==claim.token||etapa.lease_ate<=iso){
      db.exec('COMMIT');return {estado:'posse_perdida'};
    }
    const row=fonteAtual(db,claim.eventoId);
    if(!permitida(db,row)||assinaturaFonteCiclo(row)!==etapa.fonte_assinatura||
       !anteriorConcluida(db,claim.eventoId,claim.etapa,row.tipo)){
      const revogada=!permitida(db,row);
      db.prepare(`UPDATE etapas SET estado=?,ultimo_erro=?,lease_token=NULL,lease_ate=NULL,
        fonte_assinatura=NULL,proxima_tentativa_em=?,atualizado_em=? WHERE evento_id=? AND etapa=?`)
        .run(revogada?'desistida':'pendente',revogada?'fonte_revogada':'fonte_alterada',revogada?null:iso,iso,claim.eventoId,claim.etapa);
      db.exec('COMMIT');return {estado:revogada?'fonte_revogada':'fonte_alterada'};
    }
    if(apply!==undefined){
      if(typeof apply!=='function')throw new TypeError('Aplicação inválida');
      const value=apply(db,row);
      if(value&&typeof value.then==='function')throw new TypeError('Aplicação deve ser síncrona');
    }
    const receipt=JSON.stringify({fonteAssinatura:etapa.fonte_assinatura,resultado,concluidaEm:iso});
    db.prepare(`UPDATE etapas SET estado='concluida',resultado=?,lease_token=NULL,lease_ate=NULL,
      atualizado_em=?,proxima_tentativa_em=NULL WHERE evento_id=? AND etapa=?`).run(receipt,iso,claim.eventoId,claim.etapa);
    db.exec('COMMIT');return {estado:'concluida',recibo:receipt};
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function falharEtapaCiclo(db,claim,{agora=new Date(),motivo,esperaMs=60000,desistir=false}={}){
  if(!claim||typeof claim.token!=='string'||!ORDEM.slice(1).includes(claim.etapa))throw new TypeError('Claim inválido');
  if(typeof motivo!=='string'||!motivo||motivo.length>200)throw new TypeError('Motivo inválido');
  if(!Number.isSafeInteger(esperaMs)||esperaMs<0||esperaMs>86400000)throw new TypeError('Espera inválida');
  const iso=instante(agora),proxima=desistir?null:new Date(new Date(iso).getTime()+esperaMs).toISOString();
  const updated=db.prepare(`UPDATE etapas SET estado=?,ultimo_erro=?,proxima_tentativa_em=?,
    lease_token=NULL,lease_ate=NULL,fonte_assinatura=NULL,atualizado_em=?
    WHERE evento_id=? AND etapa=? AND estado='em_curso' AND lease_token=? AND lease_ate>?`)
    .run(desistir?'desistida':'falha',motivo,proxima,iso,claim.eventoId,claim.etapa,claim.token,iso);
  return updated.changes===1;
}

// Explicit retry of one original whose type became supported. Never reopens
// interpretation/assistance or any dispatch, including historical sources.
export function retomarMidiaSuportada(db,eventoId,{agora=new Date()}={}){
  if(!Number.isSafeInteger(eventoId)||eventoId<1)throw new TypeError('Fonte inválida');
  const row=fonteAtual(db,eventoId);
  if(!permitida(db,row)||!['imagem','documento'].includes(row.tipo))return false;
  return db.prepare(`UPDATE etapas SET estado='pendente',tentativas=0,ultimo_erro=NULL,
    lease_token=NULL,lease_ate=NULL,fonte_assinatura=NULL,resultado=NULL,proxima_tentativa_em=?,atualizado_em=?
    WHERE evento_id=? AND etapa='midia' AND estado='desistida' AND ultimo_erro='midia_bloqueada:tipo_nao_suportado'`)
    .run(instante(agora),instante(agora),eventoId).changes===1;
}

// Falta de capacidade não é download concluído nem erro transitório de rede.
// Encerra também as dependências que nunca poderão avançar sem o original.
export function bloquearMidiaSemSuporteCiclo(db,claim,{agora=new Date()}={}){
  if(claim?.etapa!=='midia'||typeof claim.token!=='string')throw new TypeError('Claim de mídia inválido');
  const iso=instante(agora);
  db.exec('BEGIN IMMEDIATE');
  try{
    const etapa=db.prepare("SELECT * FROM etapas WHERE evento_id=? AND etapa='midia'").get(claim.eventoId);
    if(!etapa||etapa.estado!=='em_curso'||etapa.lease_token!==claim.token||etapa.lease_ate<=iso){
      db.exec('COMMIT');return {estado:'posse_perdida'};
    }
    const row=fonteAtual(db,claim.eventoId),revogada=!permitida(db,row);
    if(revogada||assinaturaFonteCiclo(row)!==etapa.fonte_assinatura||!anteriorConcluida(db,row.id,'midia',row.tipo)){
      db.prepare(`UPDATE etapas SET estado=?,ultimo_erro=?,lease_token=NULL,lease_ate=NULL,
        fonte_assinatura=NULL,proxima_tentativa_em=?,atualizado_em=? WHERE evento_id=? AND etapa='midia'`)
        .run(revogada?'desistida':'pendente',revogada?'fonte_revogada':'fonte_alterada',revogada?null:iso,iso,claim.eventoId);
      db.exec('COMMIT');return {estado:revogada?'fonte_revogada':'fonte_alterada'};
    }
    if(!['documento','imagem','video','figurinha'].includes(row.tipo))throw new TypeError('Tipo fora da lacuna de suporte');
    if(db.prepare("SELECT 1 FROM etapas WHERE evento_id=? AND etapa NOT IN ('captura','midia') AND estado='em_curso'").get(row.id))
      throw new Error('Dependência de mídia ainda tem processamento em curso');
    db.prepare(`UPDATE etapas SET estado='desistida',ultimo_erro='midia_bloqueada:tipo_nao_suportado',
      resultado=NULL,proxima_tentativa_em=NULL,lease_token=NULL,lease_ate=NULL,fonte_assinatura=NULL,atualizado_em=?
      WHERE evento_id=? AND etapa='midia'`).run(iso,row.id);
    db.prepare(`UPDATE etapas SET estado='desistida',ultimo_erro='dependencia_bloqueada:midia_tipo_nao_suportado',
      resultado=NULL,proxima_tentativa_em=NULL,lease_token=NULL,lease_ate=NULL,fonte_assinatura=NULL,atualizado_em=?
      WHERE evento_id=? AND etapa NOT IN ('captura','midia') AND estado IN ('pendente','falha')`).run(iso,row.id);
    db.exec('COMMIT');return {estado:'desistida',motivo:'tipo_nao_suportado'};
  }catch(error){db.exec('ROLLBACK');throw error;}
}

// Mídia antiga pode já ter expirado no transporte. Sem um limite, cada reinício
// tornaria a mesma lacuna um download periódico para sempre.
// Cancelamento local nao e falha do transporte. O token protege a posse.
export function devolverEtapaCiclo(db,claim,{agora=new Date()}={}){
  if(!claim||typeof claim.token!=='string'||!ORDEM.slice(1).includes(claim.etapa))throw new TypeError('Claim invalido');
  const iso=instante(agora);
  const changed=db.prepare(`UPDATE etapas SET estado='pendente',tentativas=MAX(0,tentativas-1),
    ultimo_erro=NULL,proxima_tentativa_em=NULL,lease_token=NULL,lease_ate=NULL,
    fonte_assinatura=NULL,atualizado_em=? WHERE evento_id=? AND etapa=?
    AND estado='em_curso' AND lease_token=? AND lease_ate>?`)
    .run(iso,claim.eventoId,claim.etapa,claim.token,iso);
  return changed.changes===1;
}

export function falharMidiaCiclo(db,claim,{agora=new Date(),motivo}={}){
  if(claim?.etapa!=='midia')throw new TypeError('Claim de mídia inválido');
  if(typeof motivo!=='string'||!motivo||motivo.length>160)throw new TypeError('Motivo inválido');
  const atual=db.prepare("SELECT tentativas FROM etapas WHERE evento_id=? AND etapa='midia' AND estado='em_curso' AND lease_token=?")
    .get(claim.eventoId,claim.token);
  if(!atual)return false;
  const permanente=new Set(['midia_expirada','metadados_invalidos','host_recusado','limite_audio','espaco','arquivo']);
  const desistir=permanente.has(motivo)||atual.tentativas>=3;
  const final=motivo==='midia_expirada'?'midia_indisponivel:'+motivo:
    permanente.has(motivo)?'midia_bloqueada:'+motivo:'midia_tentativas_esgotadas:'+motivo;
  return falharEtapaCiclo(db,claim,{agora,motivo:desistir?final:motivo,
    esperaMs:Math.min(3600000,60000*atual.tentativas),desistir});
}

function sha256Arquivo(caminho,tamanho,esperado){
  if(typeof caminho!=='string'||!caminho||typeof esperado!=='string'||!/^[a-f0-9]{64}$/i.test(esperado))return false;
  let fd;
  try{
    const antes=lstatSync(caminho);
    if(!antes.isFile()||antes.isSymbolicLink()||antes.size!==tamanho)return false;
    fd=openSync(caminho,'r');
    const aberto=fstatSync(fd);
    if(!aberto.isFile()||aberto.size!==tamanho||aberto.dev!==antes.dev||aberto.ino!==antes.ino)return false;
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
    let lidos=0;
    while(lidos<tamanho){
      const n=readSync(fd,buffer,0,Math.min(buffer.length,tamanho-lidos),lidos);
      if(!n)return false;
      hash.update(buffer.subarray(0,n));lidos+=n;
    }
    const depois=fstatSync(fd);
    return lidos===tamanho&&depois.size===tamanho&&depois.mtimeMs===aberto.mtimeMs&&
      depois.ctimeMs===aberto.ctimeMs&&hash.digest('hex')===esperado.toLowerCase();
  }catch{return false}finally{if(fd!==undefined)try{closeSync(fd)}catch{}}
}

export function coberturaMidiaCiclo(db,{conversaId,limiteHashBytes=LIMITE_HASH_PADRAO}={}){
  if(!Number.isSafeInteger(limiteHashBytes)||limiteHashBytes<0)throw new TypeError('Limite de integridade invalido');
  if(conversaId!==undefined&&(typeof conversaId!=='string'||!conversaId||conversaId.length>1000))
    throw new TypeError('Conversa inválida');
  const filtroLeitura=conversaId===undefined?'':` AND ${LEITURA_PESSOAL_SQL}`;
  const temArquivo=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ciclo_midias'").get());
  const rows=db.prepare(`SELECT e.conversa_id,e.origem_id,e.permissao,s.estado,s.ultimo_erro,
      ${temArquivo?'m.caminho,m.sha256,m.tamanho':'NULL caminho,NULL sha256,NULL tamanho'} FROM eventos e
    LEFT JOIN etapas s ON s.evento_id=e.id AND s.etapa='midia'
    ${temArquivo?'LEFT JOIN ciclo_midias m ON m.evento_id=e.id':''}
    WHERE e.tipo IN ('audio','imagem','video','documento','figurinha')${filtroLeitura}
      AND (? IS NULL OR e.conversa_id=?)`)
    .iterate(conversaId??null,conversaId??null);
  const excluidos=new Set(db.prepare('SELECT hash FROM priv_excluidos').all().map(r=>r.hash));
  const conversasExcluidas=new Set(db.prepare('SELECT hash FROM priv_conversas_excluidas').all().map(r=>r.hash));
  const result={recebidas:0,baixadas:0,pendentes:0,emCurso:0,falhas:0,indisponiveis:0,esgotadas:0,bloqueadas:0,excluidas:0,desconhecidas:0};
  let hashBytes=0;
  for(const row of rows){
    if(row.permissao==='compartilhado'||excluidos.has(chaveExclusao(row.conversa_id,row.origem_id))||
       conversasExcluidas.has(chaveConversa(row.conversa_id))){
      if(conversaId===undefined)result.excluidas++;
      continue;
    }
    result.recebidas++;
    // A conclusão sem arquivo gerido presente não comprova download.
    let presente=false;
    if(row.estado==='concluida'&&row.caminho)try{
      const file=lstatSync(row.caminho),tamanho=Number(row.tamanho);
      if(file.isFile()&&file.size===tamanho&&Number.isSafeInteger(tamanho)&&tamanho>=0&&hashBytes+tamanho<=limiteHashBytes){
        presente=sha256Arquivo(row.caminho,tamanho,row.sha256);
        hashBytes+=tamanho;
        const depois=lstatSync(row.caminho);
        if(!depois.isFile()||depois.isSymbolicLink()||depois.size!==tamanho||
          depois.dev!==file.dev||depois.ino!==file.ino||depois.mtimeMs!==file.mtimeMs||depois.ctimeMs!==file.ctimeMs)presente=false;
      }
    }catch{}
    if(presente)result.baixadas++;
    else if(row.estado==='pendente')result.pendentes++;
    else if(row.estado==='em_curso')result.emCurso++;
    else if(row.estado==='falha')result.falhas++;
    else if(row.estado==='desistida'&&row.ultimo_erro?.startsWith('midia_indisponivel:'))result.indisponiveis++;
    else if(row.estado==='desistida'&&row.ultimo_erro?.startsWith('midia_tentativas_esgotadas:'))result.esgotadas++;
    else if(row.estado==='desistida'&&row.ultimo_erro?.startsWith('midia_bloqueada:'))result.bloqueadas++;
    else result.desconhecidas++;
  }
  return result;
}
