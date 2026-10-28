import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractFile,listPackage} from '@electron/asar';

const root=fileURLToPath(new URL('..',import.meta.url));
const asset='src/painel/lume-auto.css';
const source=readFileSync(resolve(root,asset));

test('desktop: whitelist inclui o CSS solicitado pela interface de organização',()=>{
  const pkg=JSON.parse(readFileSync(resolve(root,'package.json')));
  assert(pkg.build.files.includes(asset),'CSS de organização precisa entrar no pacote desktop');
  assert(source.length>0);
});

test('desktop: candidata contém o CSS de organização com os bytes atuais',{
  skip:!process.env.LUME_AUTO_PACKAGE_ASAR&&'Informe LUME_AUTO_PACKAGE_ASAR para validar uma candidata real'
},()=>{
  const archive=resolve(process.env.LUME_AUTO_PACKAGE_ASAR);
  const names=listPackage(archive).map(path=>path.replaceAll('\\','/').replace(/^\//,''));
  assert(names.includes(asset),'ASAR incompleto: '+asset);
  assert.deepEqual(extractFile(archive,normalize(asset)),source,'CSS empacotado difere da fonte revisada');
});

for(const module of ['src/pessoal/organizacao-identidade.js','src/pessoal/organizacao-atribuicao.js'])test('desktop: candidata inclui a regra utilizada pelas leituras: '+module,{
  skip:!process.env.LUME_AUTO_PACKAGE_ASAR&&'Informe LUME_AUTO_PACKAGE_ASAR para validar uma candidata real'
},()=>{
  const archive=resolve(process.env.LUME_AUTO_PACKAGE_ASAR);
  const names=listPackage(archive).map(path=>path.replaceAll('\\','/').replace(/^\//,''));
  assert(names.includes(module),'ASAR incompleto: '+module);
  assert.deepEqual(extractFile(archive,normalize(module)),readFileSync(resolve(root,module)),'Regra empacotada difere da fonte revisada: '+module);
});
