import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {criarPerfilRealSintetico} from './fixtures/backup-schema-real.js';
import {prepararPessoal} from '../src/pessoal/esquema.js';
import {exigirPessoalSemConteudo,TABELAS_PESSOAIS} from '../src/pessoal/preservacao.js';
import {Backup,cifrarBackup} from '../src/backup.js';
import {criarOrigemV9} from '../src/backup-acervo-v9.js';
import {criarOrigemV10} from '../src/backup-acervo-v10.js';
import {Privacidade} from '../src/privacidade.js';
import {ContextoApp} from '../src/contexto-app.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {AudioArquivos} from '../src/audio-desktop-arquivos.js';

const BLOQUEIO={code:'PESSOAL_DADOS_NAO_MAPEADOS'};
const senha='senha fictícia de preservação';
async function env(t){
  const f=await criarPerfilRealSintetico();t.after(()=>f.close());prepararPessoal(f.db);
  const arquivos=new ArquivosDados(f.dir),backup=new Backup(f.db,{arquivos,perfil:()=>({nome:'Pessoa fictícia'})});
  return {...f,arquivos,backup,ctx:new ContextoApp(f.db),priv:new Privacidade(f.db,{arquivos})};
}
function inbox(db){db.prepare("INSERT INTO telegram_entradas(bot_id,update_id,dono_id,entrada,criada_em) VALUES('bot-ficticio',1,'dono-ficticio','mensagem preservar','2026-10-26')").run();}
function correcao(db){db.prepare("INSERT INTO desktop_config VALUES('pessoal:correcoes:contexto-ficticio','correção preservar')").run();}
function assistencia(db){
  const evento=Number(db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('dm-ficticia','m1','entrada','texto','{}','fonte preservar','2026-10-26','2026-10-26','minha')").run().lastInsertRowid);
  db.prepare("INSERT INTO etapas(evento_id,etapa,estado,atualizado_em) VALUES(?,'assistencia','pendente','2026-10-26')").run(evento);
}
function dados(db){
  const tables=['eventos','etapas','desktop_config','priv_recibos',...TABELAS_PESSOAIS];
  return JSON.stringify(Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT * FROM "${t}"`).all()])));
}

test('preservação: cada journal pessoal povoado fecha o guard; tabela vazia permite',()=>{
  for(const tabela of TABELAS_PESSOAIS){
    // The guard intentionally operates before relying on extension column schemas.
    const db=new DatabaseSync(':memory:');try{
      db.exec(`CREATE TABLE "${tabela}"(valor TEXT)`);assert.doesNotThrow(()=>exigirPessoalSemConteudo(db));
      db.prepare(`INSERT INTO "${tabela}" VALUES(?)`).run('registro fictício preservar');assert.throws(()=>exigirPessoalSemConteudo(db),BLOQUEIO);
      assert.equal(db.prepare(`SELECT valor FROM "${tabela}"`).get().valor,'registro fictício preservar');
    }finally{db.close();}
  }
});

test('preservação: configuração colon, enabled e estado desconhecido bloqueiam; metadados inertes permitem',async t=>{
  const f=await env(t);
  for(const chave of ['pessoal-chatgpt-host','pessoal-chatgpt-model','pessoal-chatgpt-verified','pessoal-chatgpt-paused'])f.db.prepare('INSERT INTO desktop_config VALUES(?,?)').run(chave,'metadado fictício');
  f.db.prepare("INSERT INTO desktop_config VALUES('pessoal-enabled','0')").run();assert.doesNotThrow(()=>exigirPessoalSemConteudo(f.db));
  for(const [chave,valor] of [['pessoal:correcoes:abc','conteúdo'],['pessoal-outro-estado','recibo'],['pessoal-enabled','1']]){
    f.db.prepare('INSERT OR REPLACE INTO desktop_config VALUES(?,?)').run(chave,valor);
    assert.throws(()=>exigirPessoalSemConteudo(f.db),BLOQUEIO);assert.equal(f.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(chave).valor,valor);
    f.db.prepare('DELETE FROM desktop_config WHERE chave=?').run(chave);
  }
});

test('preservação: esquemas pessoais vazios conservam exportação e exclusão anteriores',async t=>{
  const f=await env(t),id=f.ctx.nota({texto:'Nota fictícia que pode ser exportada'}).id;
  assert.doesNotThrow(()=>f.priv.schemaConhecido());assert.doesNotThrow(()=>f.backup.capturar());
  const exportacao=f.priv.exportar({confirmar:true});assert.ok(JSON.stringify(exportacao).includes('Nota fictícia'));
  const previa=f.priv.preparar({fonte:id});f.priv.excluir({id:previa.id,confirmar:'APAGAR'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);
});

for(const [nome,semear] of [['inbox Telegram',inbox],['configuração colon',correcao],['etapa assistência',assistencia]]){
  test(`preservação: ${nome} bloqueia backup/exportação/exclusão antes de alterar dados`,async t=>{
    const f=await env(t);semear(f.db);const antes=dados(f.db);
    assert.throws(()=>f.backup.capturar(),BLOQUEIO);
    await assert.rejects(()=>f.backup.criar({senha,confirmar:true}),BLOQUEIO);
    assert.throws(()=>f.priv.exportar({confirmar:true}),BLOQUEIO);
    assert.throws(()=>f.priv.preparar({tudo:true}),BLOQUEIO);
    assert.equal(dados(f.db),antes);
  });
}

test('preservação: conteúdo pessoal surgido após prévia de exclusão impede apagar fonte',async t=>{
  const f=await env(t),id=f.ctx.nota({texto:'Fonte preservada após prévia'}).id,previa=f.priv.preparar({fonte:id});
  inbox(f.db);const antes=dados(f.db);
  assert.throws(()=>f.priv.excluir({id:previa.id,confirmar:'APAGAR'}),BLOQUEIO);assert.equal(dados(f.db),antes);
});

test('preservação: backup legado restaura no perfil com tabelas pessoais vazias',async t=>{
  const fonte=await env(t),destino=await env(t);fonte.ctx.nota({texto:'Nota fictícia restaurável'});
  const pacote=JSON.stringify(await cifrarBackup(fonte.backup.capturar(),senha));
  const previa=await destino.backup.preparar({arquivo:pacote,senha});const r=destino.backup.restaurar({id:previa.id,confirmarMeuBackup:true});
  assert.equal(r.eventos,1);assert.equal(destino.db.prepare('SELECT texto FROM eventos').get().texto,'Nota fictícia restaurável');
});

for(const [nome,semear] of [['inbox Telegram',inbox],['configuração colon',correcao],['etapa assistência',assistencia]]){
  test(`preservação: ${nome} inserido após prévia bloqueia restauro sem perda`,async t=>{
    const fonte=await env(t),destino=await env(t);fonte.ctx.nota({texto:'Nota do backup fictício'});
    const pacote=JSON.stringify(await cifrarBackup(fonte.backup.capturar(),senha));
    const previa=await destino.backup.preparar({arquivo:pacote,senha});semear(destino.db);const antes=dados(destino.db);
    assert.throws(()=>destino.backup.restaurar({id:previa.id,confirmarMeuBackup:true}),BLOQUEIO);
    assert.equal(dados(destino.db),antes);assert.equal(destino.backup.previa.id,previa.id);
  });
}

for(const [versao,criar] of [[9,criarOrigemV9],[10,criarOrigemV10]]){
  test(`preservação: exportador v${versao} aceita esquemas pessoais vazios`,async t=>{
    const f=await env(t),antes=dados(f.db);const source=await criar({dbPath:f.dbPath,perfil:{dono:'Pessoa fictícia'}});
    try{let bytes=0;for await(const b of source.origem)bytes+=b.length;assert.ok(bytes>0);}finally{await source.fechar();}
    assert.equal(dados(f.db),antes);
  });
  for(const [nome,semear] of [['inbox',inbox],['config colon',correcao],['assistencia',assistencia]]){
    test(`preservação: exportador v${versao} rejeita ${nome} sem emitir cópia incompleta`,async t=>{
      const f=await env(t);semear(f.db);const antes=dados(f.db);
      await assert.rejects(()=>criar({dbPath:f.dbPath,perfil:{dono:'Pessoa fictícia'}}),BLOQUEIO);
      assert.equal(dados(f.db),antes);
    });
  }
}

test('preservação: consulta de anexos continua com inbox/config e mantém arquivo referenciado',async t=>{
  const f=await env(t);inbox(f.db);correcao(f.db);const audio=new AudioArquivos(f.db,f.arquivos);
  const id='123e4567-e89b-42d3-a456-426614174000',path=audio.caminho(id);mkdirSync(f.arquivos.anexos,{recursive:true});writeFileSync(path,'áudio fictício');
  f.db.prepare("INSERT INTO transcricoes(conversa_id,origem_id,arquivo,texto,estado,criado_em) VALUES('c','a',?,'fala fictícia','transcrito','2026-10-26')").run(path);
  assert.doesNotThrow(()=>f.priv.schemaConhecido({consultaAnexos:true}));assert.equal(audio.emUso(path),true);
  mkdirSync(audio.journals,{recursive:true});writeFileSync(audio.journal(id),JSON.stringify({id,anterior:null}));
  audio.finalizar(id);assert.equal(existsSync(path),true);assert.equal(readFileSync(path,'utf8'),'áudio fictício');assert.equal(existsSync(audio.journal(id)),false);
  assert.throws(()=>f.priv.schemaConhecido(),BLOQUEIO);
});

test('preservação: consulta de anexos não permite extensão desconhecida povoada',async t=>{
  const f=await env(t);inbox(f.db);f.db.exec("CREATE TABLE extensao_desconhecida(valor TEXT);INSERT INTO extensao_desconhecida VALUES('arquivo preservar')");
  const audio=new AudioArquivos(f.db,f.arquivos);
  assert.throws(()=>f.priv.schemaConhecido({consultaAnexos:true}),/extensão não mapeada/);
  assert.throws(()=>audio.emUso(join(f.dir,'desconhecido.wav')),/extensão não mapeada/);
});
