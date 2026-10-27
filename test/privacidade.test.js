import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,readFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {Privacidade} from '../src/privacidade.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {Compartilhamento,assinarPacote,fingerprint} from '../src/compartilhamento.js';
import {LumeMcpReadService} from '../src/mcp/read-service.js';
function env(t){const dir=mkdtempSync(join(tmpdir(),'assessor-direitos-')),db=abrirBanco(join(dir,'assessor.db')),ctx=new ContextoApp(db);new Desktop(db);new DesktopIA(db);const arquivos=new ArquivosDados(dir),p=new Privacidade(db,{arquivos});t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return{db,ctx,dir,arquivos,p};}
const note=(e,text='Texto secreto para apagar')=>e.ctx.nota({texto:text,titulo:'Nota teste'}).id;
const count=(e,t)=>e.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
test('exclusão alcança nota vinculada, rascunho, CRM e FTS; preserva outra fonte e custo',t=>{
 const e=env(t),id=note(e),other=note(e,'Continuar com esta fonte');e.ctx.nota({texto:'Resumo derivado',fontes:[id]});
 const source=e.db.prepare('SELECT * FROM eventos WHERE id=?').get(id);
 e.db.prepare("INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em) VALUES(?,?,'pendencia','Tarefa derivada','2026-09-17')").run(source.conversa_id,source.origem_id);
 e.db.exec("CREATE TABLE rascunhos(item_id INTEGER,texto TEXT);INSERT INTO rascunhos VALUES(1,'Texto derivado');INSERT INTO desktop_ia_gastos VALUES('gasto','2026-09-17',1000,'reservado','2026-09-17',NULL,NULL)");
 const p=e.p.preparar({fonte:id});assert.equal(p.contagens.eventos,2);assert.equal(p.contagens.notasDerivadas,1);
 const r=e.p.excluir({id:p.id,confirmar:'APAGAR'});assert.equal(r.estado,'concluida');assert.equal(count(e,'eventos'),1);assert.equal(count(e,'itens_crm'),0);assert.equal(count(e,'rascunhos'),0);assert.equal(count(e,'desktop_ia_gastos'),1);
 assert.equal(e.db.prepare("SELECT COUNT(*) n FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH 'secreto'").get().n,0);assert.ok(e.db.prepare('SELECT 1 FROM eventos WHERE id=?').get(other));
 assert.equal(e.ctx._registrarEvento({conversaId:source.conversa_id,origemId:source.origem_id,texto:'Tentativa replay'},'minha').excluido,true);
});
test('todo histórico inclui terceiros ocultos, apaga metadados e não ressuscita no lote/grupos',t=>{
 const e=env(t);const msg={key:{remoteJid:'grupo@g.us',id:'wa1',fromMe:false},participant:'pessoa@lid',pushName:'Nome privado',messageTimestamp:1700000000,message:{conversation:'Mensagem oculta'}};
 e.ctx.receber({type:'notify',messages:[msg]});e.ctx.salvarGrupos({'grupo@g.us':{id:'grupo@g.us',subject:'Nome grupo',participants:[{id:'pessoa@lid'}]}});
 const pre=e.p.preparar({tudo:true});assert.equal(pre.contagens.eventos,1);e.p.excluir({id:pre.id,confirmar:'APAGAR'});
 for(const t of ['eventos','pessoas','pessoa_identificadores','conversas_app','grupos_app','grupo_participantes'])assert.equal(count(e,t),0,t);
 e.ctx.receber({type:'append',messages:[msg]});e.ctx.salvarGrupos({'grupo@g.us':{id:'grupo@g.us',subject:'Nome grupo',participants:[]}});assert.equal(count(e,'eventos'),0);assert.equal(count(e,'conversas_app'),0);assert.equal(count(e,'pessoas'),0);
 e.ctx.receber({type:'notify',messages:[{...msg,key:{...msg.key,id:'wa2'},message:{conversation:'Mensagem nova permitida'}}]});assert.equal(count(e,'eventos'),1);
});
test('prévia expirada/mudada e tabela desconhecida falham sem exclusão',t=>{
 const e=env(t),id=note(e),p=e.p.preparar({fonte:id});e.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Mudou',id);
 assert.throws(()=>e.p.excluir({id:p.id,confirmar:'APAGAR'}),/mudaram/);assert.equal(count(e,'eventos'),1);
 e.db.exec("CREATE TABLE extensao(texto TEXT);INSERT INTO extensao VALUES('cópia não mapeada')");assert.throws(()=>e.p.preparar({tudo:true}),/não mapeada/);
});
test('exportação pessoal respeita leitura, permite incluir ocultas explicitamente e não inclui envelope/chave',t=>{
 const e=env(t);note(e);e.ctx._registrarEvento({conversaId:'grupo',origemId:'hidden',tipo:'texto',texto:'Oculto',bruto:{mediaKey:'SEGREDO-TRANSPORTE'}},'terceiro');
 assert.equal(e.p.exportar({confirmar:true}).conteudo.eventos.length,1);const out=e.p.exportar({confirmar:true,incluirOcultas:true});assert.equal(out.conteudo.eventos.length,2);assert.ok(!JSON.stringify(out).includes('SEGREDO-TRANSPORTE'));assert.throws(()=>e.p.exportar(),/Confirme/);
});
test('revogar uma fonte oculta notas dependentes em cadeia e impede novo vínculo',t=>{
 const e=env(t),origem=note(e,'Origem revogada'),independente=note(e,'Origem independente');
 const derivada=e.ctx.nota({texto:'Derivada de duas fontes',fontes:[origem,independente]}).id;
 const neta=e.ctx.nota({texto:'Neta da derivada',fontes:[derivada]}).id;
 const conversa=e.db.prepare('SELECT conversa_id FROM eventos WHERE id=?').get(origem).conversa_id;
 const f10=new Compartilhamento(e.db),conversas=e.db.prepare('SELECT conversa_id FROM eventos').all().map(r=>r.conversa_id);
 const projeto=f10.criarProjeto({nome:'Recorte sintético',conversas}).id;
 const args={projeto,pessoa:'Origem',maquina:'Teste',destinatario:'Destino'};
 assert.equal(f10.prepararExportacao(args).eventos.length,4);
 new Desktop(e.db).politica({conversa,politica:'tudo'});
 e.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(origem);
 assert.throws(()=>e.ctx.nota({texto:'Tentativa posterior',fontes:[origem]}),/indisponível/);
 assert.deepEqual(e.p.exportar({confirmar:true}).conteudo.eventos.map(r=>r.id),[independente]);
 assert.deepEqual(f10.prepararExportacao(args).eventos.map(r=>r.texto),['Origem independente']);
 const mcp=new LumeMcpReadService(e.db);
 assert.equal(mcp.fonte(derivada,{kind:'all'}),null);
 assert.equal(mcp.fonte(neta,{kind:'all'}),null);
 assert.equal(mcp.fonte(independente,{kind:'all'})?._id,independente);
 assert.ok(e.ctx.nota({texto:'Nota independente posterior',fontes:[independente]}).id>0);
});
test('retirar política tudo oculta nota derivada da exportação, mas mantém leitura local',t=>{
 const e=env(t),origem=note(e,'Fonte local de terceiro');
 const conversa=e.db.prepare('SELECT conversa_id FROM eventos WHERE id=?').get(origem).conversa_id;
 e.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(origem);
 const desktop=new Desktop(e.db);desktop.politica({conversa,politica:'tudo'});
 const derivada=e.ctx.nota({texto:'Nota derivada da fonte de terceiro',fontes:[origem]}).id;
 assert.deepEqual(e.p.exportar({confirmar:true}).conteudo.eventos.map(r=>r.id),[origem,derivada]);
 desktop.politica({conversa,politica:'so-minhas'});
 assert.deepEqual(e.p.exportar({confirmar:true}).conteudo.eventos,[]);
 assert.deepEqual(desktop.buscar().mensagens.map(r=>r.id).sort((a,b)=>a-b),[origem,derivada]);
});
test('arquivo gerido é removido; caminho externo bloqueia antes de mutar',t=>{
 const e=env(t),id=note(e),s=e.db.prepare('SELECT * FROM eventos WHERE id=?').get(id);mkdirSync(join(e.dir,'anexos'));const file=join(e.dir,'anexos','audio.opus');writeFileSync(file,'audio sintético');
 e.db.exec('CREATE TABLE transcricoes(conversa_id TEXT,origem_id TEXT,arquivo TEXT)');e.db.prepare('INSERT INTO transcricoes VALUES(?,?,?)').run(s.conversa_id,s.origem_id,file);
 const p=e.p.preparar({fonte:id});e.p.excluir({id:p.id,confirmar:'APAGAR'});assert.equal(existsSync(file),false);assert.equal(count(e,'transcricoes'),0);
 const id2=note(e),s2=e.db.prepare('SELECT * FROM eventos WHERE id=?').get(id2);e.db.prepare('INSERT INTO transcricoes VALUES(?,?,?)').run(s2.conversa_id,s2.origem_id,join(e.dir,'assessor.db'));assert.throws(()=>e.p.preparar({fonte:id2}),/fora dos anexos/);assert.equal(count(e,'eventos'),1);
});
test('journal recupera queda antes e depois do commit sem apagar arquivo externo',t=>{
 const e=env(t);mkdirSync(join(e.dir,'anexos'));const file=join(e.dir,'anexos','teste.txt');writeFileSync(file,'Original');
 e.arquivos.preparar(randomUUID(),[file]);assert.equal(existsSync(file),false);assert.equal(e.arquivos.recuperar(e.db).revertidas,1);assert.equal(readFileSync(file,'utf8'),'Original');
 const id=randomUUID();e.arquivos.preparar(id,[file]);e.db.prepare('INSERT INTO priv_recibos VALUES(?,?,?,?)').run(id,new Date().toISOString(),'arquivos_pendentes','{}');assert.equal(e.arquivos.recuperar(e.db).finalizadas,1);assert.equal(existsSync(file),false);
});
test('compartilhamento antigo não pode reinserir fonte excluída neste perfil',t=>{
 const a=env(t),b=env(t);note(a);const af=new Compartilhamento(a.db),bf=new Compartilhamento(b.db),pr=af.criarProjeto({nome:'A',conversas:a.db.prepare('SELECT id FROM conversas_app').all().map(c=>c.id)}).id,bp=bf.criarProjeto({nome:'B'}).id,key=generateKeyPairSync('ed25519');
 const p=assinarPacote(af.prepararExportacao({projeto:pr,pessoa:'A',maquina:'PC',destinatario:'B'}),key.privateKey),opts={projeto:bp,fingerprintConfirmada:fingerprint(key.publicKey)};bf.importar(p,opts);
 const pre=b.p.preparar({tudo:true});b.p.excluir({id:pre.id,confirmar:'APAGAR'});const bp2=bf.criarProjeto({nome:'Novo'}).id;assert.throws(()=>bf.importar(p,{...opts,projeto:bp2}),/bloqueada|excluída/);assert.equal(count(b,'eventos'),0);
});

