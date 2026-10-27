// Predicados compartilhados por recuperação, exportação e direitos de dados.
// Importar uma fonte autoriza aquela contribuição, nunca o grupo inteiro.
// Mantido aqui porque este arquivo também integra o MCPB de leitura, cujo
// pacote tem lista fechada de módulos e não transporta o serviço notetaker.
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
export const NOTETAKER_COLUNAS=Object.freeze({
  notetaker_sessoes:['id','estado','origem','entradas','consentimento_em','direitos_revogados_em','inicio_em','fim_em','revisao','excluida_em','importacao_estado','importacao_sha256','importacao_bytes','asr_estado'],
  notetaker_partes:['id','sessao_id','entrada','posicao','inicio_ms','duracao_ms','sha256','caminho','estado'],
  notetaker_trechos:['id','parte_id','ordinal','inicio_ms','fim_ms','texto_gerado','texto_corrigido','ator_correcao','revisao'],
  notetaker_fontes:['evento_id','trecho_id','sessao_id','parte_id','inicio_ms','fim_ms','audio_sha256','revisao'],
  notetaker_correcoes:['id','trecho_id','revisao','texto_anterior','texto_novo','ator','corrigido_em']
});
export const COMPARTILHADO_SQL = `EXISTS(SELECT 1 FROM f10_procedencias f WHERE f.evento_id=e.id)`;
export const PROJETO_SQL = `(e.projeto_id=? OR EXISTS(SELECT 1 FROM f10_conversas fc WHERE fc.projeto_id=? AND fc.conversa_id=e.conversa_id AND e.permissao<>'compartilhado') OR EXISTS(SELECT 1 FROM f10_procedencias fp WHERE fp.evento_id=e.id AND fp.projeto_id=?))`;
const LEITURA_BASE_SQL = `(e.tipo <> 'notetaker_trecho' AND e.permissao IS NOT NULL
  AND (e.permissao<>'compartilhado' OR ${COMPARTILHADO_SQL})
  AND (e.permissao IN ('minha','dirigida') OR ${COMPARTILHADO_SQL} OR EXISTS
    (SELECT 1 FROM politicas_conversa p WHERE p.conversa_id=e.conversa_id AND p.politica='tudo')))`;
// Escopo de leitura no proprio perfil: mensagens locais disponiveis, inclusive
// terceiros em grupos, e contribuicoes importadas somente pela fonte exata.
// Nao deve ser reutilizado para envio, exportacao ou grants de executores.
const LEITURA_PESSOAL_BASE_SQL = `(e.tipo <> 'notetaker_trecho' AND e.permissao IS NOT NULL AND (
  (e.permissao IN ('minha','dirigida','terceiro') AND e.origem_compartilhamento IS NULL AND NOT ${COMPARTILHADO_SQL})
  OR ${COMPARTILHADO_SQL}))`;
// Uma nota pode depender de outra nota. Cada ancestral precisa continuar legivel
// no mesmo escopo; UNION evita ciclos. Trechos do notetaker têm gate próprio.
const ancestraisLegiveis=base=>`NOT EXISTS(
  WITH RECURSIVE ancestrais(id) AS (
    SELECT v.fonte_id FROM priv_vinculos v WHERE v.derivado_id=e.id
    UNION
    SELECT v.fonte_id FROM priv_vinculos v JOIN ancestrais a ON v.derivado_id=a.id
  )
  SELECT 1 FROM ancestrais a LEFT JOIN eventos origem ON origem.id=a.id
  WHERE origem.id IS NULL OR origem.permissao IS NULL OR
    (origem.tipo<>'notetaker_trecho' AND NOT COALESCE(${base.replace(/\be\./gu,'origem.')},0)))`;
