// Independent cache-boundary tests: SQLite only, no live profile or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {comLeituraOrganizacao,memoLeituraOrganizacao,configOrganizacao,autorizacaoOrganizacao} from '../src/pessoal/organizacao-validade.js';
const GROUP='550000006001@g.us';
function fixture(t,{all=true}={}){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE desktop_config(chave TEXT PRIMARY KEY,valor TEXT);
    CREATE TABLE pessoal_politicas(conversa_id TEXT PRIMARY KEY,remoto INTEGER,atendimento TEXT);
    CREATE TABLE autorizacoes(conversa_id TEXT PRIMARY KEY,modo TEXT);
    CREATE TABLE desktop_ia_conversas(conversa_id TEXT PRIMARY KEY,permitida INTEGER,decidido_em TEXT);`);
  db.prepare('INSERT INTO desktop_config VALUES(?,?)').run('lume-1-organizacao-escopo',JSON.stringify({tipo:all?'todas':'autorizadas',revisao:'synthetic-initial'}));
  t.after(()=>db.close());return db;
}
test('cache: repeated and nested synchronous reads share one operation, next call rereads',t=>{
  const db=fixture(t);let reads=0;
  const read=()=>memoLeituraOrganizacao(db,'synthetic',()=>({version:++reads}));
  comLeituraOrganizacao(db,()=>{const a=read();assert.strictEqual(read(),a);assert.strictEqual(comLeituraOrganizacao(db,read),a);});
  assert.equal(reads,1);comLeituraOrganizacao(db,read);assert.equal(reads,2);
  read();read();assert.equal(reads,4,'outside an operation no result is cached');
});
test('cache: explicit IA revocation is visible on the next operation',t=>{
  const db=fixture(t);
  assert.equal(comLeituraOrganizacao(db,()=>autorizacaoOrganizacao(db,GROUP)).permitida,true);
  db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,0,?)').run(GROUP,'2026-10-28T12:00:00Z');
  const after=comLeituraOrganizacao(db,()=>autorizacaoOrganizacao(db,GROUP));assert.equal(after.permitida,false);assert.equal(after.excluida,true);
});
test('cache: exception discards cache and releases its read savepoint',t=>{
  const db=fixture(t),failure=new Error('synthetic exception');
  assert.throws(()=>comLeituraOrganizacao(db,()=>{assert.equal(configOrganizacao(db,'escopo').tipo,'todas');throw failure;}),e=>e===failure);
  db.exec('BEGIN');db.prepare('UPDATE desktop_config SET valor=? WHERE chave=?').run(JSON.stringify({tipo:'autorizadas',revisao:'changed'}),'lume-1-organizacao-escopo');db.exec('COMMIT');
  assert.equal(comLeituraOrganizacao(db,()=>autorizacaoOrganizacao(db,GROUP)).permitida,false);
});
test('cache: rolled-back permission read never survives into subsequent operation',t=>{
  const db=fixture(t,{all:false});
  assert.equal(comLeituraOrganizacao(db,()=>autorizacaoOrganizacao(db,GROUP)).permitida,false);
  db.exec('BEGIN');
  db.prepare('UPDATE desktop_config SET valor=? WHERE chave=?').run(JSON.stringify({tipo:'todas',revisao:'transient'}),'lume-1-organizacao-escopo');
  assert.equal(comLeituraOrganizacao(db,()=>autorizacaoOrganizacao(db,GROUP)).permitida,true);
  db.exec('ROLLBACK');
  assert.equal(comLeituraOrganizacao(db,()=>autorizacaoOrganizacao(db,GROUP)).permitida,false);
  assert.equal(configOrganizacao(db,'escopo').revisao,'synthetic-initial');
});
test('cache: connections have independent operation scopes',t=>{
  const a=fixture(t),b=fixture(t,{all:false});
  comLeituraOrganizacao(a,()=>{assert.equal(autorizacaoOrganizacao(a,GROUP).permitida,true);assert.equal(comLeituraOrganizacao(b,()=>autorizacaoOrganizacao(b,GROUP)).permitida,false);});
});
test('cache: nested exception caught by reader does not strand the outer scope',t=>{
  const db=fixture(t);let reads=0;
  comLeituraOrganizacao(db,()=>{const first=memoLeituraOrganizacao(db,'value',()=>++reads);assert.throws(()=>comLeituraOrganizacao(db,()=>{throw Error('nested');}));assert.equal(memoLeituraOrganizacao(db,'value',()=>++reads),first);});
  assert.equal(comLeituraOrganizacao(db,()=>memoLeituraOrganizacao(db,'value',()=>++reads)),2);
});
test('cache: asynchronous outer and nested callbacks are rejected',t=>{
  const db=fixture(t);
  assert.throws(()=>comLeituraOrganizacao(db,()=>Promise.resolve()),/síncrona/);
  comLeituraOrganizacao(db,()=>{assert.throws(()=>comLeituraOrganizacao(db,()=>Promise.resolve()),/síncrona/);});
  db.exec('BEGIN');db.exec('ROLLBACK');
});
test('cache: entry budget falls back to fresh reads, never uncapped caching',t=>{
  const db=fixture(t);let afterLimit=0;
  comLeituraOrganizacao(db,()=>{for(let i=0;i<10000;i++)memoLeituraOrganizacao(db,'bounded-'+i,()=>i);
    assert.equal(memoLeituraOrganizacao(db,'overflow',()=>++afterLimit),1);assert.equal(memoLeituraOrganizacao(db,'overflow',()=>++afterLimit),2);});
});
