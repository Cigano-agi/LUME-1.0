#!/usr/bin/env node
// Imprime a cadeia de procedência de um item de CRM em formato legível (SPEC-F7).
//
// Responde à exigência de auditoria: "de onde veio e por que teve permissão de existir".
//
// Uso:
//   node bin/procedencia.js --item <id>

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirBanco } from '../src/banco.js';
import { carregarEnv } from '../src/ambiente.js';
import { procedencia } from '../src/crm.js';

export function executarProcedencia({ db, itemId, logger = console } = {}) {
  if (!itemId) {
    logger.error('Uso obrigatório: node bin/procedencia.js --item <id>');
    return { ok: false, erro: 'parametro_ausente' };
  }

  const resultado = procedencia(db, { itemId });
  if (!resultado || !resultado.item) {
    logger.error(`Item #${itemId} não encontrado no CRM.`);
    return { ok: false, erro: 'item_nao_encontrado' };
  }

  const { item, evento, conversa, permissao, regra, quando } = resultado;

  logger.log(`\n======================================================`);
  logger.log(` PROCEDÊNCIA DO ITEM #${item.id}`);
  logger.log(`======================================================`);
  logger.log(`Tipo:         ${item.tipo}`);
  logger.log(`Resumo:       ${item.resumo}`);
  logger.log(`Responsável:  ${item.responsavel || '(não atribuído)'}`);
  logger.log(`Estado:       ${item.estado || 'aberto'}`);
  logger.log(`Conversa:     ${conversa}`);
  logger.log(`Quando:       ${quando || '(sem data)'}`);
  logger.log(`------------------------------------------------------`);
  logger.log(`Mensagem de origem (id=${item.origem_id}):`);
  if (evento) {
    logger.log(`  Texto:      ${evento.texto || '(sem texto)'}`);
    logger.log(`  Autor:      ${evento.autor_id || (evento.autor_e_dono ? 'Dono' : '(desconhecido)')}`);
    logger.log(`  Recebido:   ${evento.recebido_em || '(sem data)'}`);
  } else {
    logger.log(`  (evento de origem #${item.origem_id} não encontrado na tabela eventos)`);
  }
  logger.log(`------------------------------------------------------`);
  logger.log(`Permissão na origem: ${permissao || '(pré-migração / desconhecida)'}`);
  logger.log(`Regra que autorizou: ${regra || '(pré-migração / sem regra registrada)'}`);
  logger.log(`======================================================\n`);

  return { ok: true, procedencia: resultado };
}

// Execução CLI direta
const ehScriptPrincipal = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (ehScriptPrincipal) {
  carregarEnv();
  const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dirDados = process.env.ASSESSOR_DATA_DIR;
  const caminhoBanco = dirDados === ':memory:'
    ? ':memory:'
    : resolve(dirDados || resolve(raiz, 'data'), 'assessor.db');

  const idxItem = process.argv.indexOf('--item');
  const itemId = idxItem >= 0 ? process.argv[idxItem + 1] : null;

  if (!itemId) {
    console.error('Uso: node bin/procedencia.js --item <id>');
    process.exit(1);
  }

  let db;
  try {
    db = abrirBanco(caminhoBanco);
    const res = executarProcedencia({ db, itemId });
    if (!res.ok) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Erro ao consultar procedência: ${err.message}`);
    process.exit(1);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
  process.exit(0);
}
