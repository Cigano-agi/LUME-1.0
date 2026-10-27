import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { criarClienteCentral, INTERVALO_PULSO_MS, payloadPulso } = require('../desktop/central-pulso.cjs');

const VERSAO = '3.1.0-beta.1';
const CONVITE = 'LUME-ABCDEFGHIJKL';

function ambiente({ falhar, lerEstado, inicial = null } = {}) {
  let agora = Date.parse('2026-09-18T12:00:00.000Z');
  let guardado = inicial;
  const chamadas = [], timers = [];
  const cofre = {
    async ler() { return guardado; },
    async gravar(valor) { guardado = structuredClone(valor); },
    async remover() { guardado = null; }
  };
  const enviar = async requisicao => {
    chamadas.push(structuredClone(requisicao));
    if (falhar) return falhar(requisicao, chamadas.length);
    if (requisicao.caminho.endsWith('/registrar')) return { instalacaoId: requisicao.corpo.instalacaoId, token: 'token_de_teste_seguro_12345678901234567890', canal: 'beta' };
    return { recebido: true, servidorEm: new Date(agora).toISOString() };
  };
  const cliente = criarClienteCentral({
    cofre, enviar, versao: VERSAO, canal: 'beta', plataforma: 'win32', arquitetura: 'x64', lerEstado,
    agora: () => agora,
    setTimer(fn, ms) { const item = { fn, ms, cancelado: false, unref() {} }; timers.push(item); return item; },
    clearTimer(item) { if (item) item.cancelado = true; }
  });
  return { cliente, chamadas, timers, guardado: () => guardado, avancar: ms => { agora += ms; } };
}

