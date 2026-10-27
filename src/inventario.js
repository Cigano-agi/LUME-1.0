// Inventário determinístico de uma caixa: abre a exportação do WhatsApp, lista o que
// veio dentro e transforma o .txt da conversa em eventos com data, autor e fonte.
//
// Nenhum modelo de linguagem participa desta etapa. Tudo aqui é parsing, e cada evento
// aponta para o arquivo e a linha que o originou -- é isso que permite conferir depois.
//
// O leitor de ZIP é próprio, com zlib, por dois motivos: não adicionar dependência a um
// projeto que roda sem `npm install`, e poder recusar entrada por entrada antes de
// extrair qualquer coisa. Só o índice é lido; um ZIP de 216 MB nunca vai inteiro para a
// memória, porque só a conversa em texto precisa ser descomprimida.

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const ASSINATURA_EOCD = 0x06054b50;
const ASSINATURA_CENTRAL = 0x02014b50;
const ASSINATURA_LOCAL = 0x04034b50;

// Um .txt de conversa muito além disto não é conversa: é tentativa de estourar memória.
const LIMITE_ENTRADA_BYTES = 64 * 1024 * 1024;
const RAZAO_MAXIMA_COMPRESSAO = 200;

function lerBloco(fd, posicao, tamanho) {
  const buffer = Buffer.alloc(tamanho);
  const lidos = readSync(fd, buffer, 0, tamanho, posicao);
  return lidos === tamanho ? buffer : buffer.subarray(0, lidos);
}

/**
 * Recusa nomes que escapariam da pasta de destino se um dia forem extraídos.
 * A checagem acontece na listagem, não na extração: entrada perigosa nunca chega
 * a ser oferecida a quem consome o inventário.
 */
export function nomeDeEntradaSeguro(nome) {
  if (!nome || typeof nome !== 'string') return false;
  if (nome.includes('\0')) return false;
  if (nome.startsWith('/') || nome.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(nome)) return false;
  const partes = nome.split(/[\\/]/);
  return !partes.includes('..');
}

/**
 * Lê o índice central do ZIP e devolve as entradas já filtradas.
 * Entradas recusadas voltam em `recusadas`, com motivo -- nunca somem em silêncio.
 */
export function lerIndiceZip(caminho) {
  const tamanho = statSync(caminho).size;
  const fd = openSync(caminho, 'r');
  try {
    // O EOCD fica no fim, atrás de um comentário de até 64 KB.
    const janela = Math.min(tamanho, 65535 + 22);
    const cauda = lerBloco(fd, tamanho - janela, janela);
    let posEocd = -1;
    for (let i = cauda.length - 22; i >= 0; i--) {
      if (cauda.readUInt32LE(i) === ASSINATURA_EOCD) { posEocd = i; break; }
    }
    if (posEocd < 0) throw new Error('ZIP invalido: fim do indice central nao encontrado');

    const totalEntradas = cauda.readUInt16LE(posEocd + 10);
    const tamanhoCentral = cauda.readUInt32LE(posEocd + 12);
    const inicioCentral = cauda.readUInt32LE(posEocd + 16);
    if (inicioCentral === 0xffffffff || totalEntradas === 0xffff) {
      throw new Error('ZIP64 ainda nao suportado por este inventario');
    }

    const central = lerBloco(fd, inicioCentral, tamanhoCentral);
    const entradas = [];
    const recusadas = [];
    let p = 0;

    while (p + 46 <= central.length && central.readUInt32LE(p) === ASSINATURA_CENTRAL) {
      const metodo = central.readUInt16LE(p + 10);
      const crc32 = central.readUInt32LE(p + 16);
      const bytesComprimidos = central.readUInt32LE(p + 20);
      const bytesOriginais = central.readUInt32LE(p + 24);
      const tamNome = central.readUInt16LE(p + 28);
      const tamExtra = central.readUInt16LE(p + 30);
      const tamComentario = central.readUInt16LE(p + 32);
      const atributosExternos = central.readUInt32LE(p + 38);
      const offsetLocal = central.readUInt32LE(p + 42);
      const nome = central.subarray(p + 46, p + 46 + tamNome).toString('utf8');

      const ehDiretorio = nome.endsWith('/');
      // Bit alto dos atributos externos guarda o modo Unix; 0xA000 é link simbólico.
      const ehSymlink = ((atributosExternos >>> 16) & 0xf000) === 0xa000;
      const razao = bytesComprimidos > 0 ? bytesOriginais / bytesComprimidos : 0;

      let motivoRecusa = null;
      if (!nomeDeEntradaSeguro(nome)) motivoRecusa = 'nome_inseguro';
      else if (ehSymlink) motivoRecusa = 'symlink';
      else if (bytesOriginais > LIMITE_ENTRADA_BYTES) motivoRecusa = 'entrada_grande_demais';
      else if (razao > RAZAO_MAXIMA_COMPRESSAO) motivoRecusa = 'razao_de_compressao_suspeita';

      const registro = {
        nome, metodo, crc32, bytesComprimidos, bytesOriginais,
        offsetLocal, ehDiretorio, razao: Number(razao.toFixed(1))
      };
      if (motivoRecusa) recusadas.push({ ...registro, motivo: motivoRecusa });
      else if (!ehDiretorio) entradas.push(registro);

      p += 46 + tamNome + tamExtra + tamComentario;
    }

    return { totalDeclarado: totalEntradas, entradas, recusadas };
  } finally {
    closeSync(fd);
  }
}

