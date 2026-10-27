import {importarArquivo} from './importacao.js';
import {UUID} from './contrato.js';

const PREFIX='/api/v3/notetaker';
const erros={ENTRADA:400,FORMATO:400,DIREITO:403,FECHADO:403,AUSENTE:404,CONFLITO:409,CANCELADO:409,LIMITE:413,MOTOR:503,INTEGRIDADE:503};
const falha=(json,e)=>json(erros[e?.code]||503,{erro:erros[e?.code]?e.message:'Operação local indisponível.',codigo:e?.code||'INDISPONIVEL'});
const corpoJson=async(req,max=4096)=>{let size=0,text='';for await(const b of req){size+=b.length;if(size>max)throw Object.assign(new Error('Corpo grande demais.'),{code:'LIMITE'});text+=b;}try{return JSON.parse(text||'{}');}catch{throw Object.assign(new Error('JSON inválido.'),{code:'ENTRADA'});}};
async function corpoCorrecao(req){
  let size=0;const partes=[];
  for await(const b of req){size+=b.length;if(size>65536)throw Object.assign(new Error('Corpo grande demais.'),{code:'LIMITE'});partes.push(b);}
  let texto;
  try{texto=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(partes));}
  catch{throw Object.assign(new Error('UTF-8 inválido.'),{code:'ENTRADA'});}
  try{return JSON.parse(texto);}
  catch{throw Object.assign(new Error('JSON inválido.'),{code:'ENTRADA'});}
}
function paginaCorrecoes(search){
  const params=new URLSearchParams(search),opcoes={};
  const vistos=new Set();
  for(const [k,v] of params){
    if(vistos.has(k)||!['antes','limite'].includes(k)||!v||!/^[0-9]+$/.test(v))throw Object.assign(new Error('Consulta inválida.'),{code:'ENTRADA'});
    vistos.add(k);const n=Number(v);
    if(!Number.isSafeInteger(n)||n<1||k==='limite'&&n>20)throw Object.assign(new Error('Consulta inválida.'),{code:'ENTRADA'});
    opcoes[k]=n;
  }
  return opcoes;
}

export async function registrarRotasNotetaker(req,res,url,{servico,json,signal}={}){
  if(!url.pathname.startsWith(PREFIX+'/'))return false;
  if(!servico){json(404,{erro:'Notetaker indisponível neste perfil.'});return true;}
  const caminho=url.pathname.slice(PREFIX.length);
  const cancelado=()=>Object.assign(new Error('Operação cancelada.'),{code:'CANCELADO'});
  // Sem Error no destroy: GET de áudio não instala listener de erro em req.
  const abortar=()=>req.destroy?.();
  signal?.addEventListener('abort',abortar,{once:true});
  try{
    if(signal?.aborted)throw cancelado();
    const trechos=caminho.match(/^\/trechos\/([^/]+)(\/correcoes)?$/);
    const historico=req.method==='GET'&&trechos?.[2]==='/correcoes';
    if(url.search&&!historico){json(400,{erro:'Consulta não permitida.'});return true;}
    if(trechos){
      if(!UUID.test(trechos[1]))throw Object.assign(new Error('Trecho inválido.'),{code:'ENTRADA'});
      if(historico){json(200,servico.historicoCorrecoes(trechos[1],paginaCorrecoes(url.search)));return true;}
      if(req.method==='GET'&&!trechos[2]){json(200,servico.trecho(trechos[1]));return true;}
      if(req.method==='PATCH'&&!trechos[2]){
        if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))return json(415,{erro:'Envie JSON UTF-8.'}),true;
        const correcao=await corpoCorrecao(req);
        if(signal?.aborted)throw cancelado();
        json(200,servico.corrigirTrecho(trechos[1],correcao));return true;
      }
    }
    if(req.method==='POST'&&caminho==='/sessoes'){
      if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{erro:'Envie JSON.'}),true;
      const entrada=await corpoJson(req);
      if(signal?.aborted)throw cancelado();
      json(201,servico.criarSessao(entrada));return true;
    }
    const consentir=caminho.match(/^\/sessoes\/([^/]+)\/consentir$/);
    if(req.method==='POST'&&consentir){if(!UUID.test(consentir[1]))throw Object.assign(new Error('ID inválido.'),{code:'ENTRADA'});const entrada=await corpoJson(req);if(signal?.aborted)throw cancelado();json(200,servico.consentir(consentir[1],entrada));return true;}
    const importar=caminho.match(/^\/sessoes\/([^/]+)\/importar$/);
    if(req.method==='POST'&&importar){
      if(!UUID.test(importar[1]))throw Object.assign(new Error('ID inválido.'),{code:'ENTRADA'});
      if(req.headers['content-type']!=='audio/wav')return json(415,{erro:'Envie audio/wav.'}),true;
      req.setTimeout(0);
      const resultado=await importarArquivo(req,{servico,sessaoId:importar[1],signal});
      if(signal?.aborted)throw cancelado();
      const asr=await servico.transcreverImportacao(importar[1]);
      if(signal?.aborted)throw cancelado();
      json(200,{...resultado,asr});return true;
    }
    const partes=caminho.match(/^\/sessoes\/([^/]+)\/partes$/);
    if(req.method==='POST'&&partes){
      if(!UUID.test(partes[1])||req.headers['content-type']!=='audio/wav')throw Object.assign(new Error('Parte WAV inválida.'),{code:'ENTRADA'});
      const entrada=req.headers['x-lume-entrada'];
      if(!['mic','sistema'].includes(entrada))throw Object.assign(new Error('Use /importar para arquivos.'),{code:'DIREITO'});
      // A captura e o gesto nativo são responsabilidade da 11-02.
      throw Object.assign(new Error('Captura ainda indisponível neste tracer.'),{code:'FECHADO'});
    }
    const sessao=caminho.match(/^\/sessoes\/([^/]+)$/);
    if(req.method==='GET'&&sessao){json(200,servico.estado(sessao[1]));return true;}
    const fonte=caminho.match(/^\/fontes\/([1-9]\d*)$/);
    if(req.method==='GET'&&fonte){json(200,servico.fonte(Number(fonte[1])));return true;}
    const audio=caminho.match(/^\/partes\/([^/]+)\/audio$/);
    if(req.method==='GET'&&audio){
      const bytes=await servico.audio(audio[1]),range=req.headers.range;
      if(signal?.aborted)throw cancelado();
      let ini=0,fim=bytes.length-1,status=200;
      if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m)throw Object.assign(new Error('Range inválido.'),{code:'ENTRADA'});ini=Number(m[1]);fim=m[2]?Number(m[2]):fim;if(!Number.isSafeInteger(ini)||!Number.isSafeInteger(fim)||ini>fim||fim>=bytes.length){res.writeHead(416,{'Content-Range':`bytes */${bytes.length}`});res.end();return true;}status=206;res.setHeader('Content-Range',`bytes ${ini}-${fim}/${bytes.length}`);}
      res.writeHead(status,{'Content-Type':'audio/wav','Content-Length':fim-ini+1,'Accept-Ranges':'bytes','Cache-Control':'no-store'});res.end(bytes.subarray(ini,fim+1));return true;
    }
    json(404,{erro:'Rota não encontrada.'});return true;
  }catch(e){if(!(signal?.aborted&&req.destroyed))falha(json,e);return true;}
  finally{signal?.removeEventListener('abort',abortar);}
}
