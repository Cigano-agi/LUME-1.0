import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {generateKeyPairSync} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {Compartilhamento,assinarPacote} from '../src/compartilhamento.js';
import {criarServidor} from '../src/painel/servidor.js';

test('HTTP: consentimento/token/origem e JSON grande com Unicode entre chunks',async t=>{
 const a=abrirBanco(),ctx=new ContextoApp(a);ctx.nota({titulo:'Fonte',texto:'ação memória '.repeat(6000)});ctx.nota({titulo:'Outra',texto:'decisão reunião '.repeat(5000)});
 const f=new Compartilhamento(a),pr=f.criarProjeto({nome:'Arquivo grande',conversas:a.prepare('SELECT id FROM conversas_app').all().map(c=>c.id)}).id;
 const pack=assinarPacote(f.prepararExportacao({projeto:pr,pessoa:'Sócio',maquina:'PC',destinatario:'Pessoa'}),generateKeyPairSync('ed25519').privateKey);a.close();
 const db=abrirBanco();new ContextoApp(db);const s=criarServidor(db,{desktop:true,conexao:{estado:()=>({estado:'desconectada'})}});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>s.close(r));db.close();});
 const base=`http://127.0.0.1:${s.address().port}`,path='/api/v3/compartilhamento/preparar-importacao';
 assert.equal((await fetch(base+'/api/v3/compartilhamento')).status,403);
 new Desktop(db).aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
 const body=Buffer.from(JSON.stringify({arquivo:JSON.stringify(pack)}));assert.ok(body.length>120000);
 assert.equal((await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);
 const {token}=await(await fetch(base+'/api/sessao')).json();
 assert.equal((await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Assessor-Token':token,Origin:'https://outside.invalid'},body})).status,403);
 const split=body.indexOf(Buffer.from('ó'))+1;
 const response=await new Promise((resolve,reject)=>{const r=request(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Assessor-Token':token}},res=>{let result='';res.setEncoding('utf8');res.on('data',c=>result+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(result)}));});r.on('error',reject);r.write(body.subarray(0,split));setTimeout(()=>r.end(body.subarray(split)),10);});
 assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.total,2);assert.equal(response.data.remetente.pessoa,'Sócio');assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);
});
