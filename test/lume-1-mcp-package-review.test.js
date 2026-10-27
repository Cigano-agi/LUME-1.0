import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildLumeMcpb,inspectStoredMcpb} from '../scripts/build-lume-mcpb.mjs';

test('revisao MCP: pacote extraido resolve todos imports estaticos antes de iniciar broker',async t=>{
  const stage=mkdtempSync(join(tmpdir(),'lume-mcp-import-review-'));
  t.after(()=>rmSync(stage,{recursive:true,force:true}));
  const built=buildLumeMcpb({outputDir:stage}),extracted=join(stage,'unpacked');
  for(const entry of inspectStoredMcpb(readFileSync(built.artifact))){
    const file=join(extracted,entry.name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,entry.data);
  }
  // Import only. The launcher and exported start function are never executed.
  const entry=await import(pathToFileURL(join(extracted,'src/mcp/stdio-entry.js')).href);
  assert.equal(typeof entry.startFromEnvironment,'function');
});
