import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { exportarBackupV10, restaurarBackupV10, recuperarBackupV10 } from '../src/backup-acervo-operacao-v10.js';
import { MidiaArquivos } from '../src/ciclo-midia-worker.js';
import { processarUmaMidiaCiclo } from '../src/ciclo-midia-worker.js';
import { ArquivosDados } from '../src/arquivos-dados.js';
import { ContextoApp } from '../src/contexto-app.js';

const senha = 'senha sintética maior que doze caracteres';

test('operacao v10: cria arquivo, restaura apenas perfil novo e preserva origem', async () => {
  const f = await criarPerfilRealSintetico();
  try {
    f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c','m1','entrada','texto','{}','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run();
    f.db.close();
    const pacote = path.join(f.dir, 'copia.lumebak');
    const staging = path.join(f.dir, 'staging');
    const destinoNovo = path.join(f.dir, 'novo-perfil');
    await mkdir(staging);
    const exportado = await exportarBackupV10({ dbPath: f.dbPath, destino: pacote, senha, dono: 'Teste' });
    assert.equal(exportado.versao, 10);
    assert.ok((await readFile(pacote)).length > 100);
    await assert.rejects(restaurarBackupV10({ pacote, senha, raizStaging: staging, destinoNovo, confirmarMeuBackup: false }),
      { code: 'CONFIRMACAO_OBRIGATORIA' });
    const importado = await restaurarBackupV10({ pacote, senha, raizStaging: staging, destinoNovo, confirmarMeuBackup: true });
    assert.equal(importado.versao, 10);
    const db = new DatabaseSync(path.join(destinoNovo, 'data', 'assessor.db'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 1); } finally { db.close(); }
    await assert.rejects(restaurarBackupV10({ pacote, senha, raizStaging: staging, destinoNovo, confirmarMeuBackup: true }),
      { code: 'PERFIL_OCUPADO' });
    assert.equal((await recuperarBackupV10({ destinoNovo, publicadorEncerrado: true })).estado, 'sem-pendencia');
  } finally { try { f.db.close(); } catch {} }
});

test('operacao v10: não sobrescreve arquivo de backup existente', async () => {
  const f = await criarPerfilRealSintetico();
  try {
    f.db.close();
    const destino = path.join(f.dir, 'copia.lumebak');
    await writeFile(destino, 'original');
    await assert.rejects(exportarBackupV10({ dbPath: f.dbPath, destino, senha, dono: 'Teste' }), /Destino já existe/);
    assert.equal(await readFile(destino, 'utf8'), 'original');
  } finally { try { f.db.close(); } catch {} }
});

test('operacao v10: rejeita áudio .wav inválido antes de criar pacote final', async () => {
  const f = await criarPerfilRealSintetico();
  try {
    const dir = path.join(path.dirname(f.dbPath), 'anexos');
    await mkdir(dir);
    const audio = path.join(dir, 'audio-invalido.wav');
    await writeFile(audio, Buffer.from('não é WAV'));
    f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c','a1','entrada','audio','{}','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run();
    f.db.prepare(`INSERT INTO transcricoes(conversa_id,origem_id,arquivo,estado,criado_em)
      VALUES('c','a1',?,'vazio','2026-09-28T10:00:00.000Z')`).run(audio);
    f.db.close();
    const destino = path.join(f.dir, 'invalid.lumebak');
    await assert.rejects(exportarBackupV10({ dbPath: f.dbPath, destino, senha, dono: 'Teste' }),
      { code: 'ANEXO_FORMATO_INVALIDO' });
    await assert.rejects(readFile(destino), { code: 'ENOENT' });
  } finally { try { f.db.close(); } catch {} }
});

test('operacao v10: preserva original WhatsApp gerido com recibo e referência final',async()=>{
  const f=await criarPerfilRealSintetico();
  try{
    const arquivos=new MidiaArquivos(f.db,new ArquivosDados(f.dir));
    new ContextoApp(f.db).receber({messages:[{key:{remoteJid:'c',id:'audio-original'},
      message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100}]});
    const bytes=Buffer.from('original sintético do WhatsApp');
    assert.equal((await processarUmaMidiaCiclo(f.db,{arquivos,baixar:async()=>({
      base64:bytes.toString('base64'),mime:'audio/ogg'}),agora:new Date('2026-09-28T10:00:00.000Z')})).estado,'concluida');
    const evento=f.db.prepare("SELECT id FROM eventos WHERE origem_id='audio-original'").get().id;
    const sha=createHash('sha256').update(bytes).digest('hex');
    f.db.close();
    const pacote=path.join(f.dir,'midia.lumebak'),staging=path.join(f.dir,'staging'),destinoNovo=path.join(f.dir,'novo-perfil');
    await mkdir(staging);
    const exportado=await exportarBackupV10({dbPath:f.dbPath,destino:pacote,senha,dono:'Teste'});
    assert.equal(exportado.anexos,1);
    await restaurarBackupV10({pacote,senha,raizStaging:staging,destinoNovo,confirmarMeuBackup:true});
    const db=new DatabaseSync(path.join(destinoNovo,'data','assessor.db'),{readOnly:true});
    try{
      const media=db.prepare('SELECT * FROM ciclo_midias').get();
      assert.equal(media.evento_id,evento);
      assert.equal(media.sha256,sha);
      assert.equal(media.mime,'audio/ogg');
      assert.equal(media.tamanho,bytes.length);
      assert.deepEqual(await readFile(media.caminho),bytes);
    }finally{db.close();}
  }finally{await f.close();}
});
