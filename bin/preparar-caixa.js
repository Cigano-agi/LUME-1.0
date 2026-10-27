#!/usr/bin/env node
// Monta a pasta que vai para o sócio, com SÓ o que ele precisa.
//
//   node bin/preparar-caixa.js --dry     # lista o que copiaria e o que deixaria de fora
//   node bin/preparar-caixa.js           # monta em dist/assessor-socio/
//
// Por que este arquivo existe: o repositório de desenvolvimento tem nome de cliente real
// (Vitória Mizuno, Dr. Thiago, Oblívia), valor de negociação, estratégia comercial,
// crítica dura ao próprio produto e informação pessoal de saúde do dono. Nada disso é
// necessário para instalar, e dar acesso ao repo é dar acesso a tudo junto.
//
// A regra aqui é **lista de permissão, não lista de bloqueio**. Bloqueio esquece o
// arquivo novo que alguém criar amanhã; permissão só deixa passar o que foi declarado.

import { cpSync, mkdirSync, rmSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { raizDoRepo } from '../src/ambiente.js';

const flag = n => process.argv.includes(`--${n}`);
const arg = (n, p) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : p; };

const seco = flag('dry');
const RAIZ = raizDoRepo();
const DESTINO = resolve(arg('destino', join(RAIZ, 'dist', 'assessor-socio')));

// Só o que o sócio precisa para instalar, rodar e se virar sozinho.
const PERMITIDO = [
  'src',            // o código
  'bin',            // comandos e os .vbs das tarefas agendadas
  'test',           // a prova de que funciona; não custa nada e responde "isso é sério?"
  'vault-modelo',   // o segundo cérebro vazio
  'package.json',
  'package-lock.json',
  'instalar.ps1',
  'INSTALAR.bat',
  'DIAGNOSTICO.bat',
  'DESINSTALAR.bat',
  'INSTALAR.md',    // o guia dele
  '.env.exemplo',
  '.gitignore'
];

// Arquivos de dentro das pastas permitidas que mesmo assim não vão. `preparar-caixa.js`
// não serve para quem recebe a caixa, e `MENSAGEM-SOCIOS.md` é o roteiro do remetente.
const EXCECOES = new Set(['preparar-caixa.js']);

// O que fica de fora, e por quê. Impresso na saída para a decisão ser visível, não
// implícita — quem roda isto precisa ver o que está protegendo.
const FORA = [
  ['docs/', 'casos de clientes reais, valores de negociação, estratégia e crítica ao produto'],
  ['AGENTS.md, GEMINI.md', 'instruções internas e informação pessoal de saúde do dono'],
  ['STATUS.md, BACKLOG.md, ATUALIZACOES.md', 'estado interno e nomes de clientes'],
  ['README.md', 'cita casos de clientes; o sócio lê INSTALAR.md'],
  ['MENSAGEM-SOCIOS.md', 'é o roteiro de quem envia, não de quem recebe'],
  ['data/, .env, .git/', 'mensagens privadas, credenciais e histórico de desenvolvimento']
];

const LEIA_PRIMEIRO = `# Comece aqui

**Dê dois cliques em \`INSTALAR.bat\`.**

É isso. O resto está em [INSTALAR.md](INSTALAR.md).

Se travar em qualquer ponto, chame o Fabrício em vez de quebrar a cabeça — e se der
problema depois de instalado, dois cliques em \`DIAGNOSTICO.bat\`, tira foto da tela e
manda.

Suas conversas ficam no seu computador. Ninguém mais tem acesso a elas.
`;

console.log(`caixa: ${DESTINO}${seco ? '  (simulação)' : ''}\n`);

if (!seco) {
  // Refazer do zero: caixa que acumula sobra da versão anterior é como vaza arquivo que
  // ninguém queria mandar.
  rmSync(DESTINO, { recursive: true, force: true });
  mkdirSync(DESTINO, { recursive: true });
}

let copiados = 0;
for (const item of PERMITIDO) {
  const origem = join(RAIZ, item);
  if (!existsSync(origem)) { console.log(`  (ausente, pulado) ${item}`); continue; }
  const ehPasta = statSync(origem).isDirectory();
  const quantos = ehPasta ? readdirSync(origem).filter(n => !EXCECOES.has(n)).length : 1;
  console.log(`  ${ehPasta ? 'pasta ' : 'arquivo'}  ${item}${ehPasta ? ` (${quantos} itens)` : ''}`);
  copiados += quantos;
  if (seco) continue;
  cpSync(origem, join(DESTINO, item), {
    recursive: true,
    filter: (src) => {
      const nome = src.split(/[\\/]/).pop();
      if (EXCECOES.has(nome)) return false;
      // node_modules entra por `npm ci` no instalador, não pela cópia: 50 MB que o
      // sócio baixaria à toa, e travados pelo package-lock de qualquer forma.
      return nome !== 'node_modules' && nome !== '__pycache__';
    }
  });
}

if (!seco) writeFileSync(join(DESTINO, 'LEIA-PRIMEIRO.md'), LEIA_PRIMEIRO, 'utf8');

console.log(`\nficam DE FORA, de propósito:`);
for (const [o, porque] of FORA) console.log(`  ${o.padEnd(38)} ${porque}`);

if (seco) {
  console.log(`\nSimulação. Rode sem --dry para montar.`);
} else {
  console.log(`\nPronto: ${copiados} itens em ${DESTINO}`);
  console.log(`\nConfira antes de mandar:`);
  console.log(`  grep -riE "mizuno|thiago|oblivia|TDAH" "${DESTINO}"    # nao pode achar nada`);
  console.log(`\nDepois: zipe a pasta e mande, ou suba num repositorio NOVO e privado.`);
}