test('remover origem inclui nota vinculada e anexo; preserva fonte nativa e outra origem',t=>{
 const a=env(t),b=env(t);note(a,'Fonte exclusiva');note(a,'Fonte de duas origens');note(a,'Fonte também nativa');
 const af=new Compartilhamento(a.db),bf=new Compartilhamento(b.db,{privacidade:b.p}),ap=af.criarProjeto({nome:'A',conversas:a.db.prepare('SELECT id FROM conversas_app').all().map(c=>c.id)}).id,bp=bf.criarProjeto({nome:'B'}).id,k=generateKeyPairSync('ed25519'),k2=generateKeyPairSync('ed25519'),fp=fingerprint(k.publicKey);
 const c=af.prepararExportacao({projeto:ap,pessoa:'A',maquina:'PC',destinatario:'B'});
 bf.importar(assinarPacote(c,k.privateKey),{projeto:bp,fingerprintConfirmada:fp});
 bf.importar(assinarPacote({...c,id:randomUUID(),eventos:[c.eventos[1]]},k2.privateKey),{projeto:bp,fingerprintConfirmada:fingerprint(k2.publicKey)});
 const rows=b.db.prepare('SELECT * FROM eventos ORDER BY id').all();b.db.prepare("UPDATE eventos SET permissao='minha',autor_e_dono=1 WHERE id=?").run(rows[2].id);
 const linked=b.ctx.nota({texto:'Resumo vinculado à contribuição',fontes:[rows[0].id]}).id;
 mkdirSync(join(b.dir,'anexos'));const file=join(b.dir,'anexos','audio.opus');writeFileSync(file,'audio sintético');b.db.exec('CREATE TABLE transcricoes(conversa_id TEXT,origem_id TEXT,arquivo TEXT)');b.db.prepare('INSERT INTO transcricoes VALUES(?,?,?)').run(rows[0].conversa_id,rows[0].origem_id,file);
 const p=bf.prepararRemocao({fingerprint:fp});assert.equal(p.contagens.notasDerivadas,1);assert.equal(p.contagens.originaisPreservados,2);assert.deepEqual(p.arquivos,[file]);
 const r=bf.removerOrigem({id:p.id,fingerprint:fp,confirmar:'REMOVER'});assert.equal(r.removidos,1);assert.equal(r.preservados,2);assert.equal(r.contagens.eventos,2);assert.equal(existsSync(file),false);assert.equal(b.db.prepare('SELECT * FROM eventos WHERE id=?').get(linked),undefined);
 assert.equal(count(b,'eventos'),2);assert.equal(count(b,'f10_origens'),1);assert.equal(JSON.parse(b.db.prepare('SELECT origem_compartilhamento s FROM eventos WHERE id=?').get(rows[1].id).s)[0].fingerprint,fingerprint(k2.publicKey));assert.equal(b.db.prepare('SELECT origem_compartilhamento s FROM eventos WHERE id=?').get(rows[2].id).s,null);
 assert.throws(()=>bf.importar(assinarPacote(c,k.privateKey),{projeto:bp,fingerprintConfirmada:fp}),/bloqueada/);
});

