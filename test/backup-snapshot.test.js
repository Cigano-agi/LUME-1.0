import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  criarSnapshot,
  restaurarSnapshot,
  impedirPromocaoAutomatica,
  calcularSha256Arquivo,
  ErroSnapshot
} from '../src/backup-snapshot.js';

function criarAmbienteTeste(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lume-snapshot-test-'));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

function inicializarBancoSintetico(caminhoDb) {
  const db = new DatabaseSync(caminhoDb);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA user_version = 42;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE conversas (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL
    );

    CREATE TABLE eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversa_id TEXT NOT NULL REFERENCES conversas(id),
      origem_id TEXT NOT NULL UNIQUE,
      texto TEXT,
      recebido_em TEXT NOT NULL
    );

    CREATE TABLE priv_excluidos (
      hash TEXT PRIMARY KEY,
      quando TEXT NOT NULL,
      motivo TEXT
    );

    -- Tabela legada para provar que snapshot não falha em tabelas desconhecidas
    CREATE TABLE caixas_jobs (
      job_id TEXT PRIMARY KEY,
      dados TEXT
    );
  `);

  db.exec("INSERT INTO conversas VALUES ('chat_01', 'Cliente Alfa');");
  db.exec("INSERT INTO conversas VALUES ('chat_02', 'Cliente Beta');");

  db.exec(
    "INSERT INTO eventos (conversa_id, origem_id, texto, recebido_em) VALUES ('chat_01', 'msg_01', 'Primeiro contato', '2026-09-26T10:00:00Z');"
  );
  db.exec(
    "INSERT INTO eventos (conversa_id, origem_id, texto, recebido_em) VALUES ('chat_01', 'msg_02', 'Proposta enviada', '2026-09-26T10:05:00Z');"
  );
  db.exec(
    "INSERT INTO priv_excluidos VALUES ('hash_tombstone_123', '2026-09-26T10:10:00Z', 'exclusao_solicitada');"
  );
  db.exec("INSERT INTO caixas_jobs VALUES ('job_legado_1', 'payload');");

  return db;
}

test('criarSnapshot gera cópia consistente com manifesto, integridade ok e contagens exatas', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  const destDbPath = path.join(dir, 'snapshot.db');
  const resultado = await criarSnapshot({
    caminhoOrigem: srcDbPath,
    caminhoDestino: destDbPath,
    gerarManifesto: true
  });

  assert.equal(resultado.caminhoDestino, destDbPath);
  assert.ok(existsSync(destDbPath));
  assert.ok(existsSync(resultado.caminhoManifesto));

  const { manifesto } = resultado;
  assert.equal(manifesto.formato, 'lume-sqlite-snapshot-v1');
  assert.equal(manifesto.sqlite.integridade, 'ok');
  assert.equal(manifesto.sqlite.user_version, 42);
  assert.equal(manifesto.sqlite.contagens.conversas, 2);
  assert.equal(manifesto.sqlite.contagens.eventos, 2);
  assert.equal(manifesto.sqlite.contagens.priv_excluidos, 1);
  assert.equal(manifesto.sqlite.contagens.caixas_jobs, 1);

  // Distinção formal da fronteira de segurança
  assert.equal(manifesto.fronteira.preservacao_integral_banco, true);
  assert.equal(manifesto.fronteira.exclusao_arquivos_externos_credenciais, true);
  assert.equal(manifesto.fronteira.contem_anexos_disco, false);
  assert.equal(manifesto.fronteira.promocao_automatica_permitida, false);
  assert.equal(manifesto.fronteira.contem_credenciais, undefined, 'Não deve fazer afirmação genérica de ausência de segredos no DB');
});

test('criarSnapshot opera de forma consistente com escrita concorrente em WAL', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem-wal.db');
  const writer = inicializarBancoSintetico(srcDbPath);

  // Mantém escritor aberto com transação não checkpointada
  writer.exec(
    "INSERT INTO eventos (conversa_id, origem_id, texto, recebido_em) VALUES ('chat_02', 'msg_03', 'Mensagem durante WAL', '2026-09-26T10:15:00Z');"
  );

  const destDbPath = path.join(dir, 'snapshot-wal.db');
  const { manifesto } = await criarSnapshot({
    caminhoOrigem: srcDbPath,
    caminhoDestino: destDbPath
  });

  // O escritor continua vivo e escreve mais após o snapshot
  writer.exec(
    "INSERT INTO eventos (conversa_id, origem_id, texto, recebido_em) VALUES ('chat_02', 'msg_04', 'Mensagem apos snapshot', '2026-09-26T10:20:00Z');"
  );
  writer.close();

  assert.equal(manifesto.sqlite.integridade, 'ok');
  // O snapshot capturou o estado com msg_03 que já estava gravada na origem
  assert.equal(manifesto.sqlite.contagens.eventos, 3);

  // Abre o snapshot restaurado em readOnly e confere integridade
  const destDb = new DatabaseSync(destDbPath, { readOnly: true });
  const checagem = destDb.prepare('PRAGMA integrity_check;').all();
  assert.equal(checagem[0].integrity_check, 'ok');
  destDb.close();
});

test('recusa sobrescrita se destino já existe', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const destDbPath = path.join(dir, 'existente.db');

  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  writeFileSync(destDbPath, 'conteudo previo que nao pode ser destruido');

  await assert.rejects(
    async () => {
      await criarSnapshot({
        caminhoOrigem: srcDbPath,
        caminhoDestino: destDbPath
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'DESTINO_JA_EXISTE');
      return true;
    }
  );

  assert.equal(
    readFileSync(destDbPath, 'utf8'),
    'conteudo previo que nao pode ser destruido'
  );

  // Rejeição explícita da opção permitirSobrescrita
  await assert.rejects(
    async () => {
      await criarSnapshot({
        caminhoOrigem: srcDbPath,
        caminhoDestino: destDbPath,
        permitirSobrescrita: true
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'SOBRESCRITA_NAO_PERMITIDA');
      return true;
    }
  );
});

test('recusa quando origem e destino são o mesmo arquivo', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  await assert.rejects(
    async () => {
      await criarSnapshot({
        caminhoOrigem: srcDbPath,
        caminhoDestino: srcDbPath
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'ORIGEM_IGUAL_DESTINO');
      return true;
    }
  );
});

test('cleanup em caso de falha remove apenas alvos criados e preserva arquivos pré-existentes', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem-corrompida.db');
  const preexistente = path.join(dir, 'outro-arquivo.txt');
  writeFileSync(preexistente, 'preservar');

  // Cria um arquivo que não é um sqlite válido
  writeFileSync(srcDbPath, 'este nao e um banco sqlite valido');

  const destDbPath = path.join(dir, 'destino-falha.db');

  await assert.rejects(async () => {
    await criarSnapshot({
      caminhoOrigem: srcDbPath,
      caminhoDestino: destDbPath
    });
  });

  assert.ok(!existsSync(destDbPath), 'Destino incompleto deve ser limpo');
  assert.ok(
    !existsSync(`${destDbPath}.manifest.json`),
    'Manifesto incompleto deve ser limpo'
  );
  assert.ok(existsSync(srcDbPath), 'Origem não deve ser removida');
  assert.ok(
    existsSync(preexistente),
    'Arquivo pré-existente não deve ser tocado'
  );
});

test('preservação estrita: tabelas, IDs, tombstones e chaves estrangeiras', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  const destDbPath = path.join(dir, 'snapshot.db');
  await criarSnapshot({
    caminhoOrigem: srcDbPath,
    caminhoDestino: destDbPath
  });

  const snapshotDb = new DatabaseSync(destDbPath, { readOnly: true });

  const eventos = snapshotDb
    .prepare('SELECT id, conversa_id, origem_id FROM eventos ORDER BY id;')
    .all()
    .map((e) => ({ ...e }));
  assert.deepEqual(eventos, [
    { id: 1, conversa_id: 'chat_01', origem_id: 'msg_01' },
    { id: 2, conversa_id: 'chat_01', origem_id: 'msg_02' }
  ]);

  const tombstones = snapshotDb.prepare('SELECT * FROM priv_excluidos;').all();
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].hash, 'hash_tombstone_123');

  const fks = snapshotDb.prepare('PRAGMA foreign_key_check;').all();
  assert.equal(fks.length, 0, 'Zero violações de chave estrangeira');

  snapshotDb.close();
});

test('restaurarSnapshot reabre e restaura para novo caminho isolado sem iniciar serviços', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  const snapshotPath = path.join(dir, 'snapshot.db');
  await criarSnapshot({
    caminhoOrigem: srcDbPath,
    caminhoDestino: snapshotPath,
    gerarManifesto: true
  });

  const restauradoPath = path.join(dir, 'restaurado.db');
  const res = await restaurarSnapshot({
    caminhoSnapshot: snapshotPath,
    caminhoDestino: restauradoPath,
    validarManifesto: true
  });

  assert.equal(res.ok, true);
  assert.equal(res.integridade, 'ok');
  assert.equal(res.manifestoValidado, true);
  assert.ok(existsSync(restauradoPath));

  // Restart / reabertura isolada
  const dbRestaurado = new DatabaseSync(restauradoPath, { readOnly: true });
  assert.equal(
    dbRestaurado.prepare('PRAGMA integrity_check;').get().integrity_check,
    'ok'
  );
  assert.equal(
    dbRestaurado.prepare('SELECT COUNT(*) total FROM eventos;').get().total,
    2
  );
  dbRestaurado.close();
});

test('restaurarSnapshot rejeita arquivo com hash adulterado em relação ao manifesto', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  const snapshotPath = path.join(dir, 'snapshot.db');
  await criarSnapshot({
    caminhoOrigem: srcDbPath,
    caminhoDestino: snapshotPath,
    gerarManifesto: true
  });

  // Adultera o snapshot
  const buffer = readFileSync(snapshotPath);
  buffer[buffer.length - 1] = buffer[buffer.length - 1] === 0 ? 1 : 0;
  writeFileSync(snapshotPath, buffer);

  const restauradoPath = path.join(dir, 'restaurado.db');
  await assert.rejects(
    async () => {
      await restaurarSnapshot({
        caminhoSnapshot: snapshotPath,
        caminhoDestino: restauradoPath,
        validarManifesto: true
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'HASH_DIVERGENTE');
      return true;
    }
  );
});

test('isolamento verificável: módulos de snapshot não importam serviços de rede, electron ou subprocessos', () => {
  // Substituição do teste tautológico anterior por inspeção concreta e verificável do código-fonte do módulo
  const modulePath = path.resolve('src/backup-snapshot.js');
  const sourceCode = readFileSync(modulePath, 'utf8');

  // Verifica ausência estrita de bibliotecas e serviços proibidos
  const prohibitedModules = [
    'desktop/service',
    'banco.js',
    'electron',
    'node:child_process',
    'node:net',
    'node:http',
    'node:https',
    'node:dgram',
    'ws'
  ];

  for (const mod of prohibitedModules) {
    const importRegex = new RegExp(`['"]${mod.replace('.', '\\.')}['"]`, 'i');
    assert.equal(
      importRegex.test(sourceCode),
      false,
      `Módulo proibido encontrado nos imports de backup-snapshot.js: ${mod}`
    );
  }

  // Verifica que recursos ativos do Node não incluem sockets abertos pelo módulo
  if (typeof process.getActiveResourcesInfo === 'function') {
    const active = process.getActiveResourcesInfo();
    const hasNetSocket = active.some((r) => r === 'TCPWrap' || r === 'HTTPParser');
    assert.equal(hasNetSocket, false, 'Nenhum socket ou parser HTTP ativo durante operação de snapshot');
  }
});

