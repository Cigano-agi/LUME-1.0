import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {MidiaArquivos} from '../src/ciclo-midia-worker.js';
import {CicloMidiaLoop} from '../src/ciclo-midia-loop.js';

async function ate(fn){for(let i=0;i<100;i++){if(fn())return;await delay(20);}throw Error('Prazo do teste esgotado');}

test('loop respeita pausa, no máximo dois downloads e drena antes de fechar banco',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-midia-loop-')),db=abrirBanco(join(dir,'dados.sqlite'));
  let loop;
  try{
    const contexto=new ContextoApp(db);
    for(let n=0;n<3;n++)contexto.receber({messages:[{key:{remoteJid:'c@s.whatsapp.net',id:'audio-'+n},
      message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100+n}]});
    const arquivos=new MidiaArquivos(db,new ArquivosDados(dir));
    let permitido=false,ativos=0,pico=0,liberar;
    const bloqueio=new Promise(resolve=>{liberar=resolve;});
    const baixar=async()=>{ativos++;pico=Math.max(pico,ativos);await bloqueio;ativos--;
      return {base64:Buffer.from('original sintetico').toString('base64'),mime:'audio/ogg'};};
    loop=new CicloMidiaLoop(db,{arquivos,baixar,podeProcessar:()=>permitido,intervaloMs:10});
    loop.iniciar();await delay(70);
    assert.equal(ativos,0);
    permitido=true;
    await ate(()=>ativos===2);
    assert.equal(pico,2);
    liberar();
    await ate(()=>db.prepare('SELECT COUNT(*) n FROM ciclo_midias').get().n===3);
    await loop.parar();
    assert.equal(ativos,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM etapas WHERE etapa=\'midia\' AND estado=\'concluida\'').get().n,3);
  }finally{await loop?.parar();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('pausa durante download descarta resultado sem gastar tentativa',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-midia-pause-')),db=abrirBanco(join(dir,'dados.sqlite'));
  let loop;
  try{
    new ContextoApp(db).receber({messages:[{key:{remoteJid:'c@s.whatsapp.net',id:'audio-pausa'},
      message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100}]});
    const arquivos=new MidiaArquivos(db,new ArquivosDados(dir));
    let permitido=true,liberar,entrou=false;
    const bloqueio=new Promise(resolve=>{liberar=resolve;});
    loop=new CicloMidiaLoop(db,{arquivos,podeProcessar:()=>permitido,intervaloMs:10,
      baixar:async()=>{entrou=true;await bloqueio;return {base64:Buffer.from('original sintetico').toString('base64'),mime:'audio/ogg'};}});
    loop.iniciar();await ate(()=>entrou);
    permitido=false;liberar();await loop.parar();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ciclo_midias').get().n,0);
    const row=db.prepare("SELECT estado,tentativas FROM etapas WHERE etapa='midia'").get();
    assert.equal(row.estado,'pendente');assert.equal(row.tentativas,0);
  }finally{await loop?.parar();db.close();rmSync(dir,{recursive:true,force:true});}
});
