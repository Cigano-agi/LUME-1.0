'use strict';

const { randomUUID } = require('node:crypto');

const MAX_GRANT_MS = 30_000;

function localOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
        parsed.username || parsed.password || parsed.pathname !== '/' ||
        parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch { return null; }
}

function criarPoliticaNotetaker({ getWindow, origin, now = Date.now, platform = process.platform,
  isSourceAllowed } = {}) {
  if (typeof getWindow !== 'function' || typeof now !== 'function' ||
      typeof origin !== 'string' || origin.endsWith('/') || localOrigin(origin) !== origin) {
    throw new TypeError('Origem local e funções do main obrigatórias');
  }
  const grants = new Map();

  function sameOrigin(url) {
    if (typeof url !== 'string') return false;
    try { return new URL(url).origin === origin; } catch { return false; }
  }

  function liveFrame(frame, initialUrl) {
    try {
      const win = getWindow();
      if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed()) return false;
      const web = win.webContents;
      if (!web || typeof web.isDestroyed !== 'function' || web.isDestroyed() ||
          typeof web.getURL !== 'function') return false;
      if (!frame || typeof frame.isDestroyed !== 'function' || frame.isDestroyed() ||
          frame.detached === true || frame.top !== frame || web.mainFrame !== frame) return false;
      const url = frame.url;
      return sameOrigin(url) && web.getURL() === url &&
        (initialUrl === undefined || url === initialUrl);
    } catch { return false; }
  }

  function active(grant) {
    if (!grant) return false;
    if (now() >= grant.expiresAt || !liveFrame(grant.frame, grant.url)) {
      grants.delete(grant.entry);
      return false;
    }
    return true;
  }

  function allowedSource(source) {
    if (platform !== 'win32' || !source || typeof source.id !== 'string' ||
        !source.id || typeof source.name !== 'string' || !source.name ||
        typeof isSourceAllowed !== 'function') return false;
    try { return isSourceAllowed(source) === true; } catch { return false; }
  }

  function fixedSource(source) {
    if (!source || typeof source !== 'object') return null;
    try {
      // Preserve the DesktopCapturerSource fields (including NativeImage values),
      // while fixing the stream identity before any later validation or callback.
      return Object.freeze({ ...source, id: source.id, name: source.name });
    } catch { return null; }
  }

  function grant({ sessionId, entry, frame, source } = {}) {
    if (typeof sessionId !== 'string' || !sessionId ||
        !['microphone', 'system'].includes(entry) || !liveFrame(frame)) return null;
    const chosenSource = entry === 'system' ? fixedSource(source) : undefined;
    if (entry === 'microphone' ? source !== undefined :
        !chosenSource || !allowedSource(chosenSource)) return null;
    if (active(grants.get(entry))) return null;
    const createdAt = now();
    const item = { sessionId, entry, frame, url: frame.url, source: chosenSource,
      nonce: randomUUID(), expiresAt: createdAt + MAX_GRANT_MS, state: 'armed' };
    grants.set(entry, item);
    return { nonce: item.nonce, expiresAt: item.expiresAt };
  }

  function revoke(selector) {
    if (selector === undefined) {
      const hadAny = grants.size > 0;
      grants.clear();
      return hadAny;
    }
    if (!selector || typeof selector.sessionId !== 'string' || !selector.sessionId) return false;
    let revoked = false;
    for (const [entry, item] of grants) {
      if (item.sessionId === selector.sessionId &&
          (selector.nonce === undefined || selector.nonce === item.nonce)) {
        grants.delete(entry);
        revoked = true;
      }
    }
    return revoked;
  }

  function expectedOrigin(value) {
    return localOrigin(value) === origin;
  }

  function optionalOrigin(details, field) {
    return !Object.prototype.hasOwnProperty.call(details, field) || expectedOrigin(details[field]);
  }

  function matching(permission, webContents, requestingUrl, isMainFrame) {
    const entry = permission === 'media' ? 'microphone' : null;
    if (!entry || isMainFrame !== true || !sameOrigin(requestingUrl)) return null;
    const item = grants.get(entry);
    if (!active(item) || item.url !== requestingUrl) return null;
    try {
      const win = getWindow();
      if (webContents !== win.webContents) return null;
    } catch { return null; }
    return item;
  }

  function permissionCheckHandler(webContents, permission, requestingOrigin, details) {
    try {
      if (!details || typeof details !== 'object' || !expectedOrigin(requestingOrigin) ||
          !expectedOrigin(details.embeddingOrigin) || !optionalOrigin(details, 'securityOrigin')) return false;
      const item = matching(permission, webContents, details.requestingUrl,
        details.isMainFrame);
      if (!item) return false;
      if (permission === 'media') return details.mediaType === 'audio';
      return false;
    } catch { return false; }
  }

  function permissionRequestHandler(webContents, permission, callback, details) {
    let accepted = false;
    try {
      if (details && typeof details === 'object' && expectedOrigin(details.securityOrigin) &&
          optionalOrigin(details, 'requestingOrigin') && optionalOrigin(details, 'embeddingOrigin')) {
        const item = matching(permission, webContents, details.requestingUrl,
          details.isMainFrame);
        if (item && item.state === 'armed' &&
            Array.isArray(details.mediaTypes)) {
          const types = details.mediaTypes;
          if (permission === 'media' && types.length === 1 && types[0] === 'audio') {
            item.state = 'used';
            accepted = true;
          }
        }
      }
    } catch { accepted = false; }
    callback(accepted);
  }

  function displayMediaRequestHandler(request, callback) {
    let streams = null;
    try {
      const item = grants.get('system');
      if (active(item) && item.state === 'armed' && platform === 'win32' &&
          request && request.frame === item.frame && request.frame === request.frame.top &&
          expectedOrigin(request.securityOrigin) && request.videoRequested === true &&
          request.audioRequested === true && request.userGesture === true &&
          allowedSource(item.source) && grants.get('system') === item && active(item)) {
        item.state = 'used';
        streams = { video: item.source, audio: 'loopback' };
      }
    } catch { streams = null; }
    callback(streams);
  }

  return { grant, revoke, permissionRequestHandler, permissionCheckHandler,
    displayMediaRequestHandler };
}

module.exports = { criarPoliticaNotetaker };
