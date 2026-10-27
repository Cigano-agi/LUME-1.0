import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  marcarFalsoPositivo,
  desmarcar,
  precisao,
  prepararEsquemaPrecisao
} from '../src/precisao.js';
import {
  paraTodo,
  itemCruel,
  textoAdversarial,
  textoCruel,
  dataCruel,
  inteiro,
  escolher
} from './gerador.js';

/**
 * Cria banco isolado em memória com o esquema de itens_crm
 * pronto para testar precisão.
 */
function bancoLimpo() {
  const db = new DatabaseSync(':memory:');
  prepararEsquemaPrecisao(db);
  return db;
}

/**
 * Insere um item para os testes pontuais e gerados.
 */
function inserirItem(db, {
  conversaId = 'c1@s.whatsapp.net',
  origemId = 'M1',
  tipo = 'compromisso',
  resumo = 'teste',
  quando = '2026-09-01T10:00:00.000Z',
  extraidoEm = null,
  estado = 'aberto',
  estadoEm = null,
  estadoMotivo = null
} = {}) {
  const dataExtracao = extraidoEm || quando || '2026-09-01T10:00:00.000Z';
  const r = db.prepare(`
    INSERT INTO itens_crm (
      conversa_id, origem_id, tipo, resumo, quando,
      estado, extraido_em, estado_em, estado_motivo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversaId || 'c1@s.whatsapp.net',
    origemId || 'M1',
    tipo || 'compromisso',
    resumo || 'teste',
    quando,
    estado,
    dataExtracao,
    estadoEm,
    estadoMotivo
  );
  return Number(r.lastInsertRowid);
}

// ---------------------------------------------------------------- critérios de aceite

test('prepararEsquemaPrecisao: é idempotente e garante colunas necessárias', () => {
  const db = new DatabaseSync(':memory:');
  prepararEsquemaPrecisao(db);
  prepararEsquemaPrecisao(db); // segunda chamada não pode estourar

  const colunas = db.prepare("PRAGMA table_info(itens_crm)").all().map(c => c.name);
  assert.ok(colunas.includes('estado'), 'deve conter estado');
  assert.ok(colunas.includes('estado_em'), 'deve conter estado_em');
  assert.ok(colunas.includes('estado_motivo'), 'deve conter estado_motivo');
});

test('A1: marcar move para descartado e grava motivo e data', () => {
  const db = bancoLimpo();
  const id = inserirItem(db, { origemId: 'M10' });

  const alterado = marcarFalsoPositivo(db, { itemId: id, motivo: 'não era compromisso real' });
  assert.equal(alterado, true, 'deve confirmar que o item foi alterado');

  const item = db.prepare('SELECT * FROM itens_crm WHERE id = ?').get(id);
  assert.equal(item.estado, 'descartado', 'A1 é falso se estado não for descartado');
  assert.equal(item.estado_motivo, 'falso positivo: não era compromisso real', 'deve prefixar o motivo com "falso positivo: "');
  assert.ok(item.estado_em, 'deve gravar carimbo ISO');
  assert.ok(!isNaN(Date.parse(item.estado_em)), 'carimbo deve ser ISO parseável');
});

test('A2: marcar -> desmarcar -> marcar devolve o mesmo estado final após qualquer número de ciclos', () => {
  const db = bancoLimpo();
  const id = inserirItem(db, { origemId: 'M20' });

  // Testa 7 ciclos para provar que a alternância é estável após qualquer número de ciclos
  for (let ciclo = 0; ciclo < 7; ciclo++) {
    const alterouMarcar = marcarFalsoPositivo(db, { itemId: id, motivo: `motivo ${ciclo}` });
    assert.equal(alterouMarcar, true);
    let item = db.prepare('SELECT * FROM itens_crm WHERE id = ?').get(id);
    assert.equal(item.estado, 'descartado');
    assert.equal(item.estado_motivo, `falso positivo: motivo ${ciclo}`);
    assert.ok(item.estado_em);

    const alterouDesmarcar = desmarcar(db, { itemId: id });
    assert.equal(alterouDesmarcar, true);
    item = db.prepare('SELECT * FROM itens_crm WHERE id = ?').get(id);
    assert.equal(item.estado, 'aberto', 'desmarcar devolve para aberto');
    assert.equal(item.estado_motivo, null, 'desmarcar limpa o motivo');
    assert.equal(item.estado_em, null, 'desmarcar limpa a data de mudança');
  }

  // Última marcação
  marcarFalsoPositivo(db, { itemId: id, motivo: 'definitivo' });
  const final = db.prepare('SELECT * FROM itens_crm WHERE id = ?').get(id);
  assert.equal(final.estado, 'descartado');
  assert.equal(final.estado_motivo, 'falso positivo: definitivo');
});

test('A2/A6: item resolvido marcado como descartado devolve para aberto ao desmarcar (perde aceite)', () => {
  const db = bancoLimpo();
  // Item nasce como resolvido (aceito)
  const id = inserirItem(db, { origemId: 'M_RES', estado: 'resolvido', estadoEm: '2026-09-01T10:00:00.000Z' });

  let p = precisao(db);
  assert.deepEqual(p, { julgados: 1, falsos: 0, aceitos: 1, taxa: 1 }, 'inicialmente resolvido tem taxa 1');

  // Usuário marca como falso positivo -> vai para descartado
  const alterouMarcar = marcarFalsoPositivo(db, { itemId: id, motivo: 'era falso alarme' });
  assert.equal(alterouMarcar, true);
  let item = db.prepare('SELECT * FROM itens_crm WHERE id = ?').get(id);
  assert.equal(item.estado, 'descartado');
  assert.equal(item.estado_motivo, 'falso positivo: era falso alarme');
  assert.ok(item.estado_em);

  p = precisao(db);
  assert.deepEqual(p, { julgados: 1, falsos: 1, aceitos: 0, taxa: 0 }, 'marcado como descartado derruba taxa para 0');

  // Usuário desmarca o item: a spec diz que desmarcar devolve para 'aberto' (jamais para resolvido)
  const alterouDesmarcar = desmarcar(db, { itemId: id });
  assert.equal(alterouDesmarcar, true);
  item = db.prepare('SELECT * FROM itens_crm WHERE id = ?').get(id);
  assert.equal(item.estado, 'aberto', 'desmarcar SEMPRE devolve para aberto, nunca restaura resolvido');
  assert.equal(item.estado_motivo, null, 'motivo deve ser limpo');
  assert.equal(item.estado_em, null, 'data de estado deve ser limpa');

  // Como agora está em 'aberto', não conta mais como julgado (perdeu o aceite)
  p = precisao(db);
  assert.deepEqual(p, { julgados: 0, falsos: 0, aceitos: 0, taxa: null }, 'ao voltar para aberto, taxa vira null');

  // Reversível: novo ciclo marcar -> desmarcar mantém a regra
  marcarFalsoPositivo(db, { itemId: id, motivo: 'rejeitado de novo' });
  item = db.prepare('SELECT estado FROM itens_crm WHERE id = ?').get(id);
  assert.equal(item.estado, 'descartado');
  desmarcar(db, { itemId: id });
  item = db.prepare('SELECT estado FROM itens_crm WHERE id = ?').get(id);
  assert.equal(item.estado, 'aberto');
});

test('A3: taxa é null sem julgamento', () => {
  const db = bancoLimpo();

  // Banco vazio
  let metrica = precisao(db);
  assert.equal(metrica.julgados, 0);
  assert.equal(metrica.taxa, null, 'A3 é falso se devolver 0, 1 ou NaN com julgados=0');

  // Apenas itens abertos
  inserirItem(db, { origemId: 'M1', estado: 'aberto' });
  inserirItem(db, { origemId: 'M2', estado: 'aberto' });
  metrica = precisao(db);
  assert.equal(metrica.julgados, 0);
  assert.equal(metrica.taxa, null);

  // Itens abertos e expirados, sem nenhum resolvido ou descartado
  inserirItem(db, { origemId: 'M3', estado: 'expirado' });
  metrica = precisao(db);
  assert.equal(metrica.julgados, 0);
  assert.equal(metrica.taxa, null);
});

test('A4: item inexistente não cria linha nem estoura', () => {
  const db = bancoLimpo();
  inserirItem(db, { origemId: 'M1' });
  const totalAntes = db.prepare('SELECT COUNT(*) c FROM itens_crm').get().c;

  // Casos de ID fantasma
  const fantasmas = [999999, -1, 0, 'fantasma', null, undefined, 1e15];
  for (const itemId of fantasmas) {
    assert.doesNotThrow(() => {
      const alterou = marcarFalsoPositivo(db, { itemId, motivo: 'teste fantasma' });
      assert.equal(alterou, false, `marcarFalsoPositivo deve retornar false para itemId fantasma: ${itemId}`);
      const desmarcou = desmarcar(db, { itemId });
      assert.equal(desmarcou, false, `desmarcar deve retornar false para itemId fantasma: ${itemId}`);
    }, `Não pode lançar para itemId: ${itemId}`);
  }

  const totalDepois = db.prepare('SELECT COUNT(*) c FROM itens_crm').get().c;
  assert.equal(totalDepois, totalAntes, 'A4 é falso se um itemId fantasma criar registro');
});

test('A5: expirado não conta como julgado', () => {
  const db = bancoLimpo();
  inserirItem(db, { origemId: 'R1', estado: 'resolvido', estadoEm: '2026-09-02T10:00:00.000Z' });
  inserirItem(db, { origemId: 'R2', estado: 'resolvido', estadoEm: '2026-09-02T11:00:00.000Z' });
  inserirItem(db, { origemId: 'D1', estado: 'descartado', estadoEm: '2026-09-02T12:00:00.000Z', estadoMotivo: 'falso positivo: lixo' });
  const aberto = inserirItem(db, { origemId: 'A1', estado: 'aberto' });

  const antes = precisao(db);
  assert.equal(antes.julgados, 3);
  assert.equal(antes.aceitos, 2);
  assert.equal(antes.falsos, 1);
  assert.equal(antes.taxa, 2 / 3);

  // Simula o frescor expirando o item aberto
  db.prepare("UPDATE itens_crm SET estado = 'expirado', estado_em = '2026-09-03T10:00:00.000Z' WHERE id = ?").run(aberto);

  const depois = precisao(db);
  assert.equal(depois.julgados, antes.julgados, 'A5 é falso se a contagem mudar');
  assert.equal(depois.aceitos, antes.aceitos);
  assert.equal(depois.falsos, antes.falsos);
  assert.equal(depois.taxa, antes.taxa, 'A5 é falso se a taxa mudar ao expirar itens pelo frescor');
});

test('A6: nada é apagado, marcar é reversível', () => {
  const db = bancoLimpo();
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    ids.push(inserirItem(db, { origemId: `ORIG_${i}` }));
  }

  assert.equal(db.prepare('SELECT COUNT(*) c FROM itens_crm').get().c, 5);

  marcarFalsoPositivo(db, { itemId: ids[0], motivo: 'descarte 1' });
  marcarFalsoPositivo(db, { itemId: ids[1], motivo: 'descarte 2' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM itens_crm').get().c, 5, 'A6 é falso se uma linha sumir ao marcar');

  desmarcar(db, { itemId: ids[0] });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM itens_crm').get().c, 5, 'A6 é falso se uma linha sumir ao desmarcar');
});

// ---------------------------------------------------------------- dynamic testing (4 classes)

test('Dynamic Testing 1 - Propriedade: para N ciclos aleatórios, julgados >= 0 e aceitos + falsos === julgados', () => {
  paraTodo(
    'propriedade: invariante julgados e precisão',
    (rnd, idx) => {
      const totalItens = inteiro(rnd, 1, 15);
      const itens = [];
      for (let i = 0; i < totalItens; i++) {
        const estadoInicial = escolher(rnd, ['aberto', 'resolvido', 'descartado', 'expirado']);
        itens.push({
          origemId: `D1_${idx}_${i}`,
          estado: estadoInicial,
          estadoMotivo: estadoInicial === 'descartado' ? 'falso positivo: inicial' : null,
          estadoEm: estadoInicial !== 'aberto' ? '2026-09-01T00:00:00.000Z' : null
        });
      }

      const nOperacoes = inteiro(rnd, 5, 25);
      const operacoes = [];
      for (let op = 0; op < nOperacoes; op++) {
        operacoes.push({
          alvoIdx: inteiro(rnd, 0, totalItens - 1),
          acao: escolher(rnd, ['marcar', 'desmarcar']),
          motivo: textoCruel(rnd, { min: 0, max: 30 })
        });
      }

      return { itens, operacoes };
    },
    ({ itens, operacoes }) => {
      const db = bancoLimpo();
      const ids = itens.map(it => inserirItem(db, it));

      for (const op of operacoes) {
        const idAlvo = ids[op.alvoIdx];
        if (op.acao === 'marcar') {
          marcarFalsoPositivo(db, { itemId: idAlvo, motivo: op.motivo });
        } else {
          desmarcar(db, { itemId: idAlvo });
        }

        const p = precisao(db);
        assert.ok(p.julgados >= 0, 'julgados nunca fica negativo');
        assert.ok(p.falsos >= 0, 'falsos nunca fica negativo');
        assert.ok(p.aceitos >= 0, 'aceitos nunca fica negativo');
        assert.equal(p.aceitos + p.falsos, p.julgados, 'aceitos + falsos === julgados');

        if (p.julgados === 0) {
          assert.equal(p.taxa, null, 'taxa deve ser null com julgados=0');
        } else {
          assert.equal(p.taxa, p.aceitos / p.julgados, 'taxa deve ser aceitos / julgados');
        }
      }
    },
    { casos: 100 }
  );
});

test('Dynamic Testing 2 - Adversarial: motivo de textoAdversarial() e textoCruel() é gravado como texto', () => {
  paraTodo(
    'adversarial: injeções e caracteres cruéis gravados com segurança',
    (rnd, idx) => {
      const motivo = rnd() < 0.5 ? textoAdversarial(rnd) : textoCruel(rnd);
      return { idx, motivo };
    },
    ({ idx, motivo }) => {
      const db = bancoLimpo();
      const idAlvo = inserirItem(db, { origemId: `ADV_ALVO_${idx}`, resumo: 'alvo' });
      const idControle = inserirItem(db, { origemId: `ADV_CTRL_${idx}`, resumo: 'controle' });

      assert.doesNotThrow(() => {
        marcarFalsoPositivo(db, { itemId: idAlvo, motivo });
      });

      const itemAlvo = db.prepare('SELECT * FROM itens_crm WHERE id = ?').get(idAlvo);
      assert.equal(itemAlvo.estado, 'descartado');
      assert.equal(itemAlvo.estado_motivo, `falso positivo: ${motivo}`);

      // Garante que o item de controle permaneceu intacto e a tabela não foi derrubada
      const itemCtrl = db.prepare('SELECT * FROM itens_crm WHERE id = ?').get(idControle);
      assert.equal(itemCtrl.estado, 'aberto');
      assert.equal(itemCtrl.resumo, 'controle');
    },
    { casos: 100 }
  );
});

test('Dynamic Testing 3 - Fronteira: 0 itens, 1 item, já descartado, já resolvido, IDs limites', () => {
  const db = bancoLimpo();

  // 0 itens
  assert.deepEqual(precisao(db), { julgados: 0, falsos: 0, aceitos: 0, taxa: null });

  // 1 item aberto
  const id1 = inserirItem(db, { origemId: 'F1' });
  assert.deepEqual(precisao(db), { julgados: 0, falsos: 0, aceitos: 0, taxa: null });

  // Item já descartado: marcar de novo atualiza sem quebrar
  marcarFalsoPositivo(db, { itemId: id1, motivo: 'primeiro' });
  assert.deepEqual(precisao(db), { julgados: 1, falsos: 1, aceitos: 0, taxa: 0 });
  marcarFalsoPositivo(db, { itemId: id1, motivo: 'segundo' });
  const item1 = db.prepare('SELECT estado, estado_motivo FROM itens_crm WHERE id = ?').get(id1);
  assert.equal(item1.estado, 'descartado');
  assert.equal(item1.estado_motivo, 'falso positivo: segundo');
  assert.deepEqual(precisao(db), { julgados: 1, falsos: 1, aceitos: 0, taxa: 0 });

  // Item já resolvido: marcar falso positivo move para descartado
  const id2 = inserirItem(db, { origemId: 'F2', estado: 'resolvido', estadoEm: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(precisao(db), { julgados: 2, falsos: 1, aceitos: 1, taxa: 0.5 });
  marcarFalsoPositivo(db, { itemId: id2, motivo: 'foi falso positivo afinal' });
  const item2 = db.prepare('SELECT estado, estado_motivo FROM itens_crm WHERE id = ?').get(id2);
  assert.equal(item2.estado, 'descartado');
  assert.deepEqual(precisao(db), { julgados: 2, falsos: 2, aceitos: 0, taxa: 0 });

  // Desmarcar item que era resolvido: devolve para 'aberto' (NUNCA restaura resolvido)
  const desmarcouResolvido = desmarcar(db, { itemId: id2 });
  assert.equal(desmarcouResolvido, true);
  const item2Aberto = db.prepare('SELECT estado, estado_motivo, estado_em FROM itens_crm WHERE id = ?').get(id2);
  assert.equal(item2Aberto.estado, 'aberto', 'desmarcar deve devolver para aberto mesmo se item era resolvido');
  assert.equal(item2Aberto.estado_motivo, null);
  assert.equal(item2Aberto.estado_em, null);
  // Taxa cai porque perdeu o aceite e voltou para aberto (não é mais julgado)
  assert.deepEqual(precisao(db), { julgados: 1, falsos: 1, aceitos: 0, taxa: 0 });

  // Desmarcar item já aberto: idempotente e não quebra
  const id3 = inserirItem(db, { origemId: 'F3', estado: 'aberto' });
  desmarcar(db, { itemId: id3 });
  assert.equal(db.prepare('SELECT estado FROM itens_crm WHERE id = ?').get(id3).estado, 'aberto');

  // IDs nos limites: negativo, zero, gigante, não-numérico
  // Deve confirmar changes === 0 (retorno false) e nenhum item alterado
  const limites = [-999999, 0, 999999999999, 'NaN', Infinity, -Infinity, {}, [], true, false, null, undefined, '', '0', '-1'];
  const snapshotAntes = db.prepare('SELECT * FROM itens_crm ORDER BY id').all();
  for (const lim of limites) {
    const alterou = marcarFalsoPositivo(db, { itemId: lim, motivo: 'fronteira' });
    assert.equal(alterou, false, `marcarFalsoPositivo deve retornar false para itemId inválido/inexistente: ${String(lim)}`);
    const desmarcou = desmarcar(db, { itemId: lim });
    assert.equal(desmarcou, false, `desmarcar deve retornar false para itemId inválido/inexistente: ${String(lim)}`);
  }
  const snapshotDepois = db.prepare('SELECT * FROM itens_crm ORDER BY id').all();
  assert.deepEqual(snapshotDepois, snapshotAntes, 'nenhum item existente pode ser alterado por IDs de fronteira');
});

test('Dynamic Testing 4 - Temporal: filtro desde exclui itens anteriores; estado_em nulo não usa quando; agregação resiliente a dataCruel', () => {
  const db = bancoLimpo();
  // Itens em datas distintas
  inserirItem(db, { origemId: 'T_ANT_R', estado: 'resolvido', quando: '2026-08-01T10:00:00.000Z', estadoEm: '2026-08-01T10:00:00.000Z' });
  inserirItem(db, { origemId: 'T_ANT_D', estado: 'descartado', quando: '2026-08-15T12:00:00.000Z', estadoEm: '2026-08-15T12:00:00.000Z', estadoMotivo: 'falso positivo: lixo agosto' });
  inserirItem(db, { origemId: 'T_SET_R', estado: 'resolvido', quando: '2026-09-02T10:00:00.000Z', estadoEm: '2026-09-02T10:00:00.000Z' });
  inserirItem(db, { origemId: 'T_SET_D', estado: 'descartado', quando: '2026-09-10T12:00:00.000Z', estadoEm: '2026-09-10T12:00:00.000Z', estadoMotivo: 'falso positivo: lixo setembro' });
  inserirItem(db, { origemId: 'T_ABERTO', estado: 'aberto', quando: '2026-09-11T12:00:00.000Z' });
  // Item descartado legado/migrado cujo estado_em é NULL mas quando é futuro (setembro)
  inserirItem(db, { origemId: 'T_LEGADO', estado: 'descartado', quando: '2026-09-20T12:00:00.000Z', estadoEm: null, estadoMotivo: 'falso positivo: legado' });

  // 1. Sem filtro temporal: todos os julgados entram (inclusive o legado sem estado_em)
  const total = precisao(db);
  assert.equal(total.julgados, 5, 'sem filtro temporal, inclui 2 resolvidos + 3 descartados');
  assert.equal(total.aceitos, 2);
  assert.equal(total.falsos, 3);
  assert.equal(total.taxa, 2 / 5);

  // 2. Com filtro desde em setembro: exclui itens de agosto E exclui o legado sem estado_em
  // Isolamento exato: mudou apenas o parâmetro `desde`, mantendo todo o restante igual
  const desdeSetembro = precisao(db, { desde: '2026-09-01T00:00:00.000Z' });
  assert.equal(desdeSetembro.julgados, 2, 'filtro desde deve excluir itens de agosto e descartado com estado_em nulo');
  assert.equal(desdeSetembro.aceitos, 1);
  assert.equal(desdeSetembro.falsos, 1);
  assert.equal(desdeSetembro.taxa, 1 / 2);

  // 3. Com filtro desde mais estrito: apenas o descartado de 10/09
  const desdeDez = precisao(db, { desde: '2026-09-08T00:00:00.000Z' });
  assert.equal(desdeDez.julgados, 1, 'filtro desde mais estrito deve excluir item de 02/09');
  assert.equal(desdeDez.aceitos, 0);
  assert.equal(desdeDez.falsos, 1);
  assert.equal(desdeDez.taxa, 0);

  // 4. 'desde' no futuro distante: zera tudo
  const futura = precisao(db, { desde: '2099-01-01T00:00:00.000Z' });
  assert.equal(futura.julgados, 0, 'desde no futuro deve zerar julgados');
  assert.equal(futura.taxa, null, 'desde no futuro deve ter taxa null');

  // 5. Dynamic Testing com dataCruel e verificação de agregação resiliente
  paraTodo(
    'temporal: agregação resiliente a dataCruel e filtro desde',
    (rnd, idx) => {
      const itens = [];
      for (let i = 0; i < 5; i++) {
        const cruel = itemCruel(rnd, i);
        itens.push({
          conversaId: cruel.conversa_id || 'c@s.whatsapp.net',
          origemId: `C_${idx}_${i}_${cruel.origem_id || i}`,
          tipo: cruel.tipo,
          resumo: cruel.resumo,
          quando: cruel.quando,
          estado: cruel.estado,
          estadoEm: cruel.estado !== 'aberto' ? dataCruel(rnd) : null,
          estadoMotivo: cruel.estado === 'descartado' ? 'falso positivo: cruel' : null
        });
      }
      const filtroDesde = dataCruel(rnd);
      return { itens, filtroDesde };
    },
    ({ itens, filtroDesde }) => {
      const dbCruel = bancoLimpo();
      for (const it of itens) {
        inserirItem(dbCruel, it);
      }

      assert.doesNotThrow(() => {
        const res = precisao(dbCruel, { desde: filtroDesde });
        assert.ok(typeof res.julgados === 'number');
        assert.ok(res.julgados >= 0);
        assert.equal(res.aceitos + res.falsos, res.julgados);
        if (res.julgados === 0) {
          assert.equal(res.taxa, null);
        } else {
          assert.equal(res.taxa, res.aceitos / res.julgados);
        }
      }, `precisao() não pode derrubar a agregação com desde=${filtroDesde}`);
    },
    { casos: 50 }
  );
});
