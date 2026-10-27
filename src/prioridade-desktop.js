// Regras de organização explícitas. Nenhum prazo/valor é inferido do texto.
export const ACOES_POR_PAGINA = 10;
const antiga = 'julianday(i.extraido_em) IS NULL, julianday(i.extraido_em) ASC, i.id ASC';
const TIPOS = { compromisso: 'Compromisso', pendencia: 'Pendência', lead: 'Oportunidade', decisao: 'Decisão' };
const ORDEM = {
  compromissos: {
    tipos: ['compromisso', 'pendencia', 'lead', 'decisao'],
    explicacao: 'Compromissos → pendências → oportunidades → decisões. Em cada grupo, há mais tempo na lista primeiro.'
  },
  oportunidades: {
    tipos: ['lead', 'compromisso', 'pendencia', 'decisao'],
    explicacao: 'Oportunidades → compromissos → pendências → decisões. Em cada grupo, há mais tempo na lista primeiro.'
  },
  antigas: { explicacao: 'Há mais tempo na lista primeiro, independentemente do tipo.' },
  recentes: { explicacao: 'Adicionadas à lista mais recentemente primeiro, independentemente do tipo.' }
};
export function regraPrioridade(ordem) {
  if (!Object.hasOwn(ORDEM, ordem)) throw new Error('Ordem de ações inválida.');
  const regra = ORDEM[ordem];
  const sql = regra.tipos
    ? `CASE i.tipo ${regra.tipos.map((tipo, index) => `WHEN '${tipo}' THEN ${index}`).join(' ')} ELSE 4 END, ${antiga}`
    : ordem === 'antigas' ? antiga : 'julianday(i.extraido_em) IS NULL, julianday(i.extraido_em) DESC, i.id DESC';
  return { sql, explicacao: regra.explicacao, motivo(tipo) {
    const grupo = regra.tipos?.indexOf(tipo);
    return {
      tipo: TIPOS[tipo] || 'Ação',
      motivo: regra.tipos
        ? `Grupo ${grupo >= 0 ? grupo + 1 : 5} nesta ordem · há mais tempo na lista primeiro.`
        : ordem === 'antigas' ? 'Há mais tempo na lista primeiro.' : 'Adicionada mais recentemente primeiro.'
    };
  } };
}
