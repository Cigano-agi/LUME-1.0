import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';

test('landing Vercel fica fechada até existir beta assinado',()=>{
  execFileSync(process.execPath,['scripts/build-vercel-site.mjs']);
  const html=readFileSync('site-dist/index.html','utf8'),siteScript=readFileSync('site-dist/lume-site.js','utf8'),config=JSON.parse(readFileSync('vercel.json','utf8'));
  assert.match(html,/próximo beta assinado (?:está |em )preparação/i);
  assert.match(html,/Nenhum instalador está liberado nesta página/i);
  assert.doesNotMatch(html,/data-download-open|id="download-action"|id="download-dialog"|href=["'][^"']*\.(?:exe|dmg)/i);
  assert.match(html,/href="\/download"/);
  assert.doesNotMatch(html,/alpha\.5|sem assinatura digital|79c9da5a761614e9|xtzcnwvizldelcss\.public\.blob\.vercel-storage\.com\/downloads/i);
  assert.doesNotMatch(siteScript,/alpha\.5|\/download\/windows|79c9da5a761614e9/i);
  assert.doesNotMatch(html,/href="\/app/);
  const windows=config.redirects.find(item=>item.source==='/download/windows'),releases=config.redirects.find(item=>item.source==='/releases/:channel/:file');
  assert.equal(windows,undefined);
  assert.ok(releases);assert.match(releases.destination,/\.public\.blob\.vercel-storage\.com\/releases\/:channel\/:file$/);
  for(const file of ['lume.css','lume-features.css','lume-site.js','lume-motion.js','lume-download.css','vendor/motion.js','icon.png','og-lume.png','robots.txt','download.html','download/windows.html','download/mac.html'])assert.ok(statSync('site-dist/'+file).size>0,file);
  for(const platform of ['','windows','mac']){
    const page=readFileSync(`site-dist/download${platform?'/'+platform:''}.html`,'utf8');
    assert.match(page,/Não há instalador liberado nesta versão/);
    assert.doesNotMatch(page,/href=["'][^"']*\.(?:exe|dmg|zip)/i);
  }
  assert.equal(html.includes('GEMINI_API_KEY'),false);assert.equal(html.includes('BLOB_READ_WRITE_TOKEN'),false);
});
