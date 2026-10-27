// Prepara o banco local ativo antes de exportar. O validador v10 continua
// responsável por rejeitar colunas, tabelas ou anexos desconhecidos.
import { ContextoApp } from './contexto-app.js';
import { Desktop } from './desktop.js';
import { DesktopIA } from './desktop-ia.js';
import { Semantica } from './semantica.js';
import { ColetorCaixas } from './caixas.js';
import { prepararEsquemaInventario } from './inventario.js';
import { prepararEsquemaTranscricao } from './transcricao.js';
import { prepararMetadadosAudio } from './audio-desktop-arquivos.js';
import { prepararEsquemaFinanceiro } from './financeiro.js';
import { prepararEsquemaRascunho } from './rascunho.js';
import { prepararEsquemaPrecisao } from './precisao.js';
import { prepararWhatsAppLabels } from './whatsapp-labels.js';
import { prepararAcoesLume } from './acoes-lume.js';
import { prepararExecucoes } from './execucao/esquema.js';
import { prepararHistoricoWhatsApp } from './transporte/historico.js';
import { prepararVendasJev } from './vendas/servico.js';
import { prepararProjetosComerciais } from './projetos-comerciais/esquema.js';
import { prepararProcedenciaCiclo } from './privacidade.js';
import { prepararEsquemaFilaLaya } from './laya/fila.js';
import { prepararMidiasCiclo } from './ciclo-midia-worker.js';

export function prepararAcervoV10(db, diretorioGerido) {
  new ContextoApp(db);
  new Desktop(db);
  new DesktopIA(db, { gerar: async () => { throw new Error('IA indisponível no preparo do backup'); } });
  new Semantica(db, { extrair: async () => [] });
  new ColetorCaixas(db, { diretorioBase: diretorioGerido });
  prepararEsquemaInventario(db);
  prepararEsquemaTranscricao(db);
  prepararMetadadosAudio(db);
  prepararEsquemaFinanceiro(db);
  prepararEsquemaRascunho(db);
  prepararEsquemaPrecisao(db);
  prepararWhatsAppLabels(db);
  prepararAcoesLume(db);
  prepararExecucoes(db);
  prepararHistoricoWhatsApp(db);
  prepararVendasJev(db);
  prepararProjetosComerciais(db);
  prepararProcedenciaCiclo(db);
  prepararEsquemaFilaLaya(db);
  prepararMidiasCiclo(db);
}
