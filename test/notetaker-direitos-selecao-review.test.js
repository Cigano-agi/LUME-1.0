import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {NotetakerServico} from '../src/notetaker/servico.js';
import {prepararComandosWhatsapp} from '../src/comandos-whatsapp.js';
import {prepararNegocios} from '../src/negocios-desktop.js';
import {assinaturaFonte} from '../src/tarefas-esquema.js';
import {selecionarDireitosSessao,iterarExportacaoSessao} from '../src/notetaker/direitos-selecao.js';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'lume-notetaker-selecao-review-'));
  const marker=randomUUID(),anterior=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;
  writeFileSync(join(root,'.lume-notetaker-test'),marker);
  const db=abrirBanco(join(root,'db.sqlite'));
  t.after(()=>{
    db.close();
    if(anterior===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
    else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=anterior;
    rmSync(root,{recursive:true,force:true});
  });
  new ContextoApp(db);new Desktop(db);
  const servico=new NotetakerServico(db,{notetakerExperimento:true,testProfileRoot:root,testMarker:marker,
    audioLocal:{async estado(){return {disponivel:false};}}});
  const sessao=servico.criarSessao({origem:'importacao',entradas:['importacao']}).id;
  servico.consentir(sessao,{entradas:['importacao'],confirmar:true});
  return {db,sessao,perfil:{testProfileRoot:root,testMarker:marker}};
}

test('coluna renomeada em tabela conhecida vazia falha fechada e limpa TEMP',t=>{
  const {db,sessao,perfil}=fixture(t);
  const mapa=selecionarDireitosSessao(db,sessao,perfil);
  db.exec('ALTER TABLE notetaker_correcoes RENAME COLUMN texto_novo TO texto_outro');
  assert.throws(()=>selecionarDireitosSessao(db,sessao,perfil),{code:'INTEGRIDADE'});
  assert.throws(()=>[...iterarExportacaoSessao(db,mapa,perfil)],{code:'INTEGRIDADE'});
  assert.equal(db.isTransaction,false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(),undefined);
});

test('linha sintética acima de 4 MiB não sai na projeção',t=>{
  const {db,sessao,perfil}=fixture(t);
  db.prepare('UPDATE notetaker_sessoes SET entradas=? WHERE id=?')
    .run(JSON.stringify(['importacao','x'.repeat(4*1024*1024)]),sessao);
  const mapa=selecionarDireitosSessao(db,sessao,perfil),iter=iterarExportacaoSessao(db,mapa,perfil);
  assert.throws(()=>iter.next(),{code:'LIMITE'});
  assert.equal(db.isTransaction,false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(),undefined);
});

function fixtureComTag(t){
  const {db,sessao,perfil}=fixture(t);
  prepararComandosWhatsapp(db);
  const parte=randomUUID(),trecho=randomUUID(),texto='Trecho sintético local.';
  db.prepare(`INSERT INTO notetaker_partes(id,sessao_id,entrada,posicao,inicio_ms,duracao_ms,sha256,caminho,estado)
    VALUES(?,?,'importacao',0,0,500,?,?, 'salva')`).run(parte,sessao,'a'.repeat(64),parte+'.wav');
  db.prepare(`INSERT INTO notetaker_trechos(id,parte_id,ordinal,inicio_ms,fim_ms,texto_gerado)
    VALUES(?,?,0,0,500,?)`).run(trecho,parte,texto);
  const evento=(conversa,origem,tipo,permissao,conteudo)=>db.prepare(`INSERT INTO eventos
    (conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada',NULL,1,?,'{}',?,'2026-09-27T12:00:00.000Z','2026-09-27',?) RETURNING id`)
    .get(conversa,origem,tipo,conteudo,permissao).id;
  const local=evento('local:notetaker:'+sessao,'trecho:'+parte+':0','notetaker_trecho','notetaker_local',texto);
  db.prepare(`INSERT INTO notetaker_fontes(evento_id,trecho_id,sessao_id,parte_id,inicio_ms,fim_ms,audio_sha256)
    VALUES(?,?,?,?,0,500,?)`).run(local,trecho,sessao,parte,'a'.repeat(64));
  const conversa='nota:'+randomUUID(),origem='nota:'+randomUUID();
  const nota=evento(conversa,origem,'nota','minha','Nota sintética derivada.');
  db.prepare('INSERT INTO priv_vinculos(fonte_id,derivado_id) VALUES(?,?)').run(local,nota);
  const comando=db.prepare(`INSERT INTO lume_comandos
    (idempotencia,contrato,evento_id,conversa_id,origem_id,estado,motivo,criado_em,atualizado_em)
    VALUES(?,'v1',?,?,?,'feito','ok','2026-09-27T12:00:00.000Z','2026-09-27T12:00:00.000Z') RETURNING id`)
    .get(randomUUID(),nota,conversa,origem).id;
  const tag=db.prepare(`INSERT INTO lume_tags(chave,nome_exibido,criada_em)
    VALUES('sintetica','Sintética','2026-09-27T12:00:00.000Z') RETURNING id`).get().id;
  const associar=(tipo,id,conversaId=conversa,origemId=origem)=>db.prepare(`INSERT INTO lume_tags_entidades
    (tag_id,entidade_tipo,entidade_id,comando_id,conversa_id,origem_id,criada_em)
    VALUES(?,?,?,?,?,?,'2026-09-27T12:00:00.000Z')`)
    .run(tag,tipo,String(id),comando,conversaId,origemId);
  const externo=(origemExterna=randomUUID())=>({id:evento(conversa,origemExterna,'texto','minha','Mensagem externa sintética.'),origem:origemExterna});
  return {db,sessao,perfil,conversa,origem,nota,comando,tag,associar,externo};
}

