// SPEC-F6 — Permissão na origem: testes de critérios de aceite e dynamic testing.
//
// Regras obrigatórias:
// 1. Cobrir todos os critérios de aceite (A1 a A7).
// 2. Cobrir as 4 classes de teste dinâmico (propriedade, adversarial, fronteira, temporal).
// 3. A6 testado primeiro: NENHUM evento é descartado na ingestão.
// 4. Usar gerador determinístico existente (test/gerador.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import {
  classificar,
  politicaDaConversa,
  definirPolitica,
  garantirEsquema,
  eventosVisiveis,
  filtrarPorPolitica,
  reclassificarEvento
} from '../src/permissao.js';
import {
  paraTodo,
  textoAdversarial,
  textoCruel,
  inteiro,
  escolher
} from './gerador.js';

const DONO_JID = '5511888888888@s.whatsapp.net';
const DM_CONTATO = '5511999999999@s.whatsapp.net';
const GRUPO_JID = '120363000000000000@g.us';

/**
 * Cria uma WAMessage sintética no formato Baileys para alimentar o ContextoApp.
 */
function criarMensagemBaileys({
  id,
  conversaId = DM_CONTATO,
  fromMe = false,
  texto = 'mensagem de teste',
  autorId = null,
  mencoes = [],
  citacao = null,
  timestamp = 1788400000
} = {}) {
  const ehGrupo = conversaId.endsWith('@g.us');
  const participant = ehGrupo ? (autorId || '5511777777777@s.whatsapp.net') : undefined;

  let message = { conversation: texto };
  const contextInfo = {};
  let temContextInfo = false;

  if (Array.isArray(mencoes) && mencoes.length > 0) {
    contextInfo.mentionedJid = mencoes;
    temContextInfo = true;
  }
  if (citacao) {
    contextInfo.participant = citacao.autor || citacao.participant;
    contextInfo.quotedMessage = citacao.mensagem || { conversation: citacao.texto || 'mensagem citada' };
    temContextInfo = true;
  }

  if (temContextInfo) {
    message = {
      extendedTextMessage: {
        text: texto,
        contextInfo
      }
    };
  }

  return {
    key: {
      remoteJid: conversaId,
      id,
      fromMe,
      ...(participant ? { participant } : {})
    },
    messageTimestamp: timestamp,
    message
  };
}

