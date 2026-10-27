import test from 'node:test';
import assert from 'node:assert/strict';
import { injetarBloco, agruparPorMes, slugVault } from '../src/vault.js';

const NOTA = `---
title: "WhatsApp — WAVES"
type: synthesis
---

# WhatsApp — WAVES

Prosa que um humano escreveu e ninguem pode apagar.

## Related

- [[wiki/entities/people/diogo-kaleo]]
`;

test('bloco novo entra antes de Related, sem tocar na prosa existente', () => {
  const r = injetarBloco(NOTA, 'WHATSAPP-CRM', '### itens\n\n- um');
  assert.match(r, /Prosa que um humano escreveu e ninguem pode apagar\./);
  assert.match(r, /- \[\[wiki\/entities\/people\/diogo-kaleo\]\]/);
  assert.ok(r.indexOf('WHATSAPP-CRM:START') < r.indexOf('## Related'),
    'o bloco entra antes dos links, para a nota terminar pelos links');
});

test('reescrever troca so o miolo do bloco: prosa e outros blocos sobrevivem', () => {
  const primeira = injetarBloco(NOTA, 'WHATSAPP-CRM', 'versao um');
  const comOutro = injetarBloco(primeira, 'REL', 'conexoes do notion');
  const segunda = injetarBloco(comOutro, 'WHATSAPP-CRM', 'versao dois');

  assert.match(segunda, /versao dois/);
  assert.doesNotMatch(segunda, /versao um/, 'conteudo velho do bloco sai');
  assert.match(segunda, /conexoes do notion/, 'bloco de outra ferramenta permanece');
  assert.match(segunda, /Prosa que um humano escreveu/, 'a prosa nunca e tocada');
  assert.equal((segunda.match(/WHATSAPP-CRM:START/g) || []).length, 1, 'nao duplica marcador');
});

test('nota sem Related recebe o bloco no fim, sem perder conteudo', () => {
  const simples = '# Titulo\n\nalgum texto\n';
  const r = injetarBloco(simples, 'WHATSAPP-CRM', 'itens');
  assert.match(r, /algum texto/);
  assert.match(r, /WHATSAPP-CRM:START/);
});

test('chave de bloco arbitraria e recusada, para nao virar injecao de regex', () => {
  assert.throws(() => injetarBloco(NOTA, 'a.*b', 'x'), TypeError);
  assert.throws(() => injetarBloco(NOTA, '-->', 'x'), TypeError);
});

test('eventos vao para o mes da propria data, nunca misturando anos', () => {
  const porMes = agruparPorMes([
    { data: '2026-09-08', linha: 'a' },
    { data: '2025-12-31', linha: 'b' },
    { data: '2026-09-01', linha: 'c' },
    { data: '2026-01-15', linha: 'd' }
  ]);
  assert.deepEqual(Object.keys(porMes).sort(), ['2025-12', '2026-01', '2026-09']);
  assert.deepEqual(porMes['2026-09'].map(e => e.data), ['2026-09-01', '2026-09-08'],
    'dentro do mes fica em ordem cronologica');
  assert.equal(porMes['2025-12'].length, 1, 'dezembro de 2025 nao entra em 2026');
});

test('evento sem data resolvivel e deixado de fora, nunca chutado para hoje', () => {
  const porMes = agruparPorMes([
    { data: null, linha: 'a' },
    { data: 'ontem', linha: 'b' },
    { data: '', linha: 'c' },
    { data: '2026-09-08', linha: 'd' }
  ]);
  assert.deepEqual(Object.keys(porMes), ['2026-09']);
  assert.equal(porMes['2026-09'].length, 1);
});

test('slug de nome de conversa vira nome de arquivo seguro', () => {
  assert.equal(slugVault('Agente de Atendimento - Clube Carvão'), 'agente-de-atendimento-clube-carvao');
  assert.equal(slugVault('🌀Guilda - Ai Networking [Free]'), 'guilda-ai-networking-free');
  assert.equal(slugVault('../../etc/passwd'), 'etc-passwd', 'nada de travessia de diretorio');
  assert.equal(slugVault(''), '');
});
