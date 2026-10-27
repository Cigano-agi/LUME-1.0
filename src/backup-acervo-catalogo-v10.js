import {createHash} from 'node:crypto';
import {CATALOGO_V9} from './backup-acervo-catalogo.js';

// v10 adiciona a fila ao catálogo imutável v9. O catálogo e o hash v9 ficam
// intactos para que pacotes antigos continuem verificáveis.
const ETAPAS=Object.freeze({
  decisao:'I',nome:'etapas',
  colunas:Object.freeze('evento_id,etapa,estado,tentativas,ultimo_erro,resultado,atualizado_em,proxima_tentativa_em,lease_token,lease_ate,fonte_assinatura'.split(',')),
  pk:Object.freeze(['evento_id','etapa'])
});
export const CATALOGO_V10_LEGADO=Object.freeze(CATALOGO_V9.map(t=>t.nome==='etapas'?ETAPAS:t));
const MIDIAS=Object.freeze({
  decisao:'I',nome:'ciclo_midias',
  colunas:Object.freeze('evento_id,caminho,sha256,mime,tamanho,criado_em'.split(',')),
  pk:Object.freeze(['evento_id'])
});
export const CATALOGO_V10_MIDIAS=Object.freeze([...CATALOGO_V10_LEGADO,MIDIAS]);
const FILA_RETOMADA=Object.freeze({
  decisao:'I',nome:'wa_fila_retomada',
  colunas:Object.freeze('interrupcao_id,conversa_id,estado,tentativas,proxima_tentativa_em,ultimo_erro,criado_em,atualizado_em'.split(',')),
  pk:Object.freeze(['interrupcao_id','conversa_id'])
});
export const CATALOGO_V10=Object.freeze([...CATALOGO_V10_MIDIAS,FILA_RETOMADA]);
export const TABELAS_I_V10=Object.freeze(CATALOGO_V10.filter(t=>t.decisao==='I'));
export const TABELAS_I_V10_MIDIAS=Object.freeze(CATALOGO_V10_MIDIAS.filter(t=>t.decisao==='I'));
export const TABELAS_I_V10_LEGADO=Object.freeze(CATALOGO_V10_LEGADO.filter(t=>t.decisao==='I'));
export const CATALOGO_SHA256_V10_LEGADO=createHash('sha256').update(JSON.stringify(CATALOGO_V10_LEGADO)).digest('hex');
export const CATALOGO_SHA256_V10_MIDIAS=createHash('sha256').update(JSON.stringify(CATALOGO_V10_MIDIAS)).digest('hex');
export const CATALOGO_SHA256_V10=createHash('sha256').update(JSON.stringify(CATALOGO_V10)).digest('hex');
