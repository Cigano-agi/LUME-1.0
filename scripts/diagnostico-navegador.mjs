#!/usr/bin/env node
// Ensaio privado: snapshot SQLite consistente, API somente de leitura e sem transporte.
import { DatabaseSync, backup } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import { LEITURA_SQL } from '../src/leitura-sql.js';
import { diagnosticarCaptura } from '../src/diagnostico-captura.js';

const source = resolve(process.argv[2] || join(process.env.APPDATA || '', 'AssessorDesktop', 'data', 'assessor.db'));
const origin = new DatabaseSync(source, { readOnly: true });
const folder = mkdtempSync(join(tmpdir(), 'lume-diagnostico-'));
const copy = join(folder, 'snapshot.sqlite');
await backup(origin, copy);
origin.close();
const db = new DatabaseSync(copy, { readOnly: true });
if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Cópia SQLite inválida');
const appCopy = join(folder, 'app.sqlite');
await backup(db, appCopy);
const appDb = abrirBanco(appCopy);
const offline = { estado:()=>({estado:'pausado'}), historico:{estado:()=>({estado:'indisponivel'})} };
const offlineSecrets = {estado:async()=>({configurada:false}),ler:async()=>null};
const appServer = criarServidor(appDb,{desktop:true,readOnly:true,conexao:offline,segredos:offlineSecrets,segredosJev:offlineSecrets});
await new Promise((resolve,reject)=>{appServer.once('error',reject);appServer.listen(0,'127.0.0.1',resolve)});
const appUrl = `http://127.0.0.1:${appServer.address().port}/app`;
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
const captura = diagnosticarCaptura(db);
const hoje = captura.hoje;
const count = table => tables.has(table) ? db.prepare(`SELECT count(*) total FROM ${table}`).get().total : null;
const stats = {
  capturedAt: new Date().toISOString(), source: 'snapshot local isolado', events: count('eventos'),
  today: db.prepare('SELECT count(*) total FROM eventos WHERE dia_local=?').get(hoje).total,
  day: hoje,
  lastEvent: db.prepare('SELECT max(recebido_em) ultimo FROM eventos').get().ultimo,
  taskSuggestions: count('desktop_tarefas_sugestoes'), deals: count('desktop_negocios'),
  actions: count('lume_acoes'), commercialProjects: count('lume_projetos_comerciais'),
  crm: count('itens_crm'),
  legacyAnalysisActive: tables.has('desktop_tarefas_config') ? db.prepare('SELECT ativa FROM desktop_tarefas_config LIMIT 1').get()?.ativa ?? null : null
};
const readable = db.prepare(`SELECT count(*) total FROM eventos e WHERE e.conversa_id=? AND ${LEITURA_SQL}`);
const readableToday = db.prepare(`SELECT count(*) total FROM eventos e WHERE e.conversa_id=? AND e.dia_local=? AND ${LEITURA_SQL}`);
const cases = db.prepare(`SELECT c.id,c.nome,COUNT(e.id) eventos,
  SUM(CASE WHEN e.dia_local=? THEN 1 ELSE 0 END) hoje
  FROM conversas_app c LEFT JOIN eventos e ON e.conversa_id=c.id
  WHERE lower(c.nome) LIKE '%ozare%' OR lower(c.nome) LIKE '%luminus%' OR lower(c.nome) LIKE '%waves%'
  GROUP BY c.id,c.nome ORDER BY hoje DESC,c.nome`).all(hoje).map(item=>({...item,visiveis:readable.get(item.id).total,visiveisHoje:readableToday.get(item.id,hoje).total}));
const crm = tables.has('itens_crm') ? db.prepare(`SELECT i.id,i.conversa_id,i.origem_id,i.tipo,i.resumo,i.estado,
  e.id evento_id,c.nome conversa_nome FROM itens_crm i
  LEFT JOIN eventos e ON e.conversa_id=i.conversa_id AND e.origem_id=i.origem_id AND ${LEITURA_SQL}
  LEFT JOIN conversas_app c ON c.id=i.conversa_id WHERE e.id IS NOT NULL ORDER BY i.id`).all() : [];
