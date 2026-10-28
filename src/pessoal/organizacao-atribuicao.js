/** Narrow evidence rule: a person's identity alone does not attribute work. */
export const VERSAO_ATRIBUICAO='evidencia-nominal-1';
const normal=v=>String(v).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\d]+/gu,' ').trim();
const contem=(texto,nome)=>Boolean(normal(nome))&&(' '+normal(texto)+' ').includes(' '+normal(nome)+' ');
const nomeProprio=v=>/^\p{Lu}[\p{L}'’-]*(?:\s+(?:(?:da|de|do|das|dos)\s+)?\p{Lu}[\p{L}'’-]*){0,4}$/u.test(v);
const artefato=v=>/^(?:landing pages?|social media|crm|sites?|catalogos?|relatorios?|criativos?|copys?|paginas?|software|aplicativos?)(?:\s+(?:de|do|da|dos|das)\s+.+)?$/u.test(normal(v));
const neutra=v=>/^(?:(?:muito\s+)?obrigad[oa]|valeu|beleza|ok|certo|perfeito|sim|entendi|joia|opa|show)$/u.test(normal(v));
const atividade=v=>/^(?:criar|revisar|preparar|construir|desenvolver|enviar|mandar|entregar|fazer|produzir)\b/u.test(normal(v));

export function sentencasDoIntervalo({texto,inicio,tamanho}={}){
  if(typeof texto!=='string'||!Number.isInteger(inicio)||!Number.isInteger(tamanho)||inicio<0||tamanho<1||inicio+tamanho>texto.length)return [];
  const spans=[];let start=0;
  for(const m of texto.matchAll(/[.!?]+(?=\s|$)/g)){const end=m.index+m[0].length;spans.push([start,end]);start=end;}
  if(start<texto.length)spans.push([start,texto.length]);
  return spans.filter(([a,b])=>inicio<b&&a<inicio+tamanho).map(([a,b])=>texto.slice(a,b).trim());
}

function identidadeNominal(frase){
  const s=frase.replace(/[.!?]+$/u,'').trim();
  if(neutra(s))return {nominal:true,nomes:[]};
  if(artefato(s))return {nominal:false,nomes:[]};
  if(nomeProprio(s))return {nominal:true,nomes:[s]};
  // Restrict the copular pattern to identification subjects and a proper name
  // predicate. An artifact or an action sentence is not nominal evidence.
  const m=s.match(/^(?:(?:[oa]|esse|essa|este|esta)\s+(?:d[ao]|de)\s+.+?|(?:o\s+)?nome(?:\s+d[ae]l[ae])?|(?:o\s+)?cliente(?:\s+.+?)?|(?:o\s+)?projeto\s+.+?)\s+(?:é|e|eh|era|seria)\s+(?:(?:[oa]|d[ao]|de)\s+)?(.+)$/iu);
  // Explicit identification syntax does not require names to be capitalized.
  const nome=m?.[1];
  return nome&&!artefato(nome)&&!atividade(nome)&&/^[\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,5}$/u.test(nome)?{nominal:true,nomes:[nome]}:{nominal:false,nomes:[]};
}

/** Callers supply only complete, authorized candidates and their source spans. */
export function identidadesUnicasDoProjeto(id,candidatos){
  const grupos=candidatos.map(p=>({id:p.id,nomes:[p.nome,...p.fontes.flatMap(f=>sentencasDoIntervalo(f).flatMap(s=>identidadeNominal(s).nomes))]}));
  const atual=grupos.find(p=>p.id===id);if(!atual)return [];
  return [...new Set(atual.nomes)].filter(nome=>!grupos.some(p=>p.id!==id&&p.nomes.some(outro=>contem(nome,outro)||contem(outro,nome))));
}

export const alvoIdentificado=(alvo,identidades)=>sentencasDoIntervalo(alvo).some(s=>identidades.some(nome=>contem(s,nome)));

export function avaliarAtribuicao({alvo,evidencias,identidadesUnicas=[]}={}){
  const frases=sentencasDoIntervalo(alvo),fontes=Array.isArray(evidencias)?evidencias.map(sentencasDoIntervalo):[];
  if(!frases.length||!fontes.length||fontes.some(f=>!f.length))return {elegivel:false,motivo:'intervalo_invalido'};
  if(fontes.flat().some(s=>!identidadeNominal(s).nominal)||alvoIdentificado(alvo,identidadesUnicas))return {elegivel:true,motivo:null};
  return {elegivel:false,motivo:'evidencia_apenas_nominal'};
}
