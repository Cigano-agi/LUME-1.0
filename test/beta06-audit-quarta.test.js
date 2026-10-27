// Auditoria independente: apenas perfis sintéticos e backups cifrados reais.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {ExecucoesLume} from '../src/execucao/servico.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';
import {Backup,abrirBackup} from '../src/backup.js';
import {Privacidade} from '../src/privacidade.js';
import {criarServidor} from '../src/painel/servidor.js';

const out=resolve('work/beta06-audit-quarta');mkdirSync(out,{recursive:true});
const senha='senha-exclusivamente-sintetica-audit4';
const inicio='2026-09-25T22:00:00.000Z';
const nome='Projeto Sintético <img src=x onerror="window.auditXss=1">';
function ambiente(t){
  const dir=mkdtempSync(join(out,'perfil-')),path=join(dir,'audit.sqlite');
  const f={dir,path,now:new Date(inicio)};
  function abrir(){
    f.db=abrirBanco(path);f.contexto=new ContextoApp(f.db);f.desktop=new Desktop(f.db);new DesktopIA(f.db);
    f.acoes=new AcoesLume(f.db,{agora:()=>f.now});f.service=new ProjetosComerciais(f.db,{agora:()=>f.now});
    f.backup=new Backup(f.db,{perfil:()=>({nome:'Titular fictício'})});f.priv=new Privacidade(f.db);
  }
  abrir();t.after(async()=>{if(f.server){f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}f.db.close();});
  f.restart=()=>{f.db.close();abrir();};
  f.add=(texto,{chat='audit-dm',permissao='dirigida'}={})=>{
    f.db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(chat,'Pessoa sintética');
    return Number(f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
      VALUES(?,?,'entrada','texto','{}',?,?,'2026-09-25',?,0)`).run(chat,randomUUID(),texto,inicio,permissao).lastInsertRowid);
  };
  return f;
}
function criar(f,{restrita=false,invalida=false}={}){
  const texto='Enviar proposta. OUTRO PROJETO OMITIDO. Enviar proposta.';
  const a=f.add(texto),b=f.add('Base complementar reservada.',{chat:'audit-grupo',permissao:restrita?'terceiro':'dirigida'});
  if(restrita)f.db.prepare("INSERT INTO politicas_conversa VALUES('audit-grupo','tudo',?)").run(inicio);
  const p=f.service.criarRascunho({nome,natureza:'acordo_citado',fontes:[{eventoId:a,trecho:'Enviar proposta.',inicio:texto.lastIndexOf('Enviar proposta.')},{eventoId:b,trecho:'Base complementar'}]});
  const extra=f.add('Extra opcional literal. OUTRO ASSUNTO OMITIDO.');
  const link=f.service.vincularFonte({id:p.id,eventoId:extra,trecho:'Extra opcional literal.'});
  f.service.confirmar({id:p.id,confirmar:true});
  if(invalida){f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Mudança passageira',a);f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(texto,a);}
  return {p,a,b,extra,link,texto};
}
async function transferir(a,b,label='backup'){
  const packed=JSON.stringify((await a.backup.criar({senha,confirmar:true})).pacote);
  assert.ok(!packed.includes(nome));assert.ok(!packed.includes('Base complementar'));
  writeFileSync(join(b.dir,label+'.json'),packed);
  const claro=await abrirBackup(packed,senha);
  const preview=await b.backup.preparar({arquivo:packed,senha});
  b.backup.restaurar({id:preview.id,confirmarMeuBackup:true});
  return claro;
}

test('AUDIT-Q0: restauração preserva fontes exatas e oferece revisão local sem autoridade importada',async t=>{
  const a=ambiente(t),b=ambiente(t),c=criar(a);
  a.acoes.autorizar({conversa:'audit-dm',permitida:true});
  a.acoes.registrar({eventoId:c.extra,candidatas:[{fonte:'E'+c.extra,tipo:'pendencia',resumo:'Preparar material sintético',trecho:'Extra opcional literal.',prazo_citado:''}]});
  a.db.prepare("INSERT INTO politicas_conversa VALUES('audit-dm','tudo',?)").run(inicio);
  a.db.exec("UPDATE desktop_ia_config SET habilitada=1; INSERT INTO desktop_ia_conversas VALUES('audit-dm',1,'2026-09-25')");
  const acao=a.acoes.listar()[0],exec=new ExecucoesLume(a.db,{agora:()=>a.now});
  const context=exec.preparar({acao_id:acao.id});
  const run=exec.iniciar({contexto_id:context.contexto.id,assistente:'claude',confirmar:true,manter_contexto:true,chave_idempotencia:randomUUID()});
  assert.equal(a.db.prepare('SELECT count(*) n FROM lume_execucao_contexto_grants').get().n,1);
  assert.equal(a.db.prepare('SELECT invalidada FROM lume_execucao_contexto_grants').get().invalidada,0);
  const claro=await transferir(a,b);
  assert.equal(b.service.obter(c.p.id),null);
  assert.equal(b.db.prepare('SELECT count(*) n FROM politicas_conversa').get().n,0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM lume_acoes_conversas').get().n,0);
  assert.equal(b.db.prepare('SELECT habilitada FROM desktop_ia_config').get().habilitada,0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM desktop_ia_conversas').get().n,0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM lume_execucao_contexto_grants').get().n,0);
  assert.equal(b.db.prepare('SELECT estado FROM lume_execucoes WHERE id=?').get(run.execucao.id).estado,'revogada');
  for(const table of ['lume_projetos_revisoes','lume_execucao_contexto_grants','lume_vendas_revisoes'])assert.equal(Object.hasOwn(claro.tabelas,table),false);
  assert.equal(typeof b.service.listarImportados,'function','Projeto restaurado precisa de caminho para conferir fontes');
});

test('AUDIT-Q1: exportação/exclusão continua disponível depois de preparar ações para projeto',t=>{
  const f=ambiente(t),id=f.add('Preparar proposta sintética.');
  f.acoes.autorizar({conversa:'audit-dm',permitida:true});
  f.acoes.registrar({eventoId:id,candidatas:[{fonte:'E'+id,tipo:'pendencia',resumo:'Preparar proposta',trecho:'Preparar proposta sintética.',prazo_citado:''}]});
  const acao=f.acoes.listar()[0];f.acoes.revisar({id:acao.id,acao:'confirmar'});
  f.service.previaDeAcoes({acaoIds:[acao.id]});
  assert.doesNotThrow(()=>f.priv.schemaConhecido(),'Cache de revisão local não pode bloquear direitos de dados');
});

test('AUDIT-Q2: projeto comum mantém nome privado se base for revogada e restaurada, inclusive após restart',t=>{
  const f=ambiente(t),c=criar(f,{restrita:true});
  assert.equal(f.service.obter(c.p.id).acordoVerificado,false);
  f.db.exec("DELETE FROM politicas_conversa WHERE conversa_id='audit-grupo'; INSERT INTO politicas_conversa VALUES('audit-grupo','tudo','2026-09-25')");
  f.restart();assert.equal(f.service.obter(c.p.id),null);assert.deepEqual(f.service.timeline({id:c.p.id}),[]);
  assert.ok(!JSON.stringify(f.service.listar()).includes(nome));
  const exported=f.priv.dadosCiclo([c.a,c.b,c.extra],{exportacao:true});assert.equal(exported.lume_projetos_comerciais.length,0);
});

function preparar(f,c){return f.service.prepararImportado({id:c.p.id});}
function revisar(f,p){return f.service.revalidarImportado({previaId:p.previaId,confirmar:true});}
function semAutoridade(f){
  for(const table of ['projetos','conversa_projetos','autorizacoes','politicas_conversa','lume_acoes_conversas','lume_execucao_contexto_grants']){
    if(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table);
  }
}

test('AUDIT-Q3: revisão de importado preserva base/posição literal e identidade, sem aceite ou autorização',async t=>{
  const a=ambiente(t),b=ambiente(t),c=criar(a);await transferir(a,b);
  const lista=b.service.listarImportados({limite:100});assert.equal(lista.length,1);
  assert.equal(lista[0].id,c.p.id);assert.equal(lista[0].importacao.revisaoNecessaria,true);
  const p=preparar(b,c);assert.equal(p.projeto.nome,nome);assert.equal(p.fontes.length,3);
  assert.deepEqual(p.fontes.map(f=>f.trecho).sort(),['Base complementar','Enviar proposta.','Extra opcional literal.']);
  const repetida=p.fontes.find(f=>f.eventoId===c.a);assert.equal(repetida.inicio,c.texto.lastIndexOf('Enviar proposta.'));assert.equal(repetida.base,true);
  assert.doesNotMatch(JSON.stringify(p),/OUTRO PROJETO OMITIDO|OUTRO ASSUNTO OMITIDO/);
  assert.equal(b.service.obter(c.p.id),null);semAutoridade(b);
  assert.throws(()=>b.service.revalidarImportado({previaId:p.previaId,confirmar:'true'}));
  const r=revisar(b,p);assert.equal(r.id,c.p.id);assert.equal(r.estado,'rascunho');assert.equal(r.acordoVerificado,false);
  assert.equal(b.service.obter(c.p.id).fontes.length,3);semAutoridade(b);
  const writes=b.db.prepare('SELECT total_changes() n').get().n;
  assert.equal(revisar(b,p).alterado,false);assert.equal(b.db.prepare('SELECT total_changes() n').get().n,writes);
  assert.equal(b.db.prepare('SELECT count(*) n FROM lume_projetos_comerciais').get().n,1);
  b.restart();assert.equal(b.service.obter(c.p.id).estado,'rascunho');
  assert.equal(b.service.timeline({id:c.p.id}).filter(h=>h.tipo==='importado_revisado').length,1);
  assert.doesNotThrow(()=>b.priv.schemaConhecido());
});

test('AUDIT-Q4: sem leitura de uma base, listagem/prévia/exportação não expõem nome nem fragmentos',async t=>{
  const a=ambiente(t),b=ambiente(t),c=criar(a,{restrita:true});await transferir(a,b);
  assert.deepEqual(b.service.listarImportados(),[]);assert.throws(()=>preparar(b,c));
  const exported=b.priv.dadosCiclo([c.a,c.extra],{exportacao:true});assert.equal(exported.lume_projetos_comerciais.length,0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM politicas_conversa').get().n,0);
  b.db.prepare("INSERT INTO politicas_conversa VALUES('audit-grupo','tudo',?)").run(inicio);
  assert.equal(b.service.listarImportados().length,1);const p=preparar(b,c);
  b.db.exec("DELETE FROM politicas_conversa WHERE conversa_id='audit-grupo'; INSERT INTO politicas_conversa VALUES('audit-grupo','tudo','2026-09-25')");
  assert.throws(()=>revisar(b,p));b.restart();assert.deepEqual(b.service.listarImportados(),[]);assert.throws(()=>preparar(b,c));
});

test('AUDIT-Q5: fonte-base invalidada antes do backup nunca fica apta, mesmo após dois restores',async t=>{
  const a=ambiente(t),b=ambiente(t),d=ambiente(t),c=criar(a,{invalida:true});
  assert.equal(a.service.obter(c.p.id),null);await transferir(a,b);
  assert.deepEqual(b.service.listarImportados(),[]);assert.throws(()=>preparar(b,c));
  await transferir(b,d,'rebackup-invalidado');d.restart();
  assert.deepEqual(d.service.listarImportados(),[]);assert.throws(()=>preparar(d,c));assert.equal(d.service.obter(c.p.id),null);
});

test('AUDIT-Q6: rebackup antes e depois da revisão exige novo gesto no destino e não restaura confirmação',async t=>{
  const a=ambiente(t),b=ambiente(t),d=ambiente(t),e=ambiente(t),c=criar(a);await transferir(a,b);
  await transferir(b,d,'rebackup-antes');assert.equal(d.service.listarImportados().length,1);assert.equal(d.service.obter(c.p.id),null);
  const pb=preparar(b,c);revisar(b,pb);b.service.confirmar({id:c.p.id,confirmar:true});
  await transferir(b,e,'rebackup-depois');assert.equal(e.service.obter(c.p.id),null);assert.equal(e.service.listarImportados().length,1);
  assert.throws(()=>revisar(e,pb));const r=revisar(e,preparar(e,c));assert.equal(r.estado,'rascunho');assert.equal(r.acordoVerificado,false);semAutoridade(e);
});

test('AUDIT-Q7: ABA em fonte pendente invalida prévia e rebackup não recupera elegibilidade',async t=>{
  for(const estado of ['pendente','revisado'])await t.test(estado,async t=>{
    const a=ambiente(t),b=ambiente(t),d=ambiente(t),c=criar(a);await transferir(a,b);const p=preparar(b,c);
    if(estado==='revisado')revisar(b,p);
    b.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte provisória',c.a);
    b.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(c.texto,c.a);
    assert.throws(()=>revisar(b,p));assert.equal(b.service.obter(c.p.id),null);
    await transferir(b,d,'rebackup-apos-ABA');assert.deepEqual(d.service.listarImportados(),[]);assert.throws(()=>preparar(d,c));
  });
});

test('AUDIT-Q8: decisão única, retry sem escrita, prévia expirada/reiniciada/alterada negada',async t=>{
  const a=ambiente(t),b=ambiente(t),c=criar(a);await transferir(a,b);
  const expirada=preparar(b,c);b.now=new Date(expirada.expiraEm);assert.throws(()=>revisar(b,expirada));
  b.now=new Date(inicio);const perdida=preparar(b,c);b.restart();assert.throws(()=>revisar(b,perdida));
  const atual=preparar(b,c);assert.throws(()=>b.service.revalidarImportado({previaId:atual.previaId,confirmar:true,raiz:'C:/privado'}));
  const r=revisar(b,atual);assert.equal(r.estado,'rascunho');
  const writes=b.db.prepare('SELECT total_changes() n').get().n;assert.equal(revisar(b,atual).alterado,false);
  assert.equal(b.db.prepare('SELECT total_changes() n').get().n,writes);
  b.service.confirmar({id:c.p.id,confirmar:true});assert.throws(()=>revisar(b,atual));
  const rows=b.service.timeline({id:c.p.id}).filter(h=>h.tipo==='importado_revisado');assert.equal(rows.length,1);
});

test('AUDIT-Q9: vínculo opcional inválido/removido não retorna após conferir bases restantes',async t=>{
  for(const modo of ['removido','invalidado'])await t.test(modo,async t=>{
    const a=ambiente(t),b=ambiente(t),c=criar(a);
    if(modo==='removido')a.service.desvincularFonte({id:c.p.id,fonteId:c.link.fonteId});
    else{a.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Versão passageira',c.extra);a.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Extra opcional literal. OUTRO ASSUNTO OMITIDO.',c.extra);}
    await transferir(a,b);const p=preparar(b,c);assert.equal(p.fontes.length,2);assert.ok(!JSON.stringify(p).includes('Extra opcional'));
    const r=revisar(b,p);assert.equal(r.fontes.length,2);assert.ok(!JSON.stringify(b.service.timeline({id:c.p.id})).includes('Extra opcional'));
  });
});

test('AUDIT-Q11: rebackup de perfil legado com causa desconhecida não presume vínculo apto',async t=>{
  const a=ambiente(t),b=ambiente(t),d=ambiente(t),c=criar(a);await transferir(a,b);
  // Forma real da base anterior: fontes importadas têm estado_original NULL.
  b.db.exec("UPDATE lume_ciclo_importacoes SET estado_original=NULL WHERE tabela='lume_projetos_fontes'");
  await transferir(b,d,'rebackup-legado');assert.deepEqual(d.service.listarImportados(),[]);assert.throws(()=>preparar(d,c));
  assert.equal(d.service.obter(c.p.id),null);
});

async function http(f){
  f.desktop.aceitar({nome:'Auditor sintético',aceito:true,versao:VERSAO_TERMOS});f.desktop.configurarGuia({dispensado:true});
  f.server=criarServidor(f.db,{desktop:true,contexto:f.contexto,agoraIA:()=>f.now});
  await new Promise(r=>f.server.listen(0,'127.0.0.1',r));f.origin=`http://127.0.0.1:${f.server.address().port}`;
  const {token}=await (await fetch(f.origin+'/api/sessao')).json();f.headers={'x-assessor-token':token,'content-type':'application/json'};
  f.post=(path,body,extra={})=>fetch(f.origin+'/api/v3/projetos-comerciais/'+path,{method:'POST',headers:{...f.headers,...extra},body:JSON.stringify(body)});
  f.get=path=>fetch(f.origin+'/api/v3/projetos-comerciais/'+path,{headers:f.headers});
}
test('AUDIT-Q10: HTTP exige sessão, CSRF, campos fechados e gesto separado para a revisão',async t=>{
  const a=ambiente(t),b=ambiente(t),c=criar(a);await transferir(a,b);await http(b);
  const endpoint=b.origin+'/api/v3/projetos-comerciais/importados';
  assert.equal((await fetch(endpoint)).status,403);
  assert.equal((await b.post('importados/previa',{id:c.p.id},{origin:'https://externo.invalid'})).status,403);
  for(const data of [null,[],{id:c.p.id,extra:true}])assert.equal((await b.post('importados/previa',data)).status,400);
  assert.equal((await b.get('importados?limite=0')).status,400);
  const listed=await (await b.get('importados')).json();assert.equal(listed.projetos.length,1);
  const res=await b.post('importados/previa',{id:c.p.id});assert.equal(res.status,200);const {previa}=await res.json();
  for(const confirmar of [undefined,false,'true'])assert.equal((await b.post('importados/revalidar',{previaId:previa.previaId,confirmar})).status,400);
  assert.equal((await b.post('importados/revalidar',{previaId:previa.previaId,confirmar:true,envio:true})).status,400);
  assert.equal((await b.post('importados/revalidar',{previaId:previa.previaId,confirmar:true},{origin:'https://externo.invalid'})).status,403);
  const revised=await b.post('importados/revalidar',{previaId:previa.previaId,confirmar:true});assert.equal(revised.status,200);
  assert.equal((await revised.json()).projeto.acordoVerificado,false);
  const writes=b.db.prepare('SELECT total_changes() n').get().n;
  const retry=await b.post('importados/revalidar',{previaId:previa.previaId,confirmar:true});assert.equal(retry.status,200);
  assert.equal((await retry.json()).projeto.alterado,false);assert.equal(b.db.prepare('SELECT total_changes() n').get().n,writes);semAutoridade(b);
});

test('AUDIT-QUI: renderer real em 390/1440, consentimento, escape e resposta tardia',{
  skip:process.env.LUME_AUDIT_QUARTA_UI!=='1'?'requer LUME_AUDIT_QUARTA_UI=1':false,timeout:60000
},async t=>{
  const a=ambiente(t),b=ambiente(t),c=criar(a);await transferir(a,b);await http(b);
  const {chromium}=await import('playwright'),browser=await chromium.launch({channel:'msedge',headless:true});
  const errors=[],external=[],evidence={sintetico:true,data:new Date().toISOString(),larguras:[]};
  try{
    const page=await browser.newPage({viewport:{width:390,height:950},reducedMotion:'reduce'});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{if(!route.request().url().startsWith(b.origin)){external.push(route.request().url());return route.abort();}return route.continue();});
    await page.goto(b.origin+'/app');await page.locator('#clarity-content:not([hidden])').waitFor();
    await page.locator('[data-route="projects"]').first().click();
    const review=page.locator('.projects-imported').getByRole('button',{name:'Conferir fontes',exact:true});await review.waitFor();
    for(const width of [390,1440]){
      await page.setViewportSize({width,height:950});await page.screenshot({path:join(out,`lista-${width}.png`)});
      await review.click();await page.locator('#project-import-confirm').waitFor();
      const dialog=page.locator('#projects-dialog');
      assert.equal(await page.locator('#project-import-confirm').isChecked(),false);
      assert.equal(await dialog.getByRole('button',{name:'Retomar rascunho',exact:true}).isEnabled(),false);
      const text=await dialog.innerText();assert.ok(text.includes(nome));assert.doesNotMatch(text,/OUTRO PROJETO OMITIDO|OUTRO ASSUNTO OMITIDO/);
      assert.equal(await page.evaluate(()=>window.auditXss),undefined);assert.equal(await dialog.locator('img').count(),0);
      assert.equal(await dialog.evaluate(n=>n.scrollWidth>n.clientWidth),false);
      await page.screenshot({path:join(out,`previa-${width}.png`)});
      await page.locator('#project-import-confirm').focus();await page.keyboard.press('Space');
      assert.equal(await dialog.getByRole('button',{name:'Retomar rascunho',exact:true}).isEnabled(),true);
      await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);
      assert.equal(await review.evaluate(n=>n===document.activeElement),true);
      evidence.larguras.push({width,consentimentoInicial:false,semOverflow:true,escape:true,focoRestaurado:true});
    }
    // Resposta de prévia chega depois do fechamento: não repõe conteúdo privado no DOM.
    let release,requested;const requestedPromise=new Promise(r=>requested=r);
    await page.route('**/api/v3/projetos-comerciais/importados/previa',async route=>{requested();await new Promise(r=>release=r);await route.continue();});
    await review.click();await requestedPromise;await page.keyboard.press('Escape');release();await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#projects-dialog').isVisible(),false);assert.equal(await page.locator('#projects-dialog').innerHTML(),'');
    await page.unroute('**/api/v3/projetos-comerciais/importados/previa');
    await review.click();await page.locator('#project-import-confirm').check();
    await page.getByRole('button',{name:'Retomar rascunho',exact:true}).click();
    await page.getByRole('button',{name:'Confirmar organização',exact:true}).waitFor();
    assert.equal(b.service.obter(c.p.id).estado,'rascunho');assert.equal(b.service.obter(c.p.id).acordoVerificado,false);
    for(const width of [390,1440]){await page.setViewportSize({width,height:950});await page.screenshot({path:join(out,`rascunho-${width}.png`)});}
    semAutoridade(b);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    Object.assign(evidence,{respostaTardiaOculta:true,rascunhoRetomado:true,semAceite:true,errors,external});
  }finally{writeFileSync(join(out,'ui-evidence.json'),JSON.stringify({...evidence,errors,external},null,2));await browser.close();}
});