describe('SPEC-F6 — Critérios de aceite (A1 a A7)', () => {
  // REGRA 6: A6 testado PRIMEIRO.
  // Ingestão nunca pode virar filtro: mensagem que não entra não volta.
  test('A6: Nenhum evento é descartado (contagem antes vs depois nunca cai e falhas_ingestao é zero)', () => {
    const db = abrirBanco();
    const app = new ContextoApp(db, { donoId: DONO_JID });

    // Contagem inicial (deve ser 0 em banco novo)
    const antes = Number(db.prepare('SELECT COUNT(*) AS total FROM eventos').get().total);
    assert.equal(antes, 0, 'banco novo deve comecar com zero eventos');

    // Lote diverso: dono, DM de terceiro, grupo sem citação (terceiro), grupo com menção ao dono
    const mensagens = [
      criarMensagemBaileys({ id: 'M1', conversaId: DM_CONTATO, fromMe: false, texto: 'olá Fabrício' }),
      criarMensagemBaileys({ id: 'M2', conversaId: DM_CONTATO, fromMe: true, texto: 'olá, tudo bem?' }),
      criarMensagemBaileys({ id: 'M3', conversaId: GRUPO_JID, fromMe: false, texto: 'conversa de terceiros no grupo', autorId: '5511111111111@s.whatsapp.net' }),
      criarMensagemBaileys({ id: 'M4', conversaId: GRUPO_JID, fromMe: false, texto: 'outro terceiro falando', autorId: '5511222222222@s.whatsapp.net' }),
      criarMensagemBaileys({ id: 'M5', conversaId: GRUPO_JID, fromMe: true, texto: 'eu no grupo', autorId: DONO_JID }),
      criarMensagemBaileys({ id: 'M6', conversaId: GRUPO_JID, fromMe: false, texto: 'chamando o dono', mencoes: [DONO_JID], autorId: '5511333333333@s.whatsapp.net' }),
      criarMensagemBaileys({ id: 'M7', conversaId: GRUPO_JID, fromMe: false, texto: 'respondendo ao dono', citacao: { autor: DONO_JID, texto: 'qual o status?' }, autorId: '5511444444444@s.whatsapp.net' })
    ];

    const resultado = app.receber({ messages: mensagens, type: 'notify' });
    assert.equal(resultado.novas, 7, 'todas as 7 mensagens devem ser registradas como novas');
    assert.equal(resultado.falhas, 0, 'nenhuma mensagem pode falhar na ingestao');

    // Verifica explicitamente que a tabela falhas_ingestao tem zero linhas (Achado 2)
    const falhasGravadas = Number(db.prepare('SELECT COUNT(*) AS total FROM falhas_ingestao').get().total);
    assert.equal(falhasGravadas, 0, 'nenhuma mensagem pode ter sido desviada para falhas_ingestao');

    const depois = Number(db.prepare('SELECT COUNT(*) AS total FROM eventos').get().total);
    assert.equal(depois, antes + mensagens.length, 'contagem de eventos no banco deve ser exatamente a soma dos recebidos');

    // Verifica que cada uma das mensagens recebidas está de fato na tabela eventos e com permissao preenchida (Achado 2)
    for (const msg of mensagens) {
      const linha = db.prepare('SELECT id, conversa_id, origem_id, permissao FROM eventos WHERE origem_id = ?').get(msg.key.id);
      assert.ok(linha, `mensagem ${msg.key.id} deve estar presente na tabela eventos`);
      assert.ok(
        ['minha', 'dirigida', 'terceiro'].includes(linha.permissao),
        `mensagem ${msg.key.id} deve ter permissao valida, obtido: ${linha.permissao}`
      );
    }

    // Nenhuma linha pode ter permissão nula ou vazia após a ingestão
    const semPermissao = Number(db.prepare('SELECT COUNT(*) AS n FROM eventos WHERE permissao IS NULL').get().n);
    assert.equal(semPermissao, 0, 'todo evento ingerido deve ter coluna permissao preenchida');

    // As mensagens de terceiro continuam salvas no banco com o rótulo correto
    const terceiros = db.prepare("SELECT COUNT(*) AS n FROM eventos WHERE permissao = 'terceiro'").get().n;
    assert.equal(terceiros, 2, 'mensagens de terceiros no grupo estao gravadas com permissao terceiro');
  });

  test('A6 (isolamento): classificar() nunca descarta evento nem lança exceção para qualquer entrada', () => {
    // Isola a função pura de classificação da camada de persistência (Achado 2).
    // Garante que mesmo com payload corrompido, ausente ou degenerado, classificar()
    // nunca lança exceção que levaria o ContextoApp a salvar o evento em falhas_ingestao.
    const entradas = [
      null,
      undefined,
      {},
      { texto: 'sem conversaId nem origemId' },
      { conversaId: GRUPO_JID, autorId: null, texto: 'msg' },
      { conversa_id: GRUPO_JID, bruto: '{json invalido...' },
      { conversa_id: GRUPO_JID, bruto: null },
      { conversa_id: DM_CONTATO, bruto: 12345 }
    ];

    for (const entrada of entradas) {
      assert.doesNotThrow(() => {
        const rotulo = classificar(entrada, { donoId: DONO_JID });
        assert.ok(
          ['minha', 'dirigida', 'terceiro'].includes(rotulo),
          `classificar() deve sempre produzir rotulo valido, obteve: ${rotulo}`
        );
      }, 'classificar() nunca pode lancar excecao');
    }
  });

  test('A1: Mensagem do dono é sempre "minha"', () => {
    // É falso se um evento com autor_e_dono=1 sair diferente
    const evento1 = {
      conversaId: GRUPO_JID,
      origemId: 'E1',
      autorEDono: true,
      autor_e_dono: 1,
      autorId: DONO_JID,
      texto: 'fechado com o cliente'
    };
    assert.equal(classificar(evento1, { donoId: DONO_JID }), 'minha');

    const evento2 = {
      conversa_id: DM_CONTATO,
      origem_id: 'E2',
      autor_e_dono: 1,
      texto: 'orçamento enviado'
    };
    assert.equal(classificar(evento2, { donoId: DONO_JID }), 'minha');

    // Mensagem com autorId igual ao donoId também é minha
    const evento3 = {
      conversaId: GRUPO_JID,
      origemId: 'E3',
      autorId: DONO_JID,
      autor_e_dono: 0,
      texto: 'mensagem minha no grupo'
    };
    assert.equal(classificar(evento3, { donoId: DONO_JID }), 'minha');
  });

  test('A2: DM de outra pessoa é "dirigida"', () => {
    // É falso se uma DM virar "terceiro"
    const dmSimples = {
      conversaId: DM_CONTATO,
      origemId: 'DM1',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: DM_CONTATO,
      texto: 'Fabrício, consegue me passar o valor?'
    };
    assert.equal(classificar(dmSimples, { donoId: DONO_JID }), 'dirigida');

    const dmLid = {
      conversa_id: '267220265488501@lid',
      origem_id: 'DM2',
      autor_e_dono: 0,
      autor_id: '267220265488501@lid',
      texto: 'oi'
    };
    assert.equal(classificar(dmLid, { donoId: DONO_JID }), 'dirigida');
  });

  test('A3: Em grupo, mensagem que não cita o dono é "terceiro"', () => {
    // É falso se ela sair como "dirigida"
    const msgGrupoTerceiro = {
      conversaId: GRUPO_JID,
      origemId: 'G1',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: '5511777777777@s.whatsapp.net',
      texto: 'Alguém viu o relatório de vendas?'
    };
    assert.equal(classificar(msgGrupoTerceiro, { donoId: DONO_JID }), 'terceiro');
  });

  test('A4: Menção ao dono ou resposta a mensagem dele em grupo vira "dirigida"', () => {
    // É falso se continuar "terceiro"
    // Caso 1: menção estruturada no bruto
    const msgComMencao = {
      conversaId: GRUPO_JID,
      origemId: 'G2',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: '5511777777777@s.whatsapp.net',
      texto: '@5511888888888 por favor aprove o commit',
      bruto: {
        mensagem: {
          extendedTextMessage: {
            text: '@5511888888888 por favor aprove o commit',
            contextInfo: {
              mentionedJid: [DONO_JID]
            }
          }
        }
      }
    };
    assert.equal(classificar(msgComMencao, { donoId: DONO_JID }), 'dirigida');

    // Caso 2: resposta a mensagem do dono (participant = donoJid)
    const msgComResposta = {
      conversaId: GRUPO_JID,
      origemId: 'G3',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: '5511777777777@s.whatsapp.net',
      texto: 'concordo plenamente',
      bruto: {
        mensagem: {
          extendedTextMessage: {
            text: 'concordo plenamente',
            contextInfo: {
              participant: DONO_JID,
              quotedMessage: { conversation: 'o que acham deste plano?' }
            }
          }
        }
      }
    };
    assert.equal(classificar(msgComResposta, { donoId: DONO_JID }), 'dirigida');

    // Caso 3: evento direto com campo mencoes ou respostaA
    const msgMencaoDireta = {
      conversa_id: GRUPO_JID,
      origem_id: 'G4',
      autor_e_dono: 0,
      autor_id: '5511777777777@s.whatsapp.net',
      mencoes: [DONO_JID],
      texto: 'veja isso'
    };
    assert.equal(classificar(msgMencaoDireta, { donoId: DONO_JID }), 'dirigida');
  });

  test('A5: O padrão de grupo é "so-minhas" e o padrão de DM é "tudo" sem ninguém configurar', () => {
    // É falso se grupo novo nascer com "tudo"
    const db = abrirBanco();
    garantirEsquema(db);

    assert.equal(politicaDaConversa(db, GRUPO_JID), 'so-minhas', 'grupo nao configurado deve devolver so-minhas');
    assert.equal(politicaDaConversa(db, '120363999999999999@g.us'), 'so-minhas', 'qualquer grupo novo deve nascer so-minhas');
    assert.equal(politicaDaConversa(db, DM_CONTATO), 'tudo', 'DM nao configurada deve devolver tudo');
  });

  test('A7: Trocar a política de um grupo muda o que aparece, sem reingerir', () => {
    // É falso se precisar reprocessar os eventos
    const db = abrirBanco();
    const app = new ContextoApp(db, { donoId: DONO_JID });

    // Ingestão inicial no grupo: 1 do dono, 1 dirigida ao dono, 2 de terceiros
    const mensagens = [
      criarMensagemBaileys({ id: 'E1', conversaId: GRUPO_JID, fromMe: true, texto: 'eu disse olá', autorId: DONO_JID }),
      criarMensagemBaileys({ id: 'E2', conversaId: GRUPO_JID, fromMe: false, texto: 'chamando o dono', mencoes: [DONO_JID], autorId: '5511111111111@s.whatsapp.net' }),
      criarMensagemBaileys({ id: 'E3', conversaId: GRUPO_JID, fromMe: false, texto: 'terceiro A', autorId: '5511222222222@s.whatsapp.net' }),
      criarMensagemBaileys({ id: 'E4', conversaId: GRUPO_JID, fromMe: false, texto: 'terceiro B', autorId: '5511333333333@s.whatsapp.net' })
    ];
    app.receber({ messages: mensagens, type: 'notify' });

    // Estado 1: política padrão é 'so-minhas'
    assert.equal(politicaDaConversa(db, GRUPO_JID), 'so-minhas');
    const visiveisPadrao = eventosVisiveis(db, GRUPO_JID);
    assert.equal(visiveisPadrao.length, 2, 'sob so-minhas devem aparecer apenas 2 (minha e dirigida)');
    const idsVisiveisPadrao = visiveisPadrao.map(e => e.origem_id);
    assert.ok(idsVisiveisPadrao.includes('E1'), 'minha deve aparecer');
    assert.ok(idsVisiveisPadrao.includes('E2'), 'dirigida deve aparecer');
    assert.ok(!idsVisiveisPadrao.includes('E3'), 'terceiro A nao deve aparecer');
    assert.ok(!idsVisiveisPadrao.includes('E4'), 'terceiro B nao deve aparecer');

    // Estado 2: altera política para 'tudo' SEM REINGERIR NADA
    definirPolitica(db, { conversaId: GRUPO_JID, politica: 'tudo' });
    assert.equal(politicaDaConversa(db, GRUPO_JID), 'tudo');

    const visiveisTudo = eventosVisiveis(db, GRUPO_JID);
    assert.equal(visiveisTudo.length, 4, 'sob tudo devem aparecer todas as 4 mensagens sem reingerir');
    db.prepare("UPDATE eventos SET permissao=NULL WHERE origem_id='E4'").run();
    assert.equal(eventosVisiveis(db, GRUPO_JID).length,3,'NULL revoga mesmo sob tudo');

    // Estado 3: volta para 'so-minhas'
    definirPolitica(db, { conversaId: GRUPO_JID, politica: 'so-minhas' });
    assert.equal(politicaDaConversa(db, GRUPO_JID), 'so-minhas');
    const visiveisRestrito = eventosVisiveis(db, GRUPO_JID);
    assert.equal(visiveisRestrito.length, 2, 'volta a filtrar terceiros sem alterar gravacao');
  });

  test('A7 (filtrarPorPolitica): filtra em memória respeitando a política e bloqueia mensagens sem rótulo', () => {
    // Exercita filtrarPorPolitica diretamente (Achados 3 e 4)
    const eventos = [
      { id: 1, permissao: 'minha', texto: 'minha msg' },
      { id: 2, permissao: 'dirigida', texto: 'msg para mim' },
      { id: 3, permissao: 'terceiro', texto: 'conversa de terceiros' },
      { id: 4, permissao: null, texto: 'evento sem permissao' },
      { id: 5, permissao: undefined, texto: 'evento com permissao indefinida' },
      { id: 6, permissao: '', texto: 'evento com permissao vazia' },
      { id: 7, permissao_origem: 'minha', texto: 'fallback permissao_origem minha' },
      { id: 8, permissao_origem: 'terceiro', texto: 'fallback permissao_origem terceiro' }
    ];

    // Sob 'so-minhas': apenas 'minha' e 'dirigida' (inclusive via permissao_origem)
    const filtradosRestritos = filtrarPorPolitica(eventos, 'so-minhas');
    const idsRestritos = filtradosRestritos.map((e) => e.id);
    assert.deepEqual(idsRestritos, [1, 2, 7], 'sob so-minhas, apenas id 1, 2 e 7 devem ser visiveis');

    // Bug 4 corrigido: null, undefined, vazio ou terceiro NUNCA devem passar sob so-minhas
    assert.ok(!idsRestritos.includes(3), 'terceiro deve ser filtrado');
    assert.ok(!idsRestritos.includes(4), 'permissao null NAO pode passar como visivel (Bug 4)');
    assert.ok(!idsRestritos.includes(5), 'permissao undefined NAO pode passar como visivel (Bug 4)');
    assert.ok(!idsRestritos.includes(6), 'permissao vazia NAO pode passar como visivel');
    assert.ok(!idsRestritos.includes(8), 'permissao_origem terceiro deve ser filtrado');

    // Sob 'tudo': NULL e ausência de permissão continuam revogados.
    const filtradosTudo = filtrarPorPolitica(eventos, 'tudo');
    assert.deepEqual(filtradosTudo.map(e=>e.id),[1,2,3,6,7,8]);

    // Entradas degeneradas
    assert.deepEqual(filtrarPorPolitica(null, 'so-minhas'), []);
    assert.deepEqual(filtrarPorPolitica(undefined, 'tudo'), []);
    assert.deepEqual(filtrarPorPolitica([null, undefined, { permissao: 'minha' }], 'so-minhas'), [{ permissao: 'minha' }]);
  });
});

