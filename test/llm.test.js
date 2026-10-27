import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modeloDaApi, motorAtivo, chaveApi, limparSchema, escolherModelo,
  estimarTokens, interpretarSaidaAgy
} from '../src/llm.js';
import { paraTodo, textoCruel, inteiro } from './gerador.js';

/** O ambiente é global; sem restaurar, um teste contamina o próximo. */
function comAmbiente(vars, corpo) {
  const antes = {};
  for (const [k, v] of Object.entries(vars)) {
    antes[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try { corpo(); } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const SEM_NADA = { GEMINI_API_KEY: null, GOOGLE_API_KEY: null, ASSESSOR_LLM: null };

test('sufixo de nivel de raciocinio do agy sai antes de virar nome de modelo da API', () => {
  // `gemini-3.8-flash-medium` existe na CLI e nao existe na API: com o sufixo a
  // requisicao volta 404 e o erro fala de modelo inexistente, nao de sufixo.
  assert.equal(modeloDaApi('gemini-3.8-flash-medium'), 'gemini-3.8-flash');
  assert.equal(modeloDaApi('gemini-3.8-flash-high'), 'gemini-3.8-flash');
  assert.equal(modeloDaApi('gemini-3.8-flash-low'), 'gemini-3.8-flash');
  assert.equal(modeloDaApi('gemini-3.8-flash'), 'gemini-3.8-flash',
    'nome ja limpo passa intacto');
  assert.equal(modeloDaApi('gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite',
    '-lite e nome de modelo, nao nivel de raciocinio');
});

test('sem chave o motor continua sendo o agy: a maquina do Fabricio nao muda de comportamento', () => {
  comAmbiente(SEM_NADA, () => {
    assert.equal(chaveApi(), null);
    assert.equal(motorAtivo(), 'agy');
  });
});

test('com chave o motor passa a ser a API, que e o caso do socio', () => {
  comAmbiente({ ...SEM_NADA, GEMINI_API_KEY: 'AIza-teste' }, () => {
    assert.equal(motorAtivo(), 'api');
  });
});

test('chave so de espacos nao conta como chave', () => {
  // O instalador escreve o .env a partir do que a pessoa colou; colar vazio e comum,
  // e `GEMINI_API_KEY=` viraria string vazia -- que e falsa -- mas `"   "` e verdadeira.
  comAmbiente({ ...SEM_NADA, GEMINI_API_KEY: '   ' }, () => {
    assert.equal(chaveApi(), null);
    assert.equal(motorAtivo(), 'agy');
  });
});

test('ASSESSOR_LLM manda mais que a presenca da chave, nos dois sentidos', () => {
  comAmbiente({ ...SEM_NADA, GEMINI_API_KEY: 'AIza-teste', ASSESSOR_LLM: 'agy' }, () => {
    assert.equal(motorAtivo(), 'agy', 'da para forcar o agy mesmo com chave no ambiente');
  });
  comAmbiente({ ...SEM_NADA, ASSESSOR_LLM: 'api' }, () => {
    assert.equal(motorAtivo(), 'api', 'forcar a API sem chave falha depois, com erro claro');
  });
  comAmbiente({ ...SEM_NADA, ASSESSOR_LLM: 'qualquer-coisa' }, () => {
    assert.equal(motorAtivo(), 'agy', 'valor invalido nao inventa um terceiro motor');
  });
});

test('GOOGLE_API_KEY tambem serve, porque e o nome que metade dos tutoriais usa', () => {
  comAmbiente({ ...SEM_NADA, GOOGLE_API_KEY: 'AIza-outra' }, () => {
    assert.equal(chaveApi(), 'AIza-outra');
    assert.equal(motorAtivo(), 'api');
  });
});

test('chaves de JSON Schema que o Gemini recusa saem do schema antes do envio', () => {
  // `responseSchema` e subconjunto do OpenAPI: `$schema` e `additionalProperties`
  // fazem a requisicao voltar 400, e o erro do Google nao diz qual chave ofendeu.
  const limpo = limparSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    type: 'object',
    properties: {
      itens: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tipo: { type: 'string', enum: ['compromisso', 'pendencia'] },
            resumo: { type: 'string', minLength: 3 }
          },
          required: ['tipo', 'resumo']
        }
      }
    },
    required: ['itens']
  });

  assert.deepEqual(limpo, {
    type: 'object',
    properties: {
      itens: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['compromisso', 'pendencia'] },
            resumo: { type: 'string' }
          },
          required: ['tipo', 'resumo']
        }
      }
    },
    required: ['itens']
  });
});

