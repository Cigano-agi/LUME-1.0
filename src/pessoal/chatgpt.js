import {randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';

const AUTH = 'https://auth.openai.com';
const API = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const CLIENT = /^oaiapp_[A-Za-z0-9_-]{1,180}$/;
const TERMINAL_REFRESH = new Set(['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused']);
const cleanCode = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : 'indisponivel';
const random = () => randomBytes(32).toString('base64url');
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));

export class ErroChatGPT extends Error {
  constructor(code, {status = null, requestId = null} = {}) {
    const c = cleanCode(code);
    super(c === 'subscription_sharing_usage_limit_exceeded'
      ? 'O limite autorizado do plano foi atingido. Confira o uso no ChatGPT.'
      : c === 'login_necessario' ? 'Entre com sua conta ChatGPT no Lume.'
      : c === 'permissao_plano_ausente' ? 'Autorize o Lume a usar seu plano ChatGPT.'
      : c === 'http_403' ? 'A OpenAI recusou esta solicitação. Seu login foi preservado; o acesso ao modelo ainda não foi confirmado.'
      : c === 'rede_indisponivel' ? 'A consulta à OpenAI não terminou a tempo. Tente novamente; seu login foi preservado.'
      : 'O ChatGPT não concluiu esta solicitação. A demanda foi preservada.');
    this.name = 'ErroChatGPT'; this.code = c; this.status = status;
    this.requestId = typeof requestId === 'string' && /^[\w-]{1,180}$/.test(requestId) ? requestId : null;
  }
}

async function jsonLimit(response, limit = 262144) {
  const metadata={status:response.status,requestId:response.headers?.get('x-request-id')};
  const decoder=new TextDecoder();let text='',bytes=0;
  for await(const chunk of response.body??[]) {
    bytes+=chunk.byteLength;
    if(bytes>limit)throw new ErroChatGPT('resposta_grande_demais',metadata);
    text+=decoder.decode(chunk,{stream:true});
  }
  text+=decoder.decode();
  try { return JSON.parse(text); }
  catch { throw new ErroChatGPT(response.ok?'resposta_invalida':'http_'+response.status,metadata); }
}

export function validarIdToken(token, jwks, {clientId, nonce, subject, agora = Date.now()} = {}) {
  if (typeof token !== 'string' || token.length > 32768) throw new ErroChatGPT('identidade_invalida');
  try {
    const pieces = token.split('.');
    if (pieces.length !== 3 || pieces.some(p => !/^[\w-]+$/.test(p))) throw Error();
    const header = JSON.parse(Buffer.from(pieces[0],'base64url'));
    const claims = JSON.parse(Buffer.from(pieces[1],'base64url'));
    const key = jwks?.keys?.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
    if (header.alg !== 'RS256' || header.crit || !key || !verify('RSA-SHA256',Buffer.from(pieces.slice(0,2).join('.')),createPublicKey({key,format:'jwk'}),Buffer.from(pieces[2],'base64url'))) throw Error();
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== AUTH || !aud.includes(clientId) || aud.length > 1 && claims.azp !== clientId ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= agora ||
        claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > agora + 30000) ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 500 ||
        nonce !== undefined && !same(claims.nonce,nonce) || subject !== undefined && claims.sub !== subject) throw Error();
    return {subject: claims.sub, email: typeof claims.email === 'string' ? claims.email.slice(0,254) : null};
  } catch { throw new ErroChatGPT('identidade_invalida'); }
}

