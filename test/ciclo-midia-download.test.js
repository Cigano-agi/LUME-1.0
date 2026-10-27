import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {MidiaArquivos,processarUmaMidiaCiclo} from '../src/ciclo-midia-worker.js';
import {coberturaMidiaCiclo} from '../src/ciclo-captura.js';
import {baixarAudioWhatsapp,MAX_AUDIO_DOWNLOAD} from '../src/audio-whatsapp.js';
import {Privacidade} from '../src/privacidade.js';
import {Backup} from '../src/backup.js';

const agora=new Date('2026-09-28T12:00:00Z');
function fixture(fn){
  const dir=mkdtempSync(join(tmpdir(),'lume-media-')),db=abrirBanco(join(dir,'dados.sqlite'));
  new Desktop(db);new DesktopIA(db);
  new ContextoApp(db).receber({messages:[{key:{remoteJid:'grupo@g.us',id:'audio',participant:'autor@s.whatsapp.net'},
    message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100}]});
  const arquivos=new MidiaArquivos(db,new ArquivosDados(dir));
  return Promise.resolve().then(()=>fn({db,arquivos,dir})).finally(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
}

test('download guarda original no perfil e replay/restart não cria segundo arquivo',()=>fixture(async({db,arquivos,dir})=>{
  let calls=0;
  const baixar=async()=>{calls++;return {base64:Buffer.from('audio sintetico').toString('base64'),nome:'Áudio.ogg',mime:'audio/ogg'};};
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,baixar,agora})).estado,'concluida');
  const row=db.prepare('SELECT * FROM ciclo_midias').get();
  assert.equal(readFileSync(row.caminho,'utf8'),'audio sintetico');
  assert.equal(row.mime,'audio/ogg');
  assert.equal(coberturaMidiaCiclo(db).baixadas,1);
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,baixar,agora})),null);
  const retomado=new MidiaArquivos(db,new ArquivosDados(dir));
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos:retomado,baixar,agora})),null);
  assert.equal(calls,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ciclo_midias').get().n,1);
  unlinkSync(row.caminho);
  assert.equal(coberturaMidiaCiclo(db).baixadas,0);
  assert.equal(coberturaMidiaCiclo(db).desconhecidas,1);
}));

test('falha transitória respeita prazo e mídia ausente termina em lacuna',()=>fixture(async({db,arquivos})=>{
  const baixar=async()=>{throw Object.assign(Error('expired'),{codigo:'midia_expirada'});};
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,baixar,agora})).estado,'desistida');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ciclo_midias').get().n,0);
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,baixar,agora})),null);
}));

test('metadados inválidos encerram a etapa e o worker relata o mesmo estado',()=>fixture(async({db,arquivos})=>{
  const baixar=async()=>{throw Object.assign(Error('invalid'),{codigo:'metadados_invalidos'});};
  const result=await processarUmaMidiaCiclo(db,{arquivos,baixar,agora});
  assert.equal(db.prepare("SELECT estado FROM etapas WHERE etapa='midia'").get().estado,'desistida');
  assert.equal(result.estado,'desistida');
}));

test('original gerido pode entrar na prévia de exclusão da fonte',()=>fixture(async({db,arquivos})=>{
  const baixar=async()=>({base64:Buffer.from('audio sintetico').toString('base64'),mime:'audio/ogg'});
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,baixar,agora})).estado,'concluida');
  const id=db.prepare("SELECT id FROM eventos WHERE origem_id='audio'").get().id;
  assert.doesNotThrow(()=>new Privacidade(db,{arquivos:arquivos.arquivos}).preparar({fonte:id}));
}));

test('excluir fonte elimina recibo e arquivo original gerido',()=>fixture(async({db,arquivos})=>{
  const baixar=async()=>({base64:Buffer.from('audio sintetico').toString('base64'),mime:'audio/ogg'});
  await processarUmaMidiaCiclo(db,{arquivos,baixar,agora});
  const {caminho}=db.prepare('SELECT caminho FROM ciclo_midias').get();
  const id=db.prepare("SELECT id FROM eventos WHERE origem_id='audio'").get().id;
  const privacidade=new Privacidade(db,{arquivos:arquivos.arquivos});
  const previa=privacidade.preparar({fonte:id});
  assert.equal(previa.contagens.ciclo_midias,1);
  assert.deepEqual(previa.arquivos,[caminho]);
  const resultado=privacidade.excluir({id:previa.id,confirmar:'APAGAR'});
  assert.equal(resultado.estado,'concluida');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ciclo_midias').get().n,0);
  assert.equal(existsSync(caminho),false);
}));