const findSource = db.prepare(`SELECT e.id FROM eventos e WHERE e.conversa_id=? AND e.texto LIKE ? AND ${LEITURA_SQL} ORDER BY e.id DESC LIMIT 1`);
const named = term => cases.find(item=>item.nome.includes(term))?.id;
const traces = [
  { title:'OZARE · VSLs de 15 e 45 minutos', kind:'Pedido explícito no grupo', state:'Fonte presente; sem sugestão de tarefa. A mensagem cita outro participante. Responsável e prazo de entrega ainda precisam ser confirmados.', conversation:named('OZARE'), phrase:'%preciso urgentemente das VLS%' },
  { title:'OZARE · interesse para janeiro', kind:'Sinal comercial', state:'Há interesse mencionado para janeiro, mas não há negócio criado nem acordo de compra confirmado.', conversation:named('OZARE'), phrase:'%entrarem em janeiro%' },
  { title:'LUMINUS · responsabilidade pela copy', kind:'Demanda ambígua', state:'A pergunta sobre quem faria a copy está no texto; áudios relacionados não têm transcrição. Não atribuir tarefa sem revisão.', conversation:named('LUMINUS'), phrase:'%copy entrava%' }
].map(({phrase,...item})=>({...item,sourceId:item.conversation?findSource.get(item.conversation,phrase)?.id:null})).filter(item=>item.sourceId);
const eventQuery = db.prepare(`SELECT e.id,e.conversa_id,e.origem_id,e.recebido_em,e.dia_local,e.autor_id,
  e.direcao,e.tipo,e.texto,e.permissao FROM eventos e WHERE e.conversa_id=? AND ${LEITURA_SQL}
  ORDER BY e.id DESC LIMIT 120`);
const oneEvent = db.prepare(`SELECT e.id,e.conversa_id,e.origem_id,e.recebido_em,e.autor_id,
  e.direcao,e.tipo,e.texto,e.permissao,c.nome conversa_nome FROM eventos e
  LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE e.id=? AND ${LEITURA_SQL}`);
const html = readFileSync(fileURLToPath(new URL('../tools/diagnostico-navegador.html', import.meta.url)));
const js = readFileSync(fileURLToPath(new URL('../tools/diagnostico-navegador.js', import.meta.url)));
const blueprint = readFileSync(fileURLToPath(new URL('../work/blueprint-hoje-2026-09-28.html', import.meta.url)));
const blueprintText = readFileSync(fileURLToPath(new URL('../work/blueprint-hoje-2026-09-28.txt', import.meta.url)));
function respond(res, status, type, body) {
  res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
  res.end(body);
}
const server = createServer((req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${server.address().port}`) return respond(res,403,'text/plain','Acesso recusado');
  if (url.pathname === '/') return respond(res,200,'text/html; charset=utf-8',html);
  if (url.pathname === '/diagnostico.js') return respond(res,200,'text/javascript; charset=utf-8',js);
  if (url.pathname === '/blueprint') return respond(res,200,'text/html; charset=utf-8',blueprint);
  if (url.pathname === '/blueprint.txt') return respond(res,200,'text/plain; charset=utf-8',blueprintText);
  if (url.pathname === '/app-original') {res.writeHead(302,{Location:appUrl,'Cache-Control':'no-store'});return res.end();}
  if (url.pathname === '/api/overview') return respond(res,200,'application/json; charset=utf-8',JSON.stringify({stats,cases,crm,traces,appUrl}));
  if (url.pathname === '/api/capture') return respond(res,200,'application/json; charset=utf-8',JSON.stringify(captura));
  if (url.pathname === '/api/events') {
    const id = url.searchParams.get('conversation');
    if (!cases.some(item => item.id === id)) return respond(res,404,'text/plain','Conversa não encontrada');
    return respond(res,200,'application/json; charset=utf-8',JSON.stringify(eventQuery.all(id).reverse()));
  }
  if (url.pathname === '/api/source') {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isSafeInteger(id) || id < 1) return respond(res,400,'text/plain','Fonte inválida');
    const row = oneEvent.get(id);
    return row && (cases.some(item=>item.id===row.conversa_id)||crm.some(item=>item.evento_id===id)||traces.some(item=>item.sourceId===id))
      ? respond(res,200,'application/json; charset=utf-8',JSON.stringify(row)) : respond(res,404,'text/plain','Fonte não encontrada');
  }
  return respond(res,404,'text/plain','Página não encontrada');
});
server.listen(0,'127.0.0.1', () => console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/`,appUrl,snapshot:folder,stats})));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(async () => {
  await appServer.encerrar();
  appDb.close();db.close();
  if (resolve(folder).startsWith(resolve(tmpdir()) + sep)) rmSync(folder,{recursive:true,force:true});
  process.exit(0);
}));
