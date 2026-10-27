import { parseArgs } from 'node:util';
import { readFileSync,statSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Compartilhamento,verificarPacote,MAX_PACOTE } from '../src/compartilhamento.js';
let db;
try{
  const {values:v}=parseArgs({options:{pacote:{type:'string'},banco:{type:'string'},'projeto-local':{type:'string'},fingerprint:{type:'string'},dry:{type:'boolean'},help:{type:'boolean'}}});
  const help='node bin/receber-compartilhamento.js --pacote <arquivo.json> --banco <db> --projeto-local <id> --fingerprint <codigo-confirmado-por-outro-canal> [--dry]';
  if(v.help)console.log(help);else{
    if(!v.pacote||!v.banco||!v['projeto-local']||!v.fingerprint||!existsSync(v.banco))throw new Error(help);
    if(statSync(resolve(v.pacote)).size>MAX_PACOTE)throw new Error('Arquivo excede 8 MB.');
    // Verifica o pacote e a confiança ANTES de abrir o banco, inclusive para --dry.
    const verificado=verificarPacote(readFileSync(resolve(v.pacote),'utf8'));
    if(v.fingerprint.replace(/[\s:]/g,'').toLowerCase()!==verificado.fingerprint)throw new Error('Impressão digital não corresponde ao remetente confirmado.');
    db=new DatabaseSync(resolve(v.banco),{readOnly:Boolean(v.dry)});db.exec('PRAGMA foreign_keys=ON');
    const f=new Compartilhamento(db);console.log(JSON.stringify({...f.importar(verificado.pacote,{projeto:v['projeto-local'],fingerprintConfirmada:v.fingerprint,dry:Boolean(v.dry)}),dry:Boolean(v.dry)}));
  }
}catch(e){console.error(e.message);process.exitCode=1;}finally{db?.close();}