/** Descomprime uma entrada específica já validada pelo índice. */
export function extrairEntrada(caminho, entrada) {
  if (entrada.bytesOriginais > LIMITE_ENTRADA_BYTES) {
    throw new Error('Entrada excede o limite de extracao');
  }
  const fd = openSync(caminho, 'r');
  try {
    const cabecalho = lerBloco(fd, entrada.offsetLocal, 30);
    if (cabecalho.readUInt32LE(0) !== ASSINATURA_LOCAL) {
      throw new Error('ZIP invalido: cabecalho local ausente');
    }
    const inicioDados = entrada.offsetLocal + 30
      + cabecalho.readUInt16LE(26) + cabecalho.readUInt16LE(28);
    const bruto = lerBloco(fd, inicioDados, entrada.bytesComprimidos);
    if (entrada.metodo === 0) return bruto;
    if (entrada.metodo === 8) return inflateRawSync(bruto);
    throw new Error(`Metodo de compressao nao suportado: ${entrada.metodo}`);
  } finally {
    closeSync(fd);
  }
}

const CABECALHO_MENSAGEM = /^‎?\[(\d{2})\/(\d{2})\/(\d{4}),\s(\d{2}):(\d{2}):(\d{2})\]\s([^:]+):\s?([\s\S]*)$/;
const ANEXO_CITADO = /<(?:anexado|attached):\s*([^>]+)>/g;

/**
 * Converte o .txt exportado em mensagens. Linhas sem cabeçalho pertencem à mensagem
 * anterior: quebrar isso separaria um parágrafo em eventos que nunca existiram.
 *
 * A data é a do aparelho de quem exportou, em horário local sem fuso declarado. Isso
 * fica marcado em `baseFuso` para que ninguém trate a hora como UTC mais tarde.
 */
