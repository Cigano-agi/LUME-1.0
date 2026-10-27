import {registrarPessoa} from './pessoas.js';
import {metadadosExcluidos,eventoExcluido} from './exclusoes.js';
import {performance} from 'node:perf_hooks';

// Cache statements, never results: names, aliases and exclusions remain live reads.
// The small adapter also reuses prepares made by the existing identity/privacy
// helpers, without duplicating or changing their rules. Weak keys isolate dbs.
const consultasPorBanco=new WeakMap();
const resolvedoresPorBanco=new WeakMap();
function consultas(db){
  let banco=consultasPorBanco.get(db);
  if(!banco){
    const statements=new Map();
    banco={prepare(sql){
      if(!statements.has(sql))statements.set(sql,db.prepare(sql));
      return statements.get(sql);
    },exec(sql){return db.exec(sql);}};
    consultasPorBanco.set(db,banco);consultasPorBanco.set(banco,banco);
  }
  return banco;
}

function emLote(db,executar){
  db.exec('SAVEPOINT nomes_whatsapp');
  try{const resultado=executar();db.exec('RELEASE nomes_whatsapp');return resultado;}
  catch(error){db.exec('ROLLBACK TO nomes_whatsapp; RELEASE nomes_whatsapp');throw error;}
}

// A name is presentation only; it never grants permission or changes a routing ID.
const IDENTIFICADOR_CRU = /^(?:\d{6,}(?:-\d+)?|[^\s@]+@(?:lid|s\.whatsapp\.net|c\.us|g\.us|newsletter))$/i;
const SEM_NOME=/^(?:contato sem nome|grupo sem nome|canal sem nome|nome não disponível)$/i;
const jid=id=>typeof id==='string'?id.trim().replace(/^([^@:]+):\d+@/,'$1@'):'';
const direta=id=>/^[^@\s]+@(?:lid|s\.whatsapp\.net|c\.us)$/.test(id);
export function nomeWhatsappValido(nome,id='') {
  return typeof nome==='string'&&Boolean(nome.trim())&&nome.trim()!==id&&
    /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(nome)&&
    !IDENTIFICADOR_CRU.test(nome.trim())&&!SEM_NOME.test(nome.trim())&&
    !/^\+?[\d\s().-]{6,}$/.test(nome.trim());
}

export function criarNomeVisivel(db) {
  db=consultas(db);
  if(resolvedoresPorBanco.has(db))return resolvedoresPorBanco.get(db);
  const pessoaPorId=db.prepare(`WITH RECURSIVE cadeia(id,nome_exibicao,nome_cru,fundida_em) AS (
    SELECT p.id,p.nome_exibicao,p.nome_cru,p.fundida_em FROM pessoa_identificadores pi
    JOIN pessoas p ON p.id=pi.pessoa_id WHERE pi.identificador=? AND pi.ativo=1
    UNION SELECT p.id,p.nome_exibicao,p.nome_cru,p.fundida_em FROM pessoas p JOIN cadeia c ON p.id=c.fundida_em
  ) SELECT nome_exibicao,nome_cru FROM cadeia WHERE fundida_em IS NULL LIMIT 1`);
  const conversaPorId=db.prepare('SELECT nome FROM conversas_app WHERE id=?');
  const grupoPorId=db.prepare('SELECT nome FROM grupos_app WHERE id=?');
  // Prepared indexed reads avoid the old negative cache surviving a name update.
  const resolver=(nome,id)=>{
    const excluido=id?metadadosExcluidos(db,id):false;
    const pessoa=excluido?null:pessoaPorId.get(id??'');
    const candidatos=excluido?[]:id?.endsWith('@g.us')
      ?[grupoPorId.get(id)?.nome,conversaPorId.get(id)?.nome,nome]
      :[pessoa?.nome_exibicao,pessoa?.nome_cru,conversaPorId.get(id??'')?.nome,nome];
    const conhecido=candidatos.find(n=>nomeWhatsappValido(n,id));
    if(conhecido)return conhecido.trim();
    if(id?.endsWith('@g.us'))return 'Grupo sem nome';
    if(id?.endsWith('@newsletter'))return 'Canal sem nome';
    return 'Contato sem nome';
  };
  resolvedoresPorBanco.set(db,resolver);
  return resolver;
}

