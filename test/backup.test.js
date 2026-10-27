import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {Backup,abrirBackup,cifrarBackup} from '../src/backup.js';
import {Privacidade} from '../src/privacidade.js';
import {prepararEsquemaTranscricao} from '../src/transcricao.js';
const senha='senha sintética para o teste';
function env(t){const dir=mkdtempSync(join(tmpdir(),'assessor-backup-')),db=abrirBanco(join(dir,'assessor.db')),ctx=new ContextoApp(db);new Desktop(db);new DesktopIA(db);const arquivos=new ArquivosDados(dir),b=new Backup(db,{arquivos,perfil:()=>({nome:'Dono teste'})});t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return{db,dir,ctx,arquivos,b};}
test('backup cifrado restaura fontes, nota ligada e anexo em perfil vazio, com IA pausada',async t=>{
 const a=env(t),b=env(t),id=a.ctx.nota({texto:'Texto privado único'}).id;a.ctx.nota({texto:'Resumo',fontes:[id]});
 prepararEsquemaTranscricao(a.db);mkdirSync(join(a.dir,'anexos'));const file=join(a.dir,'anexos','voz.opus');writeFileSync(file,'audio teste');const e=a.db.prepare('SELECT * FROM eventos WHERE id=?').get(id);
 a.db.prepare("INSERT INTO transcricoes(conversa_id,origem_id,arquivo,texto,estado,criado_em) VALUES(?,?,?,'transcrição','transcrito','2026-09-17')").run(e.conversa_id,e.origem_id,file);
 const out=await a.b.criar({senha,confirmar:true}),json=JSON.stringify(out.pacote);assert.ok(!json.includes('Texto privado único'));assert.ok(!json.includes(a.dir));
 const p=await b.b.preparar({arquivo:json,senha});assert.equal(p.total,2);assert.equal(p.anexos,1);const r=b.b.restaurar({id:p.id,confirmarMeuBackup:true});assert.equal(r.eventos,2);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM priv_vinculos').get().n,1);
 assert.equal(b.db.prepare('SELECT habilitada FROM desktop_ia_config').get().habilitada,0);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM desktop_ia_conversas').get().n,0);const restored=b.db.prepare('SELECT arquivo FROM transcricoes').get().arquivo;assert.ok(restored.startsWith(join(b.dir,'anexos')));assert.equal(readFileSync(restored,'utf8'),'audio teste');
});
test('senha errada e alteração autenticada falham antes de restaurar',async t=>{
 const a=env(t);a.ctx.nota({texto:'Segredo'});const out=await a.b.criar({senha,confirmar:true}),p=out.pacote;
 await assert.rejects(()=>abrirBackup(JSON.stringify(p),'senha errada bastante longa'),/Senha incorreta/);
 const tamper={...p,dados:(p.dados[0]==='A'?'B':'A')+p.dados.slice(1)};await assert.rejects(()=>abrirBackup(JSON.stringify(tamper),senha),/alterado/);
 assert.equal(a.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,1);
});
test('restauração recusa acervo existente e nunca desfaz exclusão local',async t=>{
 const a=env(t);a.ctx.nota({texto:'Deletar depois do backup'});const file=JSON.stringify((await a.b.criar({senha,confirmar:true})).pacote);
 let p=await a.b.preparar({arquivo:file,senha});assert.throws(()=>a.b.restaurar({id:p.id,confirmarMeuBackup:true}),/vazio/);
 const privacy=new Privacidade(a.db,{arquivos:a.arquivos}),del=privacy.preparar({tudo:true});privacy.excluir({id:del.id,confirmar:'APAGAR'});
 p=await a.b.preparar({arquivo:file,senha});assert.throws(()=>a.b.restaurar({id:p.id,confirmarMeuBackup:true}),/excluídas/);assert.equal(a.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);
});
test('arquivo hostil não injeta tabela, SQL, caminho ou gasto negativo',async t=>{
 const a=env(t),b=env(t);a.ctx.nota({texto:'Fonte'});const content=a.b.capturar();
 const extra=structuredClone(content);extra.tabelas['eventos;DROP TABLE eventos']=[];await assert.rejects(async()=>b.b.preparar({arquivo:JSON.stringify(await cifrarBackup(extra,senha)),senha}),/inválido/);
 const path=structuredClone(content);prepararEsquemaTranscricao(a.db);const cols=a.db.prepare('PRAGMA table_info(transcricoes)').all().map(c=>c.name),row=Object.fromEntries(cols.map(c=>[c,null]));row.arquivo='C:/Users/Usuario/.codex/config.toml';path.tabelas.transcricoes=[row];await assert.rejects(async()=>b.b.preparar({arquivo:JSON.stringify(await cifrarBackup(path,senha)),senha}),/anexo inválida/);
 const cost=structuredClone(content);cost.tabelas.desktop_ia_gastos=[{id:'fraude',dia:'2026-09-17',reservado_micros:-9999,estado:'concluido',criado_em:'2026-09-17',entrada_tokens:null,saida_tokens:null}];await assert.rejects(async()=>b.b.preparar({arquivo:JSON.stringify(await cifrarBackup(cost,senha)),senha}),/gasto inválido/);
 assert.equal(b.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);
});
test('journal da restauração limpa arquivo órfão após queda e preserva commit confirmado',t=>{
 const e=env(t);mkdirSync(e.arquivos.anexos);let id=randomUUID(),file=join(e.arquivos.anexos,`restaurado-${id}-0.bin`);e.arquivos.iniciarRestauracao(id,1);writeFileSync(file,'restauro incompleto');assert.equal(e.arquivos.recuperarRestauracoes(e.db).revertidas,1);assert.equal(existsSync(file),false);
 id=randomUUID();file=join(e.arquivos.anexos,`restaurado-${id}-0.bin`);e.arquivos.iniciarRestauracao(id,1);writeFileSync(file,'restauro válido');e.db.prepare('INSERT INTO priv_recibos VALUES(?,?,?,?)').run(id,new Date().toISOString(),'restaurado','{}');assert.equal(e.arquivos.recuperarRestauracoes(e.db).finalizadas,1);assert.equal(readFileSync(file,'utf8'),'restauro válido');
});

