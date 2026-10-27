import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  nomeDeEntradaSeguro, lerIndiceZip, extrairEntrada,
  parsearConversa, inventariarCaixa, registrarInventario
} from '../src/inventario.js';

// Monta um ZIP de verdade: e a unica forma de provar que o leitor proprio entende o
// formato, e nao apenas o caso que o proprio teste inventou.
function montarZip(itens) {
  const locais = [];
  const central = [];
  let offset = 0;

  for (const item of itens) {
    const nome = Buffer.from(item.nome, 'utf8');
    const conteudo = Buffer.from(item.conteudo ?? '', 'utf8');
    const comprimido = item.semCompressao ? conteudo : deflateRawSync(conteudo);
    const metodo = item.semCompressao ? 0 : 8;
    const crc = crc32(conteudo);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(item.mentirTamanho ?? conteudo.length, 22);
    local.writeUInt16LE(nome.length, 26);
    locais.push(local, nome, comprimido);

    const entradaCentral = Buffer.alloc(46);
    entradaCentral.writeUInt32LE(0x02014b50, 0);
    entradaCentral.writeUInt16LE(metodo, 10);
    entradaCentral.writeUInt32LE(crc, 16);
    entradaCentral.writeUInt32LE(comprimido.length, 20);
    entradaCentral.writeUInt32LE(item.mentirTamanho ?? conteudo.length, 24);
    entradaCentral.writeUInt16LE(nome.length, 28);
    // `<< 16` estoura para negativo em int32; o modo Unix mora no dword alto.
    entradaCentral.writeUInt32LE(item.symlink ? 0xa1ff * 0x10000 : 0, 38);
    entradaCentral.writeUInt32LE(offset, 42);
    central.push(entradaCentral, nome);

    offset += local.length + nome.length + comprimido.length;
  }

  const corpoLocal = Buffer.concat(locais);
  const corpoCentral = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(itens.length, 8);
  eocd.writeUInt16LE(itens.length, 10);
  eocd.writeUInt32LE(corpoCentral.length, 12);
  eocd.writeUInt32LE(corpoLocal.length, 16);
  return Buffer.concat([corpoLocal, corpoCentral, eocd]);
}

