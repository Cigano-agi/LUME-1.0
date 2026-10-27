import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { criarCofreCentral, criarTransporteCentral, executarComandoCentral, ORIGEM_CENTRAL } = require('../desktop/central-runtime.cjs');
const {criarClienteCentral}=require('../desktop/central-pulso.cjs');

const estado = {
  schema: 'lume-central-client-v1', consentido: true,
  instalacaoId: 'b84c33d7-35c6-4a89-bf3f-7f9dc7c8b133', convite: 'LUME-ABCDEFGHIJKL', token: null,
  revogada: false, ultimoSucessoEm: null, proximaTentativaEm: null, falhasConsecutivas: 0
};
const token = 'token_de_teste_seguro_12345678901234567890';
const corpoRegistro = { convite: 'LUME-ABCDEFGHIJKL', instalacaoId: estado.instalacaoId, versao: '3.1.0-beta.1', canal: 'beta', plataforma: 'win32', arquitetura: 'x64' };
const corpoPulso = { versao: '3.1.0-beta.1', canal: 'beta', plataforma: 'win32', arquitetura: 'x64', estadoAtualizacao: 'em_dia', whatsappEstado: 'conectado' };

function safeStorage(disponivel = true) {
  return {
    isEncryptionAvailable: () => disponivel,
    encryptString: texto => Buffer.from(`CIFRADO:${Buffer.from(texto).toString('base64')}`),
    decryptString: bytes => Buffer.from(bytes.toString().slice(8), 'base64').toString()
  };
}

test('cofre grava central.seguro atomicamente, cifrado e com permissao restrita', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lume-central-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cofre = criarCofreCentral(dir, safeStorage());
  assert.deepEqual(cofre.estado(), { disponivel: true, configurado: false });
  assert.deepEqual(cofre.gravar(estado), { ok: true });
  const arquivo = join(dir, 'central.seguro');
  assert.equal(existsSync(arquivo), true);
  assert.equal(existsSync(`${arquivo}.tmp`), false);
  assert.equal(readFileSync(arquivo, 'utf8').includes(estado.convite), false);
  if (process.platform !== 'win32') assert.equal(statSync(arquivo).mode & 0o777, 0o600);
  assert.deepEqual(cofre.ler(), estado);
  assert.deepEqual(cofre.remover(), { ok: true });
  assert.equal(existsSync(arquivo), false);
});

test('cofre falha fechado quando safeStorage nao protege ou o arquivo e adulterado', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lume-central-fechado-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const indisponivel = criarCofreCentral(dir, safeStorage(false));
  assert.throws(() => indisponivel.gravar(estado), /COFRE_CENTRAL_INDISPONIVEL/);
  assert.equal(existsSync(join(dir, 'central.seguro')), false);
  writeFileSync(join(dir, 'central.seguro'), 'CONTEUDO CORROMPIDO');
  assert.throws(() => criarCofreCentral(dir, safeStorage()).ler(), error => error.message === 'COFRE_CENTRAL_INDISPONIVEL' && !error.message.includes('CONTEUDO'));
  assert.throws(() => criarCofreCentral(dir, safeStorage()).gravar({ ...estado, conversa: 'segredo' }), /COFRE_CENTRAL_INDISPONIVEL/);
});

test('cofre recusa backend basic_text no Linux', () => {
  const safe = { ...safeStorage(), getSelectedStorageBackend: () => 'basic_text' };
  const cofre = criarCofreCentral('diretorio-fixo', safe, { plataforma: 'linux' });
  assert.deepEqual(cofre.estado(), { disponivel: false, configurado: false });
  assert.throws(() => cofre.gravar(estado), /COFRE_CENTRAL_INDISPONIVEL/);
});