test('backup antigo recusa original gerido que não consegue preservar',()=>fixture(async({db,arquivos})=>{
  await processarUmaMidiaCiclo(db,{arquivos,agora,
    baixar:async()=>({base64:Buffer.from('audio sintetico').toString('base64'),mime:'audio/ogg'})});
  assert.throws(()=>new Backup(db,{arquivos:arquivos.arquivos}).capturar(),/backup v10/i);
}));

test('falha local de gravação pausa mídia como arquivo, sem fingir erro de rede',()=>fixture(async({db,arquivos})=>{
  writeFileSync(arquivos.arquivos.anexos,'bloqueio sintético');
  const result=await processarUmaMidiaCiclo(db,{arquivos,agora,
    baixar:async()=>({base64:Buffer.from('audio sintetico').toString('base64'),mime:'audio/ogg'})});
  assert.equal(result.motivo,'arquivo');
  assert.equal(result.estado,'desistida');
  assert.match(db.prepare("SELECT ultimo_erro FROM etapas WHERE etapa='midia'").get().ultimo_erro,/arquivo/);
}));

test('revogação durante download impede recibo e remove arquivo temporário',()=>fixture(async({db,arquivos})=>{
  const baixar=async()=>{
    db.prepare("UPDATE eventos SET texto='mudou' WHERE origem_id='audio'").run();
    return {base64:Buffer.from('audio sintetico').toString('base64'),nome:'Áudio.ogg',mime:'audio/ogg'};
  };
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,baixar,agora})).estado,'fonte_alterada');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ciclo_midias').get().n,0);
  assert.equal(arquivos.listar().length,0);
}));

test('HTTP 404 do transporte é lacuna permanente, sem nova tentativa',async()=>{
  const raw=JSON.stringify({mensagem:{message:{audioMessage:{mimetype:'audio/ogg',
    mediaKey:Buffer.alloc(32,1),fileSha256:Buffer.alloc(32,2),fileEncSha256:Buffer.alloc(32,3),
    url:'https://mmg.whatsapp.net/expirado'}}}});
  await assert.rejects(()=>baixarAudioWhatsapp(raw,{fetchFn:async()=>new Response(null,{status:404})}),
    error=>error.codigo==='midia_expirada');
});

test('payload acima do limite e metadados ausentes não são tratados como rede',async()=>{
  const media={mimetype:'audio/ogg',mediaKey:Buffer.alloc(32,1),fileSha256:Buffer.alloc(32,2),
    fileEncSha256:Buffer.alloc(32,3),url:'https://mmg.whatsapp.net/audio'};
  const raw=value=>JSON.stringify({mensagem:{message:{audioMessage:value}}});
  const fetchFn=async()=>new Response(new Uint8Array([1]),{headers:{'content-length':String(MAX_AUDIO_DOWNLOAD+1025)}});
  await assert.rejects(()=>baixarAudioWhatsapp(raw(media),{fetchFn}),e=>e.codigo==='limite_audio');
  await assert.rejects(()=>baixarAudioWhatsapp(raw({...media,mediaKey:undefined}),{fetchFn}),
    e=>e.codigo==='metadados_invalidos');
});

test('recuperação elimina só órfão antigo, preservando original referenciado',()=>fixture(async({db,arquivos})=>{
  await processarUmaMidiaCiclo(db,{arquivos,agora,baixar:async()=>({base64:Buffer.from('x').toString('base64'),mime:'audio/ogg'})});
  const mantido=db.prepare('SELECT caminho FROM ciclo_midias').get().caminho;
  mkdirSync(arquivos.arquivos.anexos,{recursive:true});
  const orfao=join(arquivos.arquivos.anexos,'ciclo-midia-999-00000000-0000-4000-8000-000000000000.ogg');
  writeFileSync(orfao,'órfão');
  assert.deepEqual(arquivos.recuperar({agora:new Date(Date.now()+7200000)}),{removidos:1});
  assert.equal(readFileSync(mantido,'utf8'),'x');
  assert.equal(arquivos.listar().length,1);
}));
