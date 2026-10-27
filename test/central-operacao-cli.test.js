import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { exigirOrigem, validarAmbienteCentral } from '../api/_central/config.js';
import { criarConviteRemoto, executarRetencao, preflightCentral, revogarConviteRemoto, verificarCentralRemota } from '../scripts/central-operacao-lib.mjs';

const SEGREDO='segredo-administrativo-com-mais-de-trinta-e-dois';
const PEPPER='pepper-independente-com-mais-de-trinta-e-dois';
const CRON='segredo-cron-independente-com-mais-de-trinta-e-dois';
const executar=promisify(execFile);
const ambiente=(extra={})=>({
  NODE_ENV:'production',DATABASE_URL:'postgresql://usuario:senha@db.example.test/lume?sslmode=require',
  LUME_ADMIN_SECRET:SEGREDO,LUME_TOKEN_PEPPER:PEPPER,LUME_BETA_VERSION:'3.1.0-beta.1',
  CRON_SECRET:CRON,
  LUME_PUBLIC_ORIGIN:'https://lume.example.test',LUME_CENTRAL_URL:'https://lume.example.test',
  LUME_RETENTION_DAYS:'90',LUME_RETENTION_APPROVED:'APROVADA',
  LUME_RATE_LIMIT_APPROVED:'CONFIGURADO',LUME_RELEASE_ENV_APPROVED:'APROVADO',...extra
});

test('preflight exige ambiente completo e aprova os arquivos locais da Central',async()=>{
  const resultado=await preflightCentral({env:ambiente()});
  assert.equal(resultado.ok,true);
  assert.equal(resultado.retencaoDias,90);
  assert.deepEqual(resultado.migrations,['001-operacao.sql','002-feedback.sql','003-feedback-severidade.sql','004-feedback-contato.sql','005-pulso-confirmado.sql']);
  await assert.rejects(preflightCentral({env:ambiente({LUME_RETENTION_DAYS:'30'})}),/RETENCAO_DIVERGENTE/);
  await assert.rejects(preflightCentral({env:ambiente({CRON_SECRET:''})}),/CRON_SECRET_INVALIDO/);
  for(const [chave,valor] of [
    ['LUME_RETENTION_APPROVED',''],['LUME_RATE_LIMIT_APPROVED',''],['LUME_RELEASE_ENV_APPROVED','']
  ])assert.throws(()=>validarAmbienteCentral(ambiente({[chave]:valor}),{publicacao:true}),/NAO_|AMBIENTE/);
  assert.throws(()=>validarAmbienteCentral(ambiente({LUME_TOKEN_PEPPER:SEGREDO})),/CENTRAL_NAO_CONFIGURADA/);
  assert.throws(()=>validarAmbienteCentral(ambiente({DATABASE_URL:'postgresql://db.example.test/lume'})),/CENTRAL_NAO_CONFIGURADA/);
  await assert.rejects(preflightCentral({env:ambiente({LUME_CENTRAL_URL:'https://outra.example.test'})}),/CENTRAL_URL_DIVERGENTE/);
});

test('preflight exige painel e todas as rotas apontando para as acoes corretas',async t=>{
  const raiz=mkdtempSync(join(tmpdir(),'lume-central-preflight-'));t.after(()=>rmSync(raiz,{recursive:true,force:true}));
  for(const arquivo of ['vercel.json','api/central.js','scripts/build-vercel-site.mjs','scripts/central-migrar.mjs','scripts/central-migrations-lib.mjs','central/migrations/001-operacao.sql','central/migrations/002-feedback.sql','central/migrations/003-feedback-severidade.sql','central/migrations/004-feedback-contato.sql','central/migrations/005-pulso-confirmado.sql','central/site/index.html','central/site/central.js','central/site/central.css']){
    const destino=join(raiz,arquivo);mkdirSync(dirname(destino),{recursive:true});cpSync(resolve(arquivo),destino);
  }
  const vercel=JSON.parse(readFileSync(join(raiz,'vercel.json'),'utf8'));
  vercel.rewrites=vercel.rewrites.filter(item=>item.source!=='/api/v1/instalacoes/pulso');
  writeFileSync(join(raiz,'vercel.json'),JSON.stringify(vercel));
  await assert.rejects(preflightCentral({env:ambiente(),raiz}),/ROTAS_CENTRAL_INCOMPLETAS/);
  const original=JSON.parse(readFileSync(resolve('vercel.json'),'utf8'));
  original.rewrites.find(item=>item.source==='/api/v1/admin/instalacoes').destination='/api/central?action=convite';
  writeFileSync(join(raiz,'vercel.json'),JSON.stringify(original));
  await assert.rejects(preflightCentral({env:ambiente(),raiz}),/ROTAS_CENTRAL_INCORRETAS/);
});

test('CLI chama o resultado de pre-voo local sem declarar producao aprovada',async()=>{
  const {stdout}=await executar(process.execPath,['scripts/central-operacao.mjs','preflight'],{cwd:resolve('.'),env:{...process.env,...ambiente()},windowsHide:true});
  const resultado=JSON.parse(stdout);
  assert.equal(resultado.mensagem,'Pré-voo local aprovado. Conclua as verificações externas antes do deploy de produção.');
  assert.equal(/aprovado para publicação/i.test(resultado.mensagem),false);
});

