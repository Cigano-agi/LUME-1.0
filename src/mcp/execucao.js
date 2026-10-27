import { ExecucaoErro } from '../execucao/servico.js';

const id = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' };
const key = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,100}$' };
const tool = (name, title, properties, readOnly = false) => ({
  name, title,
  description: 'Usa somente uma execução já autorizada no Lume para este assistente. O prazo adicional de 7 dias exige consentimento local e mantém somente o snapshot da tarefa; não amplia buscas. Não envia mensagens, não publica e não altera o estado comercial. Relatos ficam como informados até conferência local.',
  inputSchema: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});
export const EXECUCAO_TOOL_DEFINITIONS = Object.freeze([
  tool('lume_obter_contexto_execucao', 'Abrir contexto autorizado', { execucao_id: id }, true),
  tool('lume_iniciar_execucao', 'Registrar início da execução', { execucao_id: id, chave_idempotencia: key }),
  tool('lume_registrar_progresso', 'Registrar progresso informado', { execucao_id: id, chave_idempotencia: key, texto: { type: 'string', minLength: 1, maxLength: 1000 } }),
  tool('lume_registrar_resultado', 'Registrar resultado informado', { execucao_id: id, chave_idempotencia: key, resumo: { type: 'string', minLength: 1, maxLength: 4000 }, artefatos: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 500 } } })
]);

export function executarExecucao(service, nome, input, auth, sourceId) {
  const acesso = { clientId: auth.clientId, scope: auth.scope, revision: auth.revision };
  try {
    let result;
    if (nome === 'lume_obter_contexto_execucao') {
      if (!input || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'execucao_id')) throw new ExecucaoErro('INVALID_INPUT');
      result = service.obter({ id: input.execucao_id }, acesso);
    } else {
      const tipo = { lume_iniciar_execucao: 'inicio', lume_registrar_progresso: 'progresso', lume_registrar_resultado: 'resultado' }[nome];
      result = service.registrar(tipo, input, acesso);
    }
    if (sourceId && result.contexto) {
      const fonte = service.fonteAutorizada(input.execucao_id, acesso);
      result.contexto.fontes = result.contexto.fontes.map(item => ({ ...item, source_id: sourceId(fonte) }));
    }
    if (result.contexto?.autorizacao.manter_contexto) {
      result.contexto.avisos = [...(result.contexto.avisos || []),
        'Este contexto mantém somente o snapshot autorizado para esta tarefa até ' + result.contexto.autorizacao.contexto_expira_em + '. As consultas gerais continuam no escopo do conector; mudanças nas fontes ou permissões encerram esta autorização.'];
    }
    return { ok: true, ...result };
  } catch (error) {
    const safe = error instanceof ExecucaoErro ? error : new ExecucaoErro('INTERNAL_ERROR');
    return { ok: false, error: { code: safe.code, message: safe.message } };
  }
}
