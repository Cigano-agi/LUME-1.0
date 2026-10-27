// Bounded deterministic layout. Geometry is not a score of social closeness.
export function layoutGrafo(nos,arestas){
  const hash=s=>{let n=2166136261;for(const c of s)n=Math.imul(n^c.charCodeAt(0),16777619);return n>>>0;};
  const nodes=nos.map(n=>({...n,x:120+hash(n.id)%720,y:90+hash(n.id+'y')%360,vx:0,vy:0}));
  const map=new Map(nodes.map(n=>[n.id,n]));
  const conversations=nodes.filter(n=>n.tipo==='conversa'),columns=Math.ceil(Math.sqrt(conversations.length*1.7));
  conversations.forEach((n,i)=>{n.x=140+(i%columns)*680/Math.max(1,columns-1);n.y=110+Math.floor(i/columns)*300/Math.max(1,Math.ceil(conversations.length/columns)-1);});
  for(const n of nodes.filter(n=>n.tipo==='pessoa')){
    const neighbors=arestas.filter(e=>e.origem===n.id).map(e=>map.get(e.destino)).filter(Boolean);
    if(neighbors.length){const angle=hash(n.id)%628/100;n.x=neighbors.reduce((s,n)=>s+n.x,0)/neighbors.length+Math.cos(angle)*65;n.y=neighbors.reduce((s,n)=>s+n.y,0)/neighbors.length+Math.sin(angle)*65;}
  }
  for(let step=0;step<200;step++){
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
      const a=nodes[i],b=nodes[j],dx=a.x-b.x||0.01,dy=a.y-b.y||0.01,d=Math.max(12,Math.hypot(dx,dy));
      const force=Math.min(12,2500/(d*d));a.vx+=dx/d*force;a.vy+=dy/d*force;b.vx-=dx/d*force;b.vy-=dy/d*force;
    }
    for(const e of arestas){const a=map.get(e.origem),b=map.get(e.destino);if(!a||!b)continue;
      const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-85)*0.035;
      a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f;
    }
    for(const n of nodes){n.vx=(n.vx+(480-n.x)*0.0008)*0.65;n.vy=(n.vy+(260-n.y)*0.0008)*0.65;
      n.x=Math.max(80,Math.min(880,n.x+n.vx));n.y=Math.max(50,Math.min(465,n.y+n.vy));}
  }
  // Fit sparse connected components to the same usable canvas as dense maps.
  const xs=nodes.map(n=>n.x),ys=nodes.map(n=>n.y),xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  return new Map(nodes.map(n=>[n.id,{x:xmax-xmin>1?80+800*(n.x-xmin)/(xmax-xmin):480,y:ymax-ymin>1?50+415*(n.y-ymin)/(ymax-ymin):260}]));
}