test('prévia de remoção rejeita outra origem e mudança na contribuição antes de apagar',t=>{
 const a=env(t),b=env(t);note(a);const af=new Compartilhamento(a.db),bf=new Compartilhamento(b.db,{privacidade:b.p}),ap=af.criarProjeto({nome:'A',conversas:a.db.prepare('SELECT id FROM conversas_app').all().map(c=>c.id)}).id,bp=bf.criarProjeto({nome:'B'}).id,k=generateKeyPairSync('ed25519'),fp=fingerprint(k.publicKey);
 const c=af.prepararExportacao({projeto:ap,pessoa:'A',maquina:'PC',destinatario:'B'});bf.importar(assinarPacote(c,k.privateKey),{projeto:bp,fingerprintConfirmada:fp});
 const p=bf.prepararRemocao({fingerprint:fp});assert.throws(()=>bf.removerOrigem({id:p.id,fingerprint:'f'.repeat(64),confirmar:'REMOVER'}),/outra origem/);
 b.ctx.nota({texto:'Nova derivação após prévia',fontes:[1]});assert.throws(()=>bf.removerOrigem({id:p.id,fingerprint:fp,confirmar:'REMOVER'}),/mudaram/);assert.equal(count(b,'eventos'),2);assert.equal(count(b,'f10_revogadas'),0);
});