/** The only OAuth credentials used here belong to Lume's own registration. */
export class ChatGPTPessoal {
  constructor(db, {cofre, fetchImpl = fetch, agora = () => Date.now()} = {}) {
    this.db = db; this.cofre = cofre; this.fetch = fetchImpl; this.agora = agora;
    this.pending = null; this.refreshing = null; this.generation = 0;
    this.error = null; this.controllers = new Set(); this.catalog = [];
    this.writes=Promise.resolve();
    db.exec('CREATE TABLE IF NOT EXISTS desktop_config(chave TEXT PRIMARY KEY,valor TEXT NOT NULL)');
  }
  #setting(key, value) {
    if (value !== undefined) this.db.prepare('INSERT INTO desktop_config VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run('pessoal-chatgpt-'+key,String(value));
    return this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get('pessoal-chatgpt-'+key)?.valor;
  }
  async #read() {
    await this.writes;
    const state = await this.cofre.estado();
    if (!state?.disponivel) throw new ErroChatGPT('cofre_indisponivel');
    if (!state.configurada) return {version:1,active:null,accounts:[]};
    try {
      const data = JSON.parse(await this.cofre.ler());
      if (data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > 16) throw Error();
      return data;
    } catch { throw new ErroChatGPT('cofre_invalido'); }
  }
  async #write(data, generation = this.generation) {
    const serialized=JSON.stringify(data);
    const operation=this.writes.then(async()=>{
      if(generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
      await this.cofre.gravar(serialized);
      if(generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
    });
    this.writes=operation.catch(()=>{});
    return operation;
  }
  async #request(url, {timeoutMs=30000,...options} = {}) {
    const controller = new AbortController(); this.controllers.add(controller);
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(options.signal?[options.signal]:[])]);
    let abort;
    const cleanup=()=>{this.controllers.delete(controller);if(abort)signal.removeEventListener('abort',abort);};
    try {
      const response=await this.fetch(url,{...options,redirect:'error',signal});
      if(!response.body){cleanup();return response;}
      const reader=response.body.getReader();
      let finished=false;
      const cancelUpstream=reason=>{try{void reader.cancel(reason).catch(()=>{});}catch{}};
      const body=new ReadableStream({
        start(target){
          abort=()=>{if(finished)return;finished=true;cleanup();target.error(signal.reason);cancelUpstream(signal.reason);};
          signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        },
        async pull(target){
          try{const {done,value}=await reader.read();if(finished)return;if(done){finished=true;cleanup();target.close();}else target.enqueue(value);}
          catch(error){if(!finished){finished=true;cleanup();target.error(error);}}
        },
        cancel(reason){if(finished)return;finished=true;cleanup();cancelUpstream(reason);}
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    } catch {cleanup();throw new ErroChatGPT('rede_indisponivel');}
  }
  async #tokens(form) {
    const response = await this.#request(AUTH+'/api/accounts/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form).toString()});
    const data = await jsonLimit(response);
    if (!response.ok) throw new ErroChatGPT(data?.error?.code || data?.error,{status:response.status});
    if (typeof data.access_token !== 'string' || data.access_token.length < 10 || data.access_token.length > 32768 ||
      data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400) throw new ErroChatGPT('token_invalido');
    return data;
  }
  async #identity(token, options) {
    const response = await this.#request(AUTH+'/.well-known/jwks.json');
    if (!response.ok) throw new ErroChatGPT('identidade_indisponivel');
    return validarIdToken(token,await jsonLimit(response),{...options,agora:this.agora()});
  }
  async estado() {
    let data, secure = true;
    try { data = await this.#read(); } catch { data = {accounts:[]}; secure = false; }
    const active = data.accounts.find(a => a.client_id === data.active);
    return {available:true,secureStorageAvailable:secure,connected:Boolean(active?.access_token),
      planEnabled:active?.scopes?.includes('chatgpt.tokens.use.direct') === true,
      account:active ? {id:active.client_id,email:active.email} : null,
      accounts:data.accounts.map(a=>({id:a.client_id,email:a.email,connected:Boolean(a.access_token)})),
      pending:Boolean(this.pending),model:this.#setting('model') || null,
      verifiedAt:this.#setting('verified') || null,paused:this.#setting('paused') === '1',
      error:this.error,usageUrl:'https://chatgpt.com/settings/usage'};
  }
  async iniciarLogin({accountId = null} = {}) {
    if (this.pending) throw new ErroChatGPT('login_em_andamento');
    const attempt = {generation:this.generation};
    this.pending = attempt;
    try {
    const data = await this.#read();
    if(this.pending!==attempt||attempt.generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
    const saved = accountId ? data.accounts.find(a=>a.client_id===accountId) : null;
    if (accountId && !saved) throw new ErroChatGPT('conta_invalida');
    let host = this.#setting('host');
    if (!host) { host = 'urn:uuid:'+randomUUID(); this.#setting('host',host); }
    Object.assign(attempt,{state:random(),nonce:random(),verifier:random(),clientId:saved?.client_id ?? null,
      subject:saved?.subject,expires:this.agora()+300000});
    const server = createServer((req,res)=>{void this.#callback(attempt,req,res);});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    attempt.server = server;
    if(this.pending!==attempt||attempt.generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
    attempt.redirect = `http://127.0.0.1:${server.address().port}/auth/callback`;
    attempt.timer = setTimeout(()=>this.#cancelLogin(attempt),300000); attempt.timer.unref();
    this.pending = attempt;
    const url = new URL(AUTH+'/api/accounts/authorize');
    const params = {client_id:attempt.clientId || 'dynamic_agent_client',ext_agent_host_id:host,
      response_type:'code',redirect_uri:attempt.redirect,scope:SCOPES,resource:API,
      state:attempt.state,nonce:attempt.nonce,code_challenge_method:'S256',
      code_challenge:createHash('sha256').update(attempt.verifier).digest('base64url')};
    if (!saved) params.agent_name_hint = 'Lume';
    // No retained ID token goes through the renderer, URL logs, or browser storage.
    for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
    return {url:url.href,expiresAt:new Date(attempt.expires).toISOString()};
    } catch(error) {this.#cancelLogin(attempt);throw error;}
  }
  #cancelLogin(attempt) {
    if (!attempt) return;
    clearTimeout(attempt.timer); attempt.server?.close();
    if (this.pending === attempt) this.pending = null;
  }
  async #callback(attempt,req,res) {
    res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    const reply = (status,text)=>{res.statusCode=status;res.end(text);};
    try {
      const url = new URL(req.url,attempt.redirect);
      if (req.method !== 'GET' || req.headers.host !== new URL(attempt.redirect).host || url.pathname !== '/auth/callback' ||
        this.pending !== attempt || attempt.used || this.agora() > attempt.expires ||
        url.searchParams.getAll('state').length !== 1 || !same(url.searchParams.get('state'),attempt.state)) return reply(400,'Tentativa de login inválida. Volte ao Lume.');
      attempt.used = true;
      if (url.searchParams.has('error')) throw new ErroChatGPT('consentimento_recusado');
      const clientId = url.searchParams.get('client_id') || attempt.clientId;
      const code = url.searchParams.get('code');
      if (!CLIENT.test(clientId ?? '') || attempt.clientId && clientId !== attempt.clientId || !code || code.length > 4096 ||
        url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('client_id').length > 1) throw new ErroChatGPT('registro_invalido');
      const tokens = await this.#tokens({grant_type:'authorization_code',client_id:clientId,code,
        code_verifier:attempt.verifier,redirect_uri:attempt.redirect,resource:API});
      const identity = await this.#identity(tokens.id_token,{clientId,nonce:attempt.nonce,subject:attempt.subject});
      const data = await this.#read();
      const previous = data.accounts.find(a=>a.client_id===clientId);
      if (previous && previous.subject !== identity.subject) throw new ErroChatGPT('identidade_invalida');
      const account = {...identity,client_id:clientId,id_token:tokens.id_token,access_token:tokens.access_token,
        refresh_token:typeof tokens.refresh_token === 'string'?tokens.refresh_token:null,
        scopes:typeof tokens.scope === 'string'?tokens.scope.split(/\s+/):[],expires_at:this.agora()+tokens.expires_in*1000};
      data.accounts = data.accounts.filter(a=>a.client_id!==clientId).concat(account); data.active = clientId;
      await this.#write(data,attempt.generation); this.catalog = []; this.error = null;
      this.#setting('verified',''); this.#setting('paused','0'); this.#setting('model','');
      reply(200,'Login concluído no Lume. Você pode fechar esta página e voltar ao aplicativo.');
    } catch (error) {
      this.error = {code:error.code || 'login_invalido'};
      reply(400,'O login não foi concluído. Volte ao Lume para conferir ou tentar novamente.');
    } finally { if (attempt.used) this.#cancelLogin(attempt); }
  }
  async #access() {
    const generation=this.generation;
    const data = await this.#read(), account = data.accounts.find(a=>a.client_id===data.active);
    if(generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
    if (!account?.access_token) throw new ErroChatGPT('login_necessario');
    if (!account.scopes?.includes('chatgpt.tokens.use.direct')) throw new ErroChatGPT('permissao_plano_ausente');
    if (account.expires_at > this.agora()+60000) return account.access_token;
    if (!this.refreshing) this.refreshing = this.#refresh(data,account,generation).finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
  async #refresh(data,account,generation) {
    if (!account.refresh_token) throw new ErroChatGPT('login_necessario');
    try {
      const tokens = await this.#tokens({grant_type:'refresh_token',client_id:account.client_id,refresh_token:account.refresh_token,resource:API});
      if (tokens.id_token) await this.#identity(tokens.id_token,{clientId:account.client_id,subject:account.subject});
      Object.assign(account,{access_token:tokens.access_token,expires_at:this.agora()+tokens.expires_in*1000,
        refresh_token:tokens.refresh_token || account.refresh_token,id_token:tokens.id_token || account.id_token,
        scopes:typeof tokens.scope==='string'?tokens.scope.split(/\s+/):account.scopes});
      await this.#write(data,generation);
      if (!account.scopes.includes('chatgpt.tokens.use.direct')) throw new ErroChatGPT('permissao_plano_ausente');
      return account.access_token;
    } catch (error) {
      if (TERMINAL_REFRESH.has(error.code)) { delete account.access_token; delete account.refresh_token; delete account.id_token; await this.#write(data,generation); }
      throw error;
    }
  }
  async modelos() {
    const generation=this.generation;
    const token = await this.#access();
    if(generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
    const response = await this.#request(API+'/models',{headers:{Authorization:'Bearer '+token}});
    // Catalog entries may include substantial provider metadata. Retain only
    // public selector fields below, with a bounded body even for streamed JSON.
    const data = await jsonLimit(response,2*1024*1024);
    if(generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
    if (!response.ok) throw new ErroChatGPT(data?.error?.code || 'modelos_indisponiveis',{status:response.status,requestId:response.headers?.get('x-request-id')});
    if (!Array.isArray(data.models)) throw new ErroChatGPT('catalogo_invalido');
    this.catalog = data.models.filter(m=>m.visibility==='list' && typeof m.slug==='string' && /^[\w.-]{1,100}$/.test(m.slug))
      .slice(0,100).map(m=>({id:m.slug,name:String(m.display_name||m.slug).slice(0,150)}));
    return this.catalog;
  }
  async selecionarModelo(model) {
    const generation=this.generation;
    const catalog = await this.modelos();
    if(generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
    if (!catalog.some(m=>m.id===model)) throw new ErroChatGPT('modelo_indisponivel');
    this.#setting('model',model); this.#setting('verified',''); return this.estado();
  }
  async selecionarConta(id) {
    this.encerrar();
    const generation=this.generation;
    const data = await this.#read();
    if(generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
    if (!data.accounts.some(a=>a.client_id===id)) throw new ErroChatGPT('conta_invalida');
    data.active = id; await this.#write(data,generation); this.catalog=[];
    this.#setting('model','');this.#setting('verified','');this.#setting('paused','0');return this.estado();
  }
  async sair() {
    this.encerrar();
    const generation=this.generation;
    const data = await this.#read(), account = data.accounts.find(a=>a.client_id===data.active);
    if(generation!==this.generation)throw new ErroChatGPT('operacao_cancelada');
    let revoked = !account?.refresh_token;
    if (account?.refresh_token) {
      try {
        const discovery = await jsonLimit(await this.#request(AUTH+'/.well-known/openid-configuration'));
        if (discovery.issuer !== AUTH || discovery.revocation_endpoint !== AUTH+'/api/accounts/oauth/revoke') throw Error();
        const response = await this.#request(discovery.revocation_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({token:account.refresh_token,token_type_hint:'refresh_token',client_id:account.client_id}).toString()});
        revoked = response.status===200;
        await response.body?.cancel();
      } catch { revoked=false; }
    }
    if (account) { delete account.access_token;delete account.refresh_token;delete account.id_token; }
    await this.#write(data,generation);this.catalog=[];this.#setting('verified','');
    return {...await this.estado(),remoteRevocationConfirmed:revoked};
  }
  retomar() { this.#setting('paused','0'); this.error=null; }
  async responder({instructions, input, signal, validar = null} = {}) {
    if (this.#setting('paused')==='1') throw new ErroChatGPT('subscription_sharing_usage_limit_exceeded');
    const model = this.#setting('model');
    if (!model) throw new ErroChatGPT('modelo_nao_selecionado');
    if (typeof instructions!=='string' || instructions.length>32000 || !Array.isArray(input) || JSON.stringify(input).length>150000) throw new ErroChatGPT('contexto_invalido');
    const generation=this.generation,controller=new AbortController();this.controllers.add(controller);
    const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(120000),...(signal?[signal]:[])]);
    try {
      const token=await this.#access();
      combined.throwIfAborted();
      if(generation!==this.generation||validar&&validar()!==true)throw new ErroChatGPT('contexto_revogado');
      const response=await this.#request(API+'/responses',{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify({model,instructions,input,store:false,stream:true}),signal:combined,timeoutMs:120000});
      const requestId=response.headers?.get('x-request-id');
      if (!response.ok) { const data=await jsonLimit(response); throw new ErroChatGPT(data?.error?.code || 'http_'+response.status,{status:response.status,requestId}); }
      const decoder=new TextDecoder();let pending='',text='',completed=false,size=0,responseId=null;
      const event=block=>{
        const lines=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart());
        if (!lines.length) return;
        const raw=lines.join('\n');if(raw==='[DONE]')return;
        let e;try{e=JSON.parse(raw);}catch{throw new ErroChatGPT('stream_invalido');}
        if(e.type==='response.output_text.delta' && typeof e.delta==='string')text+=e.delta;
        if(e.type==='error'||e.type==='response.failed')throw new ErroChatGPT(e.response?.error?.code||e.error?.code||e.code||'resposta_falhou',{requestId});
        if(e.type==='response.incomplete')throw new ErroChatGPT('resposta_incompleta',{requestId});
        if(e.type==='response.completed') {
          if(e.response?.status && e.response.status!=='completed')throw new ErroChatGPT('resposta_incompleta');
          completed=true;
          if(typeof e.response?.id==='string'&&/^[\w-]{1,180}$/.test(e.response.id))responseId=e.response.id;
          const output=e.response?.output?.flatMap(i=>i.content??[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');
          if(typeof output==='string'&&output)text=output;
        }
      };
      if (!response.body) throw new ErroChatGPT('stream_ausente');
      for await (const chunk of response.body) {
        combined.throwIfAborted();size+=chunk.byteLength;if(size>2097152)throw new ErroChatGPT('resposta_excessiva');
        pending+=decoder.decode(chunk,{stream:true});
        let match;while((match=/\r?\n\r?\n/.exec(pending))){event(pending.slice(0,match.index));pending=pending.slice(match.index+match[0].length);}
      }
      pending+=decoder.decode();if(pending.trim())event(pending);
      if (!completed || !text.trim() || generation!==this.generation) throw new ErroChatGPT('stream_interrompido');
      this.error=null;this.#setting('verified',new Date(this.agora()).toISOString());
      return {text,model,completed:true,requestId,responseId};
    } catch(error) {
      const safe=error instanceof ErroChatGPT?error:new ErroChatGPT('stream_interrompido');
      this.error={code:safe.code,status:safe.status,requestId:safe.requestId};
      if(safe.code==='subscription_sharing_usage_limit_exceeded')this.#setting('paused','1');
      throw safe;
    } finally {this.controllers.delete(controller);}
  }
  encerrar() {this.generation++;this.#cancelLogin(this.pending);for(const c of this.controllers)c.abort();this.controllers.clear();}
}
