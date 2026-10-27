import test from 'node:test';
import assert from 'node:assert/strict';
import permission from '../desktop/notetaker-permission.cjs';
const { criarPoliticaNotetaker } = permission;

const origin = 'http://127.0.0.1:43127';
function fixture(platform = 'win32', validateSource) {
  let time = 1000;
  const frame = { url: `${origin}/app`, isDestroyed: () => false };
  frame.top = frame;
  const contents = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const source = { id: 'screen:1:0', name: 'Screen 1' };
  let policy;
  policy = criarPoliticaNotetaker({ getWindow: () => window, origin, now: () => time,
    platform, isSourceAllowed: candidate => validateSource ?
      validateSource({ candidate, source, policy }) :
      candidate.id === source.id && candidate.name === source.name });
  const request = (permission = 'media', details = { requestingUrl: frame.url, isMainFrame: true,
    securityOrigin: `${origin}/`, mediaTypes: ['audio'] }, web = contents) => {
    const calls = [];
    policy.permissionRequestHandler(web, permission, value => calls.push(value), details);
    assert.equal(calls.length, 1, 'callback chamado exatamente uma vez');
    return calls[0];
  };
  const check = (permission = 'media', details = { requestingUrl: frame.url,
    isMainFrame: true, embeddingOrigin: `${origin}/`, mediaType: 'audio' },
    web = contents, requestingOrigin = `${origin}/`) => policy.permissionCheckHandler(web, permission, requestingOrigin, details);
  const display = (overrides = {}) => {
    const calls = [];
    policy.displayMediaRequestHandler({ frame, securityOrigin: origin, videoRequested: true,
      audioRequested: true, userGesture: true, ...overrides }, value => calls.push(value));
    assert.equal(calls.length, 1, 'callback display chamado exatamente uma vez');
    return calls[0];
  };
  return { frame, contents, window, source, policy, request, check, display,
    advance: ms => { time += ms; } };
}

test('nega tudo sem grant, inclusive demais permissões', () => {
  const f = fixture();
  assert.equal(f.check(), false);
  assert.equal(f.request(), false);
  assert.equal(f.request('camera'), false);
  assert.equal(f.check('geolocation'), false);
  assert.equal(f.display(), null);
});

test('mic audio-only aceita checagens repetidas e apenas um request', () => {
  const f = fixture();
  const token = f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame });
  assert.match(token.nonce, /^[0-9a-f-]{36}$/);
  assert.equal(token.expiresAt, 31000);
  assert.equal(f.check(), true);
  assert.equal(f.check(), true);
  assert.equal(f.request(), true);
  assert.equal(f.check(), true, 'check posterior não quebra handoff');
  assert.equal(f.request(), false, 'request replay negado');
  assert.equal(f.request('media', { requestingUrl: f.frame.url, isMainFrame: true,
    securityOrigin: origin, mediaTypes: ['video'] }), false);
});

test('shapes nativos 44.4.1 aceitam somente origens locais canônicas equivalentes', () => {
  const f = fixture();
  f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame });
  const nativeCheck = { requestingUrl: f.frame.url, isMainFrame: true,
    embeddingOrigin: `${origin}/`, mediaType: 'audio' };
  const nativeRequest = { requestingUrl: f.frame.url, isMainFrame: true,
    securityOrigin: `${origin}/`, mediaTypes: ['audio'] };
  assert.equal(f.check('media', nativeCheck, f.contents, `${origin}/`), true);
  assert.equal(f.request('media', nativeRequest), true);
  assert.equal(f.request('media', nativeRequest), false, 'request repetido gasta a intenção');
});

test('origens com credenciais, caminho, query, hash, porta ou host divergente negam sem consumo', () => {
  const invalid = [
    `${origin}/sub`, `${origin}/?q=1`, `${origin}/#x`,
    'http://user@127.0.0.1:43127/', 'http://127.0.0.1:43128/',
    'http://localhost:43127/', 'https://127.0.0.1:43127/',
    'http://127.000.000.001:43127/', 'not a url', '', undefined
  ];
  const f = fixture();
  f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame });
  const request = { requestingUrl: f.frame.url, isMainFrame: true,
    securityOrigin: `${origin}/`, mediaTypes: ['audio'] };
  const check = { requestingUrl: f.frame.url, isMainFrame: true,
    embeddingOrigin: `${origin}/`, mediaType: 'audio' };
  for (const value of invalid) {
    assert.equal(f.request('media', { ...request, securityOrigin: value }), false);
    assert.equal(f.policy.permissionCheckHandler(f.contents, 'media', value, check), false);
    assert.equal(f.check('media', { ...check, embeddingOrigin: value }), false);
    assert.equal(f.check('media', { ...check, securityOrigin: value }), false);
    assert.equal(f.request('media', { ...request, embeddingOrigin: value }), false);
    assert.equal(f.request('media', { ...request, requestingOrigin: value }), false);
  }
  assert.equal(f.check('media', check), true);
  assert.equal(f.request('media', request), true);
});

