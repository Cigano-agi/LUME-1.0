#!/usr/bin/env node

/**
 * scripts/ensaio-backup-snapshot.mjs
 *
 * Ensaio isolado e sintético do mecanismo de snapshot SQLite consistente e restauração.
 * NÃO simula R0 real concluído nem toca em perfis reais (AssessorDesktop).
 * NÃO toca em dados pessoais, nuvem ou chaves.
 * NÃO inicia desktop/service.js, electron ou app.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  criarSnapshot,
  restaurarSnapshot,
  impedirPromocaoAutomatica,
  ErroSnapshot
} from '../src/backup-snapshot.js';

async function executarEnsaio() {
  console.log('=== ENSAIO SINTÉTICO: SNAPSHOT E RESTAURAÇÃO ISOLADA SQLITE (R0 SINTÉTICO) ===\n');

  const tempDir = mkdtempSync(path.join(tmpdir(), 'lume-ensaio-snapshot-'));
  console.log(`[1/6] Diretório temporário isolado criado: ${tempDir}`);

  try {
    const caminhoOrigem = path.join(tempDir, 'banco-sintetico-origem.db');
    const caminhoSnapshot = path.join(tempDir, 'snapshot-backup.db');
    const caminhoRestaurado = path.join(tempDir, 'banco-restaurado.db');

    // Inicialização de banco sintético com WAL e esquema representativo
    const escritor = new DatabaseSync(caminhoOrigem);
    escritor.exec('PRAGMA journal_mode = WAL;');
    escritor.exec('PRAGMA user_version = 106;');
    escritor.exec('PRAGMA foreign_keys = ON;');

    escritor.exec(`
      CREATE TABLE conversas_app (
        id TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        atualizada_em TEXT NOT NULL
      );

      CREATE TABLE eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversa_id TEXT NOT NULL REFERENCES conversas_app(id),
        origem_id TEXT NOT NULL UNIQUE,
        tipo TEXT NOT NULL,
        texto TEXT,
        recebido_em TEXT NOT NULL
      );

      CREATE TABLE priv_excluidos (
        hash TEXT PRIMARY KEY,
        quando TEXT NOT NULL,
        motivo TEXT
      );

      CREATE TABLE f10_origens (
        fingerprint TEXT PRIMARY KEY,
        chave_publica TEXT NOT NULL
      );

      -- Tabela legada existente no banco 0.5 (BASE-LEGADA)
      CREATE TABLE caixas_jobs (
        job_id TEXT PRIMARY KEY,
        estado TEXT NOT NULL
      );
    `);

    escritor.exec("INSERT INTO conversas_app VALUES ('c1', 'Contato Teste 1', '2026-09-26T20:00:00Z');");
    escritor.exec("INSERT INTO conversas_app VALUES ('c2', 'Contato Teste 2', '2026-09-26T20:05:00Z');");
    escritor.exec("INSERT INTO eventos (conversa_id, origem_id, tipo, texto, recebido_em) VALUES ('c1', 'w1', 'texto', 'Olá sintético 1', '2026-09-26T20:01:00Z');");
    escritor.exec("INSERT INTO eventos (conversa_id, origem_id, tipo, texto, recebido_em) VALUES ('c1', 'w2', 'texto', 'Olá sintético 2', '2026-09-26T20:02:00Z');");
    escritor.exec("INSERT INTO priv_excluidos VALUES ('hash_del_999', '2026-09-26T20:03:00Z', 'excluido_pelo_titular');");
    escritor.exec("INSERT INTO caixas_jobs VALUES ('job_legado_alpha', 'concluido');");

    console.log('[2/6] Banco de dados sintético populado em modo WAL com escritas ativas.');

    // Simula escrita concorrente adicional antes/durante snapshot
    escritor.exec("INSERT INTO eventos (conversa_id, origem_id, tipo, texto, recebido_em) VALUES ('c2', 'w3', 'texto', 'Escrita concorrente em WAL', '2026-09-26T20:06:00Z');");

    // Executa snapshot consistente via backup() oficial do node:sqlite com staging e publicação atômica
    console.log('[3/6] Executando criarSnapshot via node:sqlite backup oficial com fonte em readOnly...');
    const resultadoSnapshot = await criarSnapshot({
      caminhoOrigem,
      caminhoDestino: caminhoSnapshot,
      gerarManifesto: true
    });

    console.log(`      Snapshot gravado em: ${resultadoSnapshot.caminhoDestino}`);
    console.log(`      Manifesto gerado em: ${resultadoSnapshot.caminhoManifesto}`);
    console.log(`      SHA-256 do snapshot (streaming): ${resultadoSnapshot.manifesto.snapshot.sha256}`);
    console.log(`      Integridade SQLite: ${resultadoSnapshot.manifesto.sqlite.integridade}`);
    console.log(`      Fronteira: preservacao_integral_banco=${resultadoSnapshot.manifesto.fronteira.preservacao_integral_banco}`);
    console.log(`      Fronteira: exclusao_arquivos_externos_credenciais=${resultadoSnapshot.manifesto.fronteira.exclusao_arquivos_externos_credenciais}`);
    console.log(`      Contagens de tabelas no manifesto:`, resultadoSnapshot.manifesto.sqlite.contagens);

    // Escritor na origem fecha após o snapshot
    escritor.close();

    // Restauração isolada para novo caminho com staging privado e validação obrigatória
    console.log('[4/6] Executando restaurarSnapshot para caminho isolado com validação estrita de manifesto...');
    const resultadoRestauro = await restaurarSnapshot({
      caminhoSnapshot,
      caminhoDestino: caminhoRestaurado,
      validarManifesto: true
    });

    console.log(`      Restauração concluída: ${resultadoRestauro.caminhoDestino}`);
    console.log(`      Integridade pós-restauro: ${resultadoRestauro.integridade}`);

    // Reabertura de validação (restart isolado sem side-effects)
    console.log('[5/6] Validando banco restaurado (restart isolado)...');
    const dbRestaurado = new DatabaseSync(caminhoRestaurado, { readOnly: true });
    const checkIntegridade = dbRestaurado.prepare('PRAGMA integrity_check;').all();
    const totalEventos = dbRestaurado.prepare('SELECT COUNT(*) AS n FROM eventos;').get().n;
    const tombstones = dbRestaurado.prepare('SELECT COUNT(*) AS n FROM priv_excluidos;').get().n;
    const legados = dbRestaurado.prepare('SELECT COUNT(*) AS n FROM caixas_jobs;').get().n;
    dbRestaurado.close();

    console.log(`      PRAGMA integrity_check: ${checkIntegridade[0].integrity_check}`);
    console.log(`      Eventos preservados: ${totalEventos}`);
    console.log(`      Tombstones preservados: ${tombstones}`);
    console.log(`      Tabela legada preservada: ${legados}`);

    if (checkIntegridade[0].integrity_check !== 'ok' || totalEventos !== 3 || tombstones !== 1 || legados !== 1) {
      throw new Error('Falha na validação dos dados restaurados!');
    }

    // Validação da salvaguarda contra promoção automática
    console.log('[6/6] Verificando salvaguardas de fronteira e bloqueio incondicional de promoção...');
    let bloqueioAtivoPadrao = false;
    try {
      impedirPromocaoAutomatica(resultadoSnapshot.manifesto);
    } catch (err) {
      if (err instanceof ErroSnapshot && err.codigo === 'PROMOCAO_AUTOMATICA_BLOQUEADA') {
        bloqueioAtivoPadrao = true;
      }
    }

    // Verifica que adulteração de flag no JSON não contorna o bloqueio
    let bloqueioAtivoAdulterado = false;
    try {
      const manifestoAdulterado = JSON.parse(JSON.stringify(resultadoSnapshot.manifesto));
      manifestoAdulterado.fronteira.promocao_automatica_permitida = true;
      impedirPromocaoAutomatica(manifestoAdulterado);
    } catch (err) {
      if (err instanceof ErroSnapshot && err.codigo === 'PROMOCAO_AUTOMATICA_BLOQUEADA') {
        bloqueioAtivoAdulterado = true;
      }
    }

    if (!bloqueioAtivoPadrao || !bloqueioAtivoAdulterado) {
      throw new Error('FALHA DE SEGURANÇA: promoção automática deveria ter sido bloqueada incondicionalmente!');
    }
    console.log('      Salvaguarda validada: promoção automática bloqueada para manifesto padrão e manifesto adulterado.');
    console.log('      Aviso de fronteira: snapshot técnico puro de SQLite NÃO substitui backup completo de anexos.\n');

    console.log('=== ENSAIO CONCLUÍDO COM SUCESSO (100% SINTÉTICO, ZERO EFEITOS EXTERNOS) ===');
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      console.log(`Limpeza concluída: ${tempDir} removido.`);
    } catch {}
  }
}

executarEnsaio().catch((err) => {
  console.error('ERRO NO ENSAIO:', err);
  process.exit(1);
});