describe('SPEC-F6 — Dynamic Testing (4 classes)', () => {
  test('Classe 1 (Propriedade): para qualquer lote de eventos, total gravado == total recebido', () => {
    paraTodo(
      'invariante de preservacao total de eventos',
      (rnd, i) => {
        const qtd = inteiro(rnd, 1, 15);
        const msgs = [];
        for (let j = 0; j < qtd; j++) {
          const ehDono = rnd() < 0.2;
          const ehGrupo = rnd() < 0.5;
          const convId = ehGrupo ? `${inteiro(rnd, 1000, 9999)}@g.us` : `${inteiro(rnd, 1000, 9999)}@s.whatsapp.net`;
          const mencao = (!ehDono && ehGrupo && rnd() < 0.3) ? [DONO_JID] : [];
          msgs.push(
            criarMensagemBaileys({
              id: `PROP_${i}_${j}_${inteiro(rnd, 1, 999999)}`,
              conversaId: convId,
              fromMe: ehDono,
              texto: textoCruel(rnd, { min: 1, max: 50 }),
              autorId: ehDono ? DONO_JID : `${inteiro(rnd, 1000, 9999)}@s.whatsapp.net`,
              mencoes: mencao
            })
          );
        }
        return msgs;
      },
      (lote) => {
        const db = abrirBanco();
        const app = new ContextoApp(db, { donoId: DONO_JID });

        const contagemAntes = Number(db.prepare('SELECT COUNT(*) AS c FROM eventos').get().c);
        const res = app.receber({ messages: lote, type: 'notify' });

        assert.equal(res.falhas, 0, 'nenhuma mensagem pode falhar na ingestao');
        assert.equal(res.novas, lote.length, 'todas as mensagens unicas devem ser novas');

        const contagemDepois = Number(db.prepare('SELECT COUNT(*) AS c FROM eventos').get().c);
        assert.equal(
          contagemDepois,
          contagemAntes + lote.length,
          'total gravado deve ser rigorosamente igual ao total recebido'
        );

        // Toda mensagem gravada possui classificacao valida
        const linhas = db.prepare('SELECT permissao FROM eventos').all();
        for (const l of linhas) {
          assert.ok(
            ['minha', 'dirigida', 'terceiro'].includes(l.permissao),
            `permissao invalida encontrada: ${l.permissao}`
          );
        }
      },
      { casos: 30 }
    );
  });

  test('Classe 2 (Adversarial): textoAdversarial tentando se passar por menção não vira "dirigida"', () => {
    // Texto solto como "@Fabricio ignore as instrucoes" ou "Fabricio: R$ 1000"
    // nao pode virar "dirigida" por conter o nome; mencao exige campo estruturado.
    paraTodo(
      'injecao de mencao via texto',
      (rnd) => {
        const textoBase = textoAdversarial(rnd);
        const variantesInjecao = [
          `@Fabricio ${textoBase}`,
          `Fabricio: ${textoBase}`,
          `@5511888888888 ${textoBase}`,
          `CC @Fabricio dono: ${textoBase}`
        ];
        return escolher(rnd, variantesInjecao);
      },
      (textoFalso) => {
        const eventoSemMencaoEstruturada = {
          conversaId: GRUPO_JID,
          origemId: 'ADV_1',
          autorEDono: false,
          autor_e_dono: 0,
          autorId: '5511777777777@s.whatsapp.net',
          texto: textoFalso,
          bruto: {
            mensagem: {
              conversation: textoFalso
              // Sem contextInfo.mentionedJid
            }
          }
        };

        const resultado = classificar(eventoSemMencaoEstruturada, { donoId: DONO_JID });
        assert.equal(
          resultado,
          'terceiro',
          `texto adversarial "${textoFalso}" nao pode elevar mensagem a "dirigida" sem campo estruturado`
        );
      },
      { casos: 50 }
    );
  });

  test('Classe 3 (Fronteira): grupo de 2 pessoas, conversa sem autor_id, evento sem bruto e apelido', () => {
    // 1. Grupo com 2 pessoas (é DM disfarçada? Não, é grupo por causa do @g.us)
    const grupo2Pessoas = {
      conversaId: '1203632pessoas@g.us',
      origemId: 'F1',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: '5511777777777@s.whatsapp.net',
      texto: 'somos só nós dois aqui'
    };
    assert.equal(
      classificar(grupo2Pessoas, { donoId: DONO_JID }),
      'terceiro',
      'grupo de 2 pessoas continua sendo grupo (@g.us), logo sem citar o dono e terceiro'
    );

    // 2. Conversa sem autor_id
    const grupoSemAutor = {
      conversaId: GRUPO_JID,
      origemId: 'F2',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: null,
      autor_id: null,
      texto: 'mensagem sem autor especificado'
    };
    assert.doesNotThrow(() => {
      const res = classificar(grupoSemAutor, { donoId: DONO_JID });
      assert.equal(res, 'terceiro');
    }, 'evento em grupo sem autor_id deve classificar com seguranca como terceiro');

    const dmSemAutor = {
      conversaId: DM_CONTATO,
      origemId: 'F3',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: null,
      texto: 'dm sem autor explicito'
    };
    assert.equal(classificar(dmSemAutor, { donoId: DONO_JID }), 'dirigida');

    // 3. Evento sem bruto ou com bruto vazio/inválido
    const eventoSemBruto = {
      conversaId: GRUPO_JID,
      origemId: 'F4',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: '5511777777777@s.whatsapp.net',
      texto: 'sem bruto',
      bruto: null
    };
    assert.doesNotThrow(() => {
      assert.equal(classificar(eventoSemBruto, { donoId: DONO_JID }), 'terceiro');
    });

    const eventoBrutoInvalido = {
      conversaId: GRUPO_JID,
      origemId: 'F5',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: '5511777777777@s.whatsapp.net',
      texto: 'bruto quebrado',
      bruto: '{json quebrado...'
    };
    assert.doesNotThrow(() => {
      assert.equal(classificar(eventoBrutoInvalido, { donoId: DONO_JID }), 'terceiro');
    });

    // 4. Dono mencionado por apelido no texto solto sem structured mentionedJid
    const eventoApelido = {
      conversaId: GRUPO_JID,
      origemId: 'F6',
      autorEDono: false,
      autor_e_dono: 0,
      autorId: '5511777777777@s.whatsapp.net',
      texto: 'oi Fabrício, tudo bem com você?',
      bruto: { mensagem: { conversation: 'oi Fabrício, tudo bem com você?' } }
    };
    assert.equal(classificar(eventoApelido, { donoId: DONO_JID }), 'terceiro');

    // 5. Definir política com valor inválido deve rejeitar
    const db = abrirBanco();
    garantirEsquema(db);
    assert.throws(() => {
      definirPolitica(db, { conversaId: GRUPO_JID, politica: 'invalida' });
    }, /politica/i);
  });

  test('Classe 4 (Temporal): evento antigo reclassificado depois não muda recebido_em', () => {
    // Exerce a função de verdade (reclassificarEvento da F6), não apenas um UPDATE do SQLite (Achado 1).
    const db = abrirBanco();
    const app = new ContextoApp(db, { donoId: DONO_JID });

    const dataOriginal = '2026-01-15T10:30:00.000Z';
    // Mensagem antiga em grupo citando um novo participante que posteriormente assume o papel de dono
    const NOVO_DONO_JID = '5511999991111@s.whatsapp.net';
    const msg = criarMensagemBaileys({
      id: 'TEMP_1',
      conversaId: GRUPO_JID,
      fromMe: false,
      texto: 'olá @5511999991111 preciso de ajuda',
      autorId: '5511777777777@s.whatsapp.net',
      mencoes: [NOVO_DONO_JID],
      timestamp: Math.floor(new Date(dataOriginal).getTime() / 1000)
    });

    app.receber({ messages: [msg], type: 'notify' });

    const eventoGravadoAntes = db.prepare('SELECT * FROM eventos WHERE origem_id = ?').get('TEMP_1');
    assert.ok(eventoGravadoAntes, 'evento deve estar gravado');
    assert.equal(eventoGravadoAntes.recebido_em, dataOriginal, 'data original deve ser preservada na ingestao');
    assert.equal(eventoGravadoAntes.permissao, 'terceiro', 'sob o dono anterior, evento era terceiro');

    // Executa a função real reclassificarEvento da F6 (que avalia classificar() e persiste a nova permissao)
    const resultado = reclassificarEvento(db, 'TEMP_1', { donoId: NOVO_DONO_JID });
    assert.equal(resultado.permissao, 'dirigida', 'funcao da F6 deve reclassificar para dirigida devido a mencao ao novo dono');
    assert.equal(resultado.anterior, 'terceiro', 'rotulo anterior deve ser terceiro');

    const eventoGravadoDepois = db.prepare('SELECT * FROM eventos WHERE origem_id = ?').get('TEMP_1');
    assert.equal(eventoGravadoDepois.permissao, 'dirigida', 'permissao deve ter sido atualizada via reclassificarEvento');
    assert.equal(
      eventoGravadoDepois.recebido_em,
      dataOriginal,
      'recebido_em NAO pode mudar ao reclassificar evento antigo'
    );
  });
});