export function parsearConversa(texto) {
  const linhas = texto.replace(/^﻿/, '').split(/\r?\n/);
  const mensagens = [];
  let atual = null;
  let numeroLinha = 0;

  const fechar = () => {
    if (!atual) return;
    atual.texto = atual.texto.trim();
    const anexos = [];
    for (const achado of atual.texto.matchAll(ANEXO_CITADO)) {
      anexos.push(achado[1].trim().replace(/‎/g, ''));
    }
    atual.anexos = anexos;
    mensagens.push(atual);
    atual = null;
  };

  for (const linha of linhas) {
    numeroLinha++;
    const achado = linha.match(CABECALHO_MENSAGEM);
    if (achado) {
      fechar();
      const [, dia, mes, ano, hora, minuto, segundo, autor, resto] = achado;
      atual = {
        instanteLocal: `${ano}-${mes}-${dia}T${hora}:${minuto}:${segundo}`,
        baseFuso: 'local_do_aparelho_sem_fuso_declarado',
        autor: autor.replace(/‎/g, '').trim(),
        texto: resto.replace(/‎/g, ''),
        linhaInicial: numeroLinha,
        anexos: []
      };
    } else if (atual) {
      atual.texto += '\n' + linha.replace(/‎/g, '');
    }
  }
  fechar();
  return mensagens;
}

/**
 * Inventaria uma caixa já descarregada: o que veio dentro, o que a conversa cita e o
 * que falta. Anexo citado e ausente vira lacuna registrada, nunca silêncio.
 */
export function inventariarCaixa(caminhoZip) {
  const indice = lerIndiceZip(caminhoZip);
  const nomesPresentes = new Set(indice.entradas.map(e => e.nome.split('/').pop()));

  const porExtensao = {};
  for (const entrada of indice.entradas) {
    const ext = entrada.nome.includes('.') ? entrada.nome.split('.').pop().toLowerCase() : '(sem)';
    porExtensao[ext] = (porExtensao[ext] || 0) + 1;
  }

  const entradaConversa = indice.entradas.find(e => e.nome.toLowerCase().endsWith('.txt'));
  if (!entradaConversa) {
    return {
      ok: false, motivo: 'conversa_txt_ausente',
      totalArquivos: indice.entradas.length, porExtensao, recusadas: indice.recusadas
    };
  }

  const texto = extrairEntrada(caminhoZip, entradaConversa).toString('utf8');
  const mensagens = parsearConversa(texto);

  const citados = new Set();
  for (const m of mensagens) for (const a of m.anexos) citados.add(a);
  const ausentes = [...citados].filter(nome => !nomesPresentes.has(nome));

  const autores = {};
  for (const m of mensagens) autores[m.autor] = (autores[m.autor] || 0) + 1;

  return {
    ok: true,
    arquivoConversa: entradaConversa.nome,
    totalArquivos: indice.entradas.length,
    porExtensao,
    recusadas: indice.recusadas,
    mensagens,
    totalMensagens: mensagens.length,
    primeiroEm: mensagens[0]?.instanteLocal ?? null,
    ultimoEm: mensagens[mensagens.length - 1]?.instanteLocal ?? null,
    baseFuso: 'local_do_aparelho_sem_fuso_declarado',
    autores,
    anexosCitados: citados.size,
    anexosAusentes: ausentes
  };
}

const ESQUEMA_INVENTARIO = `
CREATE TABLE IF NOT EXISTS caixas_inventario (
  caixa_id         TEXT PRIMARY KEY,
  arquivo_conversa TEXT,
  total_arquivos   INTEGER,
  por_extensao     TEXT,
  total_mensagens  INTEGER,
  primeiro_em      TEXT,
  ultimo_em        TEXT,
  base_fuso        TEXT,
  autores          TEXT,
  anexos_citados   INTEGER,
  anexos_ausentes  TEXT,
  recusadas        TEXT,
  estado           TEXT NOT NULL,
  motivo           TEXT,
  criado_em        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS linha_tempo (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  caixa_id       TEXT NOT NULL,
  instante_local TEXT NOT NULL,
  base_fuso      TEXT,
  autor          TEXT,
  texto          TEXT,
  anexos         TEXT,
  linha_fonte    INTEGER NOT NULL,
  UNIQUE(caixa_id, linha_fonte)
);

CREATE INDEX IF NOT EXISTS idx_linha_tempo_caixa ON linha_tempo(caixa_id, instante_local);
CREATE INDEX IF NOT EXISTS idx_linha_tempo_autor ON linha_tempo(autor);
`;

export function prepararEsquemaInventario(db) {
  db.exec(ESQUEMA_INVENTARIO);
}