test('cofre nao declara revogacao concluida quando o arquivo nao pode ser apagado', () => {
  const fsFalho = {
    existsSync: () => true,
    unlinkSync: () => { throw Object.assign(new Error('nome privado'), { code: 'EACCES' }); }
  };
  const cofre = criarCofreCentral('diretorio-fixo', safeStorage(), { fs: fsFalho });
  assert.throws(() => cofre.remover(), error => error.message === 'COFRE_CENTRAL_INDISPONIVEL' && !error.message.includes('privado'));
});

test('transporte usa somente HTTPS, host publico e endpoints exatos', async () => {
  const chamadas = [];
  const enviar = criarTransporteCentral({ fetchImpl: async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return new Response(JSON.stringify({ recebido: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await enviar({ caminho: '/api/v1/instalacoes/pulso', token, corpo: corpoPulso }), { recebido: true });
  assert.equal(chamadas[0].url, `${ORIGEM_CENTRAL}/api/v1/instalacoes/pulso`);
  assert.equal(chamadas[0].opcoes.redirect, 'error');
  assert.equal(chamadas[0].opcoes.credentials, 'omit');
  assert.equal(chamadas[0].opcoes.headers.authorization, `Bearer ${token}`);
  await assert.rejects(enviar({ caminho: 'https://evil.example/pulso', token, corpo: corpoPulso }), /CAMINHO_NAO_PERMITIDO/);
  await assert.rejects(enviar({ caminho: '/api/v1/instalacoes/pulso?url=https://evil.example', token, corpo: corpoPulso }), /CAMINHO_NAO_PERMITIDO/);
  await assert.rejects(enviar({ caminho: '/api/v1/instalacoes/registrar', token, corpo: corpoRegistro }), /AUTENTICACAO_INVALIDA/);
  await assert.rejects(enviar({ caminho: '/api/v1/instalacoes/pulso', token, corpo: { ...corpoPulso, mensagem: 'segredo' } }), /CORPO_INVALIDO/);
  assert.equal(chamadas.length, 1);
});

test('transporte nao le nem vaza corpo de erro HTTP', async () => {
  const segredo = 'TOKEN_INTERNO_DO_SERVIDOR';
  const enviar = criarTransporteCentral({ fetchImpl: async () => new Response(segredo, { status: 403 }) });
  await assert.rejects(enviar({ caminho: '/api/v1/instalacoes/pulso', token, corpo: corpoPulso }), error => {
    assert.equal(error.code, 'HTTP_403');
    assert.equal(error.status, 403);
    assert.equal(String(error).includes(segredo), false);
    return true;
  });
});

test('cofre real migra estado v1 e aceita feedback sem consentimento técnico',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-central-migracao-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const cofre=criarCofreCentral(dir,safeStorage());
  cofre.gravar(estado);
  const cliente=criarClienteCentral({cofre,enviar:async()=>{throw new Error('rede inesperada');},versao:'3.1.0-beta.1',canal:'beta',plataforma:'win32',arquitetura:'x64'});
  assert.equal((await cliente.estado()).feedbackHabilitado,true);
  assert.equal((await cliente.desativarAcompanhamento()).consentido,false);
  assert.equal(cofre.ler().feedbackHabilitado,true);
  assert.equal(cofre.ler().consentido,false);
  assert.equal((await criarClienteCentral({cofre,enviar:async()=>{},versao:'3.1.0-beta.1',canal:'beta',plataforma:'win32',arquitetura:'x64'}).estado()).feedbackHabilitado,true);
  assert.deepEqual(cofre.gravar({...cofre.ler(),feedbackHabilitado:true}),{ok:true});
});

test('transporte de feedback usa só HTTPS e corpo escolhido pela pessoa',async()=>{
  const chamadas=[];
  const enviar=criarTransporteCentral({fetchImpl:async(url,opcoes)=>{chamadas.push({url,opcoes});return new Response(JSON.stringify({id:'640ad0f7-2d23-4c7f-a8db-8c49fa66c167',recebidoEm:'2026-09-24T15:00:00.000Z'}),{status:201});}});
  const corpo={chaveCliente:'14d10888-d8f2-4464-b178-f8fb9c999efe',categoria:'erro',etapa:'conexao',relato:'A conexão não avançou depois do QR.',utilidade:null};
  await enviar({caminho:'/api/v1/feedback',token,corpo});
  assert.equal(chamadas[0].url,`${ORIGEM_CENTRAL}/api/v1/feedback`);
  assert.deepEqual(JSON.parse(chamadas[0].opcoes.body),corpo);
  await assert.rejects(enviar({caminho:'/api/v1/feedback',token,corpo:{...corpo,conversa:'não enviar'}}),/CORPO_INVALIDO/);
  assert.equal(chamadas.length,1);
});

test('transporte corta resposta excessiva e corpo de requisicao excessivo', async () => {
  let chamadas = 0;
  const enviar = criarTransporteCentral({ maxRespostaBytes: 256, fetchImpl: async () => {
    chamadas += 1;
    return new Response('x'.repeat(257), { status: 200 });
  } });
  await assert.rejects(enviar({ caminho: '/api/v1/instalacoes/registrar', corpo: corpoRegistro }), /RESPOSTA_EXCESSIVA/);
  await assert.rejects(enviar({ caminho: '/api/v1/instalacoes/registrar', corpo: { ...corpoRegistro, convite: `LUME-${'X'.repeat(5000)}` } }), /CORPO_INVALIDO/);
  assert.equal(chamadas, 1);
});

test('timeout aborta a requisicao e retorna codigo fechado de rede', async () => {
  const enviar = criarTransporteCentral({ timeoutMs: 100, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('segredo da rede'), { name: 'AbortError' })), { once: true });
  }) });
  await assert.rejects(enviar({ caminho: '/api/v1/instalacoes/registrar', corpo: corpoRegistro }), error => error.code === 'SEM_REDE' && !error.message.includes('segredo'));
});

