import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {DesktopTarefas} from '../src/desktop-tarefas.js';
import {Privacidade} from '../src/privacidade.js';
import {Backup,abrirBackup,cifrarBackup} from '../src/backup.js';
import {prepararEsquemaTranscricao,transcreverArquivo,gravarTranscricao,limparTranscricao} from '../src/transcricao.js';
import {sinaisTextoModelo} from '../src/qualidade-transcricao.js';
function env(t){
  const db=abrirBanco();t.after(()=>db.close());const contexto=new ContextoApp(db),desktop=new Desktop(db);
  const ia=new DesktopIA(db,{agora:()=>new Date('2026-09-18T15:00:00Z'),segredos:{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>'chave_fake_apenas_teste'},gerar:async()=>({dados:{insuficiente:true,afirmacoes:[]}})});
  prepararEsquemaTranscricao(db);db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('audio-teste','Áudio sintético');
  let n=0;const audio=({permissao='minha',texto=null}={})=>{const origemId='audio-'+(++n);const id=Number(db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('audio-teste',?,'entrada','audio','{}',?,'2026-09-18T12:00:00Z','2026-09-18',?)").run(origemId,texto,permissao).lastInsertRowid);return {id,origemId,conversaId:'audio-teste'};};
  return {db,contexto,desktop,ia,audio,backup:new Backup(db),priv:new Privacidade(db)};
}
test('transcrição: original literal e todas as respostas da operação sobrevivem à limpeza e segunda tentativa',async t=>{
  const e=env(t),a=e.audio();let n=0;
  const original='  Aqui está a transcrição do áudio: "Enviar o orçamento amanhã."  ';
  const result=await transcreverArquivo('arquivo-sintetico.opus',{transcrever:async()=>({texto:n++?'  Aqui está a transcrição do áudio: "Enviar o orçamento amanhã."  ':'(sem fala)',duracaoMs:7})});
  assert.equal(n,2);assert.equal(result.duracaoMs,14);assert.equal(result.texto,'Enviar o orçamento amanhã.');
  gravarTranscricao(e.db,{...a,...result});const row=e.db.prepare('SELECT * FROM transcricoes').get();
  assert.equal(row.texto_original,original);assert.deepEqual(JSON.parse(row.respostas_json).map(r=>r.textoOriginal),['(sem fala)',original]);
  assert.equal(e.db.prepare('SELECT texto FROM eventos').get().texto,null,'não altera a mensagem capturada');
});
test('transcrição: sem fala e falha na segunda tentativa preservam resposta, sem indexar erro como fala',async t=>{
  const e=env(t),a=e.audio(),b=e.audio();
  const vazio=await transcreverArquivo('fake',{transcrever:async()=>({texto:' (sem fala) ',duracaoMs:1})});gravarTranscricao(e.db,{...a,...vazio});
  assert.equal(e.desktop.fonte(a.id).transcricao.textoOriginal,' (sem fala) ');assert.equal(e.desktop.fonte(a.id).transcricao.estado,'vazio');
  let n=0;await assert.rejects(async()=>{try{await transcreverArquivo('fake',{transcrever:async()=>{if(n++)throw Error('Falha sintética');return{texto:'(sem fala)',duracaoMs:2};}});}catch(error){gravarTranscricao(e.db,{...b,...error.transcricao,erro:error.message});throw error;}},/Falha sintética/);
  const registro=e.desktop.fonte(b.id).transcricao;assert.equal(registro.estado,'erro');assert.equal(registro.textoOriginal,'(sem fala)');assert.equal(registro.textoTratado,null);
  assert.equal(e.desktop.buscar().mensagens.length,2);
});
test('transcrição: limpeza conserva fala parecida, avisos são suspeitas e não um detector de verdade',()=>{
  assert.equal(limparTranscricao('Transcrição será entregue amanhã'),'Transcrição será entregue amanhã');
  assert.equal(limparTranscricao('"Uma fala sem fechar as aspas'),'"Uma fala sem fechar as aspas');
  assert.ok(sinaisTextoModelo('Como um modelo de linguagem, não posso ouvir.').length);
  assert.ok(sinaisTextoModelo('<think>vou completar a fala</think>').length);
  assert.ok(sinaisTextoModelo('Resumo: pagar a proposta').length,'pode ser fala legítima: falso positivo explicitado na UI');
  assert.deepEqual(sinaisTextoModelo('A pessoa aprovou o orçamento inventado.'),[],'alucinação sem marcador não é detectável por esta heurística');
});
test('transcrição: busca legível, original só por fonte, caminhos não expostos, revogação imediata',t=>{
  const e=env(t),a=e.audio(),secreto=e.audio({permissao:'terceiro'}),legado=e.audio({texto:'<anexado: antigo.opus>'});
  gravarTranscricao(e.db,{...a,arquivo:'caminho-privado.opus',textoOriginal:'Transcrição: Integração combinada.\nObservações: talvez cobrar mais.'});
  gravarTranscricao(e.db,{...secreto,textoOriginal:'Transcrição: SEGREDO'});gravarTranscricao(e.db,{...legado,texto:'Conteúdo legado'});
  const resultado=e.desktop.buscar({q:'Integração'}).mensagens;assert.equal(resultado.length,1);assert.equal(resultado[0].id,a.id);assert.equal(resultado[0].transcricao.originalDisponivel,true);assert.equal(resultado[0].transcricao.textoOriginal,undefined);
  assert.ok(!JSON.stringify(resultado).includes('caminho-privado'));assert.ok(!JSON.stringify(e.desktop.fonte(a.id)).includes('caminho-privado'));
  assert.equal(e.desktop.buscar({q:'Conteúdo legado'}).mensagens[0].transcricao.originalDisponivel,false);
  assert.equal(e.desktop.fonte(secreto.id).id,secreto.id);e.desktop.politica({conversa:'audio-teste',politica:'tudo'});assert.equal(e.desktop.buscar({q:'SEGREDO'}).mensagens.length,1);
  e.desktop.politica({conversa:'audio-teste',politica:'so-minhas'});assert.equal(e.desktop.buscar({q:'SEGREDO'}).mensagens.length,1);
  e.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(secreto.id);
  assert.equal(e.desktop.buscar({q:'SEGREDO'}).mensagens.length,0);assert.throws(()=>e.desktop.fonte(secreto.id),/indisponível/);
});
test('transcrição: captura textual existente não é substituída por texto de áudio vinculado',t=>{
  const e=env(t),a=e.audio({texto:'Mensagem capturada permanece'});gravarTranscricao(e.db,{...a,textoOriginal:'Transcrição: Derivada distinta'});
  assert.equal(e.desktop.fonte(a.id).texto,'Mensagem capturada permanece');assert.equal(e.desktop.buscar({q:'Derivada'}).mensagens.length,0);
});
test('transcrição: exportação pessoal e exclusão acompanham originais sem vazar terceiros',t=>{
  const e=env(t),a=e.audio(),b=e.audio({permissao:'terceiro'});for(const x of [a,b])gravarTranscricao(e.db,{...x,textoOriginal:'Transcrição: Original '+x.origemId});
  const exportado=e.priv.exportar({confirmar:true});assert.equal(exportado.conteudo.derivados.transcricoes.length,1);assert.equal(exportado.conteudo.derivados.transcricoes[0].texto_original,'Transcrição: Original '+a.origemId);
  const previa=e.priv.preparar({fonte:a.id});e.priv.excluir({id:previa.id,confirmar:'APAGAR'});assert.equal(e.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n,1);
  assert.deepEqual(e.desktop.buscar().mensagens.map(m=>m.id),[b.id]);
  assert.equal(e.priv.exportar({confirmar:true}).conteudo.derivados.transcricoes.length,0);
});
test('transcrição: NULL revoga exportação mesmo quando a política da conversa é tudo',t=>{
  const e=env(t),visivel=e.audio(),revogada=e.audio({permissao:null});
  for(const x of [visivel,revogada])gravarTranscricao(e.db,{...x,textoOriginal:'Transcrição: '+x.origemId});
  e.desktop.politica({conversa:'audio-teste',politica:'tudo'});
  const exportado=e.priv.exportar({confirmar:true}).conteudo;
  assert.deepEqual(exportado.eventos.map(x=>x.id),[visivel.id]);
  assert.deepEqual(exportado.derivados.transcricoes.map(x=>x.origem_id),[visivel.origemId]);
  assert.throws(()=>e.desktop.fonte(revogada.id),/indisponível/);
});
test('transcrição: backup v7 restaura original e tentativas, rejeita relação adulterada',async t=>{
  const e=env(t),dest=env(t),a=e.audio();dest.db.exec('DELETE FROM conversas_app');
  gravarTranscricao(e.db,{...a,textoOriginal:'Transcrição: Resposta final',respostas:[{textoOriginal:'(sem fala)',duracaoMs:2},{textoOriginal:'Transcrição: Resposta final',duracaoMs:3}]});
  const senha='senha sintética de teste',out=await e.backup.criar({senha,confirmar:true}),conteudo=await abrirBackup(JSON.stringify(out.pacote),senha);assert.equal(conteudo.versao,'assessor-acervo-v7');
  const adulterado=structuredClone(conteudo);adulterado.tabelas.transcricoes[0].texto_original='outro';assert.throws(()=>dest.backup.validar(adulterado),/incompatíveis/);
  const p=await dest.backup.preparar({arquivo:JSON.stringify(out.pacote),senha});dest.backup.restaurar({id:p.id,confirmarMeuBackup:true});
  const restaurada=dest.desktop.fonte(a.id).transcricao;assert.equal(restaurada.textoOriginal,'Transcrição: Resposta final');assert.equal(restaurada.respostas.length,2);
});
test('transcrição: backup legado v1/v2 fechado migra sem inventar original; v5 parcial é recusado',t=>{
  const e=env(t),a=e.audio();gravarTranscricao(e.db,{...a,texto:'Legado'});const base=e.backup.capturar();
  for(const versao of ['assessor-acervo-v1','assessor-acervo-v2']){
    const antigo=structuredClone(base);antigo.versao=versao;for(const tabela of ['desktop_negocios','desktop_negocios_historico','lume_comandos','lume_tags','lume_tags_entidades','lume_comando_tarefas','lume_comando_lembretes','whatsapp_labels','whatsapp_label_associacoes','whatsapp_label_observacoes','lume_acoes','lume_acoes_historico'])delete antigo.tabelas[tabela];for(const r of antigo.tabelas.transcricoes){delete r.texto_original;delete r.respostas_json;}
    if(versao.endsWith('v1'))for(const k of Object.keys(antigo.tabelas))if(k.startsWith('desktop_tarefas_'))delete antigo.tabelas[k];
    e.backup.validar(antigo);assert.equal(antigo.versao,'assessor-acervo-v7');assert.equal(antigo.tabelas.transcricoes[0].texto_original,null);
  }
  const parcial=structuredClone(base);parcial.versao='assessor-acervo-v5';for(const tabela of ['whatsapp_labels','whatsapp_label_associacoes','whatsapp_label_observacoes','lume_acoes','lume_acoes_historico'])delete parcial.tabelas[tabela];delete parcial.tabelas.transcricoes[0].respostas_json;assert.throws(()=>e.backup.validar(parcial),/incompatíveis/);
  const legadoInvalido=structuredClone(base);legadoInvalido.versao='assessor-acervo-v2';for(const tabela of ['desktop_negocios','desktop_negocios_historico','lume_comandos','lume_tags','lume_tags_entidades','lume_comando_tarefas','lume_comando_lembretes','whatsapp_labels','whatsapp_label_associacoes','whatsapp_label_observacoes','lume_acoes','lume_acoes_historico'])delete legadoInvalido.tabelas[tabela];assert.throws(()=>e.backup.validar(legadoInvalido),/legados/);
});
test('fontes: avisos da prévia seguem para pergunta e tarefas, sem mudar o texto literal',async t=>{
  const e=env(t);const texto='Revisar a proposta.\nObservações: recomendação do modelo.';
  e.db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('audio-teste','nota','entrada','texto','{}',?,'2026-09-18T12:00:00Z','2026-09-18','minha')").run(texto);
  await e.ia.configurar({habilitada:true,limiteUSD:1,cienteEnvio:true});e.ia.permitir({conversa:'audio-teste',permitida:true});
  const p=e.ia.preparar({pergunta:'proposta',periodo:'tudo'});assert.ok(p.fontes[0].avisos.length);assert.equal(p.fontes[0].texto,texto);
  assert.deepEqual(JSON.parse(e.ia.previas.get(p.id).pedido.contents[0].parts[0].text).fontes,p.fontes);
  const tarefas=new DesktopTarefas(e.db,{ia:e.ia,agora:()=>new Date('2026-09-18T15:00:00Z'),perfil:()=>({aceito:true})});const q=tarefas.preparar({conversa:'audio-teste',periodo:'tudo'});
  assert.ok(q.fontes[0].avisos.length);assert.deepEqual(JSON.parse(e.ia.previas.get(q.id).pedido.contents[0].parts[0].text).fontes,q.fontes);
});
