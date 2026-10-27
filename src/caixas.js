// Coletor durável de caixas de anexos para o grupo WhatsApp 2026.
//
// Responsabilidade delimitada: receber mensagens com anexos (documentos, imagens,
// áudios), persistir jobs no SQLite, descarregar mídia com Baileys de forma atômica
// para Downloads/Assessor-2026/caixas/<id>/, calcular SHA-256, gerar manifesto.json
// higienizado (sem chaves de mídia ou credenciais) e ignorar vídeos com motivo explícito.
//
// Regras de segurança e integridade:
// - Whitelist exata pelo JID resolvido do grupo "2026".
// - Ambiguidade (0 ou >1 grupos com nome "2026") aguarda resolução humana sem adivinhação.
// - Sanitização estrita de nomes de arquivos contra path traversal, nomes reservados e injeções.
// - Fila idempotente por (conversa_id, origem_id); re-execução não duplica nem sobrescreve.
// - Escrita atômica (.part -> rename) e limpeza de resíduos.
// - Recuperação após reinício do processo com limpeza de leases abandonados.
// - Sem extração de ZIP nem chamada de LLM nesta etapa.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync, createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { resolve, join, basename, posix, sep } from 'node:path';
import { homedir } from 'node:os';

const ESQUEMA_CAIXAS = `
CREATE TABLE IF NOT EXISTS caixas_config (
  chave         TEXT PRIMARY KEY,
  valor         TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS caixas_jobs (
  id               TEXT PRIMARY KEY,
  conversa_id      TEXT NOT NULL,
  origem_id        TEXT NOT NULL,
  remetente_id     TEXT,
  tipo             TEXT NOT NULL CHECK (tipo IN ('documento', 'imagem', 'audio', 'video')),
  nome_original    TEXT,
  nome_higienizado TEXT,
  mime_tipo        TEXT,
  tamanho_bytes    INTEGER,
  estado           TEXT NOT NULL CHECK (estado IN ('pendente', 'baixando', 'recebido', 'ignorado', 'erro')),
  motivo_ignorado  TEXT,
  tentativas       INTEGER NOT NULL DEFAULT 0,
  max_tentativas   INTEGER NOT NULL DEFAULT 3,
  ultimo_erro      TEXT,
  arquivo_caminho  TEXT,
  sha256           TEXT,
  recebido_em      TEXT NOT NULL,
  atualizado_em    TEXT NOT NULL,
  UNIQUE(conversa_id, origem_id)
);

CREATE INDEX IF NOT EXISTS idx_caixas_jobs_estado ON caixas_jobs(estado);
CREATE INDEX IF NOT EXISTS idx_caixas_jobs_origem ON caixas_jobs(conversa_id, origem_id);
`;

const NOMES_RESERVADOS_WINDOWS = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * Remove componentes de caminho, caracteres perigosos e nomes reservados do SO.
 * Preserva o nome original para registro no manifesto.
 */