test('alvo mensagem interno canônico é exportável e editar vínculo muda assinatura',t=>{
  const {db,sessao,perfil,origem,associar,tag}=fixtureComTag(t);
  associar('mensagem',origem);
  const mapa=selecionarDireitosSessao(db,sessao,perfil);
  assert.deepEqual(mapa.bloqueios.exportacao,[]);
  const linhas=[...iterarExportacaoSessao(db,mapa,perfil)];
  assert.ok(linhas.some(x=>x.tabela==='lume_tags_entidades'&&x.registro.tag_id===tag));
  db.prepare('UPDATE lume_tags_entidades SET estado=? WHERE tag_id=?').run('revisar',tag);
  const mudado=selecionarDireitosSessao(db,sessao,perfil);
  assert.notEqual(mudado.assinatura,mapa.assinatura);
  assert.throws(()=>[...iterarExportacaoSessao(db,mapa,perfil)],{code:'CONFLITO'});
});

test('alvo mensagem externo canônico bloqueia exportação sem incluir original',t=>{
  const {db,sessao,perfil,associar,externo}=fixtureComTag(t);
  const alvo=externo();associar('mensagem',alvo.origem);
  const mapa=selecionarDireitosSessao(db,sessao,perfil);
  assert.ok(!mapa.ids.eventos.includes(alvo.id));
  assert.ok(mapa.bloqueios.exportacao.some(x=>x.classe==='tag_mista'));
  assert.ok(mapa.impactos.some(x=>x.classe==='tag_mista'));
  assert.throws(()=>[...iterarExportacaoSessao(db,mapa,perfil)],{code:'INTEGRIDADE'});
});

test('origem da associação divergente do comando fecha exportação e exclusão',t=>{
  const {db,sessao,perfil,origem,associar}=fixtureComTag(t);
  associar('mensagem',origem,'conversa:outra');
  const mapa=selecionarDireitosSessao(db,sessao,perfil);
  assert.ok(mapa.bloqueios.exportacao.some(x=>x.classe==='tag_origem_ambigua'));
  assert.ok(mapa.bloqueios.exclusao.some(x=>x.classe==='tag_origem_ambigua'));
  assert.throws(()=>[...iterarExportacaoSessao(db,mapa,perfil)],{code:'INTEGRIDADE'});
});

test('par do comando divergente do evento fecha exportação e exclusão',t=>{
  const {db,sessao,perfil,origem,comando,associar}=fixtureComTag(t);
  associar('mensagem',origem);
  db.prepare('UPDATE lume_comandos SET origem_id=? WHERE id=?').run('origem:outra',comando);
  const mapa=selecionarDireitosSessao(db,sessao,perfil);
  assert.ok(mapa.bloqueios.exportacao.some(x=>x.classe==='comando_origem_ambigua'));
  assert.ok(mapa.bloqueios.exclusao.some(x=>x.classe==='comando_origem_ambigua'));
  assert.throws(()=>[...iterarExportacaoSessao(db,mapa,perfil)],{code:'INTEGRIDADE'});
});

