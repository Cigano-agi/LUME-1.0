// Independent temporary fixtures. No personal profile, pairing or paid inference.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';

const tests=['settings-groups','conversas','contatos','negocios','dados','grafo','lembretes','atualizacoes','mcp-ui','central-ui','novidades-ui','desktop-ia','transcricao','compartilhamento','tarefas','comandos-ui'];
const selected=process.argv.slice(2);
if(selected.some(name=>!tests.includes(name)))throw Error('Unknown regression fixture.');
const queue=[...(selected.length?selected:tests)],results=[],out=resolve('work/beta06-regression');mkdirSync(out,{recursive:true});
async function worker(){
  while(queue.length){
    const name=queue.shift(),started=performance.now();console.log('START '+name);
    const result=await new Promise(resolveResult=>{
      const env={...process.env,ASSESSOR_E2E_EMBEDDINGS:'0',ASSESSOR_E2E_LONG_CONTEXT:'0',ASSESSOR_E2E_AUDIO:'0'};
      const child=spawn(process.execPath,['test/'+name+'.e2e.mjs'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let log='',timedOut=false;for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log=(log+bytes.toString()).slice(-100000);});
      const timer=setTimeout(()=>{timedOut=true;child.kill();},180000);
      child.once('error',error=>{log+=error.message;});
      child.once('close',code=>{clearTimeout(timer);writeFileSync(join(out,name+'.log'),log);resolveResult({name,code,timedOut,durationMs:Math.round(performance.now()-started)});});
    });
    results.push(result);console.log(JSON.stringify(result));
  }
}
await Promise.all([worker(),worker()]);
const evidence={date:new Date().toISOString(),synthetic:true,results,passed:results.filter(r=>r.code===0&&!r.timedOut).length};
writeFileSync(join(out,selected.length?'evidence-'+selected.join('-')+'.json':'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
if(evidence.passed!==results.length)process.exitCode=1;
