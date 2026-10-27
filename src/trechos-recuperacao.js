// Query units and literal windows. Never rewrite source text or insert ellipses.
const STOP = new Set('a o as os de da do das dos em no na nos nas um uma e ou que qual quais como para por com foi esta este esse essa isso hoje ontem semana meu minha mim eu ficou ficaram combinado'.split(' '));
const normalizar = s => s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();

export function unidadesConsulta(pergunta) {
  const numbers=[];
  // Portuguese thousands separators: 1200, 1.200 and 1 200 are the same amount.
  // The alternatives remain whole FTS tokens/phrases, never prefix matches.
  const rest=normalizar(pergunta).replace(/(?<![\p{L}\p{N}])(?:[1-9]\d{0,2}(?:[. ]\d{3})+|[1-9]\d{3,})(?![\p{L}\p{N}])/gu, value=>{
    numbers.push(value.replace(/[. ]/g,''));return ' ';
  });
  const words=[...new Set([...numbers,...(rest.match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>w.length>1&&!STOP.has(w))])].slice(0,24);
  return words.flatMap(word=>{
    const units=[{chave:word,tokens:[word]}];
    if(numbers.includes(word))units.push({chave:word,tokens:word.replace(/\B(?=(\d{3})+(?!\d))/g,' ').split(' ')});
    return units;
  });
}

export function trechoRelevante(texto, units, limite=1800) {
  if(texto.length<=limite)return null;
  const tokens=[...texto.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map(m=>({word:normalizar(m[0]),start:m.index,end:m.index+m[0].length}));
  const heads=new Map();
  for(const u of units){if(!heads.has(u.tokens[0]))heads.set(u.tokens[0],[]);heads.get(u.tokens[0]).push(u);}
  const hits=[];
  for(let i=0;i<tokens.length;i++) for(const u of heads.get(tokens[i].word)||[]) {
    if(u.tokens.every((w,j)=>tokens[i+j]?.word===w))hits.push({start:tokens[i].start,key:u.chave});
  }
  // A late passage may be shorter than the budget; don't pad it with old filler.
  const starts=[...new Set([0,...hits.map(h=>Math.max(0,h.start-240))])].sort((a,b)=>a-b);
  let left=0,right=0,best=0,bestScore=-1;
  const counts=new Map();
  // Sliding window: repeated filler cannot outweigh distinct query concepts.
  for(const start of starts){
    while(right<hits.length && hits[right].start<start+limite){const k=hits[right++].key;counts.set(k,(counts.get(k)||0)+1);}
    while(left<right && hits[left].start<start){const k=hits[left++].key,n=counts.get(k)-1;if(n)counts.set(k,n);else counts.delete(k);}
    // Later equal windows retain continuation after late matches (e.g. "foi
    // retirada"). This is a snippet tie-break, not a claim of newer truth.
    if(counts.size>=bestScore){bestScore=counts.size;best=start;}
  }
  let inicio=best,fim=Math.min(texto.length,best+limite);
  // Keep exact original offsets (including decomposed accents and emoji).
  // Prefer whole-word boundaries when they are within 80 characters.
  if(inicio>0 && /\S/u.test(texto[inicio-1]) && /\S/u.test(texto[inicio])) {
    const boundary=texto.slice(inicio,inicio+80).search(/\s/u);if(boundary>=0)inicio+=boundary+1;
  }
  if(fim<texto.length && /\S/u.test(texto[fim-1]) && /\S/u.test(texto[fim])) {
    const chunk=texto.slice(Math.max(inicio,fim-80),fim), boundary=chunk.search(/\s\S*$/u);
    if(boundary>=0)fim-=chunk.length-boundary;
  }
  if(/[\uDC00-\uDFFF]/u.test(texto[inicio]||''))inicio++;
  if(/[\uD800-\uDBFF]/u.test(texto[fim-1]||''))fim--;
  return {inicio,trecho:texto.slice(inicio,fim)};
}
