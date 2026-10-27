import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync,
  unlinkSync, symlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { NotetakerServico } from '../src/notetaker/servico.js';
import { cabecalhoWav } from '../src/notetaker/contrato.js';
import { importarArquivo } from '../src/notetaker/importacao.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { exportarSessao } from '../src/notetaker/exportacao.js';
import { selecionarDireitosSessao, validarPublicacaoSessao } from '../src/notetaker/direitos-selecao.js';

const sha = x => createHash('sha256').update(x).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lume-notetaker-export-'));
  const marker = randomUUID(), previous = process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = root;
  writeFileSync(join(root, '.lume-notetaker-test'), marker);
  const dbPath = join(root, 'db.sqlite'), db = abrirBanco(dbPath);
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
    else process.env.ASSESSOR_DESKTOP_TEST_PROFILE = previous;
    rmSync(root, { recursive: true, force: true });
  });
  new ContextoApp(db); new Desktop(db);
  const svc = new NotetakerServico(db, { notetakerExperimento: true, testProfileRoot: root,
    testMarker: marker, audioLocal: { async estado() { return { disponivel: false }; } } });
  const sessaoId = svc.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
  svc.consentir(sessaoId, { entradas: ['importacao'], confirmar: true });
  const destinoPai = join(root, 'exportacoes'); mkdirSync(destinoPai);
  const partes = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID(), wav = Buffer.concat([cabecalhoWav(32000), Buffer.alloc(32000, i + 1)]);
    writeFileSync(join(root, 'notetaker-audio', id + '.wav'), wav);
    db.prepare(`INSERT INTO notetaker_partes(id,sessao_id,entrada,posicao,inicio_ms,duracao_ms,sha256,caminho,estado)
      VALUES(?,?,'importacao',?,?,1000,?,?,'salva')`).run(id, sessaoId, i, i * 1000, sha(wav), id + '.wav');
    partes.push({ id, wav });
  }
  const perfil = { testProfileRoot: root, testMarker: marker };
  return { root, db, dbPath, sessaoId, destinoPai, perfil, partes,
    args: { dbPath, sessaoId, destinoPai, perfil, confirmar: true } };
}