test('dispatcher do processo principal aceita somente envelopes IPC exatos', async () => {
  const chamadas = [];
  const cliente = {
    estado: async () => ({ situacao: 'pronto' }),
    consentir: async convite => { chamadas.push(['consentir', convite]); },
    sincronizar: async () => ({ situacao: 'registrado' }),
    revogarLocalmente: async () => { chamadas.push(['revogar']); return { situacao: 'revogada_localmente' }; },
    enviarFeedback: async dados=>{chamadas.push(['feedback',dados.chaveCliente]);return {id,recebidoEm:'2026-09-24T15:00:00.000Z'};}
  };
  const id = '35ebef5e-ad64-43c2-84f7-a7727013a8fc';
  assert.deepEqual(await executarComandoCentral(cliente, { tipo: 'central-comando', id, acao: 'consentir', convite: 'LUME-ABCDEFGHIJKL' }), { tipo: 'central-resposta', id, estado: { situacao: 'registrado' } });
  assert.deepEqual(await executarComandoCentral(cliente, { tipo: 'central-comando', id, acao: 'revogar' }), { tipo: 'central-resposta', id, estado: { situacao: 'revogada_localmente' } });
  assert.deepEqual(await executarComandoCentral(cliente, {tipo:'central-comando',id,acao:'feedback',dados:{chaveCliente:id,categoria:'erro',etapa:'conexao',relato:'Falha no QR',utilidade:null}}),{tipo:'central-resposta',id,recibo:{id,recebidoEm:'2026-09-24T15:00:00.000Z'}});
  assert.deepEqual(await executarComandoCentral(cliente, { tipo: 'central-comando', id, acao: 'consultar', conversa: 'segredo' }), { tipo: 'central-resposta', id, erro: 'ACAO_INVALIDA' });
  assert.equal(await executarComandoCentral(cliente, { tipo: 'central-comando', id: 'invalido', acao: 'consultar' }), null);
  assert.deepEqual(chamadas, [['consentir', 'LUME-ABCDEFGHIJKL'], ['revogar'],['feedback',id]]);
});
