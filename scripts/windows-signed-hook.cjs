// electron-builder's callback: preserve already signed native bytes, sign every other PE.
const {readFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
const {join,resolve,sep}=require('node:path');
const {execFileSync}=require('node:child_process');
const stage=resolve(__dirname,'../work/windows-signed-stage');
const receipt=JSON.parse(readFileSync(join(stage,'receipt.json'),'utf8'));
const expected=new Map(receipt.nativeFiles.map(x=>[x.path,x.sha256]));
const signer=(process.env.LUME_WINDOWS_SIGNER_THUMBPRINT||'').toUpperCase();
if(!/^[A-F0-9]{40}$/.test(signer))throw Error('WINDOWS_SIGNER_IDENTITY_MISSING');
function valid(file){
  const script=`$p=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $s=Get-AuthenticodeSignature -LiteralPath $p.path; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne $p.signer) { exit 1 }`;
  try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {input:JSON.stringify({path:file,signer}),windowsHide:true,timeout:30000,stdio:['pipe','ignore','ignore']});return true;}
  catch{return false;}
}
module.exports=async(configuration)=>{
  const file=resolve(configuration.path);
  const normalized=file.split(sep).join('/').toLowerCase();
  const match=[...expected].find(([path])=>normalized.endsWith('/'+path.toLowerCase())||
    normalized.endsWith('/app.asar.unpacked/'+path.toLowerCase())||
    (path.startsWith('audio-local/')&&normalized.endsWith('/resources/'+path.toLowerCase())));
  if(match){
    const actual=createHash('sha256').update(readFileSync(file)).digest('hex');
    if(actual!==match[1]||!valid(file))throw Error('WINDOWS_PRESIGNED_NATIVE_CHANGED');
    return;
  }
  if(configuration.hash!=='sha256')throw Error('WINDOWS_SIGNING_HASH_INVALID');
  const {signAuthenticode}=await import('./windows-signing-authenticode.mjs');
  signAuthenticode(file,{certificate:process.env.LUME_WINDOWS_SIGN_CERTIFICATE,
    password:process.env.LUME_WINDOWS_SIGN_PASSWORD,thumbprint:signer});
  if(!valid(file))throw Error('WINDOWS_PACKAGE_SIGNATURE_INVALID');
};