test('fronteira segura: impedirPromocaoAutomatica rejeita snapshot puro mesmo com flag manipulada no JSON', () => {
  const manifestoPuro = {
    formato: 'lume-sqlite-snapshot-v1',
    fronteira: {
      tipo: 'snapshot_tecnico_sqlite',
      contem_anexos_disco: false,
      promocao_automatica_permitida: false
    }
  };

  assert.throws(
    () => {
      impedirPromocaoAutomatica(manifestoPuro);
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'PROMOCAO_AUTOMATICA_BLOQUEADA');
      return true;
    }
  );

  // Tentativa de burlar salvaguarda injetando promocao_automatica_permitida = true
  const manifestoManipulado = {
    formato: 'lume-sqlite-snapshot-v1',
    fronteira: {
      tipo: 'snapshot_tecnico_sqlite',
      contem_anexos_disco: false,
      promocao_automatica_permitida: true
    }
  };

  assert.throws(
    () => {
      impedirPromocaoAutomatica(manifestoManipulado);
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'PROMOCAO_AUTOMATICA_BLOQUEADA');
      return true;
    }
  );

  // Entrada inválida
  assert.throws(
    () => {
      impedirPromocaoAutomatica(null);
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'MANIFESTO_INVALIDO');
      return true;
    }
  );
});

