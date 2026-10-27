#!/usr/bin/env node
// Static evidence, not an assertion that every path works at runtime.
import {readFile,readdir,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,relative,dirname,join,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
// Reuse the parser already installed with Playwright; no download or new dependency.
const {babelParse}=require(join(dirname(require.resolve('playwright/package.json')),'lib/transform/babelBundle.js'));
const defaultRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const slash=p=>p.replaceAll('\\','/');
const text=n=>n?.value??(n?.type==='Identifier'?n.name:null);
const member=n=>n?.type==='MemberExpression'||n?.type==='OptionalMemberExpression';
const prop=n=>member(n)?text(n.property):null;
function walk(node,visit,ancestors=[]){if(!node||typeof node!=='object')return;if(node.type)visit(node,ancestors);for(const [key,value] of Object.entries(node)){if(['loc','tokens','comments','leadingComments','trailingComments','innerComments','extra'].includes(key))continue;if(Array.isArray(value)){for(const child of value)if(child?.type)walk(child,visit,[...ancestors,node]);}else if(value?.type)walk(value,visit,[...ancestors,node]);}}
async function filesIn(root,folder){let entries;try{entries=await readdir(join(root,folder),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}const out=[];for(const e of entries.sort((a,b)=>a.name.localeCompare(b.name,'en'))){const name=slash(join(folder,e.name));if(e.isDirectory())out.push(...await filesIn(root,name));else if(/\.(?:[cm]?js|html|css)$/.test(name))out.push(name);}return out;}
function literal(node,env={}){
 if(!node)return null;if(['StringLiteral','NumericLiteral'].includes(node.type))return node.value;
 if(node.type==='Identifier')return env[node.name]??null;
 if(node.type==='TemplateLiteral'&&!node.expressions.length)return node.quasis.map(x=>x.value.cooked).join('');
 if(node.type==='BinaryExpression'&&node.operator==='+'){const a=literal(node.left,env),b=literal(node.right,env);return a!==null&&b!==null?String(a)+b:null;}return null;
}
function methodOf(node,ancestors,source){
 const found=[];for(const a of [...ancestors,node]){
  if(a.type==='FunctionDeclaration'&&/pessoal(Get|Post)$/.test(a.id?.name))found.push(a.id.name.endsWith('Get')?'GET':'POST');
  if(a.type==='IfStatement')for(const m of source.slice(a.test.start,a.test.end).matchAll(/req\.method\s*===?\s*['"](GET|POST|PATCH|PUT|DELETE|OPTIONS|HEAD)['"]/g))found.push(m[1]);
 }return [...new Set(found)].join('|')||'UNRESOLVED';
}
export async function collectInventory(root=defaultRoot){
 const files=[...await filesIn(root,'src'),...await filesIn(root,'desktop')].sort();
 const result={schema:1,scope:['src/**/*.{js,mjs,cjs,html,css}','desktop/**/*.{js,mjs,cjs,html,css}'],files:[],routes:[],assets:[],screens:[],dialogs:[],navigation:[],states:[],scripts:[],apiReferences:[],dynamic:[],issues:[]};
 const add=(key,file,line,extra)=>result[key].push({file,line,...extra});
 for(const file of files){
  const source=await readFile(join(root,file),'utf8');result.files.push({file,sha256:createHash('sha256').update(source).digest('hex')});
  const isUI=file.startsWith('src/painel/')||file.startsWith('desktop/');
  const lineAt=index=>source.slice(0,index).split('\n').length;
  if(isUI&&/\.(html|[cm]?js)$/.test(file)&&!file.includes('/vendor/')){
   for(const match of source.matchAll(/<([a-z][\w-]*)\b([^<>]*?)>/gi)){
    const [,tag,attrs]=match,attributes={};for(const a of attrs.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs))attributes[a[1]]=a[3];
    const line=lineAt(match.index),id=attributes.id??null;
    if(tag==='script'&&attributes.src)add('scripts',file,line,{src:attributes.src,type:attributes.type??'classic',loading:/\bdefer\b/.test(attrs)?'defer':'normal'});
    if(tag==='dialog'||attributes.role==='dialog'||attributes.role==='alertdialog')add('dialogs',file,line,{id,kind:'markup',role:attributes.role??tag});
    if(id&&(/\bview\b/.test(attributes.class??'')||['onboarding','workspace'].includes(id)))add('screens',file,line,{id,kind:'markup',hidden:/\bhidden\b/.test(attrs)});
    for(const [key,value] of Object.entries(attributes)){
     if(/^data-(view|memory-mode|settings-group|settings-group-panel|settings-back|grupo|tab|mode|route)$/.test(key))add('navigation',file,line,{kind:'attribute',id,key,value});
     if(/^(aria-busy|aria-live|aria-expanded|aria-selected|aria-pressed|data-state)$/.test(key)||key==='role'&&['status','alert','progressbar'].includes(value))add('states',file,line,{kind:'attribute',id,key,value});
    }
   }
  }
  if(!/\.[cm]?js$/.test(file)||file.includes('/vendor/'))continue;
  let ast;try{ast=babelParse(source,file);}catch(e){result.issues.push({file,kind:'parse',message:e.message.split('\n')[0]});continue;}
  const env={},prefixes={};walk(ast,n=>{if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'){const value=literal(n.init,env);if(value!==null)env[n.id.name]=value;
   if(n.init?.type==='CallExpression'&&prop(n.init.callee)==='slice'&&prop(n.init.callee.object)==='pathname'){
    const arg=n.init.arguments[0];if(prop(arg)==='length'){const prefix=literal(arg.object,env);if(typeof prefix==='string')prefixes[n.id.name]=prefix;}
   }
  }});
  const code=n=>source.slice(n.start,n.end).replace(/\s+/g,' ').slice(0,350);
  const routeFile=/(?:servidor|http)\.[cm]?js$/.test(file)||source.includes('req.method')&&source.includes('pathname');
  walk(ast,(n,anc)=>{
   const line=n.loc?.start.line??1,parent=anc.at(-1);
   if(routeFile){
    if(n.type==='VariableDeclarator'&&n.id.name==='assets'&&n.init?.type==='ObjectExpression')for(const p of n.init.properties){if(p.type==='ObjectProperty')add('assets',file,line,{path:text(p.key),target:literal(p.value.elements?.[0],env)});}
    if(n.type==='AssignmentExpression'&&member(n.left)&&n.left.object.name==='assets'){
     const loop=[...anc].reverse().find(a=>a.type==='ForOfStatement');
     const vals=loop?.right?.type==='ArrayExpression'?loop.right.elements.map(x=>literal(x,env)):[];
     const name=loop?.left?.declarations?.[0]?.id?.name;
     for(const value of vals.length?vals:[null]){const vars=name?{...env,[name]:value}:env,path=literal(n.left.property,vars),target=literal(n.right.elements?.[0],vars);if(path&&target)add('assets',file,line,{path,target});else add('dynamic',file,line,{kind:'asset',expression:code(n)});}
    }
    if(n.type==='IfStatement'){
     const method=methodOf(n,anc,source),expr=code(n.test),paths=[];
     walk(n.test,(part)=>{
      if(part.type==='BinaryExpression'&&['===','=='].includes(part.operator)){
       const l=code(part.left),r=literal(part.right,env);
       if(/(?:pathname|^path$|^caminho$|^acao$)/.test(l)&&typeof r==='string'&&(r.startsWith('/')||r===''&&prefixes[l]))paths.push({path:(prefixes[l]??(l==='caminho'?env.PREFIX??'':''))+r,kind:'exact'});
      }
      if(part.type==='CallExpression'&&member(part.callee)){
       if(prop(part.callee)==='startsWith'&&/pathname|^path$/.test(code(part.callee.object))){const p=literal(part.arguments[0],env);if(p)paths.push({path:p,kind:'prefix-dispatch'});}
       if(prop(part.callee)==='includes'&&part.callee.object.type==='ArrayExpression'&&part.arguments.some(a=>/pathname/.test(code(a))))for(const p of part.callee.object.elements){const value=literal(p,env);if(typeof value==='string'&&value.startsWith('/'))paths.push({path:value,kind:'set'});}
      }
     });
     // Guard lists (host/CSP/ACL) are references, not registered handlers.
     const body=code(n.consequent),handler=/\b(?:json|res\.end|readFile|registrarRotas|return)\b/.test(body)&&!/setHeader\('Content-Security/.test(body);
     for(const p of paths){if(method!=='UNRESOLVED'&&handler)add('routes',file,line,{method,...p,condition:expr});else add('apiReferences',file,line,{path:p.path,kind:'guard-or-dispatch',expression:expr});}
    }
    if(n.type==='RegExpLiteral'&&parent?.type==='CallExpression'&&prop(parent.callee)==='match')add('dynamic',file,line,{kind:'route-pattern',prefix:env.PREFIX??null,expression:code(parent),pattern:n.pattern,method:'Context dependent; see branch'});
   }
   if(n.type==='StringLiteral'&&n.value.startsWith('/api/'))add('apiReferences',file,line,{path:n.value,kind:routeFile?'server-literal':'reference'});
   if(!isUI)return;
   if(n.type==='CallExpression'||n.type==='OptionalCallExpression'){
    const fn=member(n.callee)?prop(n.callee):text(n.callee),value=literal(n.arguments?.[0],env);
    if(['show','lumeSetMemoryMode','abrirAjuste','abrirGrupoAjustes','mostrarEscolhasAjustes','openConversation','abrirFonteTarefa'].includes(fn))add('navigation',file,line,{kind:'call',function:fn,target:value??code(n.arguments[0]??n),dynamic:value===null});
    if(['createElement','element'].includes(fn)&&value==='dialog')add('dialogs',file,line,{kind:'created',binding:parent?.type==='VariableDeclarator'?text(parent.id):parent?.type==='AssignmentExpression'?code(parent.left):null,expression:code(n)});
    if(['showModal','close'].includes(fn)&&/dialog/i.test(code(n.callee)))add('dialogs',file,line,{kind:fn,expression:code(n)});
    if(fn==='setAttribute'&&typeof value==='string'&&/^(aria-|role$|data-state$)/.test(value))add('states',file,line,{kind:'setAttribute',key:value,value:literal(n.arguments[1],env)??code(n.arguments[1]??n),expression:code(n)});
    if(fn==='import'&&typeof value==='string')add('scripts',file,line,{src:value,type:'dynamic-import',loading:'dynamic'});
   }
   if(n.type==='ImportDeclaration')add('scripts',file,line,{src:n.source.value,type:'module-import',loading:'module'});
   if(n.type==='AssignmentExpression'&&prop(n.left)==='className'&&typeof literal(n.right,env)==='string'&&/\bview\b/.test(literal(n.right,env)))add('screens',file,line,{id:null,kind:'dynamic-class',binding:code(n.left.object),expression:code(n)});
   if(n.type==='AssignmentExpression'&&member(n.left)&&(['hidden','disabled','state','estado','mode','view'].includes(prop(n.left))))add('states',file,line,{kind:'assignment',key:code(n.left),value:literal(n.right,env)??code(n.right)});
  });
 }
 // Validate discovered scripts/assets against the tree rather than a hand-maintained list.
 const assetMap=new Map(result.assets.map(a=>[a.path,a]));
 for(const asset of result.assets){try{await stat(join(root,'src/painel',asset.target));}catch{result.issues.push({kind:'asset-missing',file:asset.file,path:asset.path,target:asset.target});}}
 for(const script of result.scripts){
  if(/^(https?:|data:)/.test(script.src)||!script.src.startsWith('/')&&!script.src.startsWith('.'))continue;
  const target=script.src.startsWith('/')?assetMap.get(script.src)?.target&&join('src/painel',assetMap.get(script.src).target):join(dirname(script.file),script.src);
  if(!target){result.issues.push({kind:'script-unserved',...script});continue;}try{await stat(join(root,target));}catch{result.issues.push({kind:'script-missing',...script,target});}
 }
 for(const key of Object.keys(result))if(Array.isArray(result[key])&&key!=='scope')result[key]=[...new Map(result[key].map(x=>[JSON.stringify(x),x])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
 return result;
}
export function renderMarkdown(data){
 const esc=x=>String(x??'—').replaceAll('|','\\|').replaceAll('\n',' ');
 const counts=Object.entries(data).filter(([,v])=>Array.isArray(v)).map(([k,v])=>`| ${k} | ${v.length} |`).join('\n');
 const table=(rows,columns)=>`| ${columns.join(' | ')} |\n| ${columns.map(()=> '---').join(' | ')} |\n`+rows.map(r=>`| ${columns.map(k=>esc(r[k])).join(' | ')} |`).join('\n');
 const screens=data.screens.map(r=>({id:r.id,arquivo:`${r.file}:${r.line}`,hidden:r.hidden}));
 const dialogs=data.dialogs.filter(r=>['markup','created'].includes(r.kind)).map(r=>({dialog:r.id??r.binding??r.expression,arquivo:`${r.file}:${r.line}`}));
 const routes=data.routes.filter(r=>r.kind!=='prefix-dispatch').map(r=>({método:r.method,rota:r.path,arquivo:`${r.file}:${r.line}`}));
 return `# Inventário automatizado da experiência Lume\n\nGerado por \`node scripts/inventario-experiencia.mjs\`. Verificação sem escrita: \`node scripts/inventario-experiencia.mjs --check\`. [Dados completos](INVENTARIO.json).\n\nA lista nasce do código atual; não há contagens, rotas ou nomes de telas congelados no verificador. Mudanças exigem regenerar o artefato. O check compara conteúdo e cobertura, verifica parsing e scripts/assets locais; não prova execução nem aceite.\n\n| Categoria | Registros |\n| --- | ---: |\n${counts}\n\n## Telas estáticas\n\n${table(screens,['id','arquivo','hidden'])}\n\n## Diálogos declarados\n\n${table(dialogs,['dialog','arquivo'])}\n\n## Rotas HTTP reconhecidas\n\n${table(routes,['método','rota','arquivo'])}\n\n## Cobertura e limites\n\n- JSON preserva arquivo/linha, condições, navegação declarada e chamadas, estados ARIA/DOM, importações e scripts, assets e hashes dos arquivos lidos. Estados são pontos de código; sua presença não comprova transições nem acessibilidade.\n- AST Babel reaproveitado do Playwright instalado; erros de sintaxe falham o check. Vendor é registrado por hash, sem extrair implementação de terceiros. HTML e templates usam extração de atributos, não renderização completa de DOM.\n- Rotas condicionais e conjuntos são detectados; prefixos, regex e expressões dinâmicas permanecem identificados em dynamic/routes. Guardas e referências de cliente ficam separados de handlers. Notetaker contém regex dependentes de ramo; não são achatadas em URLs fictícias.\n- Importações calculadas, aliases de navegação e construção arbitrária de HTML podem exigir inspeção manual; isto não é prova de cobertura comportamental exaustiva.\n- Baseline privada: \`work/experiencia-lume-20261026/baseline-result.json\`; método, limitações e APIs reais em \`work/experiencia-lume-20261026/inventario-relatorio.md\`.\n`;
}
export async function run(root=defaultRoot,{check=false}={}){
 const data=await collectInventory(root),json=JSON.stringify(data,null,2)+'\n',md=renderMarkdown(data),dir=join(root,'docs/experiencia-lume');
 const failures=[...data.issues];
 if(check){for(const [name,expected] of [['INVENTARIO.json',json],['INVENTARIO.md',md]]){try{if(await readFile(join(dir,name),'utf8')!==expected)failures.push({kind:'stale',file:name,message:'Execute node scripts/inventario-experiencia.mjs para regenerar a partir do código atual.'});}catch(e){failures.push({kind:'missing',file:name,message:e.code});}}}
 else{await mkdir(dir,{recursive:true});await writeFile(join(dir,'INVENTARIO.json'),json);await writeFile(join(dir,'INVENTARIO.md'),md);}
 return {ok:failures.length===0,mode:check?'check':'generate',counts:Object.fromEntries(Object.entries(data).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,v.length])),failures};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const result=await run(defaultRoot,{check:process.argv.includes('--check')});console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}catch(e){console.error(e.message);process.exitCode=1;}}
