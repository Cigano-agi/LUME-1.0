export const TABELAS_PESSOAIS=Object.freeze(['pessoal_politicas','pessoal_propostas','pessoal_proposta_saidas','pessoal_vinculos','telegram_entradas','telegram_saidas']);
/** Existing backup formats deliberately refuse to omit the transport journals. */
export function exigirPessoalSemConteudo(db) {
  const tem=nome=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nome));
  const bloquear=()=>{throw Object.assign(new Error('Há histórico ou recibos do Lume pessoal que este formato não preserva. A operação foi interrompida; mantenha o perfil local.'),{code:'PESSOAL_DADOS_NAO_MAPEADOS'});};
  for(const nome of TABELAS_PESSOAIS)if(tem(nome)&&db.prepare('SELECT 1 FROM "'+nome+'" LIMIT 1').get())bloquear();
  if(tem('etapas')&&db.prepare("SELECT 1 FROM etapas WHERE etapa IN ('assistencia','classificacao_pessoal') LIMIT 1").get())bloquear();
  // New operational criteria are not representable by the legacy sales-only formats,
  // including manual corrections made without activating the personal assistant.
  if(tem('lume_vendas_avaliacoes')&&db.prepare("SELECT 1 FROM lume_vendas_avaliacoes WHERE CASE WHEN json_valid(resultado) THEN json_type(resultado,'$.assunto') IS NOT NULL OR json_type(resultado,'$.andamento') IS NOT NULL OR json_type(resultado,'$.continuidade') IS NOT NULL ELSE 0 END LIMIT 1").get())bloquear();
  if(tem('desktop_config')) {
    const allowed=new Set(['pessoal-chatgpt-host','pessoal-chatgpt-model','pessoal-chatgpt-verified','pessoal-chatgpt-paused']);
    for(const row of db.prepare("SELECT chave,valor FROM desktop_config WHERE chave GLOB 'pessoal*'").iterate()) {
      if(allowed.has(row.chave)||row.chave==='pessoal-enabled'&&row.valor==='0')continue;
      bloquear();
    }
  }
}