test('identidade aleatoria nasce somente com consentimento e fica protegida pelo cofre injetado', async () => {
  const a = ambiente(), b = ambiente();
  assert.equal((await a.cliente.estado()).instalacaoId, null);
  const primeiro = await a.cliente.consentir(CONVITE);
  const segundo = await b.cliente.consentir(CONVITE);
  assert.match(primeiro.instalacaoId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(primeiro.instalacaoId, segundo.instalacaoId);
  assert.equal(a.chamadas.length, 0);
  assert.equal(a.guardado().consentido, true);
  assert.equal(a.guardado().convite, CONVITE);
});

test('registro e pulso usam payload fechado sem conteudo, JID, telefone, caminho local ou segredo', async () => {
  const a = ambiente({ lerEstado: () => ({
    estadoAtualizacao: 'erro', codigoErro: 'DOWNLOAD_FALHOU', whatsappEstado: 'pareando',
    mensagem: 'NAO ENVIAR', jid: '551199999@s.whatsapp.net', telefone: '551199999', caminho: 'C:\\Users\\Pessoa', stack: 'segredo'
  }) });
  await a.cliente.consentir(CONVITE);
  assert.equal((await a.cliente.sincronizar()).situacao, 'registrado');
  const id = a.guardado().instalacaoId;
  assert.deepEqual(a.chamadas[0], { caminho: '/api/v1/instalacoes/registrar', corpo: {
    convite: CONVITE, instalacaoId: id, versao: VERSAO, canal: 'beta', plataforma: 'win32', arquitetura: 'x64'
  } });
  a.avancar(INTERVALO_PULSO_MS);
  assert.equal((await a.cliente.sincronizar()).situacao, 'pulso_enviado');
  assert.deepEqual(a.chamadas[1].corpo, {
    versao: VERSAO, canal: 'beta', plataforma: 'win32', arquitetura: 'x64',
    estadoAtualizacao: 'erro', whatsappEstado: 'pareando', codigoErro: 'DOWNLOAD_FALHOU'
  });
  assert.equal(a.chamadas[1].token, 'token_de_teste_seguro_12345678901234567890');
  assert.equal(JSON.stringify(a.chamadas[1].corpo).includes('5511'), false);
  assert.equal(JSON.stringify(a.chamadas[1].corpo).includes('Users'), false);
});

test('feedback sai só após convite autorizado, com token protegido e recibo confirmado',async()=>{
  const recibo={id:'640ad0f7-2d23-4c7f-a8db-8c49fa66c167',recebidoEm:'2026-09-24T15:00:00.000Z'};
  const a=ambiente({falhar:async requisicao=>requisicao.caminho.endsWith('/registrar')
    ?{instalacaoId:requisicao.corpo.instalacaoId,token:'token_de_teste_seguro_12345678901234567890',canal:'beta'}:recibo});
  const dados={chaveCliente:'14d10888-d8f2-4464-b178-f8fb9c999efe',categoria:'erro',etapa:'conexao',relato:'O QR ficou parado após a leitura.',utilidade:null,contatoAutorizado:true};
  await assert.rejects(a.cliente.enviarFeedback(dados),/SEM_INSTALACAO/);
  await a.cliente.consentir(CONVITE);
  assert.deepEqual(await a.cliente.enviarFeedback(dados),recibo);
  assert.deepEqual(a.chamadas.map(item=>item.caminho),['/api/v1/instalacoes/registrar','/api/v1/feedback']);
  assert.equal(a.chamadas[1].token,'token_de_teste_seguro_12345678901234567890');
  assert.deepEqual(a.chamadas[1].corpo,dados);
  await a.cliente.revogarLocalmente();
  await assert.rejects(a.cliente.enviarFeedback(dados),/SEM_INSTALACAO/);
});

test('convite habilita feedback manual sem pulsos; opt-in técnico separado inicia pulsos',async()=>{
  const recibo={id:'640ad0f7-2d23-4c7f-a8db-8c49fa66c167',recebidoEm:'2026-09-24T15:00:00.000Z'};
  const a=ambiente({falhar:async requisicao=>requisicao.caminho.endsWith('/registrar')
    ?{instalacaoId:requisicao.corpo.instalacaoId,token:'token_de_teste_seguro_12345678901234567890',canal:'beta'}:requisicao.caminho.endsWith('/feedback')?recibo:{recebido:true}});
  const dados={chaveCliente:'14d10888-d8f2-4464-b178-f8fb9c999efe',categoria:'erro',etapa:'conexao',relato:'O QR ficou parado após a leitura.'};
  const autorizado=await a.cliente.autorizarFeedback(CONVITE);
  assert.equal(autorizado.feedbackHabilitado,true);
  assert.equal(autorizado.consentido,false);
  assert.equal(a.timers.length,0);
  a.cliente.iniciar();await Promise.resolve();await Promise.resolve();
  a.avancar(INTERVALO_PULSO_MS*2);
  assert.equal((await a.cliente.sincronizar()).situacao,'sem_consentimento');
  assert.deepEqual(await a.cliente.enviarFeedback(dados),recibo);
  assert.deepEqual(a.chamadas.map(x=>x.caminho),['/api/v1/instalacoes/registrar','/api/v1/feedback']);
  assert.equal((await a.cliente.ativarAcompanhamento()).consentido,true);
  assert.equal((await a.cliente.sincronizar()).situacao,'pulso_enviado');
  assert.equal(a.chamadas.at(-1).caminho,'/api/v1/instalacoes/pulso');
  const antes=a.chamadas.length;
  const desligado=await a.cliente.desativarAcompanhamento();
  assert.equal(desligado.consentido,false);
  assert.equal(desligado.feedbackHabilitado,true);
  a.avancar(INTERVALO_PULSO_MS);
  assert.equal((await a.cliente.sincronizar()).situacao,'sem_consentimento');
  assert.equal(a.chamadas.length,antes);
  assert.deepEqual(await a.cliente.enviarFeedback({...dados,chaveCliente:'70810449-137c-47c2-9702-27c0c875b8ff'}),recibo);
  await a.cliente.revogarLocalmente();
  await assert.rejects(a.cliente.enviarFeedback(dados),/SEM_INSTALACAO/);
});

test('dois envios simultâneos compartilham o registro do convite',async()=>{
  let liberar;
  const registroPendente=new Promise(resolve=>{liberar=resolve;});
  const inicial={schema:'lume-central-client-v1',consentido:false,feedbackHabilitado:true,instalacaoId:'b84c33d7-35c6-4a89-bf3f-7f9dc7c8b133',convite:CONVITE,token:null,revogada:false,ultimoSucessoEm:null,proximaTentativaEm:null,falhasConsecutivas:0};
  const recibo={id:'640ad0f7-2d23-4c7f-a8db-8c49fa66c167',recebidoEm:'2026-09-24T15:00:00.000Z'};
  const a=ambiente({inicial,falhar:async requisicao=>requisicao.caminho.endsWith('/registrar')?registroPendente:recibo});
  const dados={chaveCliente:'14d10888-d8f2-4464-b178-f8fb9c999efe',categoria:'erro',etapa:'conexao',relato:'O QR ficou parado após a leitura.'};
  const um=a.cliente.enviarFeedback(dados),dois=a.cliente.enviarFeedback(dados);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.chamadas.filter(x=>x.caminho.endsWith('/registrar')).length,1);
  liberar({instalacaoId:inicial.instalacaoId,token:'token_de_teste_seguro_12345678901234567890',canal:'beta'});
  assert.deepEqual(await Promise.all([um,dois]),[recibo,recibo]);
  assert.equal(a.chamadas.filter(x=>x.caminho.endsWith('/registrar')).length,1);
  assert.equal(a.chamadas.filter(x=>x.caminho.endsWith('/pulso')).length,0);
});

