#!/usr/bin/env node
// Orquestrador do rascunho diario (SPEC-F8).
//
// Por que este comando existe:
// A F4 entregou `src/rascunho.js` com toda a logica pura, trava de seguranca (S1/S2/S3)
// e a rota `/api/rascunho` no painel. Porem nenhum comando criava o rascunho de forma
// automatizada na rotina diaria. Este script amarra o fluxo completo:
//   abre o banco -> pega itens abertos -> escolherAlvo() -> montarPedido() ->
//   chama o modelo -> gravarRascunho().
//
// Regras inegociaveis:
// 1. NADA E ENVIADO: rascunho e texto parado na tela do dono. Nao importa saidas nem transporte.
// 2. No maximo 1 por dia local (America/Sao_Paulo). Se rodar de novo no mesmo dia, preserva o existente.
// 3. Sem item aberto ou sem chave, avisa e sai com codigo 0 -- nunca derruba `npm run ingerir`.
//
// Uso no terminal:
//   node bin/rascunho.js --dry     # mostra o item escolhido e o pedido, sem gravar
//   node bin/rascunho.js           # gera e grava o rascunho do dia
//   node bin/rascunho.js --ver     # mostra o rascunho de hoje

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { abrirBanco } from '../src/banco.js';
import { carregarEnv } from '../src/ambiente.js';
import { diaLocal } from '../src/relogio.js';
import {
  prepararEsquemaRascunho,
  escolherAlvo,
  montarPedido,
  gravarRascunho,
  rascunhoDoDia
} from '../src/rascunho.js';
import { chaveApi, motorAtivo, gerarJson } from '../src/llm.js';

/**
 * Executa o fluxo de rascunho diario.
 *
 * Exportado para permitir testes deterministicos e com injecao de banco em memoria,
 * sem depender de estado global ou de chamadas externas de rede.
 */