// Only explicit protocol pairs may add an alias to an existing person. Existing
// identities (including inactive/manual links) are never moved or silently merged.
function vincularAlias(db,lid,pn,quando) {
  if(!/^\d+@lid$/.test(lid)||!/^\d+@s\.whatsapp\.net$/.test(pn))return false;
  const buscar=db.prepare('SELECT pessoa_id,ativo,origem FROM pessoa_identificadores WHERE identificador=?');
  const a=buscar.get(lid),b=buscar.get(pn);
  if(a&&b)return a.ativo===1&&b.ativo===1&&a.pessoa_id===b.pessoa_id;
  const conhecido=a??b;if(!conhecido||conhecido.ativo!==1)return false;
  const conflitante=db.prepare(`SELECT 1 FROM pessoa_identificadores WHERE pessoa_id=? AND ativo=1
    AND ((identificador LIKE '%@lid' AND identificador<>?) OR
      (identificador LIKE '%@s.whatsapp.net' AND identificador<>?)) LIMIT 1`).get(conhecido.pessoa_id,lid,pn);
  if(conflitante)return false;
  // Keep the name's provenance/priority. Evidence for the pair does not promote
  // a pushName into a saved address-book name.
  db.prepare('INSERT INTO pessoa_identificadores(identificador,pessoa_id,origem,visto_em) VALUES(?,?,?,?)')
    .run(a?pn:lid,conhecido.pessoa_id,conhecido.origem,quando);
  return true;
}

export function salvarNomesWhatsapp(db,lote={}, {quando=new Date().toISOString()}={}) {
  db=consultas(db);
  return emLote(db,()=>persistirNomesWhatsapp(db,lote,quando));
}

function persistirNomesWhatsapp(db,lote,quando) {
  const contatos=[],pares=[],grupos=[];
  for(const c of Array.isArray(lote.contacts)?lote.contacts:[]) {
    const id=jid(c?.id);if(!id)continue;
    if(id.endsWith('@g.us')){grupos.push({id,nome:c.name});continue;}
    if(!direta(id))continue;
    const nome=[c.name,c.notify,c.verifiedName].find(n=>nomeWhatsappValido(n,id));
    contatos.push({id,nome,origem:nome===c.name?'usync':'pushName'});
    const lid=jid(c.lid)||(id.endsWith('@lid')?id:''),pn=jid(c.phoneNumber)||(id.endsWith('@s.whatsapp.net')?id:'');
    if(lid&&pn&&(id===lid||id===pn))pares.push({lid,pn});
  }
  for(const c of Array.isArray(lote.chats)?lote.chats:[]) {
    const id=jid(c?.id),nome=[c?.name,c?.displayName].find(n=>nomeWhatsappValido(n,id));
    if(id.endsWith('@g.us'))grupos.push({id,nome});
    else if(direta(id)){contatos.push({id,nome,origem:'usync'});
      const lid=jid(c.lidJid)||jid(c.accountLid)||(id.endsWith('@lid')?id:''),pn=jid(c.pnJid)||(id.endsWith('@s.whatsapp.net')?id:'');
      if(lid&&pn&&(id===lid||id===pn))pares.push({lid,pn});
    }
  }
  for(const m of Array.isArray(lote.messages)?lote.messages:[]) {
    const k=m?.key;if(!k||k.fromMe||!k.remoteJid)continue;
    const grupo=k.remoteJid.endsWith('@g.us'),id=jid(grupo?(k.participant??k.participantLid):k.remoteJid);
    if(!direta(id)||metadadosExcluidos(db,k.remoteJid)||typeof k.id==='string'&&eventoExcluido(db,k.remoteJid,k.id))continue;
    contatos.push({id,nome:m.pushName,origem:'pushName'});
    const alt=jid(grupo?k.participantAlt:k.remoteJidAlt);
    if(id.endsWith('@lid')&&alt.endsWith('@s.whatsapp.net'))pares.push({lid:id,pn:alt});
    if(alt.endsWith('@lid')&&id.endsWith('@s.whatsapp.net'))pares.push({lid:alt,pn:id});
  }
  for(const p of Array.isArray(lote.lidPnMappings)?lote.lidPnMappings:[])pares.push({lid:jid(p?.lid),pn:jid(p?.pn)});
  let nomes=0,aliases=0,conflitos=0;
  const existente=db.prepare(`SELECT p.nome_cru,p.fundida_em,pi.ativo,pi.origem,pi.visto_em,
    (SELECT MAX(CASE i.origem WHEN 'manual' THEN 4 WHEN 'usync' THEN 3 WHEN 'grupo' THEN 2 ELSE 1 END)
      FROM pessoa_identificadores i WHERE i.pessoa_id=p.id) peso
    FROM pessoa_identificadores pi JOIN pessoas p ON p.id=pi.pessoa_id WHERE pi.identificador=?`);
  const nomesIds=new Set();
  for(const c of contatos){
    if(metadadosExcluidos(db,c.id)||!nomeWhatsappValido(c.nome,c.id))continue;
    const anterior=existente.get(c.id);if(anterior?.ativo===0)continue;
    // Historical backfill only fills a hole. It cannot roll a current name back.
    if(lote.somenteAusentes&&nomeWhatsappValido(anterior?.nome_cru,c.id))continue;
    if(anterior?.fundida_em!=null||anterior?.peso>(c.origem==='usync'?3:1)){
      nomesIds.add(c.id);continue;
    }
    // An identical observation changes neither identity nor its last-seen time.
    // Different timestamps still go through the existing identity helper.
    if(anterior?.nome_cru!==c.nome.trim()||anterior?.visto_em!==quando||anterior?.origem!==c.origem)
      registrarPessoa(db,{identificador:c.id,nomeCru:c.nome.trim(),origem:c.origem,quando});
    nomesIds.add(c.id);nomes++;
  }
  for(const p of pares){
    if(metadadosExcluidos(db,p.lid)||metadadosExcluidos(db,p.pn))continue;
    if(vincularAlias(db,p.lid,p.pn,quando)){aliases++;nomesIds.add(p.lid);nomesIds.add(p.pn);}
    else conflitos++;
  }
  const visivel=criarNomeVisivel(db);
  const salvar=db.prepare(`INSERT INTO conversas_app(id,nome) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET nome=excluded.nome
    WHERE conversas_app.nome IS NOT excluded.nome`);
  const aliasesConhecidos=db.prepare(`SELECT identificador FROM pessoa_identificadores WHERE ativo=1
    AND pessoa_id=(SELECT pessoa_id FROM pessoa_identificadores WHERE identificador=? AND ativo=1)`);
  for(const id of [...nomesIds])for(const p of aliasesConhecidos.all(id))if(direta(p.identificador))nomesIds.add(p.identificador);
  for(const id of nomesIds){const nome=visivel(null,id);if(nomeWhatsappValido(nome,id)&&!metadadosExcluidos(db,id))salvar.run(id,nome);}
  for(const g of grupos){
    if(metadadosExcluidos(db,g.id)||!nomeWhatsappValido(g.nome,g.id))continue;
    const anterior=visivel(null,g.id);if(lote.somenteAusentes&&nomeWhatsappValido(anterior,g.id))continue;
    salvar.run(g.id,g.nome.trim());
    db.prepare('UPDATE grupos_app SET nome=? WHERE id=? AND nome IS NOT ?').run(g.nome.trim(),g.id,g.nome.trim());nomes++;
  }
  return {nomes,aliases,conflitos};
}

