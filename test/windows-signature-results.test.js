import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWindowsSignatures} from '../scripts/windows-signature-results.mjs';

const signer='A'.repeat(40);
const files=['C:\\candidate\\Lume.exe','C:\\candidate\\resources\\native.dll'];
const checks=files.map(path=>({path,status:'Valid',thumbprint:signer}));

test('aceita inventário completo assinado pela identidade esperada',()=>{
  assert.deepEqual(inspectWindowsSignatures({files,checks,signer}),[]);
});

test('rejeita assinatura válida de outro certificado e identidade ausente',()=>{
  assert.deepEqual(inspectWindowsSignatures({files,checks:[checks[0],{...checks[1],thumbprint:'B'.repeat(40)}],signer}),
    [{file:files[1],status:'WRONG_SIGNER'}]);
  assert.throws(()=>inspectWindowsSignatures({files,checks,signer:''}),/WINDOWS_SIGNER_IDENTITY_MISSING/);
});

test('rejeita inventário incompleto, duplicado e caminhos trocados',()=>{
  for(const altered of [checks.slice(0,1),[checks[0],checks[0]],[checks[0],{...checks[1],path:'C:\\other.dll'}]])
    assert.throws(()=>inspectWindowsSignatures({files,checks:altered,signer}),/WINDOWS_SIGNATURE_INVENTORY_INVALID/);
});
