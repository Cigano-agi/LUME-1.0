// Signed builds use the staged native bytes. Rebuilding here would invalidate their hashes.
const {readFileSync,existsSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {createHash}=require('node:crypto');
const {Arch}=require('builder-util/out/arch');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
module.exports.default=async context=>{
  if(context.electronPlatformName!=='win32'||context.arch!==Arch.x64)throw Error('WINDOWS_SIGNED_PLATFORM_INVALID');
  const stage=resolve(__dirname,'../work/windows-signed-stage');
  const receipt=JSON.parse(readFileSync(join(stage,'receipt.json'),'utf8'));
  if(receipt.schema!=='lume-windows-signed-staging-v1'||!Array.isArray(receipt.nativeFiles))throw Error('WINDOWS_SIGNED_STAGE_INVALID');
  for(const file of receipt.nativeFiles){
    if(!/^(native\/win-acl\/bin|audio-local)\/[a-zA-Z0-9._-]+\.(exe|dll)$/.test(file.path)||
       !/^[a-f0-9]{64}$/.test(file.sha256)||!existsSync(join(stage,file.path))||hash(join(stage,file.path))!==file.sha256)
      throw Error('WINDOWS_SIGNED_STAGE_INVALID');
  }
  if(hash(join(stage,'native/win-acl/bin/manifest.json'))!==receipt.aclManifestSha256||
     hash(join(stage,'audio-local/manifest.json'))!==receipt.audioManifestSha256||
     hash(join(stage,'desktop/audio-local-policy.json'))!==receipt.policySha256)throw Error('WINDOWS_SIGNED_STAGE_INVALID');
};