/* =========================================================================
   TESTES REGRESSIVOS PARA DEFEITOS REPRODUZIDOS P0/P1
   ========================================================================= */

test('REGRESSÃO P0: restaurarSnapshot nunca apaga destino pré-existente mesmo com erro ou tentativa de sobrescrita', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  const snapshotPath = path.join(dir, 'snapshot.db');
  await criarSnapshot({
    caminhoOrigem: srcDbPath,
    caminhoDestino: snapshotPath,
    gerarManifesto: true
  });

  const preexistentePath = path.join(dir, 'arquivo-critico.db');
  writeFileSync(preexistentePath, 'DADOS_CRITICOS_PREEXISTENTES');

  // 1. Rejeição com flag permitirSobrescrita
  await assert.rejects(
    async () => {
      await restaurarSnapshot({
        caminhoSnapshot: snapshotPath,
        caminhoDestino: preexistentePath,
        permitirSobrescrita: true
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'SOBRESCRITA_NAO_PERMITIDA');
      return true;
    }
  );
  assert.equal(readFileSync(preexistentePath, 'utf8'), 'DADOS_CRITICOS_PREEXISTENTES');

  // 2. Rejeição padrão (DESTINO_JA_EXISTE)
  await assert.rejects(
    async () => {
      await restaurarSnapshot({
        caminhoSnapshot: snapshotPath,
        caminhoDestino: preexistentePath,
        permitirSobrescrita: false
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'DESTINO_JA_EXISTE');
      return true;
    }
  );
  assert.equal(readFileSync(preexistentePath, 'utf8'), 'DADOS_CRITICOS_PREEXISTENTES');
});

test('REGRESSÃO P1: restaurarSnapshot falha com MANIFESTO_NAO_ENCONTRADO quando validarManifesto=true e manifesto ausente', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  // Snapshot gerado sem manifesto
  const snapshotPath = path.join(dir, 'snapshot-sem-manifesto.db');
  await criarSnapshot({
    caminhoOrigem: srcDbPath,
    caminhoDestino: snapshotPath,
    gerarManifesto: false
  });

  const restauradoPath = path.join(dir, 'restaurado.db');

  // validarManifesto=true é o padrão, logo deve rejeitar estritamente se não houver manifesto
  await assert.rejects(
    async () => {
      await restaurarSnapshot({
        caminhoSnapshot: snapshotPath,
        caminhoDestino: restauradoPath
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'MANIFESTO_NAO_ENCONTRADO');
      return true;
    }
  );

  assert.ok(!existsSync(restauradoPath), 'Destino não deve ser criado se validação de manifesto falhar');
});

test('REGRESSÃO: restaurarSnapshot valida limites de tamanho e schema do manifesto', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  const snapshotPath = path.join(dir, 'snapshot.db');
  await criarSnapshot({
    caminhoOrigem: srcDbPath,
    caminhoDestino: snapshotPath,
    gerarManifesto: true
  });

  const manifestoPath = `${snapshotPath}.manifest.json`;
  const restauradoPath = path.join(dir, 'restaurado.db');

  // 1. JSON corrompido
  writeFileSync(manifestoPath, 'INVALID_JSON_CONTENT{{{');
  await assert.rejects(
    async () => {
      await restaurarSnapshot({
        caminhoSnapshot: snapshotPath,
        caminhoDestino: restauradoPath
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'MANIFESTO_INVALIDO');
      return true;
    }
  );

  // 2. Schema incompleto / sha256 ausente
  writeFileSync(
    manifestoPath,
    JSON.stringify({
      formato: 'lume-sqlite-snapshot-v1',
      versao_manifesto: 1,
      snapshot: { caminho: 'x' } // falta sha256 e tamanho_bytes
    })
  );
  await assert.rejects(
    async () => {
      await restaurarSnapshot({
        caminhoSnapshot: snapshotPath,
        caminhoDestino: restauradoPath
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'MANIFESTO_INVALIDO');
      return true;
    }
  );
});

test('REGRESSÃO P1: criarSnapshot recusa manifesto pré-existente e nunca o apaga no cleanup', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  const destDbPath = path.join(dir, 'snapshot-alheio.db');
  const manifestoAlheioPath = `${destDbPath}.manifest.json`;
  writeFileSync(manifestoAlheioPath, 'MANIFESTO_PREEXISTENTE_DE_TERCEIROS');

  await assert.rejects(
    async () => {
      await criarSnapshot({
        caminhoOrigem: srcDbPath,
        caminhoDestino: destDbPath,
        gerarManifesto: true
      });
    },
    (err) => {
      assert.ok(err instanceof ErroSnapshot);
      assert.equal(err.codigo, 'MANIFESTO_JA_EXISTE');
      return true;
    }
  );

  assert.equal(
    readFileSync(manifestoAlheioPath, 'utf8'),
    'MANIFESTO_PREEXISTENTE_DE_TERCEIROS',
    'Manifesto de terceiros não pode ser apagado nem sobrescrito'
  );
  assert.ok(!existsSync(destDbPath));
});

test('REGRESSÃO: cleanup com gerarManifesto=false nunca remove manifesto pré-existente em falha', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbCorrompido = path.join(dir, 'corrompido.db');
  writeFileSync(srcDbCorrompido, 'nao-e-sqlite');

  const destDbPath = path.join(dir, 'novo.db');
  const manifestoAlheio = `${destDbPath}.manifest.json`;
  writeFileSync(manifestoAlheio, 'PRESERVAR_MANIFESTO');

  await assert.rejects(async () => {
    await criarSnapshot({
      caminhoOrigem: srcDbCorrompido,
      caminhoDestino: destDbPath,
      gerarManifesto: false
    });
  });

  assert.equal(
    readFileSync(manifestoAlheio, 'utf8'),
    'PRESERVAR_MANIFESTO',
    'Cleanup não deve tocar em manifesto quando gerarManifesto=false'
  );
});

test('REGRESSÃO: banco de origem permanece 100% imutável durante snapshot e restauração', async (t) => {
  const dir = criarAmbienteTeste(t);
  const srcDbPath = path.join(dir, 'origem.db');
  const db = inicializarBancoSintetico(srcDbPath);
  db.close();

  const shaAntes = await calcularSha256Arquivo(srcDbPath);
  const sizeAntes = statSync(srcDbPath).size;

  const snapshotPath = path.join(dir, 'snapshot.db');
  await criarSnapshot({
    caminhoOrigem: srcDbPath,
    caminhoDestino: snapshotPath,
    gerarManifesto: true
  });

  const restauradoPath = path.join(dir, 'restaurado.db');
  await restaurarSnapshot({
    caminhoSnapshot: snapshotPath,
    caminhoDestino: restauradoPath
  });

  const shaDepois = await calcularSha256Arquivo(srcDbPath);
  const sizeDepois = statSync(srcDbPath).size;

  assert.equal(shaDepois, shaAntes, 'Hash da origem deve ser idêntico antes e depois');
  assert.equal(sizeDepois, sizeAntes, 'Tamanho da origem deve ser idêntico antes e depois');
});
