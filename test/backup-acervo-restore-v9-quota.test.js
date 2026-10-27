import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, open, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { gravarPacote } from '../src/backup-stream.js';
import { validarAcervoV9, descartarPlanoV9 } from '../src/backup-acervo-restore-v9.js';

const senha = 'senha sintética para cota de staging';

async function comObstaculoNoPrimeiroPlaintext(pacote, raiz, action) {
  const probe = await open(pacote, 'r');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const original = proto.write;
  let observed = false;
  proto.write = async function(...args) {
    if (!observed) {
      const own = await this.stat({ bigint: true });
      for (const area of await readdir(raiz)) {
        if (!area.startsWith('.lume-restore-')) continue;
        const base = path.join(raiz, area);
        for (const name of await readdir(base)) {
          if (!name.startsWith('.lume-stream-')) continue;
          const stat = await lstat(path.join(base, name, 'conteudo.bin'), { bigint: true }).catch(() => null);
          if (stat?.dev !== own.dev || stat.ino !== own.ino) continue;
          observed = true;
          const result = await original.apply(this, args);
          await action(base);
          return result;
        }
      }
    }
    return original.apply(this, args);
  };
  return { restore() { proto.write = original; }, observed() { return observed; } };
}

test('cota de oito falhas pre-plano recupera vaga na mesma raiz após remover obstáculo próprio', { timeout: 600000 }, async () => {
  const f = await criarPerfilRealSintetico();
  const pacote = path.join(f.dir, 'acervo.lumebak');
  const ocupadas = [];
  try {
    f.db.close();
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Pessoa sintética' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });

    for (let i = 0; i < 8; i++) {
      const raizStaging = path.join(f.dir, `staging-${i}`);
      await mkdir(raizStaging);
      let obstaculo;
      const hook = await comObstaculoNoPrimeiroPlaintext(pacote, raizStaging, async base => {
        obstaculo = path.join(base, 'acervo.sqlite');
        await writeFile(obstaculo, 'objeto desconhecido sintético');
      });
      try {
        await assert.rejects(validarAcervoV9({ pacote, senha, raizStaging }), error => {
          assert.equal(error.limpezaPendente, true);
          assert.ok(error.codigosLimpeza.includes('OBJETO_EXTRA'));
          return true;
        });
      } finally { hook.restore(); }
      assert.equal(hook.observed(), true, `raiz ${i}: falha foi criada após plaintext`);
      assert.ok(obstaculo, `raiz ${i}: objeto próprio`);
      assert.equal((await readdir(raizStaging)).length, 1, `raiz ${i}: uma área retida`);
      ocupadas.push({ raizStaging, obstaculo });
    }

    await unlink(ocupadas[0].obstaculo);
    const raizRetry = process.platform === 'win32'
      ? path.join(f.dir, 'STAGING-0') : ocupadas[0].raizStaging;
    const { plano } = await validarAcervoV9({ pacote, senha, raizStaging: raizRetry });
    assert.equal((await descartarPlanoV9(plano)).limpezaPendente, false);
    assert.deepEqual(await readdir(ocupadas[0].raizStaging), []);
    for (const { raizStaging, obstaculo } of ocupadas.slice(1)) {
      assert.equal((await readdir(raizStaging)).length, 1, 'outras falhas não são apagadas');
      assert.ok((await lstat(obstaculo)).isFile(), 'objeto desconhecido permanece');
    }
  } finally { await f.close(); }
});