export async function executarRascunho({
  db,
  seco = false,
  ver = false,
  agora = new Date(),
  chamarModelo = null,
  modelo = 'gemini-3.8-flash-medium',
  logger = console
} = {}) {
  // Garante data valida com fuso America/Sao_Paulo mesmo se agora for null, undefined ou data invalida
  const dataValida = (!agora || (agora instanceof Date && Number.isNaN(agora.getTime())))
    ? new Date()
    : (agora instanceof Date ? agora : new Date(agora));
  const dataRef = Number.isNaN(dataValida.getTime()) ? new Date() : dataValida;

  // Garante que o esquema de rascunhos exista
  prepararEsquemaRascunho(db);

  // Modo --ver: apenas exibe o rascunho de hoje e sai
  if (ver) {
    const hoje = rascunhoDoDia(db, { agora: dataRef });
    if (!hoje) {
      logger.log(`Nenhum rascunho gerado para hoje (${diaLocal(dataRef)}).`);
      return { ok: true, rascunho: null, motivo: 'nenhum_rascunho_hoje' };
    }

    let itemInfo = null;
    try {
      itemInfo = db.prepare('SELECT id, tipo, resumo, conversa_id, origem_id FROM itens_crm WHERE id = ?').get(hoje.item_id);
    } catch {
      itemInfo = null;
    }

    logger.log(`Rascunho do dia ${hoje.dia} (item #${hoje.item_id}):`);
    if (itemInfo) {
      logger.log(`  Origem: ${itemInfo.conversa_id} · [${itemInfo.origem_id}] ${itemInfo.resumo}`);
    }
    logger.log(`  Modelo: ${hoje.modelo ?? 'padrao'}`);
    logger.log(`  Texto:\n${hoje.texto}`);
    return { ok: true, rascunho: hoje, item: itemInfo };
  }

  // Criterio A2: no maximo um rascunho por dia local. Se ja existir, nao gera outro
  const existente = rascunhoDoDia(db, { agora: dataRef });
  if (existente) {
    logger.log(`Rascunho de hoje (${existente.dia}) ja existe (id #${existente.id}). Pulando geracao.`);
    return { ok: true, rascunho: existente, motivo: 'ja_existe' };
  }

  // Busca itens abertos do CRM
  let abertos = [];
  try {
    abertos = db.prepare("SELECT * FROM itens_crm WHERE estado = 'aberto'").all();
  } catch {
    abertos = [];
  }

  // Criterio A3: sem item aberto, avisa e sai com codigo 0 sem gravar nada
  if (!abertos || abertos.length === 0) {
    logger.log('Nenhum item aberto encontrado no CRM para gerar rascunho.');
    return { ok: true, rascunho: null, motivo: 'sem_itens_abertos' };
  }

  const alvo = escolherAlvo(abertos, { agora: dataRef });
  if (!alvo) {
    logger.log('Nenhum item aberto qualificado para gerar rascunho.');
    return { ok: true, rascunho: null, motivo: 'sem_alvo' };
  }

  // Recupera historico recente de mensagens da conversa para fornecer lastro ao prompt
  let mensagens = [];
  try {
    if (alvo.conversa_id) {
      const msgs = db.prepare(`
        SELECT id, origem_id, autor_id, autor_e_dono, texto
        FROM eventos
        WHERE conversa_id = ? AND texto IS NOT NULL AND texto <> ''
        ORDER BY id DESC LIMIT 20
      `).all(alvo.conversa_id);
      mensagens = msgs.reverse();
    }
  } catch {
    mensagens = [];
  }

  // Criterio A5: monta o pedido citando o item e as mensagens de origem
  const pedido = montarPedido(alvo, mensagens);

  // Criterio A1: --dry mostra o item escolhido e o pedido sem gravar nada
  if (seco) {
    logger.log(`Item escolhido: #${alvo.id} [${alvo.tipo}] ${alvo.resumo} (conversa: ${alvo.conversa_id}, origem: ${alvo.origem_id})`);
    logger.log(`Pedido montado para o modelo:\n${pedido}`);
    logger.log('--dry: rascunho nao gravado.');
    return { ok: true, seco: true, alvo, pedido };
  }

  // Criterio A4: sem chave de modelo nem agy disponivel, avisa e sai 0
  if (!chamarModelo) {
    const chave = chaveApi();
    const motor = motorAtivo();
    let agyDisponivel = false;
    if (motor === 'agy') {
      try {
        const binAgy = process.platform === 'win32' ? 'agy.exe' : 'agy';
        const proc = spawnSync(binAgy, ['--version'], { windowsHide: true, timeout: 5000 });
        agyDisponivel = (proc.status === 0);
      } catch {
        agyDisponivel = false;
      }
    }

    if (!chave && !agyDisponivel) {
      logger.log('Aviso: sem chave GEMINI_API_KEY e sem agy disponivel no PATH. Rascunho pulado.');
      return { ok: true, rascunho: null, motivo: 'sem_chave_nem_agy' };
    }
  }

  // Chama o modelo para redigir o rascunho curto
  let textoRascunho = '';
  try {
    if (chamarModelo) {
      textoRascunho = await chamarModelo(pedido, { alvo, modelo });
    } else {
      const schema = {
        type: 'object',
        properties: {
          rascunho: {
            type: 'string',
            description: 'Texto do rascunho curto de resposta para o WhatsApp'
          }
        },
        required: ['rascunho']
      };
      const resposta = await gerarJson(
        `${pedido}\n\nResponda em formato JSON com o campo "rascunho".`,
        { schema, modelo }
      );
      textoRascunho = resposta?.dados?.rascunho ?? '';
    }
  } catch (e) {
    logger.warn(`Falha ao gerar rascunho com o modelo: ${e.message}`);
    return { ok: true, rascunho: null, erro: e.message };
  }

  textoRascunho = String(textoRascunho ?? '').trim();
  if (!textoRascunho) {
    logger.log('Modelo retornou texto vazio. Nenhum rascunho gravado.');
    return { ok: true, rascunho: null, motivo: 'resposta_vazia' };
  }

  // Defesa contra injecao adversarial: se a resposta do modelo refletir comandos ou instrucoes
  // de sistema injetadas, recusa a gravacao para nao expor comandos de terceiros como rascunho
  if (/^\s*(SYSTEM:|Assistant:|<\/mensagem>|DROP TABLE|{"enviar":true)/i.test(textoRascunho)) {
    logger.warn('Modelo refletiu comando de sistema ou injeção adversarial. Rascunho descartado.');
    return { ok: true, rascunho: null, motivo: 'injecao_detectada' };
  }

  // Grava o rascunho com lastro no item_id e data de Sao Paulo
  const gravado = gravarRascunho(db, {
    itemId: alvo.id,
    texto: textoRascunho,
    modelo,
    agora: dataRef
  });

  logger.log(`Rascunho gravado com sucesso para o item #${alvo.id} (${alvo.conversa_id}):`);
  logger.log(`"${textoRascunho}"`);

  return { ok: true, rascunho: gravado, alvo };
}

// Execucao direta pela linha de comando
const ehScriptPrincipal = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (ehScriptPrincipal) {
  carregarEnv();
  const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dirDados = process.env.ASSESSOR_DATA_DIR;
  const caminhoBanco = dirDados === ':memory:'
    ? ':memory:'
    : resolve(dirDados || resolve(raiz, 'data'), 'assessor.db');

  let db;
  let teveErro = false;
  try {
    db = abrirBanco(caminhoBanco);
    const seco = process.argv.includes('--dry');
    const ver = process.argv.includes('--ver');
    await executarRascunho({ db, seco, ver });
  } catch (err) {
    console.error(`Erro inesperado ao gerar rascunho: ${err.message}`);
    teveErro = true;
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
  if (teveErro) {
    process.exit(1);
  }
  process.exit(0);
}
