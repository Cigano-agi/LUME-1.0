import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {Compartilhamento,assinarPacote,verificarPacote,fingerprint} from '../src/compartilhamento.js';
import {recuperar,prepararRecuperacao,recorte} from '../src/recuperacao.js';
import {DesktopCompartilhamento} from '../src/desktop-compartilhamento.js';
const key=()=>generateKeyPairSync('ed25519');
function env(){const db=abrirBanco();const ctx=new ContextoApp(db);const app=new Desktop(db);const f=new Compartilhamento(db);return{db,ctx,app,f};}
function fonte(e,id='1',p='minha',text='Revisar proposta na sexta',conv='grupo'){
 e.ctx._registrarEvento({conversaId:conv,origemId:id,autorId:'pessoa',tipo:'texto',texto:text,bruto:{message:{mediaKey:'NAO-EXPORTAR'}},recebidoEm:new Date('2026-09-17T12:00:00Z')},p);
 e.db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(conv,'Conversa '+conv);
}
function pack(e,k,projeto){return assinarPacote(e.f.prepararExportacao({projeto,pessoa:'Sócio',maquina:'PC',destinatario:'Equipe'}),k.privateKey);}
function importar(e,p,k,projeto){return e.f.importar(p,{projeto,fingerprintConfirmada:fingerprint(k.publicKey)});}
test('exportação filtra antes de assinar, mantém projeto e exclui envelope de transporte',()=>{
 const a=env();fonte(a);fonte(a,'2','terceiro');fonte(a,'3','minha','Outro projeto','fora');
 const pr=a.f.criarProjeto({nome:'Beta',conversas:['grupo']}).id,k=key(),p=pack(a,k,pr);
 assert.equal(p.conteudo.eventos.length,1);assert.ok(!JSON.stringify(p).includes('NAO-EXPORTAR'));
 a.app.politica({conversa:'grupo',politica:'tudo'});assert.equal(pack(a,k,pr).conteudo.eventos.length,2);
 a.app.politica({conversa:'grupo',politica:'so-minhas'});assert.throws(()=>a.f.conferirAtual({...p.conteudo,eventos:[]}),/mudaram/);a.db.close();
});
test('fonte F10 revogada por NULL não pode ser reexportada com procedência preservada',()=>{
 const a=env(),b=env();fonte(a);const pr=a.f.criarProjeto({nome:'Origem',conversas:['grupo']}).id,br=b.f.criarProjeto({nome:'Destino'}).id,k=key();
 importar(b,pack(a,k,pr),k,br);
 const args={projeto:br,pessoa:'Equipe',maquina:'PC',destinatario:'Outra pessoa'};
 assert.equal(b.f.prepararExportacao(args).eventos.length,1);
 b.db.prepare("UPDATE eventos SET permissao=NULL WHERE origem_id='1'").run();
 assert.deepEqual(b.app.buscar().mensagens,[]);
 assert.throws(()=>b.f.prepararExportacao(args),/não tem fontes/);
 a.db.close();b.db.close();
});
test('política tudo não exporta fonte compartilhada cuja procedência foi removida',()=>{
 const a=env(),b=env();fonte(a);const pr=a.f.criarProjeto({nome:'Origem',conversas:['grupo']}).id,br=b.f.criarProjeto({nome:'Destino'}).id,k=key();
 importar(b,pack(a,k,pr),k,br);
 const compartilhada=b.db.prepare("SELECT id FROM eventos WHERE origem_id='1'").get().id;
 const nota=b.ctx.nota({texto:'Resumo derivado da fonte compartilhada',fontes:[compartilhada]});
 b.app.politica({conversa:'grupo',politica:'tudo'});
 b.db.exec('DELETE FROM f10_procedencias');
 assert.deepEqual(b.app.buscar().mensagens,[]);
 assert.deepEqual(b.f.privacidade.exportar({confirmar:true}).conteudo.eventos,[]);
 assert.equal(b.db.prepare('SELECT 1 FROM eventos WHERE id=?').get(nota.id)!=null,true,'o acervo é preservado');
 assert.throws(()=>b.f.prepararExportacao({projeto:br,pessoa:'Equipe',maquina:'PC',destinatario:'Outra pessoa'}),/não tem fontes/);
 a.db.close();b.db.close();
});
test('assinatura e confiança independentes; adulteração/checksum, troca de chave e esquema recusados',()=>{
 const a=env(),b=env();fonte(a);const pr=a.f.criarProjeto({nome:'A',conversas:['grupo']}).id,bpr=b.f.criarProjeto({nome:'B'}).id,k=key(),p=pack(a,k,pr);
 const tamper=structuredClone(p);tamper.conteudo.eventos[0].texto='Mudou';assert.throws(()=>importar(b,tamper,k,bpr),/Assinatura/);
 assert.throws(()=>b.f.importar(p,{projeto:bpr,fingerprintConfirmada:'0'.repeat(64)}),/impressão/);
 const evil=assinarPacote(p.conteudo,key().privateKey);assert.throws(()=>importar(b,evil,k,bpr),/impressão/);
 const extras=structuredClone(p);extras.conteudo.eventos[0].permissao='minha';assert.throws(()=>verificarPacote(extras),/campos/);
 assert.equal(b.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0);a.db.close();b.db.close();
});
test('importação visível como compartilhado, sem IA automática, idempotente e com origem',()=>{
 const a=env(),b=env();fonte(a);const k=key(),pr=a.f.criarProjeto({nome:'A',conversas:['grupo']}).id,bpr=b.f.criarProjeto({nome:'B'}).id,p=pack(a,k,pr);
 assert.equal(importar(b,p,k,bpr).novos,1);assert.equal(importar(b,p,k,bpr).repetido,true);
 const e=b.app.buscar().mensagens[0];assert.equal(e.permissao,'compartilhado');assert.equal(e.autor_e_dono,0);assert.equal(JSON.parse(e.origem_compartilhamento)[0].fingerprint,fingerprint(k.publicKey));
 b.db.exec('CREATE TABLE desktop_ia_conversas(conversa_id TEXT,permitida INTEGER)');prepararRecuperacao(b.db);
 const filtro=recorte({pergunta:'proposta',projeto:bpr,periodo:'tudo'},new Date('2026-09-17T15:00:00Z'));
 assert.equal(recuperar(b.db,filtro).length,0);assert.equal(recuperar(b.db,filtro,{remoto:false}).length,1);
 assert.equal(recuperar(b.db,{...filtro,projeto:'outro'},{remoto:false}).length,0);a.db.close();b.db.close();
});
test('múltiplas origens, exclusão seletiva, índice removido e reimportação bloqueada',()=>{
 const a=env(),b=env();fonte(a);const pr=a.f.criarProjeto({nome:'A',conversas:['grupo']}).id,bpr=b.f.criarProjeto({nome:'B'}).id,k1=key(),k2=key(),p1=pack(a,k1,pr),p2=pack(a,k2,pr);
 importar(b,p1,k1,bpr);importar(b,p2,k2,bpr);prepararRecuperacao(b.db);
 assert.equal(JSON.parse(b.app.buscar().mensagens[0].origem_compartilhamento).length,2);
 assert.equal(b.f.removerOrigem({fingerprint:fingerprint(k1.publicKey),confirmar:'REMOVER'}).preservados,1);
 assert.throws(()=>importar(b,p1,k1,bpr),/bloqueada/);
 assert.equal(b.f.removerOrigem({fingerprint:fingerprint(k2.publicKey),confirmar:'REMOVER'}).removidos,1);
  assert.equal(b.app.buscar().mensagens.length,0);assert.equal(b.db.prepare("SELECT COUNT(*) n FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH 'proposta'").get().n,0);a.db.close();b.db.close();
});
test('colisão nativa preserva autoria, importação parcial e divergência aborta inteiro',()=>{
 const a=env(),b=env();fonte(a);fonte(a,'2');fonte(b);const pr=a.f.criarProjeto({nome:'A',conversas:['grupo']}).id,bpr=b.f.criarProjeto({nome:'B'}).id,k=key(),p=pack(a,k,pr);
 const bad=structuredClone(p.conteudo);bad.eventos[0].texto='Conflito';assert.throws(()=>importar(b,assinarPacote(bad,k.privateKey),k,bpr),/diferente/);assert.equal(b.app.buscar().mensagens.length,1);
 assert.deepEqual(importar(b,p,k,bpr),{novos:1,existentes:1,repetido:false});b.f.removerOrigem({fingerprint:fingerprint(k.publicKey),confirmar:'REMOVER'});
 assert.equal(b.app.buscar().mensagens.length,1);assert.equal(b.app.buscar().mensagens[0].permissao,'minha');a.db.close();b.db.close();
});
test('vazio, data impossível, origem duplicada e projeto inexistente falham sem pacote enganoso',()=>{
 const a=env();const pr=a.f.criarProjeto({nome:'Vazio'}).id,k=key();assert.throws(()=>pack(a,k,pr),/não tem fontes/);
 fonte(a);const p=pack(a,k,a.f.criarProjeto({nome:'A',conversas:['grupo']}).id);
 const bad=structuredClone(p.conteudo);bad.eventos[0].recebido_em='2026-02-30T12:00:00.000Z';assert.throws(()=>assinarPacote(bad,k.privateKey),/Evento inválido/);
 const dup=structuredClone(p.conteudo);dup.eventos.push(dup.eventos[0]);assert.throws(()=>assinarPacote(dup,k.privateKey),/repetida/);a.db.close();
});

