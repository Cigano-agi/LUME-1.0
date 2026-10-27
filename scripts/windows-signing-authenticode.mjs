// Windows signing support. Passwords travel through stdin and are never logged.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

const ps=`$ErrorActionPreference='Stop'
$request=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
if($request.mode -eq 'certificate') {
  $secret=ConvertTo-SecureString -String $request.password -AsPlainText -Force
  $flags=[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $cert=[System.Security.Cryptography.X509Certificates.X509Certificate2]::new($request.path,$secret,$flags)
  $eku=@($cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.EnhancedKeyUsages | ForEach-Object { $_.Value } })
  [pscustomobject]@{ thumbprint=$cert.Thumbprint; commonName=$cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false); privateKey=$cert.HasPrivateKey; validTime=($cert.NotBefore -le [DateTime]::UtcNow -and $cert.NotAfter -gt [DateTime]::UtcNow); codeSigning=($eku -contains '1.3.6.1.5.5.7.3.3') } | ConvertTo-Json -Compress
} elseif($request.mode -eq 'file') {
  $signature=Get-AuthenticodeSignature -LiteralPath $request.path
  [pscustomobject]@{ status=[string]$signature.Status; thumbprint=$signature.SignerCertificate.Thumbprint; subject=$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress
} elseif($request.mode -eq 'sign') {
  $secret=ConvertTo-SecureString -String $request.password -AsPlainText -Force
  $flags=[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $cert=[System.Security.Cryptography.X509Certificates.X509Certificate2]::new($request.certificate,$secret,$flags)
  if($cert.Thumbprint -ne $request.thumbprint) { throw 'WRONG_CERTIFICATE' }
  $signed=Set-AuthenticodeSignature -LiteralPath $request.path -Certificate $cert -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com' -Force
  if($signed.Status -ne 'Valid' -or $signed.SignerCertificate.Thumbprint -ne $request.thumbprint) { throw 'SIGNATURE_INVALID' }
  [pscustomobject]@{ status=[string]$signed.Status; thumbprint=$signed.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress
} else { throw 'INVALID_MODE' }`;

function invoke(request){
  if(process.platform!=='win32')throw Error('WINDOWS_SIGNING_REQUIRES_WINDOWS');
  const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{
    input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8192
  });
  if(child.error||child.status!==0)throw Error('WINDOWS_AUTHENTICODE_CHECK_FAILED');
  try{return JSON.parse(child.stdout.replace(/^\uFEFF/,''));}catch{throw Error('WINDOWS_AUTHENTICODE_CHECK_FAILED');}
}
export function certificateIdentity(path,password){
  if(!path||!existsSync(path)||!password)throw Error('WINDOWS_SIGNING_CERTIFICATE_REQUIRED');
  const result=invoke({mode:'certificate',path:resolve(path),password});
  if(!/^[A-F0-9]{40}$/i.test(result.thumbprint??'')||!result.privateKey||!result.validTime||!result.codeSigning||
     !result.commonName||result.commonName.length>150)
    throw Error('WINDOWS_SIGNING_CERTIFICATE_INVALID');
  return{thumbprint:result.thumbprint.toUpperCase(),commonName:result.commonName};
}
export function validSignature(path,thumbprint){
  const result=invoke({mode:'file',path:resolve(path)});
  return result.status==='Valid'&&result.thumbprint?.toUpperCase()===thumbprint?.toUpperCase();
}
export function signAuthenticode(path,{certificate,password,thumbprint}){
  if(!certificate||!password||!/^[A-F0-9]{40}$/i.test(thumbprint??''))throw Error('WINDOWS_SIGNING_CERTIFICATE_REQUIRED');
  const result=invoke({mode:'sign',path:resolve(path),certificate:resolve(certificate),password,thumbprint});
  if(result.status!=='Valid'||result.thumbprint?.toUpperCase()!==thumbprint.toUpperCase())
    throw Error('WINDOWS_NATIVE_SIGNING_FAILED');
}