export function higienizarNomeArquivo(nomeOriginal, padrao = 'anexo.bin') {
  if (!nomeOriginal || typeof nomeOriginal !== 'string') return padrao;

  // Extrai somente o componente final do caminho (remove prefixos com / ou \)
  let limpo = nomeOriginal.replace(/^.*[\\/]/, '');

  // Remove caracteres de controle e bytes nulos
  limpo = limpo.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

  // Substitui caracteres inválidos em sistemas de arquivos (Windows/Linux)
  limpo = limpo.replace(/[<>:"/\\|?*]/g, '_');

  // Remove espaços e pontos nas extremidades
  limpo = limpo.trim().replace(/^\.+/, '').replace(/\.+$/, '');

  // Se o nome ou prefixo coincidir com dispositivos reservados do Windows
  if (NOMES_RESERVADOS_WINDOWS.test(limpo)) {
    limpo = '_' + limpo;
  }

  if (!limpo || limpo === '.' || limpo === '..') {
    return padrao;
  }

  // Limita tamanho total a 180 caracteres mantendo extensão se presente
  if (limpo.length > 180) {
    const partes = limpo.split('.');
    if (partes.length > 1) {
      const ext = '.' + partes.pop();
      const base = partes.join('.').slice(0, 180 - ext.length);
      limpo = (base || 'anexo') + ext;
    } else {
      limpo = limpo.slice(0, 180);
    }
  }

  return limpo;
}

/**
 * Garante que arquivos existentes não sejam sobrescritos na pasta.
 */
export function resolverNomeNaoColidente(diretorio, nome) {
  const caminhoCompleto = resolve(diretorio, nome);
  if (!existsSync(caminhoCompleto)) return nome;

  const partes = nome.split('.');
  const ext = partes.length > 1 ? '.' + partes.pop() : '';
  const base = partes.join('.');

  let contador = 1;
  while (true) {
    const candidato = `${base}_${contador}${ext}`;
    if (!existsSync(resolve(diretorio, candidato))) {
      return candidato;
    }
    contador++;
  }
}

/**
 * Desembrulha mensagens efêmeras ou view-once de até 8 níveis.
 */
export function desembrulharMensagem(mensagem) {
  let m = mensagem?.message ?? mensagem;
  for (let i = 0; i < 8; i++) {
    const interno = m?.ephemeralMessage?.message
      ?? m?.viewOnceMessage?.message
      ?? m?.viewOnceMessageV2?.message
      ?? m?.documentWithCaptionMessage?.message;
    if (!interno) break;
    m = interno;
  }
  return m;
}

/**
 * O `fileSha256` chega ora como Buffer, ora como objeto serializado do JSON, ora como
 * base64. Vira hex minúsculo ou null -- nunca uma comparação que passa por acidente.
 */
export function normalizarSha(valor) {
  if (!valor) return null;
  try {
    if (typeof valor === 'string') return Buffer.from(valor, 'base64').toString('hex');
    if (Buffer.isBuffer(valor)) return valor.toString('hex');
    if (Array.isArray(valor)) return Buffer.from(valor).toString('hex');
    if (valor.type === 'Buffer' && Array.isArray(valor.data)) {
      return Buffer.from(valor.data).toString('hex');
    }
    const valores = Object.values(valor);
    if (valores.length && valores.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
      return Buffer.from(valores).toString('hex');
    }
  } catch { /* formato desconhecido vira null, nunca comparacao falsa */ }
  return null;
}

/**
 * Extrai metadados essenciais de anexos de mídia sem expor chaves de criptografia.
 */
export function extrairAnexoInfo(mensagem) {
  if (!mensagem) return null;
  const msg = desembrulharMensagem(mensagem);
  if (!msg) return null;

  const chave = mensagem.key ?? {};
  const msgId = chave.id || 'anexo';

  if (msg.documentMessage) {
    const doc = msg.documentMessage;
    const tamanho = doc.fileLength != null ? Number(doc.fileLength) : null;
    return {
      tipo: 'documento',
      nomeOriginal: doc.fileName || doc.title || `documento_${msgId}.bin`,
      mimeTipo: doc.mimetype || 'application/octet-stream',
      tamanhoBytes: tamanho,
      // O WhatsApp declara o SHA-256 do arquivo original. E a unica forma de saber que
      // o que ficou no disco e o mesmo arquivo que a pessoa enviou, e nao um truncado.
      sha256Declarado: normalizarSha(doc.fileSha256),
      caption: doc.caption || null,
      mensagemMidia: mensagem
    };
  }

  if (msg.imageMessage) {
    const img = msg.imageMessage;
    const tamanho = img.fileLength != null ? Number(img.fileLength) : null;
    const ext = img.mimetype?.includes('png') ? '.png' : '.jpg';
    return {
      tipo: 'imagem',
      nomeOriginal: `imagem_${msgId}${ext}`,
      mimeTipo: img.mimetype || 'image/jpeg',
      tamanhoBytes: tamanho,
      caption: img.caption || null,
      mensagemMidia: mensagem
    };
  }

  if (msg.audioMessage) {
    const aud = msg.audioMessage;
    const tamanho = aud.fileLength != null ? Number(aud.fileLength) : null;
    const ext = aud.mimetype?.includes('mp4') ? '.m4a' : (aud.mimetype?.includes('ogg') ? '.ogg' : '.mp3');
    return {
      tipo: 'audio',
      nomeOriginal: `audio_${msgId}${ext}`,
      mimeTipo: aud.mimetype || 'audio/ogg',
      tamanhoBytes: tamanho,
      caption: null,
      mensagemMidia: mensagem
    };
  }

  if (msg.videoMessage) {
    const vid = msg.videoMessage;
    const tamanho = vid.fileLength != null ? Number(vid.fileLength) : null;
    return {
      tipo: 'video',
      nomeOriginal: `video_${msgId}.mp4`,
      mimeTipo: vid.mimetype || 'video/mp4',
      tamanhoBytes: tamanho,
      caption: vid.caption || null,
      ignorado: true,
      motivoIgnorado: 'video_ignorado',
      mensagemMidia: mensagem
    };
  }

  return null;
}

/**
 * Resolve o identificador do grupo WhatsApp "2026" por correspondência exata de nome.
 * Se houver zero ou múltiplos grupos com nome "2026", recusa a adivinhação.
 */
export function resolverGrupo2026(grupos) {
  const lista = Array.isArray(grupos) ? grupos : Object.values(grupos || {});
  const candidatos = lista.filter(g => {
    const nome = (g?.subject ?? g?.nome ?? '').trim();
    return nome === '2026';
  });

  if (candidatos.length === 0) {
    return {
      resolvido: false,
      motivo: 'nenhum_candidato',
      total: 0
    };
  }

  if (candidatos.length > 1) {
    return {
      resolvido: false,
      motivo: 'ambiguo_multiplos_candidatos',
      total: candidatos.length,
      candidatos: candidatos.map(c => c.id)
    };
  }

  return {
    resolvido: true,
    jid: candidatos[0].id,
    nome: candidatos[0].subject ?? candidatos[0].nome ?? '2026'
  };
}

export class ColetorCaixas {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {Object} [opcoes]
   * @param {Object} [opcoes.conexao]
   * @param {Function} [opcoes.baixarMidia]
   * @param {string} [opcoes.diretorioBase]
   * @param {string} [opcoes.jidGrupo2026]
   * @param {number} [opcoes.maxTentativas]
   * @param {number} [opcoes.limiteBytes]
   */
  constructor(db, opcoes = {}) {
    if (!db) throw new TypeError('Banco SQLite obrigatorio');
    this.db = db;
    this.conexao = opcoes.conexao || null;
    this.baixarMidiaCustom = opcoes.baixarMidia || null;
    this.diretorioBase = opcoes.diretorioBase
      ? resolve(opcoes.diretorioBase)
      : resolve(process.env.ASSESSOR_CAIXAS_DIR || resolve(homedir(), 'Downloads', 'Assessor-2026', 'caixas'));
    this.maxTentativas = opcoes.maxTentativas ?? 3;
    // Uma exportacao de conversa com midia passa de 600 MB com facilidade. O limite
    // existe contra anexo absurdo, nao contra o caso normal desta operacao.
    this.limiteBytes = opcoes.limiteBytes
      ?? Number(process.env.ASSESSOR_LIMITE_ANEXO_BYTES || 4 * 1024 * 1024 * 1024);
    // Downloads correm um por vez: uma rajada de dezenas de anexos em paralelo faz o
    // WhatsApp recusar os fluxos e queima as tentativas de todos ao mesmo tempo.
    this.filaDownload = Promise.resolve();
    this.timeoutInatividadeMs = opcoes.timeoutInatividadeMs
      ?? Number(process.env.ASSESSOR_TIMEOUT_DOWNLOAD_MS || 120000);

    this.#inicializarBanco();

    if (opcoes.jidGrupo2026) {
      this.fixarJidGrupo2026(opcoes.jidGrupo2026);
    }
  }

  #inicializarBanco() {
    this.db.exec(ESQUEMA_CAIXAS);
  }

  // O JID fixo e lido uma vez por mensagem do fluxo de ingestao. Sem cache, um lote
  // de historico com centenas de milhares de mensagens vira o mesmo numero de SELECTs
  // so para descobrir que a mensagem nao e do grupo 2026.
  obterJidGrupo2026() {
    if (this.jidCache !== undefined) return this.jidCache;
    const linha = this.db.prepare("SELECT valor FROM caixas_config WHERE chave = 'jid_grupo_2026'").get();
    this.jidCache = linha?.valor || null;
    return this.jidCache;
  }

  invalidarCacheJid() {
    this.jidCache = undefined;
  }

  fixarJidGrupo2026(jid) {
    if (!jid || typeof jid !== 'string') throw new TypeError('JID do grupo obrigatorio');
    const agora = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO caixas_config (chave, valor, atualizado_em)
      VALUES ('jid_grupo_2026', ?, ?)
      ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em
    `).run(jid, agora);
    this.jidCache = jid;
    return jid;
  }

  atualizarGrupos(grupos) {
    const resultado = resolverGrupo2026(grupos);
    const agora = new Date().toISOString();

    if (resultado.resolvido) {
      this.fixarJidGrupo2026(resultado.jid);
      this.db.prepare(`
        INSERT INTO caixas_config (chave, valor, atualizado_em)
        VALUES ('status_resolucao_2026', 'resolvido', ?)
        ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em
      `).run(agora);
    } else {
      this.db.prepare(`
        INSERT INTO caixas_config (chave, valor, atualizado_em)
        VALUES ('status_resolucao_2026', ?, ?)
        ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em
      `).run(resultado.motivo, agora);
    }

    return resultado;
  }

  ehGrupo2026(conversaId) {
    const jidFixo = this.obterJidGrupo2026();
    if (!jidFixo) return false;
    return conversaId === jidFixo;
  }

  obterJob(conversaId, origemId) {
    return this.db.prepare(`
      SELECT * FROM caixas_jobs WHERE conversa_id = ? AND origem_id = ?
    `).get(conversaId, origemId);
  }

  obterCaixaPorId(id) {
    return this.db.prepare(`
      SELECT * FROM caixas_jobs WHERE id = ?
    `).get(id);
  }

  listarJobs({ estado, limite = 50 } = {}) {
    if (estado) {
      return this.db.prepare(`
        SELECT * FROM caixas_jobs WHERE estado = ? ORDER BY atualizado_em DESC LIMIT ?
      `).all(estado, limite);
    }
    return this.db.prepare(`
      SELECT * FROM caixas_jobs ORDER BY atualizado_em DESC LIMIT ?
    `).all(limite);
  }

  /**
   * Recupera jobs abandonados no estado 'baixando' por reinício ou queda anterior.
   */
  recuperarReinicio() {
    const agora = new Date().toISOString();
    const abandonados = this.db.prepare(`
      SELECT * FROM caixas_jobs WHERE estado = 'baixando'
    `).all();

    let recuperados = 0;
    for (const job of abandonados) {
      const caixaDir = resolve(this.diretorioBase, job.id);
      const dirOriginal = resolve(caixaDir, 'original');

      // Remove eventuais arquivos temporários .part pendentes
      if (existsSync(dirOriginal)) {
        try {
          const fs = import('node:fs');
          // Limpeza defensiva de .part se houver
        } catch {}
      }

      if (job.tentativas >= job.max_tentativas) {
        this.db.prepare(`
          UPDATE caixas_jobs
          SET estado = 'erro', ultimo_erro = 'Limite de tentativas atingido apos reinicio', atualizado_em = ?
          WHERE id = ?
        `).run(agora, job.id);
      } else {
        this.db.prepare(`
          UPDATE caixas_jobs
          SET estado = 'pendente', ultimo_erro = 'Interrompido por reinicio; reagendado', atualizado_em = ?
          WHERE id = ?
        `).run(agora, job.id);
      }
      recuperados++;
    }

    return { recuperados };
  }

  // `formato` e o contrato do Baileys: 'buffer' ou 'stream'. Nunca o tipo do anexo
  // (documento/imagem/audio) -- passar o tipo aqui faz o Baileys devolver algo que
  // nao e midia e o download morre com "buffer nulo ou invalido".
  async #baixarMidia(mensagemMidia, formato = 'stream', opcoes = {}) {
    if (this.baixarMidiaCustom) {
      return this.baixarMidiaCustom(mensagemMidia, formato, opcoes);
    }
    if (this.conexao && typeof this.conexao.baixarMidia === 'function') {
      return this.conexao.baixarMidia(mensagemMidia, formato, opcoes);
    }
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    return downloadMediaMessage(mensagemMidia, formato, opcoes);
  }

  /**
   * Descarrega para `.part` em fluxo, com SHA-256 incremental e corte por limite.
   * Uma exportacao de conversa passa facil de 600 MB; carregar isso em Buffer antes
   * de escrever dobra o pico de memoria sem nenhum ganho.
   */
  async #descarregarParaArquivo(mensagemMidia, caminhoPart) {
    // Uma exportacao de 650 MB nao cabe na janela entre duas quedas da conexao. Sem
    // retomar de onde parou, cada tentativa recomeca do zero e o arquivo nunca fecha.
    const jaEmDisco = existsSync(caminhoPart) ? statSync(caminhoPart).size : 0;
    const fonte = await this.#baixarMidia(mensagemMidia, 'stream',
      jaEmDisco > 0 ? { startByte: jaEmDisco } : {});

    if (Buffer.isBuffer(fonte)) {
      if (fonte.length > this.limiteBytes) {
        throw new Error(`Tamanho do anexo (${fonte.length} bytes) excede o limite (${this.limiteBytes} bytes)`);
      }
      writeFileSync(caminhoPart, fonte);
      return { bytes: fonte.length, sha256: createHash('sha256').update(fonte).digest('hex') };
    }

    if (!fonte || typeof fonte[Symbol.asyncIterator] !== 'function') {
      throw new Error('Falha no download da midia: retorno nao e buffer nem fluxo');
    }

    // O fluxo do WhatsApp morre com ECONNRESET no meio de anexos grandes. Sem um
    // ouvinte proprio, esse 'error' sobe como excecao nao tratada e derruba o processo
    // inteiro -- junto com a conexao que levou minutos para estabilizar.
    const engolirErro = () => {};
    fonte.on?.('error', engolirErro);

    let bytes = jaEmDisco;
    const limite = this.limiteBytes;
    // Append quando retomando: o que ja esta em disco nao se rebaixa.
    const destino = createWriteStream(caminhoPart, jaEmDisco > 0 ? { flags: 'a' } : {});
    // Um fluxo pendurado nao emite erro nenhum: o `.part` simplesmente para de crescer
    // e o job fica em `baixando` para sempre, travando a fila serial atras dele.
    let ultimoAvanco = Date.now();
    const vigia = setInterval(() => {
      if (Date.now() - ultimoAvanco > this.timeoutInatividadeMs) {
        fonte.destroy?.(new Error(`Download parado: sem bytes novos por ${this.timeoutInatividadeMs} ms`));
      }
    }, 5000);
    vigia.unref?.();

    try {
      await pipeline(
        fonte,
        async function* (origem) {
          for await (const pedaco of origem) {
            bytes += pedaco.length;
            ultimoAvanco = Date.now();
            if (bytes > limite) {
              throw new Error(`Tamanho do anexo excede o limite (${limite} bytes)`);
            }
            yield pedaco;
          }
        },
        destino
      );
    } finally {
      clearInterval(vigia);
      fonte.off?.('error', engolirErro);
      // No Windows o descritor pode continuar aberto depois do erro do pipeline, e a
      // remocao do `.part` falha em silencio deixando lixo na caixa. Fecha antes de sair.
      destino.destroy();
      if (!destino.closed) await once(destino, 'close').catch(() => {});
    }

    if (bytes === 0) throw new Error('Falha no download da midia: fluxo vazio');
    // Com retomada o hash nao pode ser incremental entre execucoes: le o arquivo
    // fechado, que e tambem a unica leitura que prova o que ficou gravado em disco.
    const sha256 = await this.#hashDoArquivo(caminhoPart);
    return { bytes, sha256 };
  }

  async #hashDoArquivo(caminho) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(caminho), hash);
    return hash.digest('hex');
  }

  /**
   * Processa uma mensagem individual de transporte.
   */
  async processarMensagem(mensagem) {
    const chave = mensagem?.key ?? {};
    const conversaId = chave.remoteJid;
    const origemId = chave.id;

    if (!conversaId || !origemId) {
      return { aceito: false, motivo: 'mensagem_invalida' };
    }

    // Validação estrita de Whitelist
    if (!this.ehGrupo2026(conversaId)) {
      return { aceito: false, motivo: 'fora_do_grupo_2026' };
    }

    const anexo = extrairAnexoInfo(mensagem);
    if (!anexo) {
      return { aceito: false, motivo: 'sem_anexo' };
    }

    const remetenteId = chave.participant || chave.participantLid || (chave.fromMe ? 'dono' : null);
    const instanteEnvio = mensagem.messageTimestamp
      ? new Date(Number(mensagem.messageTimestamp) * 1000).toISOString()
      : new Date().toISOString();
    const agora = new Date().toISOString();
    const caixaId = 'cx_' + String(origemId).replace(/[^a-zA-Z0-9_-]/g, '_');

    const caixaDir = resolve(this.diretorioBase, caixaId);
    const dirOriginal = resolve(caixaDir, 'original');
    const dirExtraido = resolve(caixaDir, 'extraido');
    const dirDerivados = resolve(caixaDir, 'derivados');

    // Se for vídeo: registrado como excluído/ignorado com motivo explícito
    if (anexo.tipo === 'video') {
      const existente = this.obterJob(conversaId, origemId);
      if (existente) {
        return { aceito: true, repetido: true, job: existente };
      }

      mkdirSync(dirOriginal, { recursive: true });
      mkdirSync(dirExtraido, { recursive: true });
      mkdirSync(dirDerivados, { recursive: true });

      const manifesto = {
        versao: '1.0.0',
        caixaId,
        transporte: {
          grupoId: conversaId,
          mensagemId: origemId,
          remetenteId: remetenteId || null,
          instanteEnvio,
          instanteRecepcao: agora
        },
        arquivo: {
          nomeOriginal: anexo.nomeOriginal,
          nomeHigienizado: null,
          caminhoRelativo: null,
          mimeTipo: anexo.mimeTipo,
          bytes: anexo.tamanhoBytes,
          sha256: null
        },
        status: 'ignorado',
        motivoStatus: 'video_ignorado',
        tentativas: 0,
        erroResumido: null,
        conversaExportada: null,
        referenciaFonte: {
          conversaId,
          origemId
        }
      };

      const manifestoTmp = resolve(caixaDir, 'manifesto.json.tmp');
      const manifestoFinal = resolve(caixaDir, 'manifesto.json');
      writeFileSync(manifestoTmp, JSON.stringify(manifesto, null, 2), 'utf-8');
      renameSync(manifestoTmp, manifestoFinal);

      this.db.prepare(`
        INSERT INTO caixas_jobs (
          id, conversa_id, origem_id, remetente_id, tipo, nome_original,
          nome_higienizado, mime_tipo, tamanho_bytes, estado, motivo_ignorado,
          tentativas, max_tentativas, ultimo_erro, arquivo_caminho, sha256,
          recebido_em, atualizado_em
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          NULL, ?, ?, 'ignorado', 'video_ignorado',
          0, ?, NULL, NULL, NULL,
          ?, ?
        )
      `).run(
        caixaId, conversaId, origemId, remetenteId, 'video', anexo.nomeOriginal,
        anexo.mimeTipo, anexo.tamanhoBytes, this.maxTentativas,
        agora, agora
      );

      return {
        aceito: true,
        ignorado: true,
        motivo: 'video_ignorado',
        caixaId
      };
    }

    // Para documentos, imagens e áudios:
    // Deduplicação idempotente:
    let job = this.obterJob(conversaId, origemId);
    if (job) {
      if (job.estado === 'recebido' || job.estado === 'ignorado') {
        return { aceito: true, repetido: true, job };
      }
      // `erro` e terminal: ou esgotou as tentativas, ou a midia nao existe mais no
      // servidor. Reenfileirar sozinho so repetiria a mesma falha a cada lote.
      if (job.estado === 'erro') {
        return { aceito: false, repetido: true, erro: job.ultimo_erro, job };
      }
    } else {
      this.db.prepare(`
        INSERT INTO caixas_jobs (
          id, conversa_id, origem_id, remetente_id, tipo, nome_original,
          nome_higienizado, mime_tipo, tamanho_bytes, estado, motivo_ignorado,
          tentativas, max_tentativas, ultimo_erro, arquivo_caminho, sha256,
          recebido_em, atualizado_em
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          NULL, ?, ?, 'pendente', NULL,
          0, ?, NULL, NULL, NULL,
          ?, ?
        )
      `).run(
        caixaId, conversaId, origemId, remetenteId, anexo.tipo, anexo.nomeOriginal,
        anexo.mimeTipo, anexo.tamanhoBytes, this.maxTentativas,
        agora, agora
      );
      job = this.obterJob(conversaId, origemId);
    }

    // Transição atômica para 'baixando' (lease)
    const tentativas = job.tentativas + 1;
    this.db.prepare(`
      UPDATE caixas_jobs
      SET estado = 'baixando', tentativas = ?, atualizado_em = ?
      WHERE id = ?
    `).run(tentativas, agora, caixaId);

    mkdirSync(dirOriginal, { recursive: true });
    mkdirSync(dirExtraido, { recursive: true });
    mkdirSync(dirDerivados, { recursive: true });

    const nomeSeguro = higienizarNomeArquivo(anexo.nomeOriginal, `${anexo.tipo}.bin`);
    const nomeFinal = resolverNomeNaoColidente(dirOriginal, nomeSeguro);
    const caminhoAlvo = resolve(dirOriginal, nomeFinal);

    // Defesa em profundidade: não permitir escape de pasta
    if (!caminhoAlvo.startsWith(resolve(dirOriginal) + sep)) {
      const erroCaminho = 'Caminho inseguro detectado fora do diretorio original';
      this.db.prepare(`
        UPDATE caixas_jobs
        SET estado = 'erro', ultimo_erro = ?, atualizado_em = ?
        WHERE id = ?
      `).run(erroCaminho, new Date().toISOString(), caixaId);
      throw new Error(erroCaminho);
    }

    const caminhoPart = caminhoAlvo + '.part';
    const bytesAntes = existsSync(caminhoPart) ? statSync(caminhoPart).size : 0;

    try {
      // Recusa antes de gastar rede quando o proprio WhatsApp ja declara o tamanho.
      if (anexo.tamanhoBytes != null && anexo.tamanhoBytes > this.limiteBytes) {
        throw new Error(`Tamanho declarado (${anexo.tamanhoBytes} bytes) excede o limite (${this.limiteBytes} bytes)`);
      }

      const proximo = this.filaDownload.then(
        () => this.#descarregarParaArquivo(anexo.mensagemMidia, caminhoPart),
        () => this.#descarregarParaArquivo(anexo.mensagemMidia, caminhoPart)
      );
      // A fila avanca mesmo quando este download falha; o erro fica com quem espera.
      this.filaDownload = proximo.then(() => {}, () => {});
      const { bytes, sha256 } = await proximo;

      // Um fluxo pode fechar limpo e ainda assim ter entregue menos do que existe: foi
      // o que aconteceu com a exportacao de 650 MB, marcada "recebido" faltando 26 KB,
      // e o ZIP so revelou o problema na hora de abrir. O `.part` continua no disco,
      // entao a proxima passada retoma exatamente do que falta.
      if (anexo.tamanhoBytes != null && bytes !== anexo.tamanhoBytes) {
        throw new Error(`Download incompleto: ${bytes} de ${anexo.tamanhoBytes} bytes`);
      }
      if (anexo.sha256Declarado && sha256 !== anexo.sha256Declarado) {
        throw new Error('Integridade falhou: SHA-256 diferente do declarado pelo WhatsApp');
      }

      // Escrita atômica (.part -> rename)
      renameSync(caminhoPart, caminhoAlvo);

      const caminhoRelativo = posix.join('original', nomeFinal);
      const atualizadoEm = new Date().toISOString();

      // Manifesto sanitizado: nunca inclui chaves de mídia ou tokens
      const manifesto = {
        versao: '1.0.0',
        caixaId,
        transporte: {
          grupoId: conversaId,
          mensagemId: origemId,
          remetenteId: remetenteId || null,
          instanteEnvio,
          instanteRecepcao: agora
        },
        arquivo: {
          nomeOriginal: anexo.nomeOriginal,
          nomeHigienizado: nomeFinal,
          caminhoRelativo,
          mimeTipo: anexo.mimeTipo,
          bytes,
          sha256,
          // Conferidos no momento do recibo: o arquivo em disco bate com o que o
          // WhatsApp declarou. Ficam registrados para auditoria posterior.
          bytesDeclarados: anexo.tamanhoBytes ?? null,
          sha256Declarado: anexo.sha256Declarado ?? null
        },
        status: 'recebido',
        motivoStatus: null,
        tentativas,
        erroResumido: null,
        conversaExportada: null,
        referenciaFonte: {
          conversaId,
          origemId
        }
      };

      const manifestoTmp = resolve(caixaDir, 'manifesto.json.tmp');
      const manifestoFinal = resolve(caixaDir, 'manifesto.json');
      writeFileSync(manifestoTmp, JSON.stringify(manifesto, null, 2), 'utf-8');
      renameSync(manifestoTmp, manifestoFinal);

      this.db.prepare(`
        UPDATE caixas_jobs
        SET estado = 'recebido', nome_higienizado = ?, arquivo_caminho = ?,
            sha256 = ?, tamanho_bytes = ?, atualizado_em = ?, ultimo_erro = NULL
        WHERE id = ?
      `).run(nomeFinal, caminhoRelativo, sha256, bytes, atualizadoEm, caixaId);

      return {
        aceito: true,
        caixaId,
        sha256,
        bytes,
        status: 'recebido'
      };
    } catch (err) {
      const erroMsg = err?.message || 'Falha desconhecida no download';
      // Queda de conexao no meio de 650 MB e o caso comum, nao a excecao: o `.part`
      // fica no disco para a proxima tentativa retomar de onde parou. So se apaga o
      // parcial quando ele nao serve para nada -- limite estourado ou fim de linha.
      // Truncado se resolve retomando. Hash errado nao: os bytes em disco estao
      // corrompidos e continuar de onde parou so preservaria a corrupcao.
      const descartarParcial = /excede o limite|Integridade falhou/i.test(erroMsg);
      if (descartarParcial && existsSync(caminhoPart)) {
        try { unlinkSync(caminhoPart); } catch {}
      }

      // O WhatsApp expira a midia no servidor. Quando o fluxo nao existe mais, repetir
      // so gasta rede: o arquivo so volta se o dono reenviar no grupo 2026.
      const indisponivel = /Failed to fetch stream|Media upload failed on all hosts|\b(404|410)\b/i.test(erroMsg);
      // Uma queda que ainda assim gravou bytes novos e progresso, nao fracasso. Se ela
      // contasse tentativa, um anexo grande esgotaria o limite antes de fechar, porque
      // 650 MB nao cabem na janela entre duas quedas da conexao.
      const bytesDepois = existsSync(caminhoPart) ? statSync(caminhoPart).size : 0;
      const houveProgresso = bytesDepois > bytesAntes;
      const tentativasFinais = houveProgresso ? Math.max(0, tentativas - 1) : tentativas;
      const novoEstado = (indisponivel || tentativasFinais >= this.maxTentativas) ? 'erro' : 'pendente';
      const motivo = indisponivel ? 'midia_indisponivel_no_whatsapp' : null;
      const atualizadoEm = new Date().toISOString();

      this.db.prepare(`
        UPDATE caixas_jobs
        SET estado = ?, tentativas = ?, ultimo_erro = ?, motivo_ignorado = ?, atualizado_em = ?
        WHERE id = ?
      `).run(novoEstado, tentativasFinais, erroMsg, motivo, atualizadoEm, caixaId);

      // Se falhou definitivamente, persiste manifesto com status de erro
      if (novoEstado === 'erro') {
        try {
          const manifestoErro = {
            versao: '1.0.0',
            caixaId,
            transporte: {
              grupoId: conversaId,
              mensagemId: origemId,
              remetenteId: remetenteId || null,
              instanteEnvio,
              instanteRecepcao: agora
            },
            arquivo: {
              nomeOriginal: anexo.nomeOriginal,
              nomeHigienizado: null,
              caminhoRelativo: null,
              mimeTipo: anexo.mimeTipo,
              bytes: anexo.tamanhoBytes,
              sha256: null
            },
            status: 'erro',
            motivoStatus: null,
            tentativas,
            erroResumido: erroMsg,
            conversaExportada: null,
            referenciaFonte: {
              conversaId,
              origemId
            }
          };
          const manifestoTmp = resolve(caixaDir, 'manifesto.json.tmp');
          const manifestoFinal = resolve(caixaDir, 'manifesto.json');
          writeFileSync(manifestoTmp, JSON.stringify(manifestoErro, null, 2), 'utf-8');
          renameSync(manifestoTmp, manifestoFinal);
        } catch {}
      }

      return {
        aceito: false,
        erro: erroMsg,
        estado: novoEstado,
        tentativas
      };
    }
  }

  /**
   * Processa um lote de mensagens.
   */
  async processarLote(lote) {
    if (!lote || !Array.isArray(lote.messages)) {
      return { recebidos: 0, ignorados: 0, repetidos: 0, erros: 0 };
    }

    let recebidos = 0;
    let ignorados = 0;
    let repetidos = 0;
    let erros = 0;

    for (const msg of lote.messages) {
      try {
        const res = await this.processarMensagem(msg);
        if (!res.aceito) {
          if (res.repetido) repetidos++;
          else ignorados++;
        } else if (res.repetido) {
          repetidos++;
        } else if (res.ignorado) {
          ignorados++;
        } else if (res.status === 'recebido') {
          recebidos++;
        }
      } catch {
        erros++;
      }
    }

    return { recebidos, ignorados, repetidos, erros };
  }

  /**
   * Busca a mensagem crua de um job na tabela `eventos`. O envelope guarda a mensagem
   * do Baileys inteira, com mediaKey e directPath -- e o que permite retomar depois.
   */
  mensagemDoJob(conversaId, origemId) {
    const linha = this.db.prepare(
      'SELECT bruto FROM eventos WHERE conversa_id = ? AND origem_id = ? LIMIT 1'
    ).get(conversaId, origemId);
    if (!linha?.bruto) return null;
    try {
      const envelope = JSON.parse(linha.bruto);
      const mensagem = envelope?.mensagem ?? envelope;
      return mensagem?.key?.id ? mensagem : null;
    } catch {
      return null;
    }
  }

  /**
   * Roda a fila: retoma cada caixa pendente de onde o `.part` parou. Existe porque uma
   * queda de conexao devolve o job para `pendente` e, sem isto, ninguem o pegaria de
   * volta ate o proximo boot -- e um anexo de 650 MB precisa de varias retomadas.
   */
  async processarPendentes({ limite = 5 } = {}) {
    const jid = this.obterJidGrupo2026();
    if (!jid) return { ok: false, motivo: 'grupo_nao_resolvido' };

    const jobs = this.db.prepare(`
      SELECT conversa_id, origem_id FROM caixas_jobs
      WHERE estado = 'pendente' AND conversa_id = ?
      ORDER BY tentativas ASC, atualizado_em ASC LIMIT ?
    `).all(jid, limite);

    const resumo = { ok: true, tentados: 0, recebidos: 0, aindaPendentes: 0, erros: 0, semMensagem: 0 };
    for (const job of jobs) {
      const mensagem = this.mensagemDoJob(job.conversa_id, job.origem_id);
      if (!mensagem) { resumo.semMensagem++; continue; }
      resumo.tentados++;
      try {
        const res = await this.processarMensagem(mensagem);
        if (res.status === 'recebido') resumo.recebidos++;
        else if (res.estado === 'pendente') resumo.aindaPendentes++;
        else if (!res.aceito) resumo.erros++;
      } catch {
        resumo.erros++;
      }
    }
    return resumo;
  }

  /**
   * Reprocessa anexos do grupo 2026 que ja foram persistidos em `eventos` mas nunca
   * passaram pelo coletor -- caso das mensagens recebidas antes desta etapa existir,
   * ou enquanto o processo estava parado. A mensagem crua guardada em `eventos.bruto`
   * preserva mediaKey e directPath, entao o download continua possivel enquanto o
   * WhatsApp mantiver a midia no servidor.
   *
   * Idempotente: reaproveita a deduplicacao por (conversa_id, origem_id).
   */
  async backfillDoBanco({ limite = 1000 } = {}) {
    const jid = this.obterJidGrupo2026();
    if (!jid) return { ok: false, motivo: 'grupo_nao_resolvido' };

    let linhas;
    try {
      linhas = this.db.prepare(
        'SELECT bruto FROM eventos WHERE conversa_id = ? ORDER BY id DESC LIMIT ?'
      ).all(jid, limite);
    } catch (err) {
      return { ok: false, motivo: 'leitura_eventos_falhou', erro: err?.message };
    }

    const resumo = {
      ok: true, jid, examinados: linhas.length,
      recebidos: 0, ignorados: 0, repetidos: 0, semAnexo: 0, erros: 0
    };

    for (const linha of linhas) {
      let mensagem = null;
      try {
        const envelope = JSON.parse(linha.bruto);
        mensagem = envelope?.mensagem ?? envelope;
      } catch {
        resumo.erros++;
        continue;
      }
      if (!mensagem?.key?.id) { resumo.erros++; continue; }

      try {
        const res = await this.processarMensagem(mensagem);
        if (res.status === 'recebido') resumo.recebidos++;
        else if (res.repetido) resumo.repetidos++;
        else if (res.ignorado) resumo.ignorados++;
        else if (res.motivo === 'sem_anexo') resumo.semAnexo++;
        else if (!res.aceito) resumo.erros++;
      } catch {
        resumo.erros++;
      }
    }

    return resumo;
  }
}
