// DDL do aplicativo em banco vazio. Nenhuma função deste módulo recebe SQL do pacote.
import { abrirBanco } from './banco.js';
import { ContextoApp } from './contexto-app.js';
import { Desktop } from './desktop.js';
import { DesktopIA } from './desktop-ia.js';
import { Semantica } from './semantica.js';
import { ColetorCaixas } from './caixas.js';
import { prepararEsquemaInventario } from './inventario.js';
import { prepararEsquemaTranscricao } from './transcricao.js';
import { prepararMetadadosAudio } from './audio-desktop-arquivos.js';
import { prepararEsquemaFinanceiro } from './financeiro.js';
import { prepararEsquemaRascunho } from './rascunho.js';
import { prepararEsquemaPrecisao } from './precisao.js';
import { prepararWhatsAppLabels } from './whatsapp-labels.js';
import { prepararAcoesLume } from './acoes-lume.js';
import { prepararExecucoes } from './execucao/esquema.js';
import { prepararHistoricoWhatsApp } from './transporte/historico.js';
import { prepararVendasJev } from './vendas/servico.js';
import { prepararProjetosComerciais } from './projetos-comerciais/esquema.js';
import { prepararProcedenciaCiclo } from './privacidade.js';
import { FilaLaya } from './laya/fila.js';
import { prepararMidiasCiclo } from './ciclo-midia-worker.js';
import { CATALOGO_V9 } from './backup-acervo-catalogo.js';
import { DDL_V9 } from './backup-acervo-schema-manifest-v9.js';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { conferirObjetoStagingV9, registrarObjetoStagingV9, validarAreaStagingV9 } from './backup-staging-v9.js';

const q = s => `"${s.replaceAll('"', '""')}"`;
function fail(code, detail) { const e = new Error(detail); e.code = code; throw e; }

/** Cria todo o schema conhecido antes de importar qualquer linha. */
export function prepararEsquemaRestoreV9(caminhoDb, diretorioGerido) {
  // O esquema nunca migra nem reabre um banco oferecido pelo chamador.
  const fd = openSync(caminhoDb, 'wx', 0o600);
  closeSync(fd);
  return prepararNoBancoVazio(caminhoDb, diretorioGerido);
}

/** Reserva DB, WAL e SHM no diário antes de entregar o caminho ao SQLite. */
export async function prepararEsquemaRestoreV9Gerido(area,{v10=false}={}) {
  validarAreaStagingV9(area, area?.caminho);
  const nomes = ['acervo.sqlite', 'acervo.sqlite-wal', 'acervo.sqlite-shm'];
  for (const nome of nomes) {
    const handle = await registrarObjetoStagingV9(area, await area.criarArquivo(nome));
    await handle.close();
  }
  for (const nome of nomes) conferirObjetoStagingV9(area, path.join(area.caminho, nome));
  const db = prepararNoBancoVazio(path.join(area.caminho, nomes[0]), area.caminho);
  try {
    if(v10){prepararMidiasCiclo(db);auditarEsquemaRestoreV9(db,{v10:true});}
    for (const nome of nomes) conferirObjetoStagingV9(area, path.join(area.caminho, nome));
    return db;
  } catch (error) { try { db.close(); } catch {} throw error; }
}

function prepararNoBancoVazio(caminhoDb, diretorioGerido) {
  const db = abrirBanco(caminhoDb);
  try {
    new ContextoApp(db);
    new Desktop(db);
    new DesktopIA(db, { gerar: async () => { throw new Error('IA indisponível em staging'); } });
    new Semantica(db, { extrair: async () => [] });
    new ColetorCaixas(db, { diretorioBase: diretorioGerido });
    prepararEsquemaInventario(db);
    prepararEsquemaTranscricao(db);
    prepararMetadadosAudio(db);
    prepararEsquemaFinanceiro(db);
    prepararEsquemaRascunho(db);
    prepararEsquemaPrecisao(db);
    prepararWhatsAppLabels(db);
    prepararAcoesLume(db);
    // Este construtor executa backfill em perfis existentes: aqui o DB ainda está vazio.
    prepararExecucoes(db);
    prepararHistoricoWhatsApp(db);
    prepararVendasJev(db);
    prepararProjetosComerciais(db);
    prepararProcedenciaCiclo(db);
    new FilaLaya(db, { laya: { classificar: async () => ({}), status: () => ({}) } });
    db.exec('PRAGMA foreign_keys=ON');
    auditarEsquemaRestoreV9(db);
    return db;
  } catch (error) { try { db.close(); } catch {} throw error; }
}