test('mic nega câmera, campos ausentes, iframe e URLs ou portas diferentes', () => {
  const f = fixture();
  f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame });
  const base = { requestingUrl: f.frame.url, isMainFrame: true, securityOrigin: origin,
    mediaTypes: ['audio'] };
  for (const details of [
    { ...base, mediaTypes: ['audio', 'video'] }, { ...base, mediaTypes: [] },
    { ...base, mediaTypes: undefined }, { ...base, isMainFrame: undefined },
    { ...base, isMainFrame: false }, { ...base, securityOrigin: undefined },
    { ...base, securityOrigin: 'http://127.0.0.1:43128' },
    { ...base, requestingUrl: 'http://127.0.0.1:43128/app' },
    { ...base, requestingUrl: 'https://example.test/app' }
  ]) assert.equal(f.request('media', details), false);
  assert.equal(f.check('media', { requestingUrl: f.frame.url, isMainFrame: false,
    securityOrigin: origin, mediaType: 'audio' }), false);
  assert.equal(f.check('media', { requestingUrl: f.frame.url, isMainFrame: true,
    securityOrigin: origin }), false);
  assert.equal(f.check('media', { requestingUrl: f.frame.url, isMainFrame: true,
    securityOrigin: origin, mediaType: 'video' }), false);
  assert.equal(f.check('media', { requestingUrl: f.frame.url, isMainFrame: true,
    securityOrigin: origin, mediaType: 'audio' }, f.contents, 'http://127.0.0.1:43128'), false);
  assert.equal(f.check('media', undefined, null), false);
  assert.equal(f.request(), true, 'negações não gastam intenção válida');
});

test('grant cruza sessão/nonce sem ampliar permissão; revogação e expiração', () => {
  const f = fixture();
  const first = f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame });
  assert.equal(f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame }), null);
  assert.equal(f.policy.revoke({ sessionId: 's2', nonce: first.nonce }), false);
  assert.equal(f.policy.revoke({ sessionId: 's1', nonce: 'nonce-de-outra-intencao' }), false);
  assert.equal(f.check(), true);
  f.advance(30001);
  assert.equal(f.check(), false);
  assert.equal(f.request(), false);
  assert.equal(f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame }) !== null, true);
  assert.equal(f.policy.revoke({ sessionId: 's1' }), true);
  assert.equal(f.check(), false);
});

test('nonce revoga apenas sua entrada na sessão; revoke global remove ambas', () => {
  const f = fixture();
  const mic = f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame });
  const system = f.policy.grant({ sessionId: 's1', entry: 'system', frame: f.frame, source: f.source });
  assert.notEqual(mic.nonce, system.nonce);
  assert.equal(f.policy.revoke({ sessionId: 's1', nonce: mic.nonce }), true);
  assert.equal(f.check(), false);
  assert.deepEqual(f.display(), { video: f.source, audio: 'loopback' });
  assert.equal(f.policy.revoke(), true);
  assert.equal(f.check('display-capture', { requestingUrl: f.frame.url,
    isMainFrame: true, mediaType: 'video' }), false);
});

test('troca/morte de frame, navegação, janela ou webContents nega', () => {
  for (const breakIt of [
    f => { f.frame.isDestroyed = () => true; },
    f => { f.frame.url = `${origin}/outra`; },
    f => { f.contents.mainFrame = { ...f.frame }; },
    f => { f.contents.isDestroyed = () => true; },
    f => { f.window.isDestroyed = () => true; }
  ]) {
    const f = fixture();
    f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame });
    breakIt(f);
    assert.equal(f.check(), false);
    assert.equal(f.request(), false);
  }
});

