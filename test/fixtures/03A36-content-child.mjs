import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abrirBanco } from '../../src/banco.js';
import { ContextoApp } from '../../src/contexto-app.js';
import { Desktop } from '../../src/desktop.js';
import { prepararProjetosComerciais } from '../../src/projetos-comerciais/esquema.js';
import { prepararTarefas } from '../../src/tarefas-esquema.js';
import { assinaturaFonte } from '../../src/tarefas-esquema.js';
import { prepararComandosWhatsapp } from '../../src/comandos-whatsapp.js';
import { prepararAcoesLume } from '../../src/acoes-lume.js';
import { prepararExecucoes } from '../../src/execucao/esquema.js';
import { NotetakerServico } from '../../src/notetaker/servico.js';
import { cabecalhoWav } from '../../src/notetaker/contrato.js';
import { montarPlanoExclusao } from '../../src/notetaker/exclusao-plano.js';
import { selecionarPerfilBoot } from '../../src/perfil-boot.js';

const [mode, rootArg] = process.argv.slice(2);
const root = realpathSync(rootArg);
assert.equal(realpathSync(tmpdir()), root);
const profileRoot = join(root, 'lume-notetaker-content');
const statePath = join(root, 'content-state.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

if (mode === 'setup' || mode === 'setup-zero') {
  mkdirSync(profileRoot);
  const marker = randomUUID();
  writeFileSync(join(profileRoot, '.lume-notetaker-test'), marker, { flag: 'wx' });
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = profileRoot;
  mkdirSync(join(profileRoot, 'data')); mkdirSync(join(profileRoot, 'credenciais'));
  const db = abrirBanco(join(profileRoot, 'data', 'assessor.db'));
  try {
    new ContextoApp(db); new Desktop(db); prepararProjetosComerciais(db); prepararTarefas(db); prepararComandosWhatsapp(db);
    const service = new NotetakerServico(db, { notetakerExperimento: true, testProfileRoot: profileRoot, testMarker: marker,
      audioLocal:{async estado(){return {disponivel:true};},async transcrever(bytes){return {motor:'whisper.cpp',modeloSha256:'a'.repeat(64),
        audioSha256:hash(bytes),trechos:[{inicioMs:0,fimMs:500,texto:'Conteudo sintetico C1.'}]};}} });
    const sessaoId = service.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
    service.consentir(sessaoId, { entradas: ['importacao'], confirmar: true });
    let sentinels=null;
    if(mode==='setup'){
      const active = service.iniciarImportacao(sessaoId);
      const parts = [Buffer.concat([cabecalhoWav(32000), Buffer.alloc(32000, 1)]), Buffer.concat([cabecalhoWav(16000), Buffer.alloc(16000, 2)])];
      try {
        parts.forEach((bytes, posicao) => service.guardarParte(sessaoId, { posicao, bytes }));
        service.marcarImportacao(sessaoId, 'completa', hash(Buffer.concat(parts)), parts.reduce((n, x) => n + x.length, 0));
      } finally { active.liberar(); }
      service.reconciliar();
      assert.equal((await service.transcreverImportacao(sessaoId)).estado,'concluida');
      const internalEvent=db.prepare('SELECT evento_id FROM notetaker_fontes WHERE sessao_id=? ORDER BY evento_id LIMIT 1').get(sessaoId).evento_id;
      const internalSource=db.prepare('SELECT texto,permissao,conversa_id,origem_id,recebido_em,projeto_id,origem_compartilhamento,autor_id,autor_e_dono,transcricao_meta FROM desktop_fontes WHERE id=?').get(internalEvent);
      const sourceSignature=assinaturaFonte(internalSource);
      const externalEvent=db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
        VALUES('external-c1','external-origin','entrada',1,'texto','{}','Sentinela externa C1','2026-09-27T12:00:00Z','2026-09-27','minha') RETURNING id`).get().id;
      const externalSource=db.prepare('SELECT texto,permissao,conversa_id,origem_id,recebido_em,projeto_id,origem_compartilhamento,autor_id,autor_e_dono,transcricao_meta FROM desktop_fontes WHERE id=?').get(externalEvent);
      const externalSignature=assinaturaFonte(externalSource);
      const derivedEvent=db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
        VALUES('derived-c1','derived-origin','entrada',1,'nota','{}','Derivado sintetico C1','2026-09-27T12:00:00Z','2026-09-27','minha') RETURNING id`).get().id;
      db.prepare('INSERT INTO priv_vinculos(fonte_id,derivado_id) VALUES(?,?)').run(internalEvent,derivedEvent);
      prepararAcoesLume(db);prepararExecucoes(db);prepararProjetosComerciais(db);
      const reboundAction=randomUUID(),contextId=randomUUID(),when='2026-09-27T12:00:00.000Z';
      db.prepare(`INSERT INTO lume_acoes(id,evento_id,chave,fonte_assinatura,tipo,resumo,trecho,trecho_inicio,prazo_citado,criada_em,atualizada_em)
        VALUES(?,?,?,?,'pendencia','Resumo sintetico','Conteudo sintetico C1.',0,'',?,?)`).run(reboundAction,externalEvent,'a'.repeat(64),externalSignature,when,when);
      const link=db.prepare(`SELECT nf.sessao_id,nf.parte_id,nf.trecho_id,nf.inicio_ms,nf.fim_ms,nf.audio_sha256,nf.revisao,p.posicao,t.revisao trecho_revisao
        FROM notetaker_fontes nf JOIN notetaker_partes p ON p.id=nf.parte_id JOIN notetaker_trechos t ON t.id=nf.trecho_id WHERE nf.evento_id=?`).get(internalEvent);
      const fonteMeta=Object.fromEntries(['permissao','conversa_id','origem_id','recebido_em','projeto_id','origem_compartilhamento','autor_id','autor_e_dono','transcricao_meta'].map(k=>[k,internalSource[k]]));
      const pacote={id:contextId,acao_id:reboundAction,fonte_retorno:{evento_id:internalEvent},fontes:[{evento_id:internalEvent}],timeline:[]};
      const integridade={acao:'b'.repeat(64),fonte:sourceSignature,vinculo_notetaker:{evento_id:internalEvent,sessao_id:link.sessao_id,
        parte_id:link.parte_id,trecho_id:link.trecho_id,posicao:link.posicao,inicio_ms:link.inicio_ms,fim_ms:link.fim_ms,
        audio_sha256:link.audio_sha256,revisao:link.revisao,fonte:fonteMeta}};
      const pacoteRaw=JSON.stringify(pacote),integridadeRaw=JSON.stringify(integridade);
      db.prepare('INSERT INTO lume_execucao_contextos(id,acao_id,pacote,integridade,criado_em,expira_em) VALUES(?,?,?,?,?,?)')
        .run(contextId,reboundAction,pacoteRaw,integridadeRaw,when,'2026-09-27T12:15:00.000Z');
      db.prepare('INSERT INTO lume_execucao_contexto_guardas(contexto_id,evento_id,assinatura_contexto) VALUES(?,?,?)')
        .run(contextId,internalEvent,hash(JSON.stringify([contextId,pacoteRaw,integridadeRaw])));
      const projectId=randomUUID(),internalProjectSource=randomUUID(),externalProjectSource=randomUUID();
      db.prepare(`INSERT INTO lume_projetos_comerciais(id,nome,natureza,estado,chave,assinatura_criacao,bases_total,criado_em,atualizado_em)
        VALUES(?,'Projeto nao base C1','proposta','rascunho',?,'fixture',1,'2026-09-27T12:00:00Z','2026-09-27T12:00:00Z')`).run(projectId,randomUUID());
      db.prepare(`INSERT INTO lume_projetos_fontes(id,projeto_id,evento_id,assinatura,inicio,tamanho,selecao,base,criada_em) VALUES(?,?,?,?,0,1,'evento',0,'2026-09-27T12:00:00Z')`).run(internalProjectSource,projectId,internalEvent,sourceSignature);
      db.prepare(`INSERT INTO lume_projetos_fontes(id,projeto_id,evento_id,assinatura,inicio,tamanho,selecao,base,criada_em) VALUES(?,?,?,?,0,1,'evento',1,'2026-09-27T12:00:00Z')`).run(externalProjectSource,projectId,externalEvent,externalSignature);
      const internalMeta=db.prepare('SELECT conversa_id,origem_id FROM eventos WHERE id=?').get(derivedEvent),externalMeta=db.prepare('SELECT conversa_id,origem_id FROM eventos WHERE id=?').get(externalEvent);
      const internalCommand=db.prepare(`INSERT INTO lume_comandos(idempotencia,contrato,evento_id,conversa_id,origem_id,estado,motivo,criado_em,atualizado_em) VALUES(?,'v1',?,?,?,'feito','ok','2026-09-27T12:00:00Z','2026-09-27T12:00:00Z') RETURNING id`).get(randomUUID(),derivedEvent,internalMeta.conversa_id,internalMeta.origem_id).id;
      const externalCommand=db.prepare(`INSERT INTO lume_comandos(idempotencia,contrato,evento_id,conversa_id,origem_id,estado,motivo,criado_em,atualizado_em) VALUES(?,'v1',?,?,?,'feito','ok','2026-09-27T12:00:00Z','2026-09-27T12:00:00Z') RETURNING id`).get(randomUUID(),externalEvent,externalMeta.conversa_id,externalMeta.origem_id).id;
      const sharedTag=db.prepare("INSERT INTO lume_tags(chave,nome_exibido,criada_em) VALUES('shared-c1','Compartilhada C1','2026-09-27T12:00:00Z') RETURNING id").get().id;
      for(const [command,meta] of [[internalCommand,internalMeta],[externalCommand,externalMeta]])db.prepare(`INSERT INTO lume_tags_entidades(tag_id,entidade_tipo,entidade_id,comando_id,conversa_id,origem_id,criada_em) VALUES(?,'mensagem',?,?,?,?, '2026-09-27T12:00:00Z')`).run(sharedTag,meta.origem_id,command,meta.conversa_id,meta.origem_id);
      db.prepare('DELETE FROM conversas_app WHERE id=?').run(`local:notetaker:${sessaoId}`);
      db.prepare("DELETE FROM conversas_app WHERE id='derived-c1'").run();
      sentinels={internalEvent,derivedEvent,externalEvent,reboundAction,projectId,internalProjectSource,externalProjectSource,sharedTag,externalCommand};
    }
    db.exec('BEGIN');
    const plan = montarPlanoExclusao(db, { sessaoId, notetakerExperimento: true, testProfileRoot: profileRoot, testMarker: marker });
    db.exec('ROLLBACK');
    assert.deepEqual(plan.bloqueios.exclusao, []);
    const state = { marker, sessaoId, previa: { sessaoId, revisao: plan.revisao, assinatura: plan.assinatura, schemaAssinatura: plan.schemaAssinatura },
      files:plan.arquivos.map(x=>x.nome),sentinels };
    writeFileSync(statePath, JSON.stringify(state), { flag: 'wx' });
    process.stdout.write(JSON.stringify({ mode, parts: plan.arquivos.length, state }));
  } finally { db.close(); }
} else if (mode === 'setup-next') {
  const previous = JSON.parse(readFileSync(statePath, 'utf8'));
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = profileRoot;
  const db = new DatabaseSync(join(profileRoot,'data','assessor.db'));db.exec('PRAGMA foreign_keys=ON');
  try {
    const service=new NotetakerServico(db,{notetakerExperimento:true,testProfileRoot:profileRoot,testMarker:previous.marker});
    const sessaoId=service.criarSessao({origem:'importacao',entradas:['importacao']}).id;
    service.consentir(sessaoId,{entradas:['importacao'],confirmar:true});
    db.exec('BEGIN');const plan=montarPlanoExclusao(db,{sessaoId,notetakerExperimento:true,testProfileRoot:profileRoot,testMarker:previous.marker});db.exec('ROLLBACK');
    assert.deepEqual(plan.bloqueios.exclusao,[]);
    const state={marker:previous.marker,sessaoId,previa:{sessaoId,revisao:plan.revisao,assinatura:plan.assinatura,schemaAssinatura:plan.schemaAssinatura}};
    writeFileSync(statePath,JSON.stringify(state));process.stdout.write(JSON.stringify({mode,parts:plan.arquivos.length,state}));
  }finally{db.close();}
} else {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = profileRoot;
  const perfil = { notetakerExperimento: true, testProfileRoot: profileRoot, testMarker: state.marker };
  const selection = mode.startsWith('recover') ? { tipo:'legado',id:'legado',geracao:null,
    dataDir:join(profileRoot,'data'),credenciaisDir:join(profileRoot,'credenciais') } : mode==='backup' ? null : await selecionarPerfilBoot(profileRoot);
  if (mode.startsWith('crash-')||mode==='recover-crash-abort') {
    const fs = createRequire(import.meta.url)('node:fs');
    if (mode === 'crash-rename') {
      const original = fs.renameSync;
      fs.renameSync = function(source, target) { const value = original.call(this, source, target);
        if (String(target).includes('notetaker-delete-journal')) process.exit(71); return value; };
    } else if(mode==='crash-before-rename'){
      const original=fs.renameSync;
      fs.renameSync=function(source,target){if(String(target).includes('notetaker-delete-journal'))process.exit(76);return original.call(this,source,target);};
    } else if(mode==='crash-rename-last'){
      const original=fs.renameSync;let count=0;
      fs.renameSync=function(source,target){const value=original.call(this,source,target);if(String(target).includes('notetaker-delete-journal')&&++count===2)process.exit(77);return value;};
    } else if (mode === 'crash-unlink') {
      const original = fs.unlinkSync;
      fs.unlinkSync = function(target) { const value = original.call(this, target);
        if (/q-\d{3}-[0-9a-f-]+\.wav$/i.test(String(target))) process.exit(72); return value; };
    } else if (mode === 'crash-commit') {
      const original = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) { const value = original.call(this, sql);
        if (/^COMMIT\s*;?$/i.test(String(sql).trim()) &&
            this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notetaker_exclusao_recibos_v1'").get() &&
            this.prepare('SELECT 1 FROM notetaker_exclusao_recibos_v1 LIMIT 1').get()) process.exit(73);
        return value; };
    } else if(mode==='crash-unlink-last'){
      const original=fs.unlinkSync;let count=0;
      fs.unlinkSync=function(target){const value=original.call(this,target);if(/q-\d{3}-[0-9a-f-]+\.wav$/i.test(String(target))&&++count===2)process.exit(78);return value;};
    } else if(mode==='crash-progress'){
      const original=DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec=function(sql){const value=original.call(this,sql);
        if(/^COMMIT\s*;?$/i.test(String(sql).trim())&&this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notetaker_exclusao_recibos_v1'").get()&&
            this.prepare("SELECT 1 FROM notetaker_exclusao_recibos_v1 WHERE estado='arquivos_pendentes' AND arquivos_pendentes=1 LIMIT 1").get())process.exit(79);return value;};
    } else if(mode==='crash-cleanup'){
      const original=fs.unlinkSync;
      fs.unlinkSync=function(target){const value=original.call(this,target);if(String(target).endsWith('manifesto.json'))process.exit(74);return value;};
    } else if(mode==='recover-crash-abort'){
      const original=DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec=function(sql){const value=original.call(this,sql);
        if(/^COMMIT\s*;?$/i.test(String(sql).trim())&&this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notetaker_exclusao_controle_v1'").get()&&
            this.prepare("SELECT 1 FROM notetaker_exclusao_controle_v1 WHERE fase='abortada' LIMIT 1").get())process.exit(75);return value;};
    }
    syncBuiltinESMExports();
  }
  const api = await import('../../src/perfil-manutencao.js');
  if(mode==='backup'){
    const before=readdirSync(root).filter(name=>name.startsWith('lume-acervo-v9-'));
    let code='ok',bytes=0;
    try{const {criarOrigemV9}=await import('../../src/backup-acervo-v9.js');const source=await criarOrigemV9({dbPath:join(profileRoot,'data','assessor.db'),perfil:{dono:'fixture'}});
      for await(const chunk of source.origem)bytes+=chunk.length;
    }catch(error){code=error?.code??'UNKNOWN';}
    const after=readdirSync(root).filter(name=>name.startsWith('lume-acervo-v9-'));
    process.stdout.write(JSON.stringify({mode,code,bytes,tempBefore:before,tempAfter:after}));process.exit(0);
  } else if (mode === 'execute' || mode.startsWith('crash-')) {
    const handle = await api.beginContentMaintenance({ userData: profileRoot, selection, opId: randomUUID(), perfil, previa: state.previa });
    const receipt = await api.executeContentMaintenance({ maintenanceHandle: handle });
    const terminal = await api.completeContentMaintenance({ maintenanceHandle: handle, receipt });
    assert.equal(api.isContentMaintenanceComplete(terminal), true);
  } else if (mode === 'guards') {
    const handle = await api.beginContentMaintenance({ userData: profileRoot, selection, opId: randomUUID(), perfil, previa: state.previa });
    assert.equal(JSON.stringify(handle), '{}');
    await assert.rejects(api.executeContentMaintenance({ maintenanceHandle: handle, db: {} }), { code:'PERFIL_MANUTENCAO_INVALIDA' });
    await assert.rejects(api.executeContentMaintenance({ maintenanceHandle: JSON.parse(JSON.stringify(handle)) }), { code:'PERFIL_MANUTENCAO_INVALIDA' });
    const receipt = await api.executeContentMaintenance({ maintenanceHandle: handle });
    assert.equal(JSON.stringify(receipt), '{}');
    await assert.rejects(api.completeContentMaintenance({ maintenanceHandle: handle, receipt: {} }), { code:'PERFIL_MANUTENCAO_INVALIDA' });
    await assert.rejects(api.executeContentMaintenance({ maintenanceHandle: handle }), { code:'PERFIL_MANUTENCAO_INVALIDA' });
    const terminal = await api.completeContentMaintenance({ maintenanceHandle: handle, receipt });
    assert.equal(api.isContentMaintenanceComplete(terminal), true); assert.equal(api.isContentMaintenanceComplete({}), false);
    await assert.rejects(api.completeContentMaintenance({ maintenanceHandle: handle, receipt }), { code:'PERFIL_MANUTENCAO_INVALIDA' });
  } else if (mode === 'recover' || mode === 'recover-crash-abort') {
    const handle = await api.readMaintenanceMarker({ userData: profileRoot });
    const receipt = await api.recoverContentMaintenance({ maintenanceHandle: handle });
    const terminal = await api.completeContentMaintenance({ maintenanceHandle: handle, receipt });
    assert.equal(api.isContentMaintenanceComplete(terminal), true);
  } else throw new Error(`modo desconhecido: ${mode}`);
  const verify = new DatabaseSync(join(profileRoot, 'data', 'assessor.db'), { readOnly: true });
  try {
    const s=state.sentinels,sessionCount=verify.prepare('SELECT COUNT(*) n FROM notetaker_sessoes WHERE id=?').get(state.sessaoId).n;
    const preserved=s&&sessionCount===0?{
      internalEvent:verify.prepare('SELECT COUNT(*) n FROM eventos WHERE id=?').get(s.internalEvent).n,
      derivedEvent:verify.prepare('SELECT COUNT(*) n FROM eventos WHERE id=?').get(s.derivedEvent).n,
      externalEvent:verify.prepare('SELECT COUNT(*) n FROM eventos WHERE id=?').get(s.externalEvent).n,
      reboundAction:verify.prepare('SELECT COUNT(*) n FROM lume_acoes WHERE id=? AND evento_id=?').get(s.reboundAction,s.externalEvent).n,
      nonBaseProject:verify.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais WHERE id=?').get(s.projectId).n,
      internalProjectSource:verify.prepare('SELECT COUNT(*) n FROM lume_projetos_fontes WHERE id=?').get(s.internalProjectSource).n,
      externalProjectSource:verify.prepare('SELECT COUNT(*) n FROM lume_projetos_fontes WHERE id=?').get(s.externalProjectSource).n,
      sharedTag:verify.prepare('SELECT COUNT(*) n FROM lume_tags WHERE id=?').get(s.sharedTag).n,
      externalTagAssociation:verify.prepare('SELECT COUNT(*) n FROM lume_tags_entidades WHERE tag_id=? AND comando_id=?').get(s.sharedTag,s.externalCommand).n,
      foreignKeys:verify.prepare('PRAGMA foreign_key_check').all().length
    }:undefined;
    process.stdout.write(JSON.stringify({ mode, sessions: sessionCount,
      parts: verify.prepare('SELECT COUNT(*) n FROM notetaker_partes WHERE sessao_id=?').get(state.sessaoId).n,
      control: verify.prepare('SELECT fase FROM notetaker_exclusao_controle_v1 ORDER BY criado_em DESC LIMIT 1').get()?.fase ?? null,
      receipt: verify.prepare('SELECT estado,arquivos_pendentes FROM notetaker_exclusao_recibos_v1 ORDER BY commit_em DESC LIMIT 1').get() ?? null,
      ...(preserved?{preserved}:{}) }));
  } finally { verify.close(); }
}