export function auditarEsquemaRestoreV9(db,{v10=false}={}) {
  const catalogo = new Map(CATALOGO_V9.map(t => [t.nome, t]));
  const internos = new Map([['sqlite_schema', 'main'], ['sqlite_sequence', 'main'], ['sqlite_temp_schema', 'temp']]);
  const vistos = new Set();
  for (const row of db.prepare('PRAGMA table_list').iterate()) {
    if (internos.get(row.name) === row.schema) continue;
    if (row.schema !== 'main') fail('SCHEMA_NAO_MAPEADO', `Objeto fora do schema principal: ${row.name}`);
    const esperado = catalogo.has(row.name) || row.name==='wa_fila_retomada' || v10&&row.name==='ciclo_midias' ? 'table' : DDL_V9.auxiliares[row.name]?.[0];
    if (!esperado || row.type !== esperado) fail('SCHEMA_NAO_MAPEADO', `Objeto não mapeado ou tipo divergente: ${row.name}`);
    vistos.add(row.name);
  }
  for (const [nome, [tipo, colunas, sql]] of Object.entries(DDL_V9.auxiliares)) {
    if (!vistos.has(nome)) fail('SCHEMA_NAO_MAPEADO', `Objeto auxiliar ausente: ${nome}`);
    const actual = db.prepare(`PRAGMA table_info(${q(nome)})`).all().map(c => c.name);
    const divergente = tipo === 'view'
      ? actual.length !== colunas.length || actual.some(c => !colunas.includes(c))
      : actual.length !== colunas.length || actual.some((c, i) => c !== colunas[i]);
    if (divergente) fail('SCHEMA_NAO_MAPEADO', `Colunas auxiliares divergentes: ${nome}`);
    if (tipo === 'virtual' && db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(nome)?.sql !== sql) fail('SCHEMA_NAO_MAPEADO', `FTS divergente: ${nome}`);
  }
  for (const table of CATALOGO_V9) {
    if (!vistos.has(table.nome)) { if (table.decisao === 'I') fail('SCHEMA_INCOMPLETO', `Tabela I ausente: ${table.nome}`); continue; }
    const cols = [...db.prepare(`PRAGMA table_info(${q(table.nome)})`).iterate()];
    const actual = new Set(cols.map(c => c.name));
    // v9 não exporta etapas (classe X). O esquema atual acrescenta campos de
    // lease, mas pacotes v9 antigos continuam restauráveis sem mudar seu hash.
    const leaseV10 = table.nome === 'etapas' && actual.size === table.colunas.length + 3 &&
      ['lease_token','lease_ate','fonte_assinatura'].every(c => actual.has(c));
    if ((!leaseV10 && actual.size !== table.colunas.length) || table.colunas.some(c => !actual.has(c)))
      fail('SCHEMA_NAO_MAPEADO', `Colunas divergentes: ${table.nome}`);
    if (table.decisao === 'I') {
      const pk = cols.filter(c => c.pk > 0).sort((a,b) => a.pk-b.pk).map(c => c.name);
      if (pk.length !== table.pk.length || pk.some((c,i) => c !== table.pk[i])) fail('PK_DIVERGENTE', `PK divergente: ${table.nome}`);
    }
    const fks = [...db.prepare(`PRAGMA foreign_key_list(${q(table.nome)})`).iterate()]
      .map(c => [c.id, c.seq, c.table, c.from, c.to, c.on_update, c.on_delete, c.match])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (JSON.stringify(fks) !== JSON.stringify(DDL_V9.foreignKeys[table.nome] ?? [])) fail('FK_DIVERGENTE', `FK divergente: ${table.nome}`);
    const indices = [...db.prepare(`PRAGMA index_list(${q(table.nome)})`).iterate()]
      .filter(c => c.unique)
      .map(c => [c.name, c.origin, c.partial,
        db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(c.name)?.sql ?? null,
        [...db.prepare(`PRAGMA index_xinfo(${q(c.name)})`).iterate()]
          // cid >= 0 aponta à posição física na tabela; o nome e seqno definem o índice lógico.
          .map(x => [x.seqno, x.cid >= 0 ? null : x.cid, x.name, x.desc, x.coll, x.key])])
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (JSON.stringify(indices) !== JSON.stringify(DDL_V9.uniqueIndexes[table.nome] ?? [])) fail('UNIQUE_DIVERGENTE', `UNIQUE divergente: ${table.nome}`);
  }
  if(v10){
    const cols=db.prepare('PRAGMA table_info(ciclo_midias)').all();
    const names=cols.map(c=>c.name).join(',');
    if(names!=='evento_id,caminho,sha256,mime,tamanho,criado_em'||
      cols.filter(c=>c.pk).map(c=>c.name).join(',')!=='evento_id')fail('SCHEMA_NAO_MAPEADO','ciclo_midias');
    const fk=db.prepare('PRAGMA foreign_key_list(ciclo_midias)').all();
    if(fk.length!==1||fk[0].table!=='eventos'||fk[0].from!=='evento_id'||fk[0].to!=='id'||fk[0].on_delete!=='CASCADE')
      fail('FK_DIVERGENTE','ciclo_midias');
    if(!db.prepare('PRAGMA index_list(ciclo_midias)').all().some(i=>i.unique&&i.origin==='u'))
      fail('UNIQUE_DIVERGENTE','ciclo_midias');
  }
  const fila=db.prepare('PRAGMA table_info(wa_fila_retomada)').all();
  if(fila.map(c=>c.name).join(',')!=='interrupcao_id,conversa_id,estado,tentativas,proxima_tentativa_em,ultimo_erro,criado_em,atualizado_em'||
    fila.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name).join(',')!=='interrupcao_id,conversa_id')
    fail('SCHEMA_NAO_MAPEADO','wa_fila_retomada');
  const filaFk=db.prepare('PRAGMA foreign_key_list(wa_fila_retomada)').all();
  if(filaFk.length!==1||filaFk[0].table!=='wa_interrupcoes'||filaFk[0].from!=='interrupcao_id'||filaFk[0].to!=='id'||filaFk[0].on_delete!=='CASCADE')
    fail('FK_DIVERGENTE','wa_fila_retomada');
  return true;
}
