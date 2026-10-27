import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {extname,join,resolve} from 'node:path';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'..');
const site=join(root,'site-dist');
const out=join(root,'work','vercel-landing-qa');
mkdirSync(out,{recursive:true});
execFileSync(process.execPath,[join(root,'scripts','build-vercel-site.mjs')],{cwd:root,stdio:'inherit'});

const types={'.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.txt':'text/plain; charset=utf-8'};
const expectedCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const expectedVersion=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
const releaseStatus=JSON.parse(readFileSync(join(site,'release-status.json'),'utf8'));
assert.deepEqual(releaseStatus,{version:expectedVersion,sourceCommit:expectedCommit,distribution:'em_validacao',downloads:[]});
const server=createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost');
  const relative=url.pathname==='/'?'index.html':url.pathname.slice(1);
  const file=resolve(site,extname(relative)||relative==='index.html'?relative:`${relative}.html`);
  if(!file.startsWith(site)){
    response.writeHead(404);
    return response.end();
  }
  try{
    const info=statSync(file);
    if(!info.isFile())throw new Error('not a file');
    response.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'});
    response.end(readFileSync(file));
  }catch{response.writeHead(404);response.end('Not found');}
});
await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1320,height:950}});
const errors=[];
const external=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('requestfailed',request=>{
  if(request.url().startsWith(origin))errors.push(`${request.url()}: ${request.failure()?.errorText}`);
});
await page.route('**/*',route=>{
  if(route.request().url().startsWith(origin))return route.continue();
  external.push(route.request().url());
  return route.abort();
});

try{
  await page.goto(origin,{waitUntil:'networkidle'});
  assert.match(await page.locator('h1').innerText(),/conversa/i);
  assert.equal(await page.locator('a[href="/app"]').count(),0);
  assert.equal(await page.locator('[data-download-open],#download-action,#download-dialog').count(),0);
  assert.ok(await page.locator('a[href="/download"]').count()>0);
  assert.equal(await page.locator('a[href$=".exe"],a[href$=".dmg"]').count(),0);
  assert.equal(await page.getByRole('button',{name:/baixar|download/i}).count(),0);
  assert.ok(await page.getByText(/próximo beta assinado (?:está |em )preparação/i).count()>0);
  assert.match(await page.locator('.release-card').innerText(),/Nenhum instalador está liberado nesta página/i);
  assert.deepEqual(errors,[]);
  assert.deepEqual(external,[]);

  for(const width of [1320,820,390]){
    await page.setViewportSize({width,height:950});
    await page.evaluate(()=>scrollTo(0,0));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:join(out,`landing-${width}.png`),fullPage:true});

    assert.equal(await page.locator('[data-download-open],#download-action,#download-dialog').count(),0);
    assert.equal(await page.locator('a[href$=".exe"],a[href$=".dmg"]').count(),0);
  }

  await page.locator('a[href="/download"]').first().click();
  assert.equal(new URL(page.url()).pathname,'/download');
  assert.match(await page.getByRole('status').innerText(),/Não há instalador liberado/);
  for(const platform of ['windows','mac']){
    await page.locator(`a[href="/download/${platform}"]`).click();
    assert.equal(new URL(page.url()).pathname,`/download/${platform}`);
    assert.match(await page.locator('.download-card').innerText(),/Instalador ainda indisponível/);
    assert.equal(await page.locator('a[href$=".exe"],a[href$=".dmg"],a[href$=".zip"]').count(),0);
    for(const width of [1320,390]){
      await page.setViewportSize({width,height:950});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:join(out,`download-${platform}-${width}.png`),fullPage:true});
    }
    await page.goto(origin+'/download');
  }

  const report={date:new Date().toISOString(),passed:true,widths:[1320,820,390],errors,externalRequests:external,checks:['landing fits without horizontal overflow','signed beta preparation is visible','platform status pages open from the landing','no installer link appears without release approval','no download dialog is present']};
  writeFileSync(join(out,'checks.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{
  await browser.close();
  await new Promise(resolveClose=>server.close(resolveClose));
}
