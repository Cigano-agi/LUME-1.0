import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {neon,neonConfig} from '@neondatabase/serverless';
import {migrarCentral,separarComandosSql} from '../scripts/central-migrations-lib.mjs';

test('SQL da Central vira comandos sem dividir strings, comentários ou blocos',()=>{
  assert.deepEqual(separarComandosSql("-- comentário;\nCREATE TABLE exemplo (texto text DEFAULT 'a;''b'); /* bloco; /* interno; */ */ UPDATE exemplo SET texto=$tag$x;y$tag$;"),[
    "-- comentário;\nCREATE TABLE exemplo (texto text DEFAULT 'a;''b')",
    '/* bloco; /* interno; */ */ UPDATE exemplo SET texto=$tag$x;y$tag$'
  ]);
  assert.throws(()=>separarComandosSql('CREATE TABLE incompleta (id int)'),/ponto e vírgula/);
  assert.throws(()=>separarComandosSql("SELECT 'texto sem fim;"),/incompleta/);
});

test('driver Neon agrupa comandos e marcador em uma única requisição transacional',async t=>{
  const anterior=neonConfig.fetchFunction;
  t.after(()=>{neonConfig.fetchFunction=anterior;});
  const requisicoes=[];
  neonConfig.fetchFunction=async(_url,opcoes)=>{requisicoes.push(JSON.parse(opcoes.body));throw Error('FETCH_SINTETICO');};
  const sql=neon('postgresql://teste:teste@exemplo.neon.tech/lume?sslmode=require');
  await assert.rejects(sql.transaction([
    sql.query('CREATE TABLE teste (id int)',[]),
    sql.query('INSERT INTO lume_schema_migrations(nome,checksum) VALUES($1,$2)',['001-teste.sql','abc'])
  ]));
  assert.equal(requisicoes.length,1);
  assert.equal(requisicoes[0].queries.length,2);
  assert.match(requisicoes[0].queries[0].query,/CREATE TABLE teste/);
  assert.match(requisicoes[0].queries[1].query,/INSERT INTO lume_schema_migrations/);
});

test('cinco migrações e marcadores são enviados em transações por arquivo; repetição não reaplica',async()=>{
  const aplicadas=new Map(),transacoes=[];
  const sql={
    query(texto,parametros=[]){
      if(texto.startsWith('CREATE TABLE IF NOT EXISTS lume_schema_migrations'))return Promise.resolve([]);
      if(texto==='SELECT nome,checksum FROM lume_schema_migrations')return Promise.resolve([...aplicadas].map(([nome,checksum])=>({nome,checksum})));
      return {texto,parametros};
    },
    async transaction(comandos){
      transacoes.push(comandos);
      const marcador=comandos.at(-1);
      assert.equal(marcador.texto,'INSERT INTO lume_schema_migrations(nome,checksum) VALUES($1,$2)');
      assert.ok(comandos.length>=2);
      assert.ok(comandos.slice(0,-1).every(item=>!item.texto.includes('lume_schema_migrations')&&!item.texto.endsWith(';')));
      aplicadas.set(...marcador.parametros);
    }
  };
  assert.deepEqual(await migrarCentral({sql}),{total:5,novas:5});
  assert.deepEqual(transacoes.map(grupo=>grupo.length),[5,4,3,2,3]);
  assert.deepEqual(await migrarCentral({sql}),{total:5,novas:0});
  assert.equal(transacoes.length,5);
});

test('falha da transação preserva a ausência do marcador e alteração aplicada é recusada',async t=>{
  const raiz=await mkdtemp(join(tmpdir(),'lume-central-migrations-'));
  t.after(()=>rm(raiz,{recursive:true,force:true}));
  const pasta=join(raiz,'migrations');await mkdir(pasta);
  const caminho=join(pasta,'001-teste.sql');await writeFile(caminho,'CREATE TABLE teste (id int);');
  const url=pathToFileURL(pasta+'/');
  const aplicadas=new Map();let falhar=true;
  const sql={
    query(texto,parametros=[]){
      if(texto.startsWith('CREATE TABLE IF NOT EXISTS lume_schema_migrations'))return Promise.resolve([]);
      if(texto==='SELECT nome,checksum FROM lume_schema_migrations')return Promise.resolve([...aplicadas].map(([nome,checksum])=>({nome,checksum})));
      return {texto,parametros};
    },
    async transaction(comandos){if(falhar)throw Error('falha simulada');aplicadas.set(...comandos.at(-1).parametros);}
  };
  await assert.rejects(migrarCentral({sql,pasta:url}),/falha simulada/);
  assert.equal(aplicadas.size,0);
  falhar=false;
  assert.deepEqual(await migrarCentral({sql,pasta:url}),{total:1,novas:1});
  await writeFile(caminho,(await readFile(caminho,'utf8'))+'\n-- alteração posterior');
  await assert.rejects(migrarCentral({sql,pasta:url}),/Migração alterada após aplicação/);
});
