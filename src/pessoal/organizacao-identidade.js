/** Conservative eligibility rule; not a general semantic classifier. */
export const VERSAO_IDENTIDADE='identidade-interrogativa-1';
const normal=s=>s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();

function duvidaIdentidade(frase){
  const s=normal(frase).trim();
  const pergunta=/\?/.test(s)||/\b(?:ne|neh|certo|correto|nao e)\s*[.!?]*$/.test(s);
  if(!pergunta)return false;
  // Operational choices and status questions do not assert a different identity.
  if(/^(?:qual\s+(?:e\s+)?)?(?:o|a)?\s*(?:prazo|data|valor|preco|custo|orcamento|status|andamento|horario)\b/.test(s))return false;
  const identificar=/\b(?:qual|quem)\s+(?:e\s+)?(?:o|a|esse|essa)?\s*(?:projeto|cliente|trabalho|responsavel)\b/.test(s);
  const alternativas=/\bou\b/.test(s);
  // Direct alternatives without articles are covered for named identities.
  // Keep the accented copula and noun shape: "cliente e a equipe podem..."
  // and "trabalho é revisar..." describe actions, not competing identities.
  const direta=frase.trim().match(/^(?:o\s+|a\s+)?(?:projeto|cliente|trabalho|responsável)\s+(?:é|eh|era|seria|são|seriam)\s+(.+?)[.!?]*$/iu);
  const nomes=direta?.[1].split(/\s+ou\s+/iu);
  const identidadeDireta=alternativas&&nomes?.length===2&&nomes.every(n=>/^\p{Lu}[\p{L}\d_-]*(?:\s+\p{Lu}[\p{L}\d_-]*){0,3}$/u.test(n));
  // An unaccented "e" can be a conjunction. Require an ownership subject and
  // identity alternatives before treating it as the copula in informal text.
  const identidadeInformal=alternativas&&/\b[oa]\s+d[ao]s?\s+(?:[\p{L}\d_-]+\s+){1,5}e\s+(?:[oa]s?|d[ao]s?|de|um|uma|esse|essa)\b/u.test(s);
  const relacao=/(?:^|[\s,(])(?:é|eh|era|seria|são|seriam)\s+(?:[oa]s?|d[ao]s?|de|um|uma|esse|essa)\b/iu.test(frase)||/\b(?:esse|essa|isso)\s+e\s+(?:o|a|de|do|da)\b/.test(s);
  const identidade=/\b(?:projeto|cliente|trabalho|pessoa|esse|essa|isso|d[ao]s?|de)\b/.test(s);
  return identificar||identidadeDireta||identidadeInformal||relacao&&identidade;
}

/** Sentence offsets always refer to the complete source, never the model quote. */
export function restricoesIdentidade(texto){
  if(typeof texto!=='string')return [];
  const ranges=[];let inicio=0;
  for(const match of texto.matchAll(/[.!?]+(?=\s|$)/g)){
    const fim=match.index+match[0].length,frase=texto.slice(inicio,fim);
    if(duvidaIdentidade(frase))ranges.push({inicio,tamanho:fim-inicio,motivo:'identidade_interrogativa'});
    inicio=fim;
  }
  if(inicio<texto.length&&duvidaIdentidade(texto.slice(inicio)))ranges.push({inicio,tamanho:texto.length-inicio,motivo:'identidade_interrogativa'});
  return ranges;
}

export function evidenciaIdentidadeAfirmativa(texto,inicio,tamanho){
  if(typeof texto!=='string'||!Number.isInteger(inicio)||!Number.isInteger(tamanho)||inicio<0||tamanho<1||inicio+tamanho>texto.length)return {elegivel:false,motivo:'intervalo_invalido'};
  const blocked=restricoesIdentidade(texto).some(r=>inicio<r.inicio+r.tamanho&&r.inicio<inicio+tamanho);
  return {elegivel:!blocked,motivo:blocked?'identidade_interrogativa':null};
}