function comZip(itens, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'assessor-inv-'));
  try {
    const caminho = resolve(dir, 'caixa.zip');
    writeFileSync(caminho, montarZip(itens));
    return fn(caminho, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('nomes de entrada que escapariam da pasta sao recusados', () => {
  assert.equal(nomeDeEntradaSeguro('_chat.txt'), true);
  assert.equal(nomeDeEntradaSeguro('midia/foto.jpg'), true);
  assert.equal(nomeDeEntradaSeguro('../../../etc/passwd'), false);
  assert.equal(nomeDeEntradaSeguro('..\\..\\windows\\system32\\cmd.exe'), false);
  assert.equal(nomeDeEntradaSeguro('/etc/shadow'), false);
  assert.equal(nomeDeEntradaSeguro('C:\\Windows\\notepad.exe'), false);
  assert.equal(nomeDeEntradaSeguro('pasta/../ainda_ok.txt'), false);
  assert.equal(nomeDeEntradaSeguro('nulo\0.txt'), false);
});

test('indice do zip separa entradas boas das recusadas, com motivo', () => {
  comZip([
    { nome: '_chat.txt', conteudo: '[01/01/2026, 10:00:00] Alguem: oi' },
    { nome: '../fuga.txt', conteudo: 'nao deveria sair' },
    { nome: 'link', conteudo: '/etc/passwd', symlink: true },
    { nome: 'bomba.bin', conteudo: 'a'.repeat(1000), mentirTamanho: 900 * 1024 * 1024 }
  ], caminho => {
    const indice = lerIndiceZip(caminho);
    assert.deepEqual(indice.entradas.map(e => e.nome), ['_chat.txt']);
    const motivos = Object.fromEntries(indice.recusadas.map(r => [r.nome, r.motivo]));
    assert.equal(motivos['../fuga.txt'], 'nome_inseguro');
    assert.equal(motivos['link'], 'symlink');
    assert.equal(motivos['bomba.bin'], 'entrada_grande_demais');
  });
});

test('extracao devolve o conteudo original, comprimido ou nao', () => {
  const texto = 'linha um\nlinha dois';
  comZip([
    { nome: 'a.txt', conteudo: texto },
    { nome: 'b.txt', conteudo: texto, semCompressao: true }
  ], caminho => {
    const indice = lerIndiceZip(caminho);
    assert.equal(indice.entradas.length, 2);
    for (const entrada of indice.entradas) {
      assert.equal(extrairEntrada(caminho, entrada).toString('utf8'), texto);
    }
  });
});

test('parser mantem mensagem de varias linhas inteira e captura anexos citados', () => {
  const bruto = [
    '[06/06/2026, 11:23:05] Fabricio: Bom diaaa',
    '[06/06/2026, 11:36:26] Fabricio: primeira linha',
    'segunda linha da MESMA mensagem',
    '100% avista fica por 87.000',
    '\u200e[06/06/2026, 11:56:16] Karen: Wedding.pdf \u200e<anexado: 00000007-Wedding.pdf>'
  ].join('\n');

  const msgs = parsearConversa(bruto);
  assert.equal(msgs.length, 3, 'continuacao nao vira evento novo');
  assert.equal(msgs[1].texto, 'primeira linha\nsegunda linha da MESMA mensagem\n100% avista fica por 87.000');
  assert.equal(msgs[1].linhaInicial, 2, 'o evento aponta para a linha de origem');
  assert.deepEqual(msgs[2].anexos, ['00000007-Wedding.pdf']);
  assert.equal(msgs[2].autor, 'Karen', 'marca invisivel do WhatsApp nao entra no nome');
  assert.equal(msgs[0].instanteLocal, '2026-06-06T11:23:05');
  assert.equal(msgs[0].baseFuso, 'local_do_aparelho_sem_fuso_declarado',
    'a hora e do aparelho: nunca tratar como UTC');
});

test('inventario aponta anexo citado que nao veio no pacote', () => {
  comZip([
    { nome: '_chat.txt', conteudo: [
      '[01/02/2026, 09:00:00] Ana: segue <anexado: 001-contrato.pdf>',
      '[01/02/2026, 09:01:00] Bruno: e este <anexado: 002-sumido.pdf>'
    ].join('\n') },
    { nome: '001-contrato.pdf', conteudo: '%PDF-1.4' }
  ], caminho => {
    const inv = inventariarCaixa(caminho);
    assert.equal(inv.ok, true);
    assert.equal(inv.totalMensagens, 2);
    assert.equal(inv.anexosCitados, 2);
    assert.deepEqual(inv.anexosAusentes, ['002-sumido.pdf'], 'lacuna registrada, nao escondida');
    assert.deepEqual(inv.autores, { Ana: 1, Bruno: 1 });
  });
});

test('zip sem conversa .txt nao vira inventario silencioso', () => {
  comZip([{ nome: 'foto.jpg', conteudo: 'binario' }], caminho => {
    const inv = inventariarCaixa(caminho);
    assert.equal(inv.ok, false);
    assert.equal(inv.motivo, 'conversa_txt_ausente');
  });
});

test('registrar inventario duas vezes nao duplica evento na linha do tempo', () => {
  comZip([
    { nome: '_chat.txt', conteudo: [
      '[01/02/2026, 09:00:00] Ana: primeira',
      '[01/02/2026, 09:05:00] Bruno: segunda'
    ].join('\n') }
  ], caminho => {
    const db = new DatabaseSync(':memory:');
    try {
      const r1 = registrarInventario(db, 'cx_teste', caminho);
      assert.equal(r1.ok, true);
      assert.equal(r1.eventos, 2);
      registrarInventario(db, 'cx_teste', caminho);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM linha_tempo').get().c, 2);
      const linha = db.prepare('SELECT * FROM caixas_inventario WHERE caixa_id = ?').get('cx_teste');
      assert.equal(linha.estado, 'inventariado');
      assert.equal(linha.primeiro_em, '2026-02-01T09:00:00');
      assert.equal(linha.ultimo_em, '2026-02-01T09:05:00');
    } finally {
      db.close();
    }
  });
});

test('zip corrompido registra erro em vez de derrubar o inventario', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assessor-inv-ruim-'));
  try {
    const caminho = resolve(dir, 'ruim.zip');
    writeFileSync(caminho, Buffer.from('isto nao e um zip de jeito nenhum'));
    const db = new DatabaseSync(':memory:');
    try {
      const r = registrarInventario(db, 'cx_ruim', caminho);
      assert.equal(r.ok, false);
      assert.equal(db.prepare('SELECT estado FROM caixas_inventario WHERE caixa_id=?').get('cx_ruim').estado, 'erro');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
