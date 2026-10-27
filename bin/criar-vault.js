#!/usr/bin/env node
// Cria um vault vazio — o "segundo cérebro" de quem instalou.
//
//   node bin/criar-vault.js --dry     # mostra o que criaria
//   node bin/criar-vault.js           # cria
//
// A pergunta que originou este arquivo foi "e se o sócio não tiver um segundo cérebro
// para guardar as informações?". A resposta é que ele não precisa ter: o vault não é
// pré-requisito, é o produto. Nasce vazio aqui e enche sozinho com o WhatsApp da própria
// pessoa, via `bin/publicar-vault.js`. Nada do vault de origem é copiado — só as
// ferramentas de índice, que são código.
//
// Idempotente por construção: arquivo que já existe nunca é sobrescrito. Rodar de novo
// depois de meses de uso não apaga nota nenhuma.

import { mkdirSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarEnv, caminhoVault, raizDoRepo } from '../src/ambiente.js';

carregarEnv();

const flag = n => process.argv.includes(`--${n}`);
const arg = (n, p) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : p; };

const seco = flag('dry');
const destino = resolve(arg('destino', null) || caminhoVault());
const MODELO = join(raizDoRepo(), 'vault-modelo');

// A estrutura é a mesma do vault de origem, porque as ferramentas de índice esperam
// estes nomes: `brain_lib.py` indexa `wiki` e `Timeline` por padrão, e
// `publicar-vault.js` escreve em `wiki/synthesis/whatsapp/`.
const PASTAS = [
  'wiki',
  'wiki/synthesis',
  'wiki/synthesis/whatsapp',
  'wiki/people',
  'wiki/companies',
  'wiki/projects',
  'Timeline',
  'DailyNotes',
  '00_Inbox',
  'tools'
];

const REGRAS = `# Regras deste vault

Escrito pelo instalador do Assessor. Vale para você e para qualquer modelo que edite aqui.

## O que não se quebra

- **\`wiki/_INDEX.md\` e \`wiki/_SUMMARIES.md\` são append-only.** Quem cuida deles é
  \`tools/index_heal.py\`. Uma reescrita completa no vault de origem apagou 51 entradas
  de uma vez — por isso a regra existe.
- **Nunca dois anos no mesmo arquivo de \`Timeline/\`.** Um arquivo por mês, \`YYYY-MM.md\`.
- **Nunca fabricar data.** Item sem data resolvível fica na seção de indeterminados; não
  some e não ganha uma data inventada.
- **Todo item vindo do WhatsApp cita a mensagem de origem.** Item sem lastro é descartado
  antes de tocar o banco. É o que separa isto de um gerador de tarefas plausíveis.
- **Texto gerado vive dentro de marcadores** \`<!-- CHAVE:START -->\` / \`<!-- CHAVE:END -->\`.
  Só o miolo é substituído; a prosa que você escreveu em volta sobrevive à regeneração.

## Estrutura

| Pasta | O que guarda |
|---|---|
| \`wiki/synthesis/whatsapp/\` | uma nota por conversa, escrita por \`bin/publicar-vault.js\` |
| \`wiki/people/\` | uma nota por pessoa; \`aliases:\` no frontmatter faz a busca aceitar grafia errada |
| \`wiki/companies/\`, \`wiki/projects/\` | empresas e projetos |
| \`Timeline/\` | o que aconteceu, por mês |
| \`DailyNotes/\` | suas anotações do dia |
| \`00_Inbox/\` | o que ainda não foi classificado |
| \`tools/\` | os índices (Python). Não edite à mão. |

## Privacidade

Este vault contém suas conversas. **Não versione \`tools/*.db\` nem o conteúdo das notas
em repositório compartilhado.** O \`.gitignore\` criado aqui já cobre os bancos.
`;

const INDICE = `# Índice

<!-- Append-only. Mantido por tools/index_heal.py — não reescreva este arquivo à mão. -->
`;

const RESUMOS = `# Resumos

<!-- Append-only. Mantido por tools/index_heal.py — não reescreva este arquivo à mão. -->
`;

const GITIGNORE = `# Bancos de índice: reconstruíveis, pesados e cheios de mensagem privada.
tools/*.db
tools/__pycache__/
.venv/
.obsidian/workspace*.json
`;

const LEIAME = `# Segundo cérebro

Este vault nasceu vazio. Ele enche sozinho conforme o Assessor lê o seu WhatsApp
e publica aqui o que foi destilado — uma nota por conversa, os itens em aberto e a
linha do tempo.

Abra esta pasta no [Obsidian](https://obsidian.md) para navegar. Nada aqui sai do seu
computador: os índices são arquivos locais, e a busca roda na sua máquina.

Regras de edição em \`CLAUDE.md\`.
`;

const ARQUIVOS = [
  ['CLAUDE.md', REGRAS],
  ['README.md', LEIAME],
  ['.gitignore', GITIGNORE],
  ['wiki/_INDEX.md', INDICE],
  ['wiki/_SUMMARIES.md', RESUMOS]
];

// ------------------------------------------------------------------------------ ação

const criadas = [];
const puladas = [];

function criarPasta(rel) {
  const caminho = join(destino, rel);
  if (existsSync(caminho)) { puladas.push(`${rel}/`); return; }
  criadas.push(`${rel}/`);
  if (!seco) mkdirSync(caminho, { recursive: true });
}

function criarArquivo(rel, conteudo) {
  const caminho = join(destino, rel);
  if (existsSync(caminho)) { puladas.push(rel); return; }
  criadas.push(rel);
  if (!seco) {
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, conteudo, 'utf8');
  }
}

console.log(`vault: ${destino}${seco ? '  (simulação, nada será escrito)' : ''}`);

if (!existsSync(MODELO)) {
  console.error(`vault-modelo nao encontrado em ${MODELO} — a caixa veio incompleta.`);
  process.exit(1);
}

if (!seco) mkdirSync(destino, { recursive: true });
for (const pasta of PASTAS) criarPasta(pasta);
for (const [rel, conteudo] of ARQUIVOS) criarArquivo(rel, conteudo);

// As ferramentas de índice são código, e código a caixa traz. Aqui elas são
// sobrescritas de propósito: uma versão nova do Assessor traz correção de índice, e
// manter a antiga porque "o arquivo já existe" esconderia a correção.
for (const nome of readdirSync(join(MODELO, 'tools'))) {
  if (!nome.endsWith('.py')) continue;
  const origem = join(MODELO, 'tools', nome);
  const alvo = join(destino, 'tools', nome);
  const novo = !existsSync(alvo);
  (novo ? criadas : puladas).push(`tools/${nome}${novo ? '' : ' (atualizado)'}`);
  if (!seco) copyFileSync(origem, alvo);
}

console.log(`\n${criadas.length} criados, ${puladas.length} já existiam.`);
if (criadas.length) console.log(`criados: ${criadas.slice(0, 12).join(', ')}${criadas.length > 12 ? ` … +${criadas.length - 12}` : ''}`);

if (seco) {
  console.log('\nSimulação. Rode sem --dry para criar.');
} else {
  console.log(`\nPronto. Aponte PUNK_RECORDS para ${destino} (o instalador já faz isso no .env).`);
}