export const DERIVADOS_SEM_REVOGACAO_SQL=ancestraisLegiveis(LEITURA_BASE_SQL);
const DERIVADOS_PESSOAIS_SQL=ancestraisLegiveis(LEITURA_PESSOAL_BASE_SQL);
export const LEITURA_SQL=`(${LEITURA_BASE_SQL} AND ${DERIVADOS_SEM_REVOGACAO_SQL})`;
export const LEITURA_PESSOAL_SQL=`(${LEITURA_PESSOAL_BASE_SQL} AND ${DERIVADOS_PESSOAIS_SQL})`;

export function raizAudioNotetaker(db){
  try{
    const declarado=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
    if(!declarado||lstatSync(declarado).isSymbolicLink()||!lstatSync(declarado).isFile())return null;
    const real=realpathSync(declarado);
    if(real!==resolve(declarado))return null;
    const audio=join(dirname(real),'notetaker-audio');
    if(!lstatSync(audio).isDirectory()||lstatSync(audio).isSymbolicLink()||realpathSync(audio)!==resolve(audio))return null;
    return audio;
  }catch{return null;}
}

// Somente leitura: o nome vem do UUID da parte; caminho persistido é comparado,
// nunca usado para abrir um arquivo arbitrário. Cache vale apenas nesta consulta.
export function fonteLocalIntegra(db,row,cache=new Map()){
  if(row?.tipo!=='notetaker_trecho')return true;
  try{
    const audioRoot=raizAudioNotetaker(db);if(!audioRoot)return false;
    const p=db.prepare(`SELECT p.id,p.caminho,p.sha256,p.estado,f.audio_sha256,s.asr_estado
      FROM notetaker_fontes f JOIN notetaker_partes p ON p.id=f.parte_id
      JOIN notetaker_sessoes s ON s.id=f.sessao_id WHERE f.evento_id=?`).get(row.id);
    if(!p||p.estado!=='salva'||p.asr_estado!=='concluida'||p.caminho!==p.id+'.wav'||p.sha256!==p.audio_sha256)return false;
    if(cache.has(p.id))return cache.get(p.id)===p.sha256;
    const path=join(audioRoot,p.id+'.wav'),stat=lstatSync(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>60*32000+44)return false;
    const atual=createHash('sha256').update(readFileSync(path)).digest('hex');
    cache.set(p.id,atual);return atual===p.sha256;
  }catch{return false;}
}

export function leituraFonteSql(db){
  const fks={notetaker_sessoes:[],notetaker_partes:['notetaker_sessoes'],notetaker_trechos:['notetaker_partes'],notetaker_fontes:['eventos','notetaker_trechos','notetaker_sessoes','notetaker_partes'],notetaker_correcoes:['notetaker_trechos']};
  try{
    for(const [tabela,colunas] of Object.entries(NOTETAKER_COLUNAS)){
      const atuais=new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map(c=>c.name));
      if(colunas.some(c=>!atuais.has(c)))return LEITURA_SQL;
      const referencias=db.prepare(`PRAGMA foreign_key_list(${tabela})`).all().map(c=>c.table);
      if(fks[tabela].some(t=>!referencias.includes(t)))return LEITURA_SQL;
    }
  }catch{return LEITURA_SQL;}
  if(!raizAudioNotetaker(db))return LEITURA_SQL;
  return `(${LEITURA_SQL} OR (e.tipo='notetaker_trecho' AND e.permissao='notetaker_local' AND EXISTS (
    SELECT 1 FROM notetaker_fontes nf JOIN notetaker_trechos nt ON nt.id=nf.trecho_id
    JOIN notetaker_partes np ON np.id=nf.parte_id AND np.id=nt.parte_id
    JOIN notetaker_sessoes ns ON ns.id=nf.sessao_id AND ns.id=np.sessao_id
    WHERE nf.evento_id=e.id AND ns.consentimento_em IS NOT NULL
      AND ns.direitos_revogados_em IS NULL AND ns.excluida_em IS NULL AND ns.estado<>'excluida'
      AND ns.asr_estado='concluida' AND np.estado='salva' AND nf.audio_sha256=np.sha256)))`;
}
