// Read-only gate for a private Windows candidate. It never signs or runs files.
import {spawnSync} from 'node:child_process';
import {lstatSync,openSync,readSync,closeSync,readdirSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
import {inspectWindowsSignatures} from './windows-signature-results.mjs';

if(process.platform!=='win32')throw Error('Verificação Authenticode exige Windows');
const root=resolve(process.argv[2]??'dist/desktop/win-unpacked');
if(!lstatSync(root).isDirectory())throw Error('Candidato Windows ausente');
const files=[];
const walk=dir=>{
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name),stat=lstatSync(path);
    if(stat.isSymbolicLink())throw Error('Candidato contém link simbólico');
    if(stat.isDirectory()){walk(path);continue;}
    if(stat.isFile()&&/\.(exe|dll|node)$/i.test(entry.name))files.push(path);
  }
};
walk(root);
if(!files.length)throw Error('Candidato não contém binários nativos');
const incompatible=[];
const windowsFiles=[];
for(const file of files){
  const fd=openSync(file,'r');
  const magic=Buffer.alloc(2);
  try{readSync(fd,magic,0,2,0);}finally{closeSync(fd);}
  if(magic.toString('ascii')!=='MZ')incompatible.push(relative(root,file).split(sep).join('/'));
  else windowsFiles.push(file);
}
if(!windowsFiles.length)throw Error('Candidato não contém binários Windows');
const script=`$ErrorActionPreference='Stop'
$paths=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$checks=@(foreach($path in $paths){
  $signature=Get-AuthenticodeSignature -LiteralPath $path
  [pscustomobject]@{path=$path;status=[string]$signature.Status;thumbprint=$signature.SignerCertificate.Thumbprint}
})
ConvertTo-Json -InputObject $checks -Compress -Depth 3`;
const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
  input:JSON.stringify(windowsFiles),encoding:'utf8',windowsHide:true,maxBuffer:1024*1024,timeout:120000
});
if(child.error||child.status!==0)throw Error('Não foi possível verificar assinaturas Authenticode');
const checks=JSON.parse(child.stdout.replace(/^\uFEFF/,''));
const invalid=inspectWindowsSignatures({files:windowsFiles,checks,signer:process.env.LUME_WINDOWS_SIGNER_THUMBPRINT})
  .map(x=>({file:relative(root,x.file).split(sep).join('/'),status:x.status}));
console.log(JSON.stringify({ok:invalid.length===0&&incompatible.length===0,files:files.length,windowsFiles:windowsFiles.length,
  incompatible:incompatible.slice(0,25),incompatibleTotal:incompatible.length,invalid:invalid.slice(0,25),invalidTotal:invalid.length}));
if(invalid.length||incompatible.length)process.exitCode=1;
