const words=text=>text.normalize('NFD').replace(/[\u0300-\u036f]/gu,'').toLocaleLowerCase('pt-BR').match(/[a-z0-9]+/gu)||[];
export function overlap(a,b){
  const left=words(a),right=words(b),used=new Set();let shared=0;
  for(const word of left){const index=right.findIndex((value,i)=>value===word&&!used.has(i));if(index>=0){used.add(index);shared++;}}
  return Math.min(shared/Math.max(1,left.length),shared/Math.max(1,right.length));
}
export function scoreActions(expected,actual){
  const used=new Set(),hits=[];
  for(const gold of expected){
    let best=-1,bestScore=0;
    for(let i=0;i<actual.length;i++){
      if(used.has(i)||actual[i].tipo!==gold.tipo)continue;
      const value=overlap(gold.trecho,actual[i].trecho);
      if(value>bestScore){best=i;bestScore=value;}
    }
    if(best>=0&&bestScore>=0.5){used.add(best);hits.push({expected:gold,actual:actual[best]});}
  }
  return{tp:hits.length,fp:actual.length-used.size,fn:expected.length-hits.length,hits};
}