test('arquivo físico compartilhado fica até a última fonte; falha final gera recibo recuperável',t=>{
 const e=env(t),a=note(e),b=note(e,'Outra referência'),rows=e.db.prepare('SELECT * FROM eventos ORDER BY id').all();mkdirSync(join(e.dir,'anexos'));const file=join(e.dir,'anexos','comum.txt');writeFileSync(file,'Conteúdo gerido');e.db.exec('CREATE TABLE transcricoes(conversa_id TEXT,origem_id TEXT,arquivo TEXT)');for(const r of rows)e.db.prepare('INSERT INTO transcricoes VALUES(?,?,?)').run(r.conversa_id,r.origem_id,file);
 let p=e.p.preparar({fonte:a});assert.equal(p.contagens.arquivosCompartilhadosPreservados,1);e.p.excluir({id:p.id,confirmar:'APAGAR'});assert.equal(existsSync(file),true);
 const original=e.arquivos.finalizar.bind(e.arquivos);e.arquivos.finalizar=()=>{throw new Error('Arquivo temporariamente ocupado');};p=e.p.preparar({fonte:b});const r=e.p.excluir({id:p.id,confirmar:'APAGAR'});assert.equal(r.arquivosPendentes,true);assert.equal(count(e,'eventos'),0);assert.equal(e.db.prepare('SELECT estado FROM priv_recibos WHERE id=?').get(r.id).estado,'arquivos_pendentes');
 e.arquivos.finalizar=original;assert.equal(e.arquivos.recuperar(e.db).finalizadas,1);assert.equal(e.db.prepare('SELECT estado FROM priv_recibos WHERE id=?').get(r.id).estado,'concluida');assert.equal(existsSync(file),false);
});

