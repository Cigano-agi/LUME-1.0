import {chromium} from 'playwright';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const base=fileURLToPath(new URL('./',import.meta.url)),root=path.resolve(base,'../..');
const proof=path.join(base,'provas');await mkdir(proof,{recursive:true});
const browser=await chromium.launch({channel:process.env.LUME_MARKETING_BROWSER_CHANNEL||'msedge',headless:true});
const results=[];
try{
  for(const [label,width,height] of [['desktop',1280,1000],['mobile',390,844]]){
    const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,reducedMotion:'reduce'}),page=await context.newPage();
    const errors=[],external=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!/^(file|data):/.test(request.url()))external.push(request.url());});
    await page.goto(pathToFileURL(path.join(base,'preview.html')).href);await page.evaluate(()=>document.fonts.ready);
    const state=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,images:[...document.images].map(i=>({loaded:i.complete&&i.naturalWidth>0,alt:i.alt})),notice:document.querySelector('.notice').textContent}));
    assert(state.scroll<=state.width);assert(state.images.every(i=>i.loaded&&i.alt));assert.match(state.notice,/Material editorial/);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await page.screenshot({path:path.join(proof,`apresentacao-${label}.png`),fullPage:true});results.push({label,...state,externalRequests:0,pageErrors:0});await context.close();
  }
  for(const [name,width,height] of [['lume-banner',1280,520],['lume-percurso',1280,360],['lume-expressoes',1280,470]]){
    const page=await browser.newPage({viewport:{width,height}});await page.goto(pathToFileURL(path.join(base,name+'.svg')).href);
    assert.equal(await page.locator('parsererror').count(),0);assert(await page.locator('title').first().textContent());assert(await page.locator('desc').textContent());
    await page.screenshot({path:path.join(proof,name+'.png')});await page.close();
  }
  const docs=['README.md','CONTRIBUTING.md','docs/README.md','docs/marketing/README.md','docs/lume-soft/README.md','docs/lume-soft/ATIVIDADE.md'];let localLinks=0;
  for(const name of docs){const file=path.join(root,name),text=await readFile(file,'utf8');
    const targets=[...text.matchAll(/\[[^\]]*\]\(([^)]+)\)|\bsrc="([^"]+)"/g)].map(m=>m[1]||m[2]);
    for(const target of targets){if(/^(https?:|#)/.test(target))continue;await access(path.resolve(path.dirname(file),target.split('#')[0]));localLinks++;}
  }
  const receipt={date:new Date().toISOString(),results,localLinks,screenshots:5,productAppOpened:false,realDataUsed:false};
  await writeFile(path.join(proof,'render-receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await browser.close();}
