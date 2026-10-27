import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import identidade from '../desktop/identidade.cjs';
import {compareReleaseVersions} from '../scripts/release-version.mjs';
import {assertVersionContract} from '../scripts/version-contract.mjs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const read=path=>readFileSync(new URL('../'+path,import.meta.url));
test('Lume 1.0 mantém versão técnica crescente, contrato de pacote e identidade persistente',()=>{
  const result=assertVersionContract({root});
  assert.equal(identidade.TITULO,'Lume 1.0');
  assert.equal(identidade.VERSAO_TECNICA,result.version);
  assert.equal(compareReleaseVersions(result.version,'3.2.0-beta.6'),1);
  assert.equal(result.packageJson.build.appId,'com.readyworks.assessor');
  assert.match(read('desktop/main.cjs').toString(),/'AssessorDesktop'/);
  assert(result.packageJson.build.files.includes('desktop/identidade.cjs'));
  assert.match(identidade.sobre,/Lume 1\.0.*Versão técnica/);
});
test('ícones amarelos derivados do vetor estão presentes em PNG, ICO e ICNS',()=>{
  assert.match(read('desktop/icon.svg').toString(),/#efc53b/);
  const png=read('desktop/icon.png'),ico=read('desktop/icon.ico'),icns=read('desktop/icon.icns');
  assert.equal(png.toString('hex',0,8),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),1024);
  assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),1);
  assert.equal(ico.readUInt32LE(14)+ico.readUInt32LE(18),ico.length);
  assert.equal(icns.toString('ascii',0,4),'icns');assert.equal(icns.readUInt32BE(4),icns.length);
});
