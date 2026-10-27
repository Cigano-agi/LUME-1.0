#!/usr/bin/env node
// Aplica a classificação de permissão aos eventos que entraram antes da F6 existir.
//
//   node bin/classificar-retroativo.js --dry     # mostra a conta, sem gravar
//   node bin/classificar-retroativo.js           # aplica
//
// Por que isto é obrigatório e não opcional: a filtragem por permissão falha FECHADA —
// mensagem sem rótulo não chega ao modelo. É a decisão certa de segurança (desconhecido
// não é autorização), mas sozinha ela cegaria o sistema: medido em 12/09, **100% dos
// 290.601 eventos do banco não têm rótulo**, porque todos entraram antes da F6.
//
// Sem este comando, falha fechada = nenhum item novo sai de conversa nenhuma.
// Com ele, o sistema enxerga de novo — e passa a enxergar a coisa certa: 155.771
// mensagens de grupo que hoje o CRM lê como se fossem do dono viram `terceiro`.
//
// Não chama API do WhatsApp. Usa `autor_e_dono` e `conversa_id`, que já estão gravados.

import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { carregarEnv, raizDoRepo } from '../src/ambiente.js';
import { classificar } from '../src/permissao.js';

carregarEnv();

const flag = n => process.argv.includes(`--${n}`);
const arg = (n, p) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : p; };

const seco = flag('dry');
const dados = process.env.ASSESSOR_DATA_DIR || join(raizDoRepo(), 'data');
const banco = resolve(arg('banco', join(dados, 'assessor.db')));
const lote = Number(arg('lote', 5000));

const db = new DatabaseSync(banco);

const pendentes = db.prepare('SELECT COUNT(*) n FROM eventos WHERE permissao IS NULL').get().n;
const total = db.prepare('SELECT COUNT(*) n FROM eventos').get().n;
console.log(`banco    : ${banco}`);
console.log(`eventos  : ${total.toLocaleString('pt-BR')} (${pendentes.toLocaleString('pt-BR')} sem rótulo)`);

if (pendentes === 0) { console.log('\nNada a fazer: todos já têm rótulo.'); db.close(); process.exit(0); }

const donoId = (process.env.ASSESSOR_DONO || '').trim() || null;
console.log(`dono     : ${donoId ?? '(não declarado — a classificação usa autor_e_dono, que basta)'}`);

// Conta antes de gravar, para o --dry mostrar exatamente o que aconteceria.
const previa = db.prepare(`
  SELECT CASE WHEN autor_e_dono = 1 THEN 'minha'
              WHEN conversa_id LIKE '%@g.us' THEN 'terceiro'
              ELSE 'dirigida' END AS rotulo,
         COUNT(*) AS n
  FROM eventos WHERE permissao IS NULL GROUP BY rotulo ORDER BY n DESC
`).all();
console.log('\nficaria assim:');
for (const p of previa) console.log(`  ${p.rotulo.padEnd(10)} ${p.n.toLocaleString('pt-BR')}`);

if (seco) { console.log('\nSimulação. Rode sem --dry para aplicar.'); db.close(); process.exit(0); }

// `classificar()` é a MESMA função da ingestão. Reimplementar a regra aqui criaria duas
// verdades que divergem na primeira mudança — e a divergência seria silenciosa.
const ler = db.prepare('SELECT id, conversa_id, autor_id, autor_e_dono FROM eventos WHERE permissao IS NULL LIMIT ?');
const gravar = db.prepare('UPDATE eventos SET permissao = ? WHERE id = ?');

let feitos = 0;
const t0 = Date.now();
for (;;) {
  const linhas = ler.all(lote);
  if (!linhas.length) break;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const l of linhas) {
      const rotulo = classificar(
        { conversaId: l.conversa_id, autorId: l.autor_id, autorEDono: l.autor_e_dono },
        { donoId, politica: 'so-minhas' }
      );
      gravar.run(rotulo, l.id);
      feitos++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); console.error(`\nFALHOU no lote: ${e.message}`); db.close(); process.exit(1); }
  process.stdout.write(`\r  ${feitos.toLocaleString('pt-BR')} / ${pendentes.toLocaleString('pt-BR')}`);
}

const depois = db.prepare('SELECT COUNT(*) n FROM eventos WHERE permissao IS NULL').get().n;
const totalDepois = db.prepare('SELECT COUNT(*) n FROM eventos').get().n;
console.log(`\n\nrotulados: ${feitos.toLocaleString('pt-BR')} em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`restantes sem rótulo: ${depois.toLocaleString('pt-BR')}`);

// A invariante da F6 vale aqui também: rotular nunca pode virar apagar.
if (totalDepois !== total) { console.error(`PERDA DE DADO: ${total} -> ${totalDepois}`); db.close(); process.exit(1); }
console.log(`contagem de eventos intacta: ${totalDepois.toLocaleString('pt-BR')}`);
db.close();