test('exporta duas partes com manifesto verificável e preserva originais e banco', async t => {
  const f = fixture(t), antes = f.db.prepare('SELECT COUNT(*) n FROM notetaker_partes').get().n;
  const r = await exportarSessao(f.args);
  const linhas = readFileSync(join(r.pasta, 'dados.ndjson'));
  const manifesto = JSON.parse(readFileSync(join(r.pasta, 'manifesto.json')));
  const final = JSON.parse(readFileSync(join(r.pasta, 'CONCLUIDO.json')));
  assert.equal(manifesto.sessaoId, f.sessaoId);
  assert.equal(manifesto.dados.sha256, sha(linhas));
  assert.equal(final.manifestoSha256, sha(readFileSync(join(r.pasta, 'manifesto.json'))));
  assert.equal(manifesto.audios.length, 2);
  assert.ok(linhas.toString().includes('notetaker_partes'));
  for (const p of f.partes) {
    assert.deepEqual(readFileSync(join(r.pasta, 'audio', p.id + '.wav')), p.wav);
    assert.deepEqual(readFileSync(join(f.root, 'notetaker-audio', p.id + '.wav')), p.wav);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_partes').get().n, antes);
});

test('falha fechada sem confirmação e com destino inválido', async t => {
  const f = fixture(t);
  await assert.rejects(exportarSessao({ ...f.args, confirmar: false }), { code: 'ENTRADA' });
  await assert.rejects(exportarSessao({ ...f.args, destinoPai: f.root }), { code: 'ENTRADA' });
  assert.deepEqual(readdirSync(f.destinoPai), []);
});

test('original corrompido não produz marcador', async t => {
  const f = fixture(t), original = join(f.root, 'notetaker-audio', f.partes[0].id + '.wav');
  writeFileSync(original, Buffer.from('corrompido'));
  await assert.rejects(exportarSessao(f.args), { code: 'INTEGRIDADE' });
  assert.deepEqual(readdirSync(f.destinoPai), []);
});

test('percurso real: duas partes importadas, correção, derivado e contexto saem sem autoridade', async t => {
  const f=fixture(t),texto='Enviar o resumo sintético da reunião amanhã.';
  const svc=new NotetakerServico(f.db,{notetakerExperimento:true,...f.perfil,
    audioLocal:{async estado(){return {disponivel:true};},async transcrever(bytes){
      return {motor:'whisper.cpp',modeloSha256:'a'.repeat(64),audioSha256:sha(bytes),
        trechos:[{inicioMs:0,fimMs:500,texto}]};
    }}});
  const sessao=svc.criarSessao({origem:'importacao',entradas:['importacao']}).id;
  svc.consentir(sessao,{entradas:['importacao'],confirmar:true});
  const wav=Buffer.concat([cabecalhoWav(61*32000),Buffer.alloc(61*32000,3)]);
  await importarArquivo({headers:{'content-length':String(wav.length)},complete:true,
    async *[Symbol.asyncIterator](){yield wav;}},{servico:svc,sessaoId:sessao});
  assert.equal((await svc.transcreverImportacao(sessao)).estado,'concluida');
  const partes=f.db.prepare('SELECT id,sha256 FROM notetaker_partes WHERE sessao_id=? ORDER BY posicao').all(sessao);
  assert.equal(partes.length,2);
  const trecho=f.db.prepare('SELECT id FROM notetaker_trechos WHERE parte_id=?').get(partes[0].id).id;
  svc.corrigirTrecho(trecho,{texto:'Resumo sintético revisado da reunião.',revisaoEsperada:0,confirmar:true});
  const evento=f.db.prepare('SELECT evento_id FROM notetaker_fontes WHERE trecho_id=?').get(trecho).evento_id;
  const nota=f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada',NULL,1,'nota','{}','Nota sintética derivada.','2026-09-27T12:01:00Z','2026-09-27','minha') RETURNING id`)
    .get('nota:'+randomUUID(),randomUUID()).id;
  f.db.prepare('INSERT INTO priv_vinculos(fonte_id,derivado_id) VALUES(?,?)').run(evento,nota);
  new AcoesLume(f.db).registrar({eventoId:evento,candidatas:[{fonte:'E'+evento,tipo:'pendencia',
    resumo:'Enviar resumo',trecho:'Resumo sintético revisado da reunião.',prazo_citado:''}]});
  const acao=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(evento).id;
  const contexto=new ExecucoesLume(f.db).preparar({acao_id:acao}).contexto;
  const r=await exportarSessao({...f.args,sessaoId:sessao});
  const linhas=readFileSync(join(r.pasta,'dados.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(linhas.filter(x=>x.tabela==='notetaker_partes').length,2);
  assert.equal(linhas.filter(x=>x.tabela==='notetaker_correcoes').length,1);
  assert.ok(linhas.some(x=>x.tabela==='eventos'&&x.registro.id===nota));
  const ctx=linhas.find(x=>x.tabela==='lume_execucao_contextos'&&x.registro.id===contexto.id).registro;
  assert.equal(ctx.rotulo,'historico_sem_autorizacao');
  assert.equal(ctx.pacote.autorizacao,undefined);assert.equal(ctx.pacote.instrucoes,undefined);
  assert.ok(!linhas.some(x=>/grant|guardas/.test(x.tabela)));
  for(const p of partes){
    const original=readFileSync(join(f.root,'notetaker-audio',p.id+'.wav'));
    assert.equal(sha(original),p.sha256);
    assert.deepEqual(readFileSync(join(r.pasta,'audio',p.id+'.wav')),original);
  }
});

test('revogação durante a cópia é vista na leitura final', async t => {
  const f = fixture(t);
  await assert.rejects(exportarSessao({ ...f.args, testHooks: { aposCopiarAudio() {
    f.db.prepare('UPDATE notetaker_sessoes SET direitos_revogados_em=? WHERE id=?')
      .run('2026-09-27T12:00:00Z', f.sessaoId);
  } } }), { code: 'DIREITO' });
  assert.deepEqual(readdirSync(f.destinoPai), []);
});

test('aborto prévio e durante cópia fecha sem pasta publicada', async t => {
  const f = fixture(t), ac = new AbortController(); ac.abort();
  await assert.rejects(exportarSessao({ ...f.args, signal: ac.signal }), { code: 'CANCELADO' });
  const during = new AbortController();
  await assert.rejects(exportarSessao({ ...f.args, signal: during.signal,
    testHooks: { aposChunk() { during.abort(); } } }), { code: 'CANCELADO' });
  assert.deepEqual(readdirSync(f.destinoPai), []);
});

test('AbortSignal externo cancela após ceder o event loop', async t => {
  const f=fixture(t), ac=new AbortController();let agendado=false;
  await assert.rejects(exportarSessao({...f.args,signal:ac.signal,testHooks:{aposChunk(){
    if(!agendado){agendado=true;setImmediate(()=>ac.abort());}
  }}}),{code:'CANCELADO'});
  assert.ok(agendado);assert.deepEqual(readdirSync(f.destinoPai),[]);
});

test('segunda conexão revoga durante cópia e não consegue vencer janela final', async t => {
  const f=fixture(t), outro=new DatabaseSync(f.dbPath);let agendado=false;
  try{
    await assert.rejects(exportarSessao({...f.args,testHooks:{aposChunk(){
      if(!agendado){agendado=true;setImmediate(()=>outro.prepare(
        'UPDATE notetaker_sessoes SET direitos_revogados_em=? WHERE id=?').run('2026-09-27T12:00:00Z',f.sessaoId));}
    }}}),{code:'DIREITO'});
    assert.ok(agendado);assert.deepEqual(readdirSync(f.destinoPai),[]);
    outro.prepare('UPDATE notetaker_sessoes SET direitos_revogados_em=NULL WHERE id=?').run(f.sessaoId);
    let bloqueado=false;
    const result=await exportarSessao({...f.args,testHooks:{antesMarcador(){
      try{outro.prepare('UPDATE notetaker_sessoes SET revisao=revisao+1 WHERE id=?').run(f.sessaoId);}
      catch(e){bloqueado=e.code==='ERR_SQLITE_ERROR';}
    }}});
    assert.ok(bloqueado);
    assert.ok(JSON.parse(readFileSync(join(result.pasta,'CONCLUIDO.json'))).manifestoSha256);
  }finally{outro.close();}
});

test('falha de escrita, exceção final e cleanup incerto não dão sucesso', async t => {
  const f=fixture(t);
  await assert.rejects(exportarSessao({...f.args,testHooks:{escrever(){return 0;}}}),{code:'IO'});
  await assert.rejects(exportarSessao({...f.args,testHooks:{escrever(){throw Object.assign(new Error('disco'),{code:'ENOSPC'});}}}),{code:'IO'});
  await assert.rejects(exportarSessao({...f.args,testHooks:{antesMarcador(){throw Error('falha final');}}}),{code:'IO'});
  assert.deepEqual(readdirSync(f.destinoPai),[]);
  let pendente;
  try{await exportarSessao({...f.args,testHooks:{antesMarcador(){
    const nome=readdirSync(f.destinoPai)[0];renameSync(join(f.destinoPai,nome),join(f.destinoPai,'movido'));
    throw Error('pasta movida');
  }}});}catch(e){pendente=e;}
  assert.equal(pendente?.code,'IO');assert.equal(pendente?.limpezaPendente,true);
  assert.ok(!readdirSync(join(f.destinoPai,'movido')).includes('CONCLUIDO.json'));
});

test('marcador final truncado não é aceito como sucesso', async t => {
  const f=fixture(t);let final=false,primeiro=true;
  await assert.rejects(exportarSessao({...f.args,testHooks:{antesMarcador(){final=true;},
    escrever(fd,buf,offset,length){
      if(!final)return writeSync(fd,buf,offset,length);
      if(primeiro){primeiro=false;return writeSync(fd,buf,offset,1);}
      return 0;
    }}}),{code:'IO'});
  assert.deepEqual(readdirSync(f.destinoPai),[]);
});

test('dados adulterados antes do marcador impedem publicação', async t => {
  const f=fixture(t);
  await assert.rejects(exportarSessao({...f.args,testHooks:{antesMarcador(){
    const pasta=join(f.destinoPai,readdirSync(f.destinoPai)[0]);
    const path=join(pasta,'dados.ndjson'),bytes=readFileSync(path);
    bytes[0]^=1;writeFileSync(path,bytes);
  }}}),{code:'INTEGRIDADE'});
  assert.deepEqual(readdirSync(f.destinoPai),[]);
});

test('WAV exportado trocado por symlink impede publicação e não é apagado às cegas', async t => {
  const f=fixture(t);let support=true;
  const falha=await exportarSessao({...f.args,testHooks:{antesMarcador(){
    const pasta=join(f.destinoPai,readdirSync(f.destinoPai)[0]);
    const out=join(pasta,'audio',f.partes[0].id+'.wav');unlinkSync(out);
    try{symlinkSync(join(f.root,'notetaker-audio',f.partes[0].id+'.wav'),out);}
    catch(e){if(e.code==='EPERM')support=false;throw e;}
  }}}).then(()=>null,e=>e);
  if(!support){t.skip('symlink indisponível nesta plataforma');return;}
  assert.equal(falha?.code,'INTEGRIDADE');
  assert.equal(falha?.limpezaPendente,true);
  const pasta=join(f.destinoPai,readdirSync(f.destinoPai)[0]);
  assert.ok(!readdirSync(pasta).includes('CONCLUIDO.json'));
});

test('original ausente e symlink são recusados sem abrir destino persistente', async t => {
  const f=fixture(t), path=join(f.root,'notetaker-audio',f.partes[0].id+'.wav');
  unlinkSync(path);
  await assert.rejects(exportarSessao(f.args),{code:'INTEGRIDADE'});
  assert.deepEqual(readdirSync(f.destinoPai),[]);
  try{symlinkSync(join(f.root,'notetaker-audio',f.partes[1].id+'.wav'),path);}
  catch(e){if(e.code==='EPERM'){t.skip('symlink indisponível nesta plataforma');return;}throw e;}
  await assert.rejects(exportarSessao(f.args),{code:'INTEGRIDADE'});
  assert.deepEqual(readdirSync(f.destinoPai),[]);
});

test('revisão externa durante cópia impede marcador e mantém transação liberada', async t => {
  const f=fixture(t),outro=new DatabaseSync(f.dbPath);let uma=false;
  try{
    await assert.rejects(exportarSessao({...f.args,testHooks:{aposChunk(){
      if(!uma){uma=true;setImmediate(()=>outro.prepare(
        'UPDATE notetaker_sessoes SET revisao=revisao+1 WHERE id=?').run(f.sessaoId));}
    }}}),{code:'CONFLITO'});
    assert.ok(uma);assert.deepEqual(readdirSync(f.destinoPai),[]);
    assert.equal(f.db.isTransaction,false);
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(),undefined);
  }finally{outro.close();}
});

test('finalizador recusa callback assíncrono e thenable sem deixar transação', t => {
  const f=fixture(t),mapa=selecionarDireitosSessao(f.db,f.sessaoId,f.perfil);
  assert.throws(()=>validarPublicacaoSessao(f.db,mapa,f.perfil,async()=>{}),{code:'ENTRADA'});
  assert.throws(()=>validarPublicacaoSessao(f.db,mapa,f.perfil,()=>({then(){}})),{code:'ENTRADA'});
  assert.equal(f.db.isTransaction,false);
});

test('cobertura parcial explícita e completa apenas com importação e ASR completas', async t => {
  const f=fixture(t),parcial=await exportarSessao(f.args);
  assert.equal(parcial.manifesto.cobertura.tipo,'parcial');
  f.db.prepare("UPDATE notetaker_sessoes SET importacao_estado='completa',asr_estado='concluida' WHERE id=?")
    .run(f.sessaoId);
  const completo=await exportarSessao(f.args);
  assert.equal(completo.manifesto.cobertura.tipo,'completa');
});
