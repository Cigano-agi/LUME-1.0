import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {DesktopTarefas} from '../src/desktop-tarefas.js';
import {Semantica} from '../src/semantica.js';
import {prepararRecuperacao,recuperar,recorte} from '../src/recuperacao.js';
import {prepararEsquemaTranscricao,gravarTranscricao} from '../src/transcricao.js';
import {assinaturaFonte} from '../src/tarefas-esquema.js';
import {Compartilhamento,assinarPacote,fingerprint} from '../src/compartilhamento.js';
import {Backup} from '../src/backup.js';
import {Privacidade} from '../src/privacidade.js';
const agora=()=>new Date('2026-09-18T15:00:00Z');
async function env(t,{gerar,extrair=async()=>[1,0]}={}){
 const db=abrirBanco();t.after(()=>db.close());const contexto=new ContextoApp(db),desktop=new Desktop(db);
 db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('grupo','Equipe sintética');
 const semantica=new Semantica(db,{extrair}),calls=[];
 const ia=new DesktopIA(db,{semantica,agora,segredos:{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>'fake_chave_para_teste'},gerar:async req=>{calls.push(req);if(gerar)return gerar(req);const fontes=JSON.parse(req.pedido.contents[0].parts[0].text).fontes;return req.pedido.systemInstruction.parts[0].text.startsWith('Extraia')?{dados:{itens:fontes.filter(f=>f.analisar).map(f=>({tipo:'compromisso',resumo:'Revisar o orçamento.',fonte:f.fonte,trecho:f.texto,prazo_citado:''}))}}:{dados:{insuficiente:true,afirmacoes:[]}};}});
 await ia.configurar({habilitada:true,limiteUSD:1,cienteEnvio:true});ia.permitir({conversa:'grupo',permitida:true});
 const tarefas=new DesktopTarefas(db,{ia,agora,perfil:()=>({aceito:true})}),f10=new Compartilhamento(db),backup=new Backup(db),priv=new Privacidade(db);
 prepararEsquemaTranscricao(db);let n=0;
 const audio=(texto='Transcrição: Vou revisar o orçamento amanhã.',permissao='minha',capturado=null)=>{
   const origemId='a'+(++n),conversaId='grupo';const id=Number(db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('grupo',?,'entrada','audio','{}',?,'2026-09-18T12:00:00.000Z','2026-09-18',?)").run(origemId,capturado,permissao).lastInsertRowid);
   gravarTranscricao(db,{conversaId,origemId,textoOriginal:texto});return {id,conversaId,origemId};
 };
 const lexical=q=>recuperar(db,recorte({pergunta:q,periodo:'tudo'},agora()));
 const integridade=()=>db.exec("INSERT INTO desktop_fontes_fts(desktop_fontes_fts,rank) VALUES('integrity-check',1)");
 return {db,contexto,desktop,semantica,ia,tarefas,f10,backup,priv,audio,lexical,integridade,calls};
}
test('áudio: lexical, denso, híbrido e fonte aberta usam o texto transcrito com ACL e avisos',async t=>{
 const e=await env(t),a=e.audio();e.audio('Transcrição: Segredo no orçamento','terceiro');
 assert.deepEqual(e.lexical('orçamento').map(x=>x.id),[a.id]);assert.equal(e.db.prepare('SELECT texto FROM eventos WHERE id=?').get(a.id).texto,null);
 await e.semantica.ativar();await e.semantica.indexar();assert.equal(e.semantica.estado().indexados,1);
 for(const modo of ['lexical','denso','hibrido']){
   const p=await e.ia.prepararConsulta({pergunta:'orçamento',periodo:'tudo',modo});assert.deepEqual(p.fontes.map(f=>f.id),[a.id]);assert.equal(p.fontes[0].texto,e.desktop.fonte(a.id).texto);assert.match(p.fontes[0].avisos[0],/Preâmbulo/);assert.equal(p.fontes[0].transcricao_meta,undefined);
 }
 e.ia.permitir({conversa:'grupo',permitida:false});assert.deepEqual(e.lexical('orçamento'),[]);assert.equal((await e.semantica.buscar(recorte({pergunta:'orçamento',periodo:'tudo'},agora()))).length,0);e.integridade();
});
test('áudio: insert/upsert/delete mantêm FTS coerente e removem tokens antigos e vetores',async t=>{
 const e=await env(t),a=e.audio('Transcrição: PalavraAntiga','minha','<anexado: arquivo.opus>');await e.semantica.ativar();await e.semantica.indexar();e.integridade();
 assert.equal(e.lexical('arquivo').length,0);assert.equal(e.lexical('PalavraAntiga').length,1);
 gravarTranscricao(e.db,{...a,textoOriginal:'Transcrição: PalavraNova'});e.integridade();assert.equal(e.lexical('PalavraAntiga').length,0);assert.equal(e.lexical('PalavraNova').length,1);assert.equal(e.semantica.estado().indexados,0);
 await e.semantica.indexar();e.db.prepare("UPDATE transcricoes SET estado='erro',texto=NULL WHERE origem_id=?").run(a.origemId);e.integridade();assert.equal(e.lexical('PalavraNova').length,0);assert.equal(e.semantica.estado().total,0);
 e.db.exec('DELETE FROM transcricoes');e.integridade();assert.equal(e.lexical('arquivo').length,1,'referência capturada volta à projeção, sem inventar fala');
 e.db.exec('DELETE FROM eventos');e.integridade();assert.equal(e.lexical('arquivo').length,0);
});
test('áudio: mudança somente no original invalida prévia e sugestões aceitas sem alterar o texto tratado',async t=>{
 const e=await env(t),a=e.audio(),p=e.ia.preparar({pergunta:'orçamento',periodo:'tudo'});
 const q=e.tarefas.preparar({conversa:'grupo',periodo:'tudo'});await e.tarefas.gerar({id:q.id,confirmar:true});const s=e.tarefas.listar().sugestoes[0];e.tarefas.decidir({id:s.id,acao:'aceitar'});assert.equal(e.desktop.resumo().fila.total,1);
 const texto=e.desktop.fonte(a.id).texto;gravarTranscricao(e.db,{...a,textoOriginal:'  Transcrição: Vou revisar o orçamento amanhã.  '});assert.equal(e.desktop.fonte(a.id).texto,texto);
 const before=e.calls.length;await assert.rejects(()=>e.ia.responder({id:p.id,confirmar:true}),/mudou|revogada/);assert.equal(e.calls.length,before);
 assert.equal(e.tarefas.listar({estado:'aceita'}).sugestoes.length,0);assert.equal(e.desktop.resumo().fila.total,0);
});
test('áudio: alteração durante inferência não recria vetor e durante provedor não publica resposta',async t=>{
 let release,started;const ready=new Promise(r=>started=r),held=new Promise(r=>release=r);
 const e=await env(t,{extrair:async()=>{started();await held;return[1,0];}}),a=e.audio();await e.semantica.ativar();const indexing=e.semantica.indexar();await ready;
 gravarTranscricao(e.db,{...a,textoOriginal:'Transcrição: Outra resposta agora.'});release();await indexing;assert.equal(e.semantica.estado().indexados,0);
 let done,sent;const sending=new Promise(r=>sent=r),finish=new Promise(r=>done=r);
 const f=await env(t,{gerar:async()=>{sent();await finish;return{dados:{insuficiente:true,afirmacoes:[]}};}}),b=f.audio(),p=f.ia.preparar({pergunta:'orçamento',periodo:'tudo'}),answer=f.ia.responder({id:p.id,confirmar:true});
 await sending;gravarTranscricao(f.db,{...b,textoOriginal:'Transcrição: Outra resposta agora.'});done();await assert.rejects(()=>answer,/mudou|revogada/);
});
test('áudio: migração do FTS antigo inclui transcrições sem reescrever captura; hash de texto comum permanece',async t=>{
 const e=await env(t),a=e.audio();e.db.exec('DROP TABLE desktop_fontes_fts');e.db.exec("CREATE VIRTUAL TABLE desktop_fontes_fts USING fts5(texto,content='eventos',content_rowid='id',tokenize='unicode61 remove_diacritics 2');INSERT INTO desktop_fontes_fts(desktop_fontes_fts) VALUES('rebuild')");
 assert.equal(e.lexical('orçamento').length,0);prepararRecuperacao(e.db);assert.equal(e.lexical('orçamento')[0].id,a.id);e.integridade();assert.equal(e.db.prepare('SELECT texto FROM eventos WHERE id=?').get(a.id).texto,null);
 const note=e.contexto.nota({texto:'Texto comum'}).id;assert.equal(assinaturaFonte(e.db.prepare('SELECT * FROM eventos WHERE id=?').get(note)),assinaturaFonte(e.db.prepare('SELECT * FROM desktop_fontes WHERE id=?').get(note)));
});
test('áudio F10 v2: assinatura real, ida/volta, dedup e remoção mantêm original separado e índice coerente',async t=>{
 const a=await env(t),b=await env(t),x=a.audio();a.audio('Transcrição: NUNCA EXPORTAR','terceiro');
 const p=a.f10.criarProjeto({nome:'Áudios',conversas:['grupo']}),dest=b.f10.criarProjeto({nome:'Recebidos'}),keys=generateKeyPairSync('ed25519'),fp=fingerprint(keys.publicKey);
 const content=a.f10.prepararExportacao({projeto:p.id,pessoa:'Origem',maquina:'Teste',destinatario:'Beta'});assert.equal(content.versao,'assessor-f10-v2');assert.equal(content.eventos.length,1);assert.equal(content.eventos[0].texto,null);assert.ok(content.eventos[0].transcricao.textoOriginal);
 const pkg=assinarPacote(content,keys.privateKey),options={projeto:dest.id,fingerprintConfirmada:fp};assert.equal(b.f10.importar(pkg,options).novos,1);assert.equal(b.f10.importar(pkg,options).repetido,true);
 const source=b.desktop.buscar({q:'orçamento'}).mensagens[0];assert.equal(b.desktop.fonte(source.id).transcricao.textoOriginal,a.desktop.fonte(x.id).transcricao.textoOriginal);assert.equal(b.db.prepare('SELECT texto FROM eventos').get().texto,null);
 assert.equal(b.lexical('orçamento').length,1);b.integridade();const again=b.f10.prepararExportacao({projeto:dest.id,pessoa:'Beta',maquina:'Teste',destinatario:'Volta'});assert.deepEqual(again.eventos[0].transcricao,content.eventos[0].transcricao);
 b.f10.removerOrigem({fingerprint:fp,confirmar:'REMOVER'});assert.equal(b.lexical('orçamento').length,0);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n,0);b.integridade();
});
test('áudio F10: original alterado invalida exportação; conflito nativo e metadados extras são recusados',async t=>{
 const a=await env(t),b=await env(t),x=a.audio();b.audio('Transcrição: Conteúdo nativo diferente.');
 const p=a.f10.criarProjeto({nome:'Áudios',conversas:['grupo']}),d=b.f10.criarProjeto({nome:'Destino'}),keys=generateKeyPairSync('ed25519');
 const content=a.f10.prepararExportacao({projeto:p.id,pessoa:'Origem',maquina:'Teste',destinatario:'Beta'}),pkg=assinarPacote(content,keys.privateKey);
 assert.throws(()=>b.f10.importar(pkg,{projeto:d.id,fingerprintConfirmada:fingerprint(keys.publicKey)}),/diferente/);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM f10_origens').get().n,0);
 const bad=structuredClone(content);bad.eventos[0].transcricao.arquivo='caminho';assert.throws(()=>assinarPacote(bad,keys.privateKey),/incompatível/);
 gravarTranscricao(a.db,{...x,textoOriginal:'  Transcrição: Vou revisar o orçamento amanhã.  '});assert.throws(()=>a.f10.conferirAtual(content),/mudaram/);
});
test('áudio: backup v3 restaura fonte de tarefa e FTS; exclusão elimina todos os derivados',async t=>{
 const a=await env(t),b=await env(t),x=a.audio();b.db.exec('DELETE FROM conversas_app');
 const p=a.tarefas.preparar({conversa:'grupo',periodo:'tudo'});await a.tarefas.gerar({id:p.id,confirmar:true});a.tarefas.decidir({id:a.tarefas.listar().sugestoes[0].id,acao:'aceitar'});
 const senha='senha sintética para o teste',backup=await a.backup.criar({senha,confirmar:true}),previa=await b.backup.preparar({arquivo:JSON.stringify(backup.pacote),senha});b.backup.restaurar({id:previa.id,confirmarMeuBackup:true});
 assert.equal(b.desktop.resumo().fila.total,1);assert.equal(recuperar(b.db,recorte({pergunta:'orçamento',periodo:'tudo'},agora()),{remoto:false}).length,1);b.integridade();
 const del=b.priv.preparar({fonte:x.id});b.priv.excluir({id:del.id,confirmar:'APAGAR'});assert.equal(b.desktop.resumo().fila.total,0);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n,0);b.integridade();
});
test('F10 v1 continua legível sem inventar transcrição ausente',async t=>{
 const a=await env(t),b=await env(t);a.audio();const p=a.f10.criarProjeto({nome:'Legado',conversas:['grupo']}),d=b.f10.criarProjeto({nome:'Destino'}),keys=generateKeyPairSync('ed25519');
 const c=a.f10.prepararExportacao({projeto:p.id,pessoa:'Origem',maquina:'Teste',destinatario:'Beta'});c.versao='assessor-f10-v1';for(const e of c.eventos)delete e.transcricao;
 b.f10.importar(assinarPacote(c,keys.privateKey),{projeto:d.id,fingerprintConfirmada:fingerprint(keys.publicKey)});assert.equal(b.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n,0);assert.equal(b.desktop.buscar({q:'orçamento'}).mensagens.length,0);
});

