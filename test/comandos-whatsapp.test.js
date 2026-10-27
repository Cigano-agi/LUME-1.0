import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {abrirBanco} from '../src/banco.js';
import {
  entradaDeMensagemWhatsapp,
  interpretarComando,
  interpretarDataHora,
  invalidarOrigemComando,
  listarEntidadesPorTag,
  normalizarTag,
  prepararComandosWhatsapp,
  processarComando
} from '../src/comandos-whatsapp.js';

const DM = '5511999999999@s.whatsapp.net';
const GRUPO = '120363000000000000@g.us';
const base = (texto, extra = {}) => ({
  conversaId: DM,
  origemId: 'MSG-1',
  fromMe: true,
  texto,
  timeZone: 'America/Sao_Paulo',
  ...extra
});

describe('Lume 3.2 - parser deterministico', () => {
  test('somente primeiro token conhecido e enviado pelo dono executa', () => {
    assert.equal(interpretarComando(base('oi #lume_tarefa fazer')).estado, 'nao_executado');
    assert.equal(interpretarComando(base('#lume_tarefa fazer', {fromMe: false})).motivo, 'autor_nao_autorizado');
    assert.equal(interpretarComando(base('#lume_tarefa fazer', {doProprioBot: true})).motivo, 'eco_do_aplicativo');
    assert.equal(interpretarComando(base('#lume_xyz fazer')).estado, 'nao_reconhecido');
    assert.equal(interpretarComando(base('#lume_tarefa')).motivo, 'corpo_vazio');
    assert.equal(interpretarComando(base('#lume_tarefa fazer #lume_tag vip')).motivo, 'mais_de_um_comando');
    assert.equal(interpretarComando(base(`#lume_tarefa ${'a'.repeat(501)}`)).motivo, 'mensagem_acima_do_limite');
    assert.equal(interpretarComando(base(`#lume_tarefa fazer${' '.repeat(501)}`)).motivo, 'mensagem_acima_do_limite');
    assert.equal(interpretarComando(base('#lume_tarefa Revisar contrato #juridico')).estado, 'feito');
  });

  test('tarefa separa descricao e no maximo cinco tags sem efeito parcial', () => {
    const ok = interpretarComando(base('#lume_tarefa Revisar contrato #Juridico #vip #VIP'));
    assert.deepEqual(ok.acao, {tipo: 'tarefa', texto: 'Revisar contrato'});
    assert.deepEqual(ok.tags.map(t => t.chave), ['juridico', 'vip']);
    const excesso = interpretarComando(base('#lume_tarefa Fazer #a #b #c #d #e #f'));
    assert.equal(excesso.estado, 'revisar');
    assert.equal(excesso.acao, null);
  });

  test('NFKC e caixa convergem, primeiro nome exibido pode ser preservado no banco', () => {
    const larga = normalizarTag('ＶＩＰ');
    const comum = normalizarTag('vip');
    assert.equal(larga.chave, comum.chave);
    assert.equal(normalizarTag('👩🏽‍💻'.repeat(40)).valida, true);
    assert.equal(normalizarTag('👩🏽‍💻'.repeat(41)).motivo, 'tag_acima_do_limite');
    assert.equal(normalizarTag('  ').motivo, 'tag_vazia');
  });

  test('lembrete aceita somente data deterministica e persiste UTC', () => {
    const agora = new Date('2026-09-18T12:00:00.000Z');
    const relativa = interpretarComando(base('#lume_lembrete amanhã 15:00 | Retomar proposta #cliente-x'), {agora});
    assert.equal(relativa.estado, 'feito');
    assert.equal(relativa.acao.prazo.utc, '2026-09-19T18:00:00.000Z');
    assert.equal(interpretarComando(base('#lume_lembrete sexta | Retomar'), {agora}).motivo, 'prazo_ambiguo');
    assert.equal(interpretarComando(base('#lume_lembrete 2026-02-30 10:00 | Retomar'), {agora}).motivo, 'prazo_impossivel');
    assert.equal(interpretarDataHora('2026-09-19 15:00').motivo, 'fuso_ausente');
    assert.equal(interpretarDataHora('2026-11-01 01:30', {timeZone: 'America/New_York'}).motivo, 'prazo_ambiguo_no_fuso');
  });

  test('cliente em grupo exige resposta com autor e tag nunca inventa alvo removido', () => {
    const semAlvo = interpretarComando(base('#lume_cliente #vip', {conversaId: GRUPO}));
    assert.equal(semAlvo.motivo, 'alvo_de_grupo_ausente');
    const removido = interpretarComando(base('#lume_cliente #vip', {conversaId: GRUPO, resposta: {origemId: 'Q1', autorId: 'pessoa@s.whatsapp.net', removida: true}}));
    assert.equal(removido.motivo, 'alvo_removido');
    const ok = interpretarComando(base('#lume_cliente #vip', {conversaId: GRUPO, resposta: {origemId: 'Q1', autorId: 'pessoa@s.whatsapp.net'}}));
    assert.deepEqual(ok.acao, {tipo: 'marcar_cliente', contatoId: 'pessoa@s.whatsapp.net'});
    const tag = interpretarComando(base('#lume_tag financeiro', {resposta: {origemId: 'Q2', autorId: 'terceiro@s.whatsapp.net'}}));
    assert.deepEqual(tag.acao, {tipo: 'marcar', entidadeTipo: 'mensagem', entidadeId: 'Q2'});
  });

  test('adaptador Baileys extrai autoria e alvo sem interpretar a mensagem citada', () => {
    const entrada = entradaDeMensagemWhatsapp({
      key: {remoteJid: GRUPO, id: 'CMD-1', fromMe: true, participant: 'dono@s.whatsapp.net'},
      message: {extendedTextMessage: {
        text: '#lume_cliente #vip',
        contextInfo: {
          stanzaId: 'ALVO-1',
          participant: 'cliente@s.whatsapp.net',
          quotedMessage: {conversation: '#lume_tarefa texto de terceiro'}
        }
      }}
    }, {timeZone: 'America/Sao_Paulo'});
    assert.equal(entrada.fromMe, true);
    assert.deepEqual(entrada.resposta, {origemId: 'ALVO-1', autorId: 'cliente@s.whatsapp.net', removida: false});
    const resultado = interpretarComando(entrada);
    assert.deepEqual(resultado.acao, {tipo: 'marcar_cliente', contatoId: 'cliente@s.whatsapp.net'});
  });

  test('adaptador Baileys desembrulha comando efemero com limite seguro', () => {
    const entrada = entradaDeMensagemWhatsapp({
      key: {remoteJid: DM, id: 'EFEMERA-1', fromMe: true},
      message: {ephemeralMessage: {message: {
        extendedTextMessage: {text: '#lume_tarefa Rever proposta #comercial'}
      }}}
    }, {timeZone: 'America/Sao_Paulo'});
    assert.equal(entrada.texto, '#lume_tarefa Rever proposta #comercial');
    const resultado = interpretarComando(entrada);
    assert.equal(resultado.estado, 'feito');
    assert.deepEqual(resultado.acao, {tipo: 'tarefa', texto: 'Rever proposta'});
  });
});

