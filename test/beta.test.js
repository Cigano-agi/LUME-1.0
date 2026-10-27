import {test} from 'node:test';
import assert from 'node:assert/strict';
import {novoRelato,validarRelato,resumoRelato} from '../src/painel/beta-model.js';
import download from '../desktop/downloads.cjs';
import pacote from '../package.json' with {type:'json'};
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
const week='2026-09-14',hoje='2026-09-18';
function relato(){return {...novoRelato(),inicioSemana:week};}
test('beta: rascunho não conta como primeira ação concluída; critérios exigem tempo, fonte e autonomia',()=>{
  const r=relato();assert.equal(resumoRelato(validarRelato(r,{hoje})).primeiraAcaoNoPrazo,null);
  r.primeiraAcao={historicoDisponivel:true,resultado:'encontrada',iniciadaEm:'2026-09-18T12:00:00.000Z',encerradaEm:'2026-09-18T12:05:00.000Z',segundos:300,fonteConferida:true,ajuda:'sozinho'};
  assert.equal(resumoRelato(validarRelato(r,{hoje})).primeiraAcaoNoPrazo,true);
  for(const change of [{fonteConferida:false},{ajuda:'com-ajuda'},{resultado:'nao-encontrada'},{segundos:301,encerradaEm:'2026-09-18T12:05:01.000Z'}])assert.equal(resumoRelato(validarRelato({...r,primeiraAcao:{...r.primeiraAcao,...change}},{hoje})).primeiraAcaoNoPrazo,false);
});
test('beta: rejeita tempo incoerente, campos extras e protótipo recebido como JSON',()=>{
  const r=relato();assert.throws(()=>validarRelato({...r,automaticamenteAprovado:true},{hoje}),/Estrutura/);
  const bad=JSON.parse(JSON.stringify(r).replace('"schema":','"__proto__":{"polluted":true},"schema":'));assert.throws(()=>validarRelato(bad,{hoje}),/Estrutura/);assert.equal({}.polluted,undefined);
  r.primeiraAcao={...r.primeiraAcao,resultado:'encontrada',historicoDisponivel:true,iniciadaEm:'2026-09-18T12:00:00.000Z',encerradaEm:'2026-09-18T12:06:00.000Z',segundos:2};assert.throws(()=>validarRelato(r,{hoje}),/Tempo/);
});
test('beta: três dias distintos na semana; nunca duplica dia ou conta uso futuro',()=>{
  const r=relato();r.diasUso=['2026-09-14','2026-09-16','2026-09-18'];assert.equal(resumoRelato(validarRelato(r,{hoje})).tresDiasNaSemana,true);
  for(const diasUso of [['2026-09-14','2026-09-14'],['2026-09-19'],['2026-09-13'],['2026-02-30'],['2026-09-22']])assert.throws(()=>validarRelato({...r,diasUso},{hoje}));
});
test('beta: importação preserva texto literal e limites sem inferir resultados',()=>{
  const r=relato();r.feedback.atrapalhou='<img src=x onerror=alert(1)> Falhou ao abrir';const copy=validarRelato(JSON.parse(JSON.stringify(r)),{hoje});assert.deepEqual(copy,r);assert.notEqual(copy,r);assert.equal(resumoRelato(copy).etapasTestadas,0);
  r.feedback.faltou='x'.repeat(1201);assert.throws(()=>validarRelato(r,{hoje}),/Texto/);
});
test('desktop: download de feedback exige janela, blob local e nome exato',()=>{
  const good={janelaCorreta:true,origem:'http://127.0.0.1:3000',url:'blob:http://127.0.0.1:3000/abc',nome:'assessor-feedback-12345678-1234-4234-8234-123456789012.json'};
  for(const type of ['feedback','backup','projeto','exportacao'])assert.equal(download.downloadPermitido({...good,nome:good.nome.replace('feedback',type)}),true);
  for(const bad of [{janelaCorreta:false},{url:'blob:http://evil.test/abc'},{url:'http://127.0.0.1:3000/file'},{url:'blob:http://127.0.0.1:30001/abc'},{nome:good.nome+'.exe'},{nome:'../'+good.nome},{nome:'assessor-feedback-------------------------------------.json'}])assert.equal(download.downloadPermitido({...good,...bad}),false);
});
test('desktop: backup v10 aceita apenas download autenticado da origem local',()=>{
  const good={janelaCorreta:true,origem:'http://127.0.0.1:3000',
    url:'http://127.0.0.1:3000/api/v3/dados/backup-v10/arquivo?ticket='+'a'.repeat(64),
    nome:'lume-backup-2026-09-28.lumebak'};
  assert.equal(download.downloadPermitido(good),true);
  for(const bad of [{janelaCorreta:false},{url:good.url.replace('127.0.0.1','evil.test')},
    {url:good.url.replace('arquivo','../../outro')},{url:good.url.replace(/a{64}$/,'abc')},
    {nome:'../'+good.nome},{nome:good.nome+'.exe'}])
    assert.equal(download.downloadPermitido({...good,...bad}),false);
});

test('beta HTTP: APIs desktop e servidor usam package.version; guia sem consentimento nao expoe acervo',async t=>{
  for(const desktop of [true,false]){
    const db=abrirBanco(),conexao={estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{}};
    const server=criarServidor(db,{desktop,conexao});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
    const base=`http://127.0.0.1:${server.address().port}`,version=await (await fetch(base+'/api/v3/versao')).json();
    assert.deepEqual(version,{versao:pacote.version,desktop});assert.equal((await (await fetch(base+'/api/estado')).json()).versao,pacote.version);
    if(desktop)for(const path of ['/beta','/beta.js','/beta.css','/beta-model.js','/beta-loader.js','/apresentacao']){const res=await fetch(base+path);assert.equal(res.status,200);assert.ok(!res.headers.get('content-security-policy').includes('unsafe-inline'));}
    assert.equal((await fetch(base+'/api/v3/busca')).status,403);assert.equal((await fetch(base+'/api/v3/versao',{headers:{origin:'https://evil.test'}})).status,403);
  }
});