test('captura nativa posterior à importação sobrevive à remoção do remetente',()=>{
 const a=env(),b=env();fonte(a);const pr=a.f.criarProjeto({nome:'A',conversas:['grupo']}).id,bpr=b.f.criarProjeto({nome:'B'}).id,k=key();importar(b,pack(a,k,pr),k,bpr);
 fonte(b);assert.equal(b.app.buscar().mensagens[0].permissao,'minha');
 assert.equal(b.f.removerOrigem({fingerprint:fingerprint(k.publicKey),confirmar:'REMOVER'}).preservados,1);assert.equal(b.app.buscar().mensagens.length,1);a.db.close();b.db.close();
});
test('confere revogação após assinatura assíncrona, não entrega prévia obsoleta',async()=>{
 const a=env();fonte(a,'1','terceiro');a.app.politica({conversa:'grupo',politica:'tudo'});const pr=a.f.criarProjeto({nome:'A',conversas:['grupo']}).id,k=key();
 const ui=new DesktopCompartilhamento(a.db,{perfil:()=>({nome:'Pessoa'}),identidade:async(op,serialized)=>{a.app.politica({conversa:'grupo',politica:'so-minhas'});const p=assinarPacote(JSON.parse(serialized),k.privateKey);return{chave_publica:p.chave_publica,assinatura:p.assinatura};}});
 const preview=ui.prepararExportacao({projeto:pr,destinatario:'Sócio'});await assert.rejects(()=>ui.exportar({id:preview.id,confirmar:true}),/não tem fontes|mudaram/);a.db.close();
});
test('falha nos derivados reverte remoção e bloqueio; rascunho acompanha fonte apagada',()=>{
 const a=env(),b=env();fonte(a);const pr=a.f.criarProjeto({nome:'A',conversas:['grupo']}).id,bpr=b.f.criarProjeto({nome:'B'}).id,k=key();importar(b,pack(a,k,pr),k,bpr);
 b.db.exec(`CREATE TABLE transcricoes(conversa_id TEXT,origem_id TEXT,arquivo TEXT);INSERT INTO transcricoes VALUES('grupo','1','arquivo-externo');`);
 assert.throws(()=>b.f.removerOrigem({fingerprint:fingerprint(k.publicKey),confirmar:'REMOVER'}),/gestão de arquivos/);assert.equal(b.app.buscar().mensagens.length,1);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM f10_revogadas').get().n,0);
 b.db.exec(`DELETE FROM transcricoes;CREATE TABLE rascunhos(item_id INTEGER,texto TEXT);INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em) VALUES('grupo','1','pendencia','Derivado','2026-09-17');INSERT INTO rascunhos VALUES(1,'Cópia derivada');`);
 const r=b.f.removerOrigem({fingerprint:fingerprint(k.publicKey),confirmar:'REMOVER'});assert.equal(r.derivados.rascunhos,1);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM itens_crm').get().n,0);a.db.close();b.db.close();
});