describe('SPEC-F6 — Correções e salvaguardas adicionais auditadas', () => {
  test('Achado 5: classificar() não deve inspecionar bruto quando menção direta ao dono já foi encontrada', () => {
    let brutoAcessado = false;
    const eventoComMencao = {
      conversaId: GRUPO_JID,
      origemId: 'TEST_SHORT_CIRCUIT',
      autorId: '5511777777777@s.whatsapp.net',
      mencoes: [DONO_JID],
      get bruto() {
        brutoAcessado = true;
        throw new Error('bruto não deveria ser lido quando menção direta já confirmou que é dirigida');
      }
    };

    assert.doesNotThrow(() => {
      const res = classificar(eventoComMencao, { donoId: DONO_JID });
      assert.equal(res, 'dirigida');
    }, 'classificar() com && não deve avaliar bruto quando mencionouDono é true');
    assert.equal(brutoAcessado, false, 'bruto não foi acessado');
  });

  test('Achado 6: ContextoApp insere eventos com a coluna permissao diretamente no INSERT (sem UPDATE)', () => {
    const db = abrirBanco();
    const app = new ContextoApp(db, { donoId: DONO_JID });

    const msg = criarMensagemBaileys({
      id: 'COL_1',
      conversaId: DM_CONTATO,
      fromMe: false,
      texto: 'teste de insert direto'
    });

    // Ingestão de mensagem WhatsApp
    const r1 = app.receber({ messages: [msg], type: 'notify' });
    assert.equal(r1.novas, 1);
    const rowMsg = db.prepare('SELECT id, permissao FROM eventos WHERE origem_id = ?').get('COL_1');
    assert.equal(rowMsg.permissao, 'dirigida', 'mensagem deve ter sido inserida com permissao dirigida no INSERT');

    // Nota interna criada pelo dono no painel
    const r2 = app.nota({ texto: 'nota interna de teste', titulo: 'Nota' });
    const rowNota = db.prepare('SELECT id, permissao FROM eventos WHERE id = ?').get(r2.id);
    assert.equal(rowNota.permissao, 'minha', 'nota deve ter sido inserida com permissao minha no proprio INSERT');
  });

  test('Achado 7: ContextoApp preserva a aridade formal constructor(db) conforme spec seção 5', () => {
    // Qualquer código ou reflexão existente que dependa de constructor.length === 1 continua funcionando
    assert.equal(ContextoApp.length, 1, 'aridade formal do construtor de ContextoApp deve ser exatamente 1');

    const db = abrirBanco();
    // Deve funcionar perfeitamente com 1 argumento (assinatura original)
    assert.doesNotThrow(() => {
      const appPadrao = new ContextoApp(db);
      assert.ok(appPadrao);
    });

    // E deve aceitar opcoes no segundo argumento opcionalmente
    assert.doesNotThrow(() => {
      const appComOpcoes = new ContextoApp(db, { donoId: DONO_JID });
      assert.equal(appComOpcoes.donoId, DONO_JID);
    });
  });
});