test('áudio: mover vínculo da transcrição e editar captura mantém FTS e invalida ambos os vetores',async t=>{
 const e=await env(t),a=e.audio('Transcrição: origem antiga'),b=e.audio('Transcrição: outra fala');
 e.db.prepare('DELETE FROM transcricoes WHERE origem_id=?').run(b.origemId);
 await e.semantica.ativar();await e.semantica.indexar();
 e.db.prepare('UPDATE transcricoes SET origem_id=? WHERE origem_id=?').run(b.origemId,a.origemId);e.integridade();
 assert.deepEqual(e.lexical('antiga').map(x=>x.id),[b.id]);assert.equal(e.semantica.estado().indexados,0);
 e.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Mensagem capturada independente',b.id);e.integridade();
 assert.equal(e.lexical('antiga').length,0);assert.equal(e.lexical('independente')[0].id,b.id);
 e.db.prepare('UPDATE eventos SET texto=NULL WHERE id=?').run(b.id);e.integridade();assert.equal(e.lexical('antiga')[0].id,b.id);
});

test('F10 v2 conserva silêncio, falha e legado sem fabricar original nem evidência para IA',async t=>{
 const a=await env(t),b=await env(t),silencio=a.audio('(sem fala)'),falha=a.audio('(sem fala)'),legado=a.audio();
 gravarTranscricao(a.db,{...falha,textoOriginal:'(sem fala)',erro:'Falha sintética'});
 gravarTranscricao(a.db,{...legado,texto:'Texto legado'});
 const p=a.f10.criarProjeto({nome:'Estados',conversas:['grupo']}),d=b.f10.criarProjeto({nome:'Recebidos'}),keys=generateKeyPairSync('ed25519');
 const c=a.f10.prepararExportacao({projeto:p.id,pessoa:'Origem',maquina:'Teste',destinatario:'Beta'});
 b.f10.importar(assinarPacote(c,keys.privateKey),{projeto:d.id,fingerprintConfirmada:fingerprint(keys.publicKey)});b.integridade();
 const again=b.f10.prepararExportacao({projeto:d.id,pessoa:'Beta',maquina:'Teste',destinatario:'Volta'});
 for(const source of c.eventos)assert.deepEqual(again.eventos.find(x=>x.origem_id===source.origem_id).transcricao,source.transcricao);
 assert.equal(b.lexical('fala').length,0);assert.equal(b.lexical('falha').length,0);assert.equal(b.lexical('legado').length,1);
 assert.equal(c.eventos.find(x=>x.origem_id===silencio.origemId).transcricao.estado,'vazio');
});
