const RE=/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

export function parseReleaseVersion(value){
 const match=RE.exec(String(value||''));
 if(!match)throw Error('Versão de release inválida.');
 return{raw:match[0],major:Number(match[1]),minor:Number(match[2]),patch:Number(match[3]),beta:match[4]===undefined?null:Number(match[4])};
}

export function compareReleaseVersions(left,right){
 const a=parseReleaseVersion(left),b=parseReleaseVersion(right);
 for(const key of ['major','minor','patch'])if(a[key]!==b[key])return a[key]>b[key]?1:-1;
 if(a.beta===b.beta)return 0;
 if(a.beta===null)return 1;
 if(b.beta===null)return-1;
 return a.beta>b.beta?1:-1;
}

export function manifestVersion(text){
 const match=/^version:\s*["']?([^\s"']+)["']?\s*$/m.exec(String(text||''));
 return match?parseReleaseVersion(match[1]).raw:null;
}
