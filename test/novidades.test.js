import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { abrirBanco } from '../src/banco.js';
import { INTERVALO_GLOBAL_MS, Novidades, criarTransporteComunicados, validarEnvelopeComunicados, validarPoliticaComunicados } from '../src/novidades.js';

const AGORA = Date.parse('2026-09-19T12:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const politica = { schema: 'lume-comunicados-policy-v1', enabled: true, channel: 'beta', feedUrl: 'https://lume-crm-fawn.vercel.app/api/v1/comunicados/beta.json', publicKey };
const campanha = (patch = {}) => ({
  id: 'nova-busca', titulo: 'Busca mais simples', texto: 'Agora ficou mais fácil encontrar uma conversa.',
  inicioEm: '2026-09-18T00:00:00.000Z', expiraEm: '2026-09-30T00:00:00.000Z',
  canais: ['beta'], plataformas: ['win32', 'darwin'], versaoMin: '3.0.0-alpha.1', versaoMax: '3.2.0',
  repetirAposHoras: 0, acao: 'ver_atualizacoes', ...patch
});
function envelope(campanhas = [campanha()], chave = keys.privateKey) {
  const corpo = { schema: 'lume-comunicados-v1', geradoEm: '2026-09-19T11:00:00.000Z', campanhas };
  return { ...corpo, assinatura: sign(null, Buffer.from(JSON.stringify(corpo)), chave).toString('base64') };
}

test('preferência começa desligada, é independente e guarda somente histórico mínimo local', async t => {
  const db = abrirBanco(); t.after(() => db.close());
  let buscas = 0;
  const novidades = new Novidades(db, { politica, versao: '3.0.0-alpha.8', plataforma: 'win32', agora: () => AGORA, buscar: async () => { buscas++; return envelope(); } });
  assert.deepEqual(novidades.estado(), { disponivel: true, consentido: false, situacao: 'desligado', comunicado: null });
  assert.equal((await novidades.verificar()).situacao, 'desligado');
  assert.equal(buscas, 0);
  assert.equal(novidades.ativar().consentido, true);
  const visto = await novidades.verificar();
  assert.deepEqual(visto.comunicado, { id: 'nova-busca', titulo: 'Busca mais simples', texto: 'Agora ficou mais fácil encontrar uma conversa.', acao: 'ver_atualizacoes' });
  const salvo = db.prepare("SELECT valor FROM desktop_config WHERE chave='novidades-historico'").get().valor;
  assert.equal(salvo.includes('Busca mais simples'), false);
  assert.equal(salvo.includes('conversa'), false);
  assert.deepEqual(Object.keys(JSON.parse(salvo)), ['ultimoExibidoEm', 'vistos']);
  assert.equal((await novidades.verificar()).situacao, 'sem_novidades');
  assert.equal(novidades.desativar().consentido, false);
});

test('assinatura, validade, plataforma, versão e frequência falham fechados', async t => {
  const db = abrirBanco(); t.after(() => db.close());
  const alterado = envelope(); alterado.campanhas[0].texto = 'Texto adulterado';
  assert.throws(() => validarEnvelopeComunicados(alterado, publicKey), /ASSINATURA_INVALIDA/);
  const outraChave = generateKeyPairSync('ed25519');
  assert.throws(() => validarEnvelopeComunicados(envelope([], outraChave.privateKey), publicKey), /ASSINATURA_INVALIDA/);

  let atual = AGORA;
  const campanhas = [
    campanha({ id: 'expirada', expiraEm: '2026-09-19T11:59:59.000Z' }),
    campanha({ id: 'mac', plataformas: ['darwin'] }),
    campanha({ id: 'versao', versaoMin: '4.0.0', versaoMax: '5.0.0' })
  ];
  const novidades = new Novidades(db, { politica, versao: '3.0.0-alpha.8', plataforma: 'win32', agora: () => atual, buscar: async () => envelope(campanhas) });
  novidades.ativar();
  assert.equal((await novidades.verificar()).situacao, 'sem_novidades');

  const repetivel = campanha({ id: 'lembrete', repetirAposHoras: 48 });
  novidades.buscar = async () => envelope([repetivel]);
  assert.equal((await novidades.verificar()).situacao, 'comunicado');
  atual += INTERVALO_GLOBAL_MS;
  assert.equal((await novidades.verificar()).situacao, 'sem_novidades');
  atual += INTERVALO_GLOBAL_MS;
  assert.equal((await novidades.verificar()).situacao, 'comunicado');
});

test('transporte usa GET fixo sem identificador, conteúdo, autorização ou telemetria de clique', async () => {
  const chamadas = [];
  const transportar = criarTransporteComunicados({
    feedUrl: politica.feedUrl,
    fetchImpl: async (url, opcoes) => { chamadas.push({ url, opcoes }); return new Response(JSON.stringify(envelope()), { status: 200, headers: { 'content-type': 'application/json' } }); }
  });
  const resposta = await transportar();
  assert.equal(resposta.schema, 'lume-comunicados-v1');
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, politica.feedUrl);
  assert.deepEqual(chamadas[0].opcoes.headers, { accept: 'application/json' });
  assert.equal(chamadas[0].opcoes.method, 'GET');
  assert.equal('body' in chamadas[0].opcoes, false);
  assert.equal('authorization' in chamadas[0].opcoes.headers, false);
  assert.equal(JSON.stringify(chamadas).match(/mensagem|contato|clique|whatsapp/gi), null);
});

test('transporte recusa resposta excessiva sem tentar interpretar conteúdo', async () => {
  const transportar = criarTransporteComunicados({
    feedUrl: politica.feedUrl,
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': String(65 * 1024) } })
  });
  await assert.rejects(transportar(), /RESPOSTA_EXCESSIVA/);
});

test('política inválida desliga o canal e campanha com campos extras é recusada', () => {
  assert.equal(validarPoliticaComunicados({ ...politica, feedUrl: 'https://example.com/feed.json' }).enabled, false);
  assert.equal(validarPoliticaComunicados({ ...politica, extra: true }).enabled, false);
  assert.throws(() => validarEnvelopeComunicados(envelope([{ ...campanha(), codigo: 'executar' }]), publicKey), /CAMPANHA_INVALIDA/);
  assert.throws(() => validarEnvelopeComunicados(envelope([campanha(), campanha()]), publicKey), /CAMPANHA_INVALIDA/);
});
