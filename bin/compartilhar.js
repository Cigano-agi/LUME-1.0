import { parseArgs } from 'node:util';
import { readFileSync,writeFileSync,existsSync,statSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { generateKeyPairSync,createPrivateKey } from 'node:crypto';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Compartilhamento,assinarPacote,fingerprint } from '../src/compartilhamento.js';

const help=`Compartilhamento manual. Não envia nada pela rede.
  node bin/compartilhar.js --banco <db> --projeto <id> --para <nome ou pasta> --pessoa <nome> [--dry]
    --chave <privada.pem> --senha-env <NOME_DA_VARIAVEL> [--arquivo <saida.json>]
  node bin/compartilhar.js --criar-identidade --chave <privada.pem> --senha-env <NOME_DA_VARIAVEL>
A senha vem da variável indicada, nunca da linha de comando. Use o app para criar projetos sem terminal.
O pacote é assinado, não criptografado. A pasta de saída precisa ser local; transporte manual.`;
let db;
try {
  const {values:v}=parseArgs({options:{banco:{type:'string'},projeto:{type:'string'},para:{type:'string'},pessoa:{type:'string'},dry:{type:'boolean'},chave:{type:'string'},'senha-env':{type:'string'},arquivo:{type:'string'},'criar-identidade':{type:'boolean'},help:{type:'boolean'}}});
  if(v.help){console.log(help);}else{
    const senha=()=>{if(!v['senha-env']||!process.env[v['senha-env']]||process.env[v['senha-env']].length<16)throw new Error('Defina --senha-env com uma variável de senha de pelo menos 16 caracteres.');return process.env[v['senha-env']];};
    if(v['criar-identidade']){
      if(!v.chave)throw new Error('Informe --chave.');const passphrase=senha(),k=generateKeyPairSync('ed25519');
      writeFileSync(resolve(v.chave),k.privateKey.export({type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase}),{flag:'wx',mode:0o600});
      console.log(JSON.stringify({criada:true,fingerprint:fingerprint(k.publicKey),aviso:'Guarde o PEM e a senha. Confirme este código com quem recebe por outro canal.'}));
    } else {
      if(!v.banco||!existsSync(v.banco)||!v.projeto||!v.para||!v.pessoa)throw new Error(help);
      // Exportação nunca migra ou escreve no banco; precisa do esquema do app atual.
      db=new DatabaseSync(resolve(v.banco),{readOnly:true});const f=new Compartilhamento(db);
      const c=f.prepararExportacao({projeto:v.projeto,pessoa:v.pessoa,maquina:hostname(),destinatario:v.para});
      if(v.dry)console.log(JSON.stringify({dry:true,projeto:c.projeto,total:c.eventos.length,arquivoGerado:false}));
      else{
        if(!v.chave)throw new Error('Informe sua chave protegida em --chave.');
        const k=createPrivateKey({key:readFileSync(resolve(v.chave)),passphrase:senha()});
        const p=assinarPacote(c,k),destino=resolve(v.arquivo||(existsSync(v.para)&&statSync(v.para).isDirectory()?join(v.para,`assessor-${c.id}.json`):`assessor-${c.id}.json`));
        if(destino.startsWith('\\\\'))throw new Error('Escolha uma pasta local. A entrega é manual.');
        writeFileSync(destino,JSON.stringify(p),{flag:'wx',mode:0o600});console.log(JSON.stringify({arquivo:destino,total:c.eventos.length,fingerprint:fingerprint(p.chave_publica),aviso:'Arquivo não criptografado; entrega manual.'}));
      }
    }
  }
}catch(e){console.error(e.message);process.exitCode=1;}finally{db?.close();}
