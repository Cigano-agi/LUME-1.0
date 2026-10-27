// Compare the signed package inventory to the certificate selected for this build.
export function inspectWindowsSignatures({files,checks,signer}){
  if(!/^[A-F0-9]{40}$/i.test(signer??''))throw Error('WINDOWS_SIGNER_IDENTITY_MISSING');
  if(!Array.isArray(files)||!Array.isArray(checks)||checks.length!==files.length)
    throw Error('WINDOWS_SIGNATURE_INVENTORY_INVALID');
  const expected=new Set(files.map(x=>x.toLowerCase()));
  const seen=new Set();
  for(const check of checks){
    const path=check?.path?.toLowerCase();
    if(!path||!expected.has(path)||seen.has(path))throw Error('WINDOWS_SIGNATURE_INVENTORY_INVALID');
    seen.add(path);
  }
  return checks.filter(x=>x.status!=='Valid'||x.thumbprint?.toUpperCase()!==signer.toUpperCase())
    .map(x=>({file:x.path,status:x.status!=='Valid'?x.status:'WRONG_SIGNER'}));
}