for(const tipo of ['conversa','contato','tarefa','lembrete','negocio'])
  test(`alvo ${tipo} interno e demonstrável continua exportável`,t=>{
    const {db,sessao,perfil,conversa,origem,nota,comando,associar}=fixtureComTag(t);
    let alvo=conversa;
    if(tipo==='tarefa')alvo=db.prepare(`INSERT INTO lume_comando_tarefas
      (comando_id,texto,conversa_id,origem_id,criada_em)
      VALUES(?,'Tarefa sintética.',?,?,'2026-09-27T12:00:00.000Z') RETURNING id`)
      .get(comando,conversa,origem).id;
    if(tipo==='lembrete')alvo=db.prepare(`INSERT INTO lume_comando_lembretes
      (comando_id,texto,prazo_local,prazo_utc,fuso,conversa_id,origem_id,criada_em)
      VALUES(?,'Lembrete sintético.','2026-09-28','2026-09-28T12:00:00.000Z','UTC',?,?,
        '2026-09-27T12:00:00.000Z') RETURNING id`).get(comando,conversa,origem).id;
    if(tipo==='negocio'){
      prepararNegocios(db);alvo=randomUUID();
      const fonte=db.prepare(`SELECT texto,permissao,conversa_id,origem_id,recebido_em,projeto_id,
        origem_compartilhamento,autor_id,autor_e_dono,transcricao_meta FROM desktop_fontes WHERE id=?`).get(nota);
      db.prepare(`INSERT INTO desktop_negocios
        (id,evento_id,assinatura,titulo,etapa,valor_centavos,proximo_contato,revisao,criado_em,atualizado_em)
        VALUES(?,?,?,'Negócio sintético','interesse',NULL,NULL,1,'2026-09-27T12:00:00.000Z',
          '2026-09-27T12:00:00.000Z')`).run(alvo,nota,assinaturaFonte(fonte));
    }
    associar(tipo,alvo);
    const mapa=selecionarDireitosSessao(db,sessao,perfil);
    assert.deepEqual(mapa.bloqueios.exportacao,[]);
    assert.ok([...iterarExportacaoSessao(db,mapa,perfil)].some(x=>x.tabela==='lume_tags_entidades'));
  });

test('alvo conversa compartilhada com evento externo bloqueia exportação',t=>{
  const {db,sessao,perfil,conversa,associar,externo}=fixtureComTag(t);
  const outro=externo();associar('conversa',conversa);
  const mapa=selecionarDireitosSessao(db,sessao,perfil);
  assert.ok(!mapa.ids.eventos.includes(outro.id));
  assert.ok(mapa.bloqueios.exportacao.some(x=>x.classe==='tag_mista'));
  assert.throws(()=>[...iterarExportacaoSessao(db,mapa,perfil)],{code:'INTEGRIDADE'});
});

test('alvo sem origem demonstrável fecha exportação e exclusão',t=>{
  const {db,sessao,perfil,associar}=fixtureComTag(t);
  associar('mensagem','origem:inexistente');
  const mapa=selecionarDireitosSessao(db,sessao,perfil);
  assert.ok(mapa.bloqueios.exportacao.some(x=>x.classe==='tag_alvo_ambiguo'));
  assert.ok(mapa.bloqueios.exclusao.some(x=>x.classe==='tag_alvo_ambiguo'));
});

for(const tipo of ['tarefa','lembrete'])
  test(`efeito ${tipo} sem tag e com par divergente não entra na projeção`,t=>{
    const {db,sessao,perfil,origem,comando}=fixtureComTag(t);
    if(tipo==='tarefa')db.prepare(`INSERT INTO lume_comando_tarefas
      (comando_id,texto,conversa_id,origem_id,criada_em)
      VALUES(?,'Tarefa sintética.','conversa:outra',?,'2026-09-27T12:00:00.000Z')`).run(comando,origem);
    else db.prepare(`INSERT INTO lume_comando_lembretes
      (comando_id,texto,prazo_local,prazo_utc,fuso,conversa_id,origem_id,criada_em)
      VALUES(?,'Lembrete sintético.','2026-09-28','2026-09-28T12:00:00.000Z','UTC',
        'conversa:outra',?,'2026-09-27T12:00:00.000Z')`).run(comando,origem);
    const mapa=selecionarDireitosSessao(db,sessao,perfil);
    assert.ok(mapa.bloqueios.exportacao.some(x=>x.classe==='efeito_origem_ambigua'));
    assert.ok(mapa.bloqueios.exclusao.some(x=>x.classe==='efeito_origem_ambigua'));
    assert.throws(()=>[...iterarExportacaoSessao(db,mapa,perfil)],{code:'INTEGRIDADE'});
  });