test('restauro com FK quebrada reverte banco e arquivos; saldo já reservado nunca diminui',async t=>{
 const a=env(t),b=env(t);a.ctx.nota({texto:'Fonte válida'});mkdirSync(a.arquivos.anexos);writeFileSync(join(a.arquivos.anexos,'orfao.txt'),'Anexo sem vínculo SQL');
 a.db.exec("INSERT INTO desktop_ia_gastos VALUES('mesmo','2026-09-17',2000,'reservado','2026-09-17',NULL,NULL)");
 b.db.exec("INSERT INTO desktop_ia_gastos VALUES('mesmo','2026-09-17',7000,'reservado','2026-09-17',NULL,NULL)");
 const c=a.b.capturar(),broken=structuredClone(c);broken.tabelas.priv_vinculos=[{fonte_id:99999,derivado_id:1}];
 let p=await b.b.preparar({arquivo:JSON.stringify(await cifrarBackup(broken,senha)),senha});assert.throws(()=>b.b.restaurar({id:p.id,confirmarMeuBackup:true}),/referências incompletas/);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);assert.deepEqual(readdirSync(b.arquivos.anexos),[]);assert.deepEqual(readdirSync(join(b.dir,'.restauracao')),[]);
 p=await b.b.preparar({arquivo:JSON.stringify(await cifrarBackup(c,senha)),senha});b.b.restaurar({id:p.id,confirmarMeuBackup:true});assert.equal(b.db.prepare('SELECT reservado_micros n FROM desktop_ia_gastos').get().n,7000);assert.equal(readdirSync(b.arquivos.anexos).length,1);assert.equal(readFileSync(join(b.arquivos.anexos,readdirSync(b.arquivos.anexos)[0]),'utf8'),'Anexo sem vínculo SQL');
});

test('tentativa inválida de backup descarta prévia antiga',async t=>{
 const a=env(t),b=env(t);a.ctx.nota({texto:'Fonte'});const arquivo=JSON.stringify((await a.b.criar({senha,confirmar:true})).pacote),p=await b.b.preparar({arquivo,senha});
 await assert.rejects(()=>b.b.preparar({arquivo,senha:'Senha incorreta longa'}),/Senha incorreta/);assert.throws(()=>b.b.restaurar({id:p.id,confirmarMeuBackup:true}),/expirada/);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);
});
