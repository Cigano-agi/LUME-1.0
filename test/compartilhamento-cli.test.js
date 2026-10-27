import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Compartilhamento} from '../src/compartilhamento.js';

test('CLI real: chave cifrada, dry sem arquivo, exportação, importação e repetição',t=>{
 const dir=mkdtempSync(join(tmpdir(),'assessor-f10-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const origem=join(dir,'origem.db'),destino=join(dir,'destino.db'),chave=join(dir,'identidade.pem'),pacote=join(dir,'pacote.json');
 const a=abrirBanco(origem),ctx=new ContextoApp(a);ctx.nota({titulo:'Teste',texto:'Decisão: validar a ação amanhã.'});
 const af=new Compartilhamento(a),pr=af.criarProjeto({nome:'Projeto',conversas:a.prepare('SELECT id FROM conversas_app').all().map(c=>c.id)}).id;a.close();
 const b=abrirBanco(destino);new ContextoApp(b);const bp=new Compartilhamento(b).criarProjeto({nome:'Recebido'}).id;b.close();
 const run=(script,args)=>{const r=spawnSync(process.execPath,[resolve('bin',script),...args],{encoding:'utf8',env:{...process.env,F10_TEST_SECRET:'senha-sintetica-nao-real-123456'}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const ident=run('compartilhar.js',['--criar-identidade','--chave',chave,'--senha-env','F10_TEST_SECRET']);assert.match(readFileSync(chave,'utf8'),/ENCRYPTED PRIVATE KEY/);
 const base=['--banco',origem,'--projeto',pr,'--para','Sócio','--pessoa','Remetente','--arquivo',pacote];
 assert.equal(run('compartilhar.js',[...base,'--dry']).arquivoGerado,false);assert.equal(existsSync(pacote),false);
 run('compartilhar.js',[...base,'--chave',chave,'--senha-env','F10_TEST_SECRET']);
 const args=['--pacote',pacote,'--banco',destino,'--projeto-local',bp,'--fingerprint',ident.fingerprint];
 assert.equal(run('receber-compartilhamento.js',[...args,'--dry']).novos,1);
 const c=abrirBanco(destino);assert.equal(c.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);c.close();
 assert.equal(run('receber-compartilhamento.js',args).novos,1);assert.equal(run('receber-compartilhamento.js',args).repetido,true);
 const tampered=JSON.parse(readFileSync(pacote,'utf8'));tampered.conteudo.eventos[0].texto='Adulterado';writeFileSync(pacote,JSON.stringify(tampered));
 const r=spawnSync(process.execPath,[resolve('bin/receber-compartilhamento.js'),...args],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/Assinatura/);
});