test('display Windows só entrega fonte escolhida com gesto informado pelo Electron', () => {
  const f = fixture();
  f.policy.grant({ sessionId: 's1', entry: 'system', frame: f.frame, source: f.source });
  const details = { requestingUrl: f.frame.url, isMainFrame: true, securityOrigin: origin,
    mediaTypes: ['video', 'audio'] };
  const checkDetails = { requestingUrl: f.frame.url, isMainFrame: true, mediaType: 'video' };
  assert.equal(f.check('display-capture', checkDetails), false,
    'check não prova getDisplayMedia versus caminho legado');
  assert.equal(f.request('display-capture', details), false,
    'request também não distingue os dois caminhos');
  assert.equal(f.request('display-capture', details), false);
  assert.deepEqual(f.display(), { video: f.source, audio: 'loopback' });
  assert.equal(f.display(), null, 'display replay negado');
});

test('display fixa fonte escolhida mesmo se objeto original mudar para outra fonte permitida', () => {
  const f = fixture('win32', ({ candidate }) =>
    ['screen:1:0', 'screen:2:0'].includes(candidate.id));
  const thumbnail = { nativeImage: 'thumbnail' };
  f.source.display_id = '1';
  f.source.appIcon = null;
  f.source.thumbnail = thumbnail;
  assert.ok(f.policy.grant({ sessionId: 's1', entry: 'system', frame: f.frame,
    source: f.source }));
  f.source.id = 'screen:2:0';
  f.source.name = 'Tela B';
  f.source.display_id = '2';
  const result = f.display();
  assert.notEqual(result.video, f.source);
  assert.equal(result.video.id, 'screen:1:0');
  assert.equal(result.video.name, 'Screen 1');
  assert.equal(result.video.display_id, '1');
  assert.equal(result.video.appIcon, null);
  assert.equal(result.video.thumbnail, thumbnail);
});

test('display falha fechado para gesto, frame, origem, fonte e plataformas sem prova', () => {
  for (const change of [
    { userGesture: false }, { userGesture: undefined }, { frame: null },
    { securityOrigin: 'http://127.0.0.1:43128' }, { audioRequested: false },
    { videoRequested: false }
  ]) {
    const f = fixture();
    f.policy.grant({ sessionId: 's1', entry: 'system', frame: f.frame, source: f.source });
    assert.equal(f.display(change), null);
  }
  const mac = fixture('darwin');
  assert.equal(mac.policy.grant({ sessionId: 's1', entry: 'system', frame: mac.frame,
    source: mac.source }), null);
  assert.equal(mac.display(), null);
  const f = fixture();
  assert.equal(f.policy.grant({ sessionId: 's1', entry: 'system', frame: f.frame,
    source: { id: 'screen:2:0', name: 'Outra' } }), null);
  assert.equal(f.request('display-capture', { requestingUrl: f.frame.url, isMainFrame: true,
    securityOrigin: origin, mediaTypes: ['video', 'audio'] }), false);
  const iframe = fixture();
  iframe.policy.grant({ sessionId: 's1', entry: 'system', frame: iframe.frame, source: iframe.source });
  const child = { url: iframe.frame.url, top: iframe.frame, isDestroyed: () => false };
  assert.equal(iframe.display({ frame: child }), null);
});

test('display assíncrono revogado ou expirado antes do callback não concede', () => {
  const f = fixture();
  f.policy.grant({ sessionId: 's1', entry: 'system', frame: f.frame, source: f.source });
  f.policy.revoke({ sessionId: 's1' });
  assert.equal(f.display(), null);
  const second = fixture();
  second.policy.grant({ sessionId: 's1', entry: 'system', frame: second.frame, source: second.source });
  second.advance(30001);
  assert.equal(second.display(), null);
});

test('revoke durante validação da fonte não concede display', () => {
  let checks = 0;
  const f = fixture('win32', ({ candidate, source, policy }) => {
    checks += 1;
    if (checks === 2) policy.revoke({ sessionId: 's1' });
    return candidate.id === source.id && candidate.name === source.name;
  });
  f.policy.grant({ sessionId: 's1', entry: 'system', frame: f.frame, source: f.source });
  assert.equal(f.display(), null);
});

test('campos que lançam erro e corrida de fechamento ainda chamam callback uma vez', () => {
  const f = fixture();
  f.policy.grant({ sessionId: 's1', entry: 'microphone', frame: f.frame });
  const calls = [];
  f.policy.permissionRequestHandler(f.contents, 'media', value => calls.push(value),
    { get requestingUrl() { throw new Error('frame destruído'); } });
  assert.deepEqual(calls, [false]);
  const displayCalls = [];
  f.policy.displayMediaRequestHandler({ get frame() { throw new Error('janela fechada'); } },
    value => displayCalls.push(value));
  assert.deepEqual(displayCalls, [null]);
});