// Call in bounded idle batches, retaining ultimoId at the integration layer. It
// reads the local captured payload only; no WhatsApp lookup or transport is used.
export function recuperarNomesWhatsapp(db,{aposId=0,limite=200,maxBytes=4*1024*1024,maxMs=20}={}) {
  if(!Number.isSafeInteger(aposId)||aposId<0||!Number.isSafeInteger(limite)||limite<1||limite>1000||
    !Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isFinite(maxMs)||maxMs<=0)throw new TypeError('Lote de nomes inválido');
  db=consultas(db);const inicio=performance.now();
  const resultado=emLote(db,()=>{
    const linhas=db.prepare('SELECT id,bruto,recebido_em FROM eventos WHERE id>? ORDER BY id LIMIT ?').iterate(aposId,limite);
    let nomes=0,aliases=0,conflitos=0,examinados=0,ultimoId=aposId,bytesLidos=0;
    try{
      while(examinados<limite){
        // Always finish at least one row, even an oversized one, so valid names
        // cannot be abandoned forever. Do not fetch/materialize the next payload
        // once a budget is spent; the returned cursor only covers examined rows.
        if(examinados&&(bytesLidos>=maxBytes||performance.now()-inicio>=maxMs))break;
        const proxima=linhas.next();if(proxima.done)break;
        const row=proxima.value;examinados++;ultimoId=row.id;bytesLidos+=Buffer.byteLength(row.bruto);
        let bruto;try{bruto=JSON.parse(row.bruto);}catch{continue;}
        if(!bruto?.mensagem?.key)continue;
        const r=persistirNomesWhatsapp(db,{messages:[bruto.mensagem],somenteAusentes:true},row.recebido_em);
        nomes+=r.nomes;aliases+=r.aliases;conflitos+=r.conflitos;
      }
    }finally{linhas.return?.();}
    const concluido=!db.prepare('SELECT 1 FROM eventos WHERE id>? LIMIT 1').get(ultimoId);
    return {examinados,ultimoId,concluido,nomes,aliases,conflitos,bytesLidos};
  });
  return {...resultado,duracaoMs:performance.now()-inicio};
}