test('nao envia mais de um pulso em seis horas e iniciar nunca espera a rede', async () => {
  const a = ambiente();
  await a.cliente.consentir(CONVITE);
  await a.cliente.sincronizar();
  assert.equal((await a.cliente.sincronizar()).situacao, 'em_dia');
  assert.equal(a.chamadas.length, 1);
  a.avancar(INTERVALO_PULSO_MS - 1);
  await a.cliente.sincronizar();
  assert.equal(a.chamadas.length, 1);
  a.avancar(1);
  await a.cliente.sincronizar();
  assert.equal(a.chamadas.length, 2);
  assert.deepEqual(a.cliente.iniciar(), { iniciado: true });
});

test('falha de rede aplica backoff limitado e nao rejeita nem bloqueia o aplicativo', async () => {
  const a = ambiente({ falhar: async () => { throw Object.assign(new Error('offline'), { code: 'ENETDOWN' }); } });
  await a.cliente.consentir(CONVITE);
  const primeira = await a.cliente.sincronizar();
  assert.equal(primeira.situacao, 'central_indisponivel');
  assert.equal(primeira.falhasConsecutivas, 1);
  assert.equal(a.chamadas.length, 1);
  assert.equal((await a.cliente.sincronizar()).situacao, 'adiado');
  assert.equal(a.chamadas.length, 1);
  a.avancar(60 * 1000);
  const segunda = await a.cliente.sincronizar();
  assert.equal(segunda.falhasConsecutivas, 2);
  assert.equal(a.chamadas.length, 2);
});

test('revogacao do servidor encerra pulsos sem tocar no acervo local', async () => {
  let pulso = false;
  const a = ambiente({ falhar: async requisicao => {
    if (requisicao.caminho.endsWith('/registrar')) return { instalacaoId: requisicao.corpo.instalacaoId, token: 'token_de_teste_seguro_12345678901234567890' };
    pulso = true;
    throw Object.assign(new Error('revogada'), { status: 401 });
  } });
  await a.cliente.consentir(CONVITE);
  await a.cliente.sincronizar();
  a.avancar(INTERVALO_PULSO_MS);
  const resultado = await a.cliente.sincronizar();
  assert.equal(pulso, true);
  assert.equal(resultado.situacao, 'revogada');
  assert.equal(a.guardado().token, null);
  assert.equal(a.guardado().consentido, false);
  assert.equal((await a.cliente.sincronizar()).situacao, 'sem_consentimento');
});

test('revogacao local apaga somente a identidade operacional do cofre', async () => {
  const a = ambiente();
  await a.cliente.consentir(CONVITE);
  const resultado = await a.cliente.revogarLocalmente();
  assert.equal(resultado.situacao, 'revogada_localmente');
  assert.equal(resultado.revogada, true);
  assert.equal(a.guardado(), null);
  assert.equal(a.chamadas.length, 0);
});

test('revogacao substitui a credencial por lapide se o arquivo nao puder ser removido', async () => {
  let guardado = null;
  const cofre = {
    async ler() { return guardado; },
    async gravar(valor) { guardado = structuredClone(valor); },
    async remover() { throw new Error('arquivo ocupado'); }
  };
  const cliente = criarClienteCentral({ cofre, enviar: async () => { throw new Error('rede proibida'); }, versao: VERSAO, canal: 'beta', plataforma: 'win32', arquitetura: 'x64' });
  await cliente.consentir(CONVITE);
  const resultado = await cliente.revogarLocalmente();
  assert.equal(resultado.situacao, 'revogada_localmente');
  assert.equal(guardado.revogada, true);
  assert.equal(guardado.consentido, false);
  assert.equal(guardado.token, null);
  assert.equal((await cliente.sincronizar()).situacao, 'encerrado');
});

test('revogacao local durante requisicao nao deixa a resposta recriar credenciais', async () => {
  let liberar;
  const espera = new Promise(resolve => { liberar = resolve; });
  const a = ambiente({ falhar: async requisicao => {
    await espera;
    return { instalacaoId: requisicao.corpo.instalacaoId, token: 'token_de_teste_seguro_12345678901234567890' };
  } });
  await a.cliente.consentir(CONVITE);
  const registro = a.cliente.sincronizar();
  await new Promise(resolve => setImmediate(resolve));
  await a.cliente.revogarLocalmente();
  liberar();
  assert.equal((await registro).situacao, 'encerrado');
  assert.equal(a.guardado(), null);
});

test('estado operacional arbitrario cai em enums seguros', () => {
  assert.deepEqual(payloadPulso({ versao: VERSAO, canal: 'beta', plataforma: 'darwin', arquitetura: 'arm64' }, () => ({
    estadoAtualizacao: 'C:\\segredo', whatsappEstado: '551199999', codigoErro: 'stack completa'
  })), {
    versao: VERSAO, canal: 'beta', plataforma: 'darwin', arquitetura: 'arm64',
    estadoAtualizacao: 'em_dia', whatsappEstado: 'nao_informado'
  });
});
