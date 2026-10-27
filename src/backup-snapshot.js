import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
  lstatSync,
  linkSync,
  copyFileSync,
  rmSync,
  mkdtempSync,
  realpathSync,
  createReadStream,
  constants
} from 'node:fs';
import path from 'node:path';

export class ErroSnapshot extends Error {
  constructor(mensagem, codigo) {
    super(mensagem);
    this.name = 'ErroSnapshot';
    this.codigo = codigo;
  }
}

function normalizarCaminho(caminho) {
  if (typeof caminho !== 'string' || !caminho.trim()) {
    throw new ErroSnapshot('Caminho informado é inválido.', 'CAMINHO_INVALIDO');
  }
  return path.resolve(caminho);
}

function caminhoExisteOuLink(caminho) {
  try {
    lstatSync(caminho);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

function caminhosIguais(caminhoA, caminhoB) {
  const normA = normalizarCaminho(caminhoA);
  const normB = normalizarCaminho(caminhoB);
  if (process.platform === 'win32') {
    if (normA.toLowerCase() === normB.toLowerCase()) return true;
  } else {
    if (normA === normB) return true;
  }

  // Se ambos os caminhos existem fisicamente, verifica se apontam para o mesmo inode/dispositivo ou mesmo realpath
  if (caminhoExisteOuLink(normA) && caminhoExisteOuLink(normB)) {
    try {
      const realA = realpathSync.native ? realpathSync.native(normA) : realpathSync(normA);
      const realB = realpathSync.native ? realpathSync.native(normB) : realpathSync(normB);
      if (process.platform === 'win32') {
        if (realA.toLowerCase() === realB.toLowerCase()) return true;
      } else {
        if (realA === realB) return true;
      }
      const statA = statSync(normA);
      const statB = statSync(normB);
      if (statA.dev === statB.dev && statA.ino === statB.ino) {
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Calcula o hash SHA-256 via streaming assíncrono.
 * Não carrega o arquivo inteiro em memória (evita estouro de heap em bases grandes).
 */
export async function calcularSha256Arquivo(caminho) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(caminho);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Publica um arquivo de staging para o caminho final sem sobrescrita.
 * Rejeita symlinks, hardlinks e arquivos surgidos durante a operação.
 */
function publicarArquivoSemSobrescrita(caminhoStaging, caminhoDestino) {
  if (caminhoExisteOuLink(caminhoDestino)) {
    throw new ErroSnapshot(
      `O arquivo de destino já existe: ${caminhoDestino}. Sobrescrita não autorizada.`,
      'DESTINO_JA_EXISTE'
    );
  }

  try {
    linkSync(caminhoStaging, caminhoDestino);
    unlinkSync(caminhoStaging);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new ErroSnapshot(
        `O arquivo de destino já existe: ${caminhoDestino}. Sobrescrita não autorizada.`,
        'DESTINO_JA_EXISTE'
      );
    }
    // Em sistemas de arquivos sem suporte a hardlinks ou cross-device, usa cópia exclusiva
    if (['EXDEV', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(err.code)) {
      try {
        copyFileSync(caminhoStaging, caminhoDestino, constants.COPYFILE_EXCL);
        unlinkSync(caminhoStaging);
      } catch (copyErr) {
        if (copyErr.code === 'EEXIST') {
          throw new ErroSnapshot(
            `O arquivo de destino já existe: ${caminhoDestino}. Sobrescrita não autorizada.`,
            'DESTINO_JA_EXISTE'
          );
        }
        throw copyErr;
      }
    } else {
      throw err;
    }
  }
}

function validarSchemaManifesto(manifesto) {
  if (!manifesto || typeof manifesto !== 'object' || Array.isArray(manifesto)) {
    throw new ErroSnapshot('Manifesto inválido ou corrompido.', 'MANIFESTO_INVALIDO');
  }

  if (manifesto.formato !== 'lume-sqlite-snapshot-v1') {
    throw new ErroSnapshot(
      `Formato de manifesto não reconhecido: ${manifesto.formato}`,
      'MANIFESTO_FORMATO_DESCONHECIDO'
    );
  }

  if (typeof manifesto.versao_manifesto !== 'number' || manifesto.versao_manifesto < 1) {
    throw new ErroSnapshot('Versão de manifesto inválida.', 'MANIFESTO_INVALIDO');
  }

  if (
    !manifesto.snapshot ||
    typeof manifesto.snapshot !== 'object' ||
    typeof manifesto.snapshot.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(manifesto.snapshot.sha256) ||
    typeof manifesto.snapshot.tamanho_bytes !== 'number' ||
    manifesto.snapshot.tamanho_bytes < 0
  ) {
    throw new ErroSnapshot('Metadados de snapshot ausentes ou inválidos no manifesto.', 'MANIFESTO_INVALIDO');
  }

  if (
    !manifesto.sqlite ||
    typeof manifesto.sqlite !== 'object' ||
    manifesto.sqlite.integridade !== 'ok' ||
    typeof manifesto.sqlite.user_version !== 'number' ||
    typeof manifesto.sqlite.application_id !== 'number' ||
    !manifesto.sqlite.contagens ||
    typeof manifesto.sqlite.contagens !== 'object' ||
    !Array.isArray(manifesto.sqlite.esquema)
  ) {
    throw new ErroSnapshot('Metadados SQLite ausentes ou inválidos no manifesto.', 'MANIFESTO_INVALIDO');
  }

  if (
    !manifesto.fronteira ||
    typeof manifesto.fronteira !== 'object' ||
    manifesto.fronteira.tipo !== 'snapshot_tecnico_sqlite'
  ) {
    throw new ErroSnapshot('Metadados de fronteira ausentes ou inválidos no manifesto.', 'MANIFESTO_INVALIDO');
  }
}

/**
 * Cria snapshot técnico consistente de um banco SQLite via API oficial backup().
 * Abre a origem exclusivamente em modo readOnly, respeitando leitores e escritores WAL concorrentes.
 * Nunca executa DDL na origem nem importa serviços do app.
 */
export async function criarSnapshot({
  caminhoOrigem,
  caminhoDestino,
  gerarManifesto = true,
  permitirSobrescrita = false
} = {}) {
  if (permitirSobrescrita) {
    throw new ErroSnapshot('Sobrescrita de destino não é suportada nem permitida.', 'SOBRESCRITA_NAO_PERMITIDA');
  }

  const origemResolvida = normalizarCaminho(caminhoOrigem);
  const destinoResolvido = normalizarCaminho(caminhoDestino);

  if (!caminhoExisteOuLink(origemResolvida)) {
    throw new ErroSnapshot(
      `Arquivo de banco de dados de origem não foi encontrado: ${origemResolvida}`,
      'ORIGEM_NAO_ENCONTRADA'
    );
  }

  if (caminhosIguais(origemResolvida, destinoResolvido)) {
    throw new ErroSnapshot(
      'Caminho de origem e caminho de destino são idênticos. Operação abortada para evitar corrupção.',
      'ORIGEM_IGUAL_DESTINO'
    );
  }

  if (caminhoExisteOuLink(destinoResolvido)) {
    throw new ErroSnapshot(
      `O arquivo de destino já existe: ${destinoResolvido}. Sobrescrita não autorizada.`,
      'DESTINO_JA_EXISTE'
    );
  }

  const caminhoManifesto = `${destinoResolvido}.manifest.json`;
  if (gerarManifesto && caminhoExisteOuLink(caminhoManifesto)) {
    throw new ErroSnapshot(
      `O manifesto do destino já existe: ${caminhoManifesto}. Sobrescrita não autorizada.`,
      'MANIFESTO_JA_EXISTE'
    );
  }

  const pastaDestino = path.dirname(destinoResolvido);
  if (!existsSync(pastaDestino)) {
    mkdirSync(pastaDestino, { recursive: true });
  }

  // Staging privado exclusivo para esta execução
  const stagingDir = mkdtempSync(path.join(pastaDestino, '.lume-snapshot-staging-'));
  const stagingDb = path.join(stagingDir, 'snapshot.db');
  const stagingManifesto = path.join(stagingDir, 'snapshot.manifest.json');

  let dbOrigem = null;
  let destinoPublicado = false;
  let manifestoPublicado = false;

  try {
    // Esta conexão só lê: não executa DDL nem força checkpoint na origem.
    // readOnly não é uma garantia de ausência de efeitos sobre metadados WAL/SHM.
    dbOrigem = new DatabaseSync(origemResolvida, { readOnly: true });

    // Usa a API oficial de backup do node:sqlite gravando no staging privado
    await backup(dbOrigem, stagingDb);

    dbOrigem.close();
    dbOrigem = null;

    // Inspeciona o arquivo gerado em readOnly isolado no staging
    const dbDestino = new DatabaseSync(stagingDb, { readOnly: true });
    let integridade = 'erro';
    let fkErros = [];
    let userVersion = 0;
    let applicationId = 0;
    const contagens = {};
    const esquema = [];

    try {
      const checagem = dbDestino.prepare('PRAGMA integrity_check;').all();
      if (!checagem.length || checagem[0].integrity_check !== 'ok') {
        throw new ErroSnapshot(
          `Falha no teste de integridade do snapshot: ${JSON.stringify(checagem)}`,
          'INTEGRIDADE_FALHOU'
        );
      }
      integridade = 'ok';

      fkErros = dbDestino.prepare('PRAGMA foreign_key_check;').all();

      const uvRow = dbDestino.prepare('PRAGMA user_version;').get();
      if (uvRow && typeof uvRow.user_version === 'number') {
        userVersion = uvRow.user_version;
      }

      const appRow = dbDestino.prepare('PRAGMA application_id;').get();
      if (appRow && typeof appRow.application_id === 'number') {
        applicationId = appRow.application_id;
      }

      const itensMestre = dbDestino
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;"
        )
        .all();

      for (const item of itensMestre) {
        esquema.push({
          tipo: item.type,
          nome: item.name,
          tabela: item.tbl_name,
          sql: item.sql
        });
        if (item.type === 'table') {
          // Escapa nome da tabela para proteger contra nomes reservados
          const nomeEscapado = `"${item.name.replace(/"/g, '""')}"`;
          const contagemRow = dbDestino
            .prepare(`SELECT COUNT(*) AS total FROM ${nomeEscapado};`)
            .get();
          contagens[item.name] = contagemRow?.total ?? 0;
        }
      }
    } finally {
      dbDestino.close();
    }

    const stats = statSync(stagingDb);
    const sha256 = await calcularSha256Arquivo(stagingDb);

    const manifesto = {
      formato: 'lume-sqlite-snapshot-v1',
      versao_manifesto: 1,
      criado_em: new Date().toISOString(),
      origem: {
        caminho: origemResolvida
      },
      snapshot: {
        caminho: destinoResolvido,
        sha256,
        tamanho_bytes: stats.size
      },
      sqlite: {
        integridade,
        foreign_keys_violadas: fkErros.length,
        user_version: userVersion,
        application_id: applicationId,
        tabelas_total: Object.keys(contagens).length,
        contagens,
        esquema
      },
      fronteira: {
        tipo: 'snapshot_tecnico_sqlite',
        contem_anexos_disco: false,
        exclusao_arquivos_externos_credenciais: true,
        preservacao_integral_banco: true,
        promocao_automatica_permitida: false,
        aviso:
          'Snapshot técnico exclusivo de tabelas SQLite. Preserva integralmente o banco, mas exclui anexos e arquivos externos de credenciais. Não há garantia de ausência de segredos contidos nos próprios registros do banco. Não substitui o backup completo de anexos e nunca autoriza promoção automática para produção.'
      }
    };

    if (gerarManifesto) {
      writeFileSync(stagingManifesto, JSON.stringify(manifesto, null, 2), 'utf8');
    }

    // Publicação sem sobrescrita; o fallback de cópia não é atômico para leitores.
    publicarArquivoSemSobrescrita(stagingDb, destinoResolvido);
    destinoPublicado = true;

    if (gerarManifesto) {
      publicarArquivoSemSobrescrita(stagingManifesto, caminhoManifesto);
      manifestoPublicado = true;
    }

    return {
      caminhoDestino: destinoResolvido,
      caminhoManifesto: gerarManifesto ? caminhoManifesto : null,
      manifesto
    };
  } catch (erro) {
    if (dbOrigem) {
      try {
        dbOrigem.close();
      } catch {}
      dbOrigem = null;
    }

    // Cleanup restrito exclusivamente a objetos publicados nesta execução com posse provada
    if (destinoPublicado) {
      try {
        unlinkSync(destinoResolvido);
      } catch {}
    }
    if (manifestoPublicado) {
      try {
        unlinkSync(caminhoManifesto);
      } catch {}
    }

    throw erro;
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Restaura um snapshot para um novo caminho de arquivo isolado.
 * Valida hash contra o manifesto obrigatoriamente por padrão e roda checagem de integridade.
 * Não conecta provedores, rede, modelos nem o serviço desktop.
 */
export async function restaurarSnapshot({
  caminhoSnapshot,
  caminhoDestino,
  validarManifesto = true,
  permitirSobrescrita = false
} = {}) {
  if (permitirSobrescrita) {
    throw new ErroSnapshot('Sobrescrita de destino não é suportada nem permitida.', 'SOBRESCRITA_NAO_PERMITIDA');
  }

  const snapshotResolvido = normalizarCaminho(caminhoSnapshot);
  const destinoResolvido = normalizarCaminho(caminhoDestino);

  if (!caminhoExisteOuLink(snapshotResolvido)) {
    throw new ErroSnapshot(
      `Snapshot não encontrado para restauração: ${snapshotResolvido}`,
      'SNAPSHOT_NAO_ENCONTRADO'
    );
  }

  if (caminhosIguais(snapshotResolvido, destinoResolvido)) {
    throw new ErroSnapshot(
      'Caminho de snapshot e caminho de restauração são idênticos.',
      'ORIGEM_IGUAL_DESTINO'
    );
  }

  if (caminhoExisteOuLink(destinoResolvido)) {
    throw new ErroSnapshot(
      `O arquivo de restauração de destino já existe: ${destinoResolvido}.`,
      'DESTINO_JA_EXISTE'
    );
  }

  let manifestoEsperado = null;
  const caminhoManifesto = `${snapshotResolvido}.manifest.json`;

  if (validarManifesto) {
    if (!caminhoExisteOuLink(caminhoManifesto)) {
      throw new ErroSnapshot(
        `Manifesto do snapshot não encontrado: ${caminhoManifesto}`,
        'MANIFESTO_NAO_ENCONTRADO'
      );
    }

    const stManifesto = statSync(caminhoManifesto);
    if (stManifesto.size > 2 * 1024 * 1024) {
      throw new ErroSnapshot(
        'Arquivo de manifesto excede o limite máximo permitido de 2 MB.',
        'MANIFESTO_INVALIDO'
      );
    }

    try {
      manifestoEsperado = JSON.parse(readFileSync(caminhoManifesto, 'utf8'));
    } catch {
      throw new ErroSnapshot(
        'Manifesto do snapshot corrompido ou JSON inválido.',
        'MANIFESTO_INVALIDO'
      );
    }

    validarSchemaManifesto(manifestoEsperado);

    const shaSnapshotAntes = await calcularSha256Arquivo(snapshotResolvido);
    if (shaSnapshotAntes !== manifestoEsperado.snapshot.sha256) {
      throw new ErroSnapshot(
        `Hash do snapshot divergente do manifesto. Esperado: ${manifestoEsperado.snapshot.sha256}, Atual: ${shaSnapshotAntes}`,
        'HASH_DIVERGENTE'
      );
    }
  }

  const pastaDestino = path.dirname(destinoResolvido);
  if (!existsSync(pastaDestino)) {
    mkdirSync(pastaDestino, { recursive: true });
  }

  const stagingDir = mkdtempSync(path.join(pastaDestino, '.lume-restore-staging-'));
  const stagingDb = path.join(stagingDir, 'restaurado.db');

  let dbSnapshot = null;
  let destinoPublicado = false;

  try {
    dbSnapshot = new DatabaseSync(snapshotResolvido, { readOnly: true });
    await backup(dbSnapshot, stagingDb);
    dbSnapshot.close();
    dbSnapshot = null;

    if (validarManifesto) {
      // Verifica se a origem foi modificada concorrentemente durante o processo de cópia
      const shaSnapshotDepois = await calcularSha256Arquivo(snapshotResolvido);
      if (shaSnapshotDepois !== manifestoEsperado.snapshot.sha256) {
        throw new ErroSnapshot(
          'Arquivo de snapshot de origem foi modificado durante o processo de restauração.',
          'ORIGEM_ALTERADA'
        );
      }

      // Restauração vinculada ao conteúdo efetivamente copiado no staging
      const shaStaging = await calcularSha256Arquivo(stagingDb);
      if (shaStaging !== manifestoEsperado.snapshot.sha256) {
        throw new ErroSnapshot(
          `Hash do banco restaurado divergente do manifesto. Esperado: ${manifestoEsperado.snapshot.sha256}, Atual: ${shaStaging}`,
          'HASH_DIVERGENTE'
        );
      }

      const stStaging = statSync(stagingDb);
      if (stStaging.size !== manifestoEsperado.snapshot.tamanho_bytes) {
        throw new ErroSnapshot(
          `Tamanho do banco restaurado divergente do manifesto. Esperado: ${manifestoEsperado.snapshot.tamanho_bytes}, Atual: ${stStaging.size}`,
          'HASH_DIVERGENTE'
        );
      }
    }

    // Inspeciona integridade do banco restaurado dentro do staging privado
    const dbRestaurado = new DatabaseSync(stagingDb, { readOnly: true });
    try {
      const checagem = dbRestaurado.prepare('PRAGMA integrity_check;').all();
      if (!checagem.length || checagem[0].integrity_check !== 'ok') {
        throw new ErroSnapshot(
          `Falha de integridade após restauração: ${JSON.stringify(checagem)}`,
          'INTEGRIDADE_FALHOU'
        );
      }
    } finally {
      dbRestaurado.close();
    }

    // Publicação sem sobrescrita; o fallback de cópia não é atômico para leitores.
    publicarArquivoSemSobrescrita(stagingDb, destinoResolvido);
    destinoPublicado = true;

    return {
      ok: true,
      caminhoDestino: destinoResolvido,
      integridade: 'ok',
      manifestoValidado: Boolean(manifestoEsperado)
    };
  } catch (erro) {
    if (dbSnapshot) {
      try {
        dbSnapshot.close();
      } catch {}
      dbSnapshot = null;
    }

    if (destinoPublicado) {
      try {
        unlinkSync(destinoResolvido);
      } catch {}
    }

    throw erro;
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Validação de salvaguarda: snapshot técnico puro de SQLite nunca autoriza
 * promoção para produção, independente de qualquer flag no manifesto JSON.
 */
export function impedirPromocaoAutomatica(manifesto) {
  if (!manifesto || typeof manifesto !== 'object' || Array.isArray(manifesto)) {
    throw new ErroSnapshot(
      'Manifesto inválido para avaliação de promoção.',
      'MANIFESTO_INVALIDO'
    );
  }

  // Snapshot técnico puro nunca autoriza promoção automática para produção,
  // mesmo que qualquer propriedade no manifesto JSON tente afirmar autorização.
  throw new ErroSnapshot(
    'PROMOÇÃO BLOQUEADA: Snapshot técnico de SQLite puro nunca autoriza promoção automática para produção. Requer validação humana explícita e inventário completo de anexos.',
    'PROMOCAO_AUTOMATICA_BLOQUEADA'
  );
}
