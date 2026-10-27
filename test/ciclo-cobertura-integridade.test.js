import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {coberturaMidiaCiclo} from '../src/ciclo-captura.js';

const sha256=value=>createHash('sha256').update(value).digest('hex');

function fixture(fn){
  const dir=mkdtempSync(join(tmpdir(),'lume-cobertura-')),db=abrirBanco(join(dir,'dados.sqlite'));
  const app=new ContextoApp(db);
  app.receber({messages:[{key:{remoteJid:'grupo@g.us',id:'video'},message:{videoMessage:{mimetype:'video/mp4'}},messageTimestamp:1788794100}]});
  db.exec(`CREATE TABLE IF NOT EXISTS ciclo_midias (
    evento_id INTEGER PRIMARY KEY REFERENCES eventos(id) ON DELETE CASCADE,
    caminho TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,mime TEXT NOT NULL,
    tamanho INTEGER NOT NULL,criado_em TEXT NOT NULL)`);
  const evento=db.prepare("SELECT id FROM eventos WHERE origem_id='video'").get().id;
  return Promise.resolve().then(()=>fn({db,dir,evento})).finally(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
}

test('corrupção de mídia com o mesmo tamanho não é baixada',()=>fixture(({db,dir,evento})=>{
  const original=Buffer.from('video original');
  const caminho=join(dir,'video.mp4');
  writeFileSync(caminho,original);
  db.prepare(`INSERT INTO ciclo_midias(evento_id,caminho,sha256,mime,tamanho,criado_em) VALUES(?,?,?,?,?,?)`)
    .run(evento,caminho,sha256(original),'video/mp4',original.length,new Date().toISOString());
  db.prepare("UPDATE etapas SET estado='concluida' WHERE evento_id=? AND etapa='midia'").run(evento);
  writeFileSync(caminho,Buffer.from('troca indevida'));
  const cobertura=coberturaMidiaCiclo(db);
  assert.equal(cobertura.baixadas,0);
  assert.equal(cobertura.desconhecidas,1);
}));

test('arquivo acima do orçamento de hash permanece desconhecido',()=>fixture(({db,dir,evento})=>{
  const bytes=Buffer.alloc(16,7),caminho=join(dir,'video.mp4');
  writeFileSync(caminho,bytes);
  db.prepare(`INSERT INTO ciclo_midias(evento_id,caminho,sha256,mime,tamanho,criado_em) VALUES(?,?,?,?,?,?)`)
    .run(evento,caminho,sha256(bytes),'video/mp4',bytes.length,new Date().toISOString());
  db.prepare("UPDATE etapas SET estado='concluida' WHERE evento_id=? AND etapa='midia'").run(evento);
  assert.equal(coberturaMidiaCiclo(db,{limiteHashBytes:8}).baixadas,0);
  assert.equal(coberturaMidiaCiclo(db,{limiteHashBytes:8}).desconhecidas,1);
}));

test('cobertura por grupo inclui mídia de participante no escopo pessoal',()=>fixture(({db,evento})=>{
  db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(evento);
  const global=coberturaMidiaCiclo(db),grupo=coberturaMidiaCiclo(db,{conversaId:'grupo@g.us'});
  assert.equal(global.recebidas,1);
  assert.equal(grupo.recebidas,1);
  assert.equal(grupo.pendentes,1);
}));
