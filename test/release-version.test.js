import test from 'node:test';
import assert from 'node:assert/strict';
import {compareReleaseVersions,manifestVersion,parseReleaseVersion} from '../scripts/release-version.mjs';

test('release aceita somente versões beta ou estável',()=>{
 assert.deepEqual(parseReleaseVersion('3.1.0-beta.2'),{raw:'3.1.0-beta.2',major:3,minor:1,patch:0,beta:2});
 assert.equal(parseReleaseVersion('3.1.0').beta,null);
 for(const value of ['3.1.0-alpha.8','v3.1.0-beta.1','3.1','3.1.0-beta.x'])assert.throws(()=>parseReleaseVersion(value));
});

test('release posterior avança e versão igual ou anterior é reconhecida',()=>{
 assert.equal(compareReleaseVersions('3.1.0-beta.2','3.1.0-beta.1'),1);
 assert.equal(compareReleaseVersions('3.1.0','3.1.0-beta.99'),1);
 assert.equal(compareReleaseVersions('3.0.9','3.1.0-beta.1'),-1);
 assert.equal(compareReleaseVersions('3.1.0-beta.2','3.1.0-beta.2'),0);
});

test('manifesto exige versão válida na linha própria',()=>{
 assert.equal(manifestVersion("version: 3.1.0-beta.2\nfiles: []\n"),'3.1.0-beta.2');
 assert.equal(manifestVersion('files: []'),null);
 assert.throws(()=>manifestVersion('version: alpha'));
});