describe('Lume 3.2 - livro local e efeitos', () => {
  test('mensagens comuns em volume nao entram no livro nem criam efeitos', () => {
    const db = abrirBanco();
    prepararComandosWhatsapp(db);
    for (let i = 0; i < 500; i++) {
      const resultado = processarComando(db, base(`Conversa comum numero ${i}`, {origemId: `NORMAL-${i}`, fromMe: i % 2 === 0}));
      assert.equal(resultado.ignorado, true);
      assert.equal(resultado.motivo, 'nao_e_comando');
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comandos').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_tarefas').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_lembretes').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_tags_entidades').get().n, 0);
  });

  test('reprocessamento nao duplica tarefa e mantem fonte resolvivel', () => {
    const db = abrirBanco();
    const entrada = base('#lume_tarefa Revisar contrato #VIP');
    const primeira = processarComando(db, entrada, {agora: new Date('2026-09-18T12:00:00Z')});
    const segunda = processarComando(db, entrada, {agora: new Date('2026-09-18T13:00:00Z')});
    assert.equal(primeira.repetido, false);
    assert.equal(segunda.repetido, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_tarefas').get().n, 1);
    const tarefa = db.prepare('SELECT * FROM lume_comando_tarefas').get();
    assert.equal(tarefa.conversa_id, DM);
    assert.equal(tarefa.origem_id, 'MSG-1');
  });

  test('reinicio em arquivo continua idempotente', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'lume-comandos-'));
    const arquivo = join(pasta, 'lume.sqlite');
    try {
      let db = abrirBanco(arquivo);
      processarComando(db, base('#lume_lembrete 2026-09-19 15:00 | Ligar #VIP'));
      db.close();
      db = abrirBanco(arquivo);
      const repetido = processarComando(db, base('#lume_lembrete 2026-09-19 15:00 | Ligar #VIP'));
      assert.equal(repetido.repetido, true);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_lembretes').get().n, 1);
      db.close();
    } finally { rmSync(pasta, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}); }
  });

  test('duas conexoes concorrentes produzem um unico efeito', async () => {
    const pasta = mkdtempSync(join(tmpdir(), 'lume-comandos-corrida-'));
    const arquivo = join(pasta, 'lume.sqlite');
    const modulo = new URL('../src/comandos-whatsapp.js', import.meta.url).href;
    let inicial = abrirBanco(arquivo);
    prepararComandosWhatsapp(inicial);
    inicial.close();
    const codigo = `
      const {parentPort, workerData} = require('node:worker_threads');
      (async () => {
        try {
          const {processarComando} = await import(workerData.modulo);
          const {abrirBanco} = await import(workerData.banco);
          const db = abrirBanco(workerData.arquivo);
          const resultado = processarComando(db, workerData.entrada);
          db.close();
          parentPort.postMessage({ok:true,repetido:resultado.repetido});
        } catch (erro) { parentPort.postMessage({ok:false,erro:erro.stack}); }
      })();`;
    const executar = () => new Promise((resolve, reject) => {
      const banco = new URL('../src/banco.js', import.meta.url).href;
      const worker = new Worker(codigo, {eval: true, workerData: {arquivo, modulo, banco, entrada: base('#lume_tarefa Concorrente #teste')}});
      let mensagem;
      worker.once('message', recebida => { mensagem = recebida; });
      worker.once('exit', codigoSaida => codigoSaida === 0 && mensagem?.ok ? resolve(mensagem) : reject(new Error(mensagem?.erro ?? `worker encerrou com ${codigoSaida}`)));
      worker.once('error', reject);
    });
    try {
      const resultados = await Promise.all([executar(), executar()]);
      assert.equal(resultados.filter(r => r.repetido).length, 1);
      const db = abrirBanco(arquivo);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comandos').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_tarefas').get().n, 1);
      db.close();
    } finally { rmSync(pasta, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}); }
  });

  test('tags equivalentes usam canonica e preservam o primeiro nome exibido', () => {
    const db = abrirBanco();
    processarComando(db, base('#lume_tarefa Uma #ＶＩＰ', {origemId: 'M1'}));
    processarComando(db, base('#lume_tarefa Duas #vip', {origemId: 'M2'}));
    const tags = db.prepare('SELECT * FROM lume_tags').all();
    assert.equal(tags.length, 1);
    assert.equal(tags[0].chave, 'vip');
    assert.equal(tags[0].nome_exibido, 'VIP');
    const entidades = listarEntidadesPorTag(db, 'Vip');
    assert.equal(entidades.length, 2);
    assert.ok(entidades.every(e => e.origem_id === 'M1' || e.origem_id === 'M2'));
  });

  test('comando desconhecido e terceiro ficam auditados com zero efeitos', () => {
    const db = abrirBanco();
    processarComando(db, base('#lume_xyz teste', {origemId: 'U1'}));
    processarComando(db, base('#lume_tarefa atacar', {origemId: 'U2', fromMe: false}));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comandos').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comando_tarefas').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_tags_entidades').get().n, 0);
  });

  test('cliente direto e grupo usam apenas o alvo comprovado', () => {
    const db = abrirBanco();
    processarComando(db, base('#lume_cliente #vip', {origemId: 'C1'}));
    processarComando(db, base('#lume_cliente #proposta', {
      origemId: 'C2', conversaId: GRUPO,
      resposta: {origemId: 'Q1', autorId: 'participante@s.whatsapp.net'}
    }));
    const alvos = db.prepare("SELECT entidade_id FROM lume_tags_entidades WHERE entidade_tipo='contato' ORDER BY entidade_id").all().map(r => r.entidade_id);
    assert.deepEqual(alvos, [DM, 'participante@s.whatsapp.net'].sort());
  });

  test('edicao e remocao invalidam derivados sem apagar a auditoria', () => {
    const db = abrirBanco();
    processarComando(db, base('#lume_tarefa Revisar #vip'));
    assert.deepEqual(invalidarOrigemComando(db, {conversaId: DM, origemId: 'MSG-1'}), {afetados: 1, estado: 'revisar'});
    assert.equal(db.prepare('SELECT estado FROM lume_comando_tarefas').get().estado, 'revisar');
    assert.equal(db.prepare('SELECT estado FROM lume_tags_entidades').get().estado, 'revisar');
    assert.deepEqual(invalidarOrigemComando(db, {conversaId: DM, origemId: 'MSG-1', removida: true}), {afetados: 1, estado: 'origem_removida'});
    assert.equal(db.prepare('SELECT estado FROM lume_comando_tarefas').get().estado, 'origem_removida');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_comandos').get().n, 1);
  });

  test('processamento nao consulta IA nem transporte', () => {
    const db = abrirBanco();
    let acessos = 0;
    const proibido = new Proxy({}, {get() { acessos++; throw new Error('servico externo acessado'); }});
    processarComando(db, base('#lume_tarefa Fazer local #offline'), {ia: proibido, transporte: proibido});
    assert.equal(acessos, 0);
  });

  test('preparo do esquema e seguro para chamadas repetidas', () => {
    const db = abrirBanco();
    prepararComandosWhatsapp(db);
    prepararComandosWhatsapp(db);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_comandos'").get());
  });
});