test('origem administrativa precisa coincidir exatamente com a origem publicada',()=>{
  assert.doesNotThrow(()=>exigirOrigem({headers:{origin:'https://lume.example.test'}},'https://lume.example.test'));
  assert.throws(()=>exigirOrigem({headers:{origin:'https://site-malicioso.test'}},'https://lume.example.test'),/ORIGEM_NAO_PERMITIDA/);
  assert.throws(()=>exigirOrigem({headers:{}},'https://lume.example.test'),/ORIGEM_NAO_PERMITIDA/);
});

test('ferramenta de convite usa segredo somente no login e reaproveita cookie curto',async()=>{
  const chamadas=[];
  const fetchImpl=async(url,opcoes)=>{
    chamadas.push({url,opcoes});
    if(chamadas.length===1)return new Response(JSON.stringify({autenticada:true}),{status:200,headers:{'content-type':'application/json','set-cookie':'lume_admin=abc.def; Path=/; HttpOnly; Secure; SameSite=Strict'}});
    return new Response(JSON.stringify({id:'3e5a9254-ea72-41cf-b4bd-530601f905cf',codigo:'LUME-0123456789ABCDEF01234567'}),{status:201,headers:{'content-type':'application/json'}});
  };
  const convite=await criarConviteRemoto('Diogo Kaleo',{env:ambiente(),fetchImpl});
  assert.equal(convite.codigo,'LUME-0123456789ABCDEF01234567');
  assert.equal(JSON.parse(chamadas[0].opcoes.body).senha,SEGREDO);
  assert.equal(chamadas[1].opcoes.headers.cookie,'lume_admin=abc.def');
  assert.equal(chamadas[1].opcoes.body.includes(SEGREDO),false);
  assert.equal(chamadas.every(item=>item.opcoes.redirect==='error'),true);
});

test('falha HTTP retorna código fechado sem ecoar corpo nem segredo',async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify({erro:SEGREDO}),{status:401});
  await assert.rejects(criarConviteRemoto('Tester',{env:ambiente(),fetchImpl}),error=>error.codigo==='CENTRAL_HTTP_401'&&!error.message.includes(SEGREDO));
});

test('smoke remoto valida saúde e schema sem autenticação',async()=>{
  let chamada;
  const fetchImpl=async(url,opcoes)=>{chamada={url,opcoes};return new Response(JSON.stringify({ok:true,banco:'pronto',schema:'005-pulso-confirmado'}),{status:200});};
  const resultado=await verificarCentralRemota({env:{NODE_ENV:'production',LUME_CENTRAL_URL:'https://lume.example.test'},fetchImpl});
  assert.equal(resultado.ok,true);
  assert.equal(chamada.url,'https://lume.example.test/api/v1/central/saude');
  assert.equal('authorization' in chamada.opcoes.headers,false);
  await assert.rejects(verificarCentralRemota({env:{NODE_ENV:'production',LUME_CENTRAL_URL:'https://lume.example.test'},fetchImpl:async()=>new Response(JSON.stringify({ok:true,banco:'pronto',schema:'001-operacao'}),{status:200})}),/CENTRAL_NAO_PRONTA/);
});

test('revogação de convite exige UUID e autenticação administrativa',async()=>{
  const id='3e5a9254-ea72-41cf-b4bd-530601f905cf';const chamadas=[];
  const fetchImpl=async(url,opcoes)=>{
    chamadas.push({url,opcoes});
    if(chamadas.length===1)return new Response(JSON.stringify({autenticada:true}),{status:200,headers:{'set-cookie':'lume_admin=abc.def; Path=/; HttpOnly; Secure'}});
    return new Response(JSON.stringify({revogado:true}),{status:200});
  };
  assert.deepEqual(await revogarConviteRemoto(id,{env:ambiente(),fetchImpl}),{id,revogado:true});
  assert.equal(chamadas[1].url,`https://lume.example.test/api/v1/admin/convites/${id}/revogar`);
  await assert.rejects(revogarConviteRemoto('id-invalido',{env:ambiente(),fetchImpl}),/CONVITE_ID_INVALIDO/);
});

test('retenção é simulação por padrão e exige confirmação separada para apagar',async()=>{
  const chamadas=[];
  const repositorio={
    async resumirRetencao(limite){chamadas.push(['resumo',limite]);return {convites:2,instalacoes:1};},
    async aplicarRetencao(limite){chamadas.push(['aplicar',limite]);return {convites:2,instalacoes:1};}
  };
  const agora=new Date('2026-09-19T12:00:00.000Z');
  const previa=await executarRetencao({repositorio,dias:90,agora});
  assert.equal(previa.aplicado,false);assert.equal(chamadas.length,1);
  await assert.rejects(executarRetencao({repositorio,dias:90,agora,aplicar:true}),/CONFIRMACAO_RETENCAO_AUSENTE/);
  const aplicada=await executarRetencao({repositorio,dias:90,agora,aplicar:true,confirmacao:'APLICAR_RETENCAO'});
  assert.equal(aplicada.aplicado,true);assert.equal(chamadas.at(-1)[0],'aplicar');
});