test('exclusão total cobre anexo sem vínculo; link para fora é recusado antes de tocar dados',t=>{
 const e=env(t),out=env(t);note(e);mkdirSync(e.arquivos.anexos);mkdirSync(out.arquivos.anexos);const externo=join(out.arquivos.anexos,'ficar.txt');writeFileSync(externo,'Outro perfil');const link=join(e.arquivos.anexos,'atalho');symlinkSync(out.arquivos.anexos,link,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>e.p.preparar({tudo:true}),/Link/);assert.equal(count(e,'eventos'),1);assert.equal(readFileSync(externo,'utf8'),'Outro perfil');unlinkSync(link);
 const orfao=join(e.arquivos.anexos,'sem-vinculo.bin');writeFileSync(orfao,'Anexo antigo');const p=e.p.preparar({tudo:true});assert.deepEqual(p.arquivos,[orfao]);e.p.excluir({id:p.id,confirmar:'APAGAR'});assert.equal(existsSync(orfao),false);assert.equal(readFileSync(externo,'utf8'),'Outro perfil');
});

test('excluir fonte descarta saídas da conversa e diagnósticos que podem conter cópias',t=>{
 const e=env(t),id=note(e);note(e,'Fonte que permanece');const c=e.db.prepare('SELECT conversa_id c FROM eventos WHERE id=?').get(id).c;
 e.db.prepare("INSERT INTO saidas(conversa_id,idempotencia,corpo,estado,criado_em,atualizado_em) VALUES(?,'s1','Texto secreto em saída','preparada','2026-09-17','2026-09-17')").run(c);e.db.exec("INSERT INTO entregas_punk(referencia,destino,estado,detalhe,criado_em) VALUES('e1','local','falha','Texto secreto no erro','2026-09-17');INSERT INTO saude(etapa,ultimo_erro) VALUES('teste','Texto secreto no diagnóstico')");
 const p=e.p.preparar({fonte:id});assert.equal(p.contagens.saidas,1);assert.equal(p.contagens.entregas_punk,1);e.p.excluir({id:p.id,confirmar:'APAGAR'});for(const table of['saidas','entregas_punk','saude'])assert.equal(count(e,table),0);assert.equal(count(e,'eventos'),1);
});