/**
 * Inventaria a caixa e grava a linha do tempo. Idempotente: reprocessar a mesma caixa
 * não duplica evento, porque cada um é ancorado na linha do arquivo que o originou.
 *
 * O texto guardado é o da exportação, sem reescrita. Interpretação é etapa seguinte e
 * de outro executor; aqui só se registra o que está escrito, com a linha de origem.
 */
export function registrarInventario(db, caixaId, caminhoZip) {
  prepararEsquemaInventario(db);
  const agora = new Date().toISOString();

  let inv;
  try {
    inv = inventariarCaixa(caminhoZip);
  } catch (err) {
    db.prepare(`
      INSERT INTO caixas_inventario (caixa_id, estado, motivo, criado_em)
      VALUES (?, 'erro', ?, ?)
      ON CONFLICT(caixa_id) DO UPDATE SET estado='erro', motivo=excluded.motivo, criado_em=excluded.criado_em
    `).run(caixaId, String(err?.message ?? 'falha').slice(0, 300), agora);
    return { ok: false, motivo: err?.message };
  }

  if (!inv.ok) {
    db.prepare(`
      INSERT INTO caixas_inventario (caixa_id, total_arquivos, por_extensao, recusadas, estado, motivo, criado_em)
      VALUES (?, ?, ?, ?, 'incompleto', ?, ?)
      ON CONFLICT(caixa_id) DO UPDATE SET estado='incompleto', motivo=excluded.motivo, criado_em=excluded.criado_em
    `).run(caixaId, inv.totalArquivos, JSON.stringify(inv.porExtensao),
      JSON.stringify(inv.recusadas ?? []), inv.motivo, agora);
    return { ok: false, motivo: inv.motivo };
  }

  db.prepare(`
    INSERT INTO caixas_inventario (
      caixa_id, arquivo_conversa, total_arquivos, por_extensao, total_mensagens,
      primeiro_em, ultimo_em, base_fuso, autores, anexos_citados, anexos_ausentes,
      recusadas, estado, motivo, criado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inventariado', NULL, ?)
    ON CONFLICT(caixa_id) DO UPDATE SET
      arquivo_conversa=excluded.arquivo_conversa, total_arquivos=excluded.total_arquivos,
      por_extensao=excluded.por_extensao, total_mensagens=excluded.total_mensagens,
      primeiro_em=excluded.primeiro_em, ultimo_em=excluded.ultimo_em,
      base_fuso=excluded.base_fuso, autores=excluded.autores,
      anexos_citados=excluded.anexos_citados, anexos_ausentes=excluded.anexos_ausentes,
      recusadas=excluded.recusadas, estado='inventariado', motivo=NULL, criado_em=excluded.criado_em
  `).run(
    caixaId, inv.arquivoConversa, inv.totalArquivos, JSON.stringify(inv.porExtensao),
    inv.totalMensagens, inv.primeiroEm, inv.ultimoEm, inv.baseFuso,
    JSON.stringify(inv.autores), inv.anexosCitados, JSON.stringify(inv.anexosAusentes),
    JSON.stringify(inv.recusadas), agora
  );

  const inserir = db.prepare(`
    INSERT INTO linha_tempo (caixa_id, instante_local, base_fuso, autor, texto, anexos, linha_fonte)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(caixa_id, linha_fonte) DO NOTHING
  `);
  let gravados = 0;
  db.exec('BEGIN');
  try {
    for (const m of inv.mensagens) {
      inserir.run(caixaId, m.instanteLocal, m.baseFuso, m.autor, m.texto,
        m.anexos.length ? JSON.stringify(m.anexos) : null, m.linhaInicial);
      gravados++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    ok: true, caixaId, eventos: gravados, totalArquivos: inv.totalArquivos,
    primeiroEm: inv.primeiroEm, ultimoEm: inv.ultimoEm,
    anexosAusentes: inv.anexosAusentes.length, recusadas: inv.recusadas.length
  };
}