test('limpar o schema preserva enum e required, que sao o que segura o formato', () => {
  const limpo = limparSchema({
    type: 'object',
    properties: { tipo: { type: 'string', enum: ['a', 'b'] } },
    required: ['tipo']
  });
  assert.deepEqual(limpo.properties.tipo.enum, ['a', 'b']);
  assert.deepEqual(limpo.required, ['tipo']);
});

test('o modelo de trabalho sai do que a chave enxerga, nao de um nome cravado no codigo', () => {
  // Cravar `gemini-3.8-flash` no codigo funciona hoje e apodrece na proxima geracao.
  // O instalador pergunta ao Google o que existe e escolhe entre o que voltou.
  assert.equal(escolherModelo(['gemini-3.8-flash', 'gemini-3.8-pro']), 'gemini-3.8-flash',
    'flash ganha do pro: a tarefa e extrair item de conversa, em volume alto');
  assert.equal(escolherModelo(['gemini-3.6-flash', 'gemini-3.5-flash']), 'gemini-3.6-flash',
    'entre os preferidos, o mais novo');
  assert.equal(escolherModelo(['gemini-9.9-flash', 'gemini-9.9-pro']), 'gemini-9.9-flash',
    'geracao que ainda nao existe hoje continua sendo resolvida');
  assert.equal(escolherModelo(['gemini-9.9-flash-preview', 'gemini-9.9-flash-lite']),
    'gemini-9.9-flash-lite',
    'sem estavel, aceita lite/preview em vez de desistir');
  assert.equal(escolherModelo(['gemini-9.9-pro']), null,
    'sem nenhum flash o instalador precisa saber que falhou, e nao receber um palpite');
  assert.equal(escolherModelo([]), null);
});

test('A4 - estimarTokens e monotonica: texto maior nunca estima menos tokens que um menor', () => {
  // Propriedade de monotonicidade com 200 pares de textos crueis
  paraTodo('estimarTokens monotonicidade', (rnd) => {
    const min = inteiro(rnd, 0, 50);
    const t1 = textoCruel(rnd, { min, max: min + 20 });
    const t2 = t1 + textoCruel(rnd, { min: 0, max: 50 });
    return { t1, t2 };
  }, ({ t1, t2 }) => {
    assert.ok(t2.length >= t1.length);
    const e1 = estimarTokens(t1);
    const e2 = estimarTokens(t2);
    assert.ok(e2 >= e1, `texto maior (${t2.length} chars -> ${e2} tokens) estimou menos que menor (${t1.length} chars -> ${e1} tokens)`);
  });
});

test('estimarTokens e barata, deterministica e segura para entradas de borda', () => {
  assert.equal(estimarTokens(''), 0);
  assert.equal(estimarTokens(null), 0);
  assert.equal(estimarTokens(undefined), 0);
  assert.equal(estimarTokens('a'), 1);
  assert.equal(estimarTokens('abcd'), 1);
  assert.equal(estimarTokens('abcde'), 2);
  // Determinismo: repetidas chamadas para o mesmo texto devolvem exatamente o mesmo valor
  const texto = 'teste determinismo 12345';
  const primeiro = estimarTokens(texto);
  for (let i = 0; i < 50; i++) {
    assert.equal(estimarTokens(texto), primeiro);
  }
});

test('A6 - o timeout do agy continua reconhecido e nao regride para erro generico', () => {
  // O agy sai com codigo 0 e devolve texto em vez de JSON quando desiste sozinho aos 5 min.
  // A mensagem precisa ser traduzida explicitamente informando lote grande demais.
  // Isolando exatamente o comportamento: duas saidas nao-JSON onde apenas o texto de timeout difere.
  const saidaTimeout = '[agy] print timeout after 5m0s with turn in progress; returning partial output';
  const saidaGenerica = '[agy] fatal internal error on worker thread; returning partial output';

  // Sem o timeout, o parser do agy acusa erro generico de formato JSON
  assert.throws(
    () => interpretarSaidaAgy(saidaGenerica),
    /resposta do agy nao e JSON:/
  );

  // Com o timeout, o parser traduz explicitamente para lote grande demais
  assert.throws(
    () => interpretarSaidaAgy(saidaTimeout),
    /Gemini cortado pelo timeout interno do agy com o turno em andamento: lote grande demais/
  );

  // E uma saida com JSON valido continua funcionando normalmente
  const saidaValida = JSON.stringify({ structured_output: { ok: true }, usage: { total_tokens: 10 } });
  assert.deepEqual(interpretarSaidaAgy(saidaValida), {
    dados: { ok: true },
    uso: { total_tokens: 10 }
  });
});

