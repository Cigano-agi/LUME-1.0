import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {generateKeyPairSync} from 'node:crypto';
import yaml from 'js-yaml';
import {prepararRelease} from '../scripts/preparar-release.mjs';
import {validarPoliticaComunicados,criarTransporteComunicados} from '../src/novidades.js';
const require=createRequire(import.meta.url),{ORIGEM_LUME,origemPermitida,feedAtualizacoes}=require('../desktop/origem-lume.cjs');
const {carregarPoliticaRelease}=require('../desktop/atualizacoes.cjs');
const {ORIGEM_CENTRAL}=require('../desktop/central-runtime.cjs');
const legacy='https://lume-crm-fawn.vercel.app';

test('distribuição: app, Central, preparação e workflow usam domínio canônico',()=>{
  assert.equal(ORIGEM_LUME,'https://lume.gypsiventures.com');assert.equal(ORIGEM_CENTRAL,ORIGEM_LUME);
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.build.publish[0].url,feedAtualizacoes('beta'));assert.ok(pkg.build.files.includes('desktop/origem-lume.cjs'));
  const workflow=yaml.load(readFileSync(new URL('../.github/workflows/update-proof.yml',import.meta.url),'utf8'));
  assert.equal(workflow.env.RELEASE_BASE_URL,feedAtualizacoes('beta'));
  for(const [version,channel]of [['3.2.0-beta.6','beta'],['3.2.0','estavel']]){
    let policy;const result=prepararRelease({platform:'win32',env:{},readiness:()=>({version}),write:(_path,body)=>policy=JSON.parse(body)});
    assert.equal(result.feedUrl,feedAtualizacoes(channel));assert.equal(policy.feedUrl,result.feedUrl);
  }
  assert.throws(()=>feedAtualizacoes('../outro'));
});

test('updater: domínio final e alias legado aceitos, porta/canal/caminho arbitrários bloqueados',t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-origin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'policy.json');
  const read=url=>{writeFileSync(file,JSON.stringify({schema:'lume-release-v1',enabled:true,channel:'beta',feedUrl:url}));return carregarPoliticaRelease(file);};
  for(const origin of [ORIGEM_LUME,legacy]){
    assert.equal(read(origin+'/releases/beta').enabled,true);assert.equal(read(origin+'/releases/beta/').enabled,true);
    for(const path of ['/releases/estavel','/releases/beta/extra','/releases/beta?outro=1','/releases/beta#outro'])assert.equal(read(origin+path).enabled,false);
  }
  for(const origin of ['http://lume.gypsiventures.com','https://lume.gypsiventures.com:444','https://lume.gypsiventures.com.evil.test','https://user@lume.gypsiventures.com','https://lume-crm-fawn.vercel.app:444']){
    assert.equal(origemPermitida(new URL(origin)),false);assert.equal(read(origin+'/releases/beta').enabled,false);
  }
  assert.equal(origemPermitida(new URL('blob:'+ORIGEM_LUME+'/releases/beta')),false);
});

test('comunicados assinados aceitam domínio final sem habilitar política distribuída',()=>{
  const {publicKey}=generateKeyPairSync('ed25519');const key=publicKey.export({format:'der',type:'spki'}).toString('base64');
  const policy={schema:'lume-comunicados-policy-v1',enabled:true,channel:'beta',feedUrl:ORIGEM_LUME+'/api/v1/comunicados/beta.json',publicKey:key};
  assert.equal(validarPoliticaComunicados(policy).enabled,true);
  assert.equal(validarPoliticaComunicados({...policy,feedUrl:policy.feedUrl.replace('.com/','.com:444/')}).enabled,false);
  assert.throws(()=>criarTransporteComunicados({feedUrl:policy.feedUrl.replace('.com/','.com:444/')}));
  for(const path of ['../desktop/release-policy.json','../desktop/comunicados-policy.json'])assert.equal(JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8')).enabled,false);
});
