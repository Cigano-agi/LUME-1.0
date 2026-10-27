const MENSAGENS = Object.freeze({
  NOT_ENABLED: 'Ative este assistente no Lume antes de consultar.',
  SCOPE_REVOKED: 'O acesso mudou ou foi desligado. Abra o Lume e confira a permissão.',
  SOURCE_CHANGED: 'A fonte mudou ou deixou de estar disponível. Faça a consulta novamente.',
  INVALID_CURSOR: 'Esta página expirou ou não pertence a esta consulta. Comece novamente.',
  TOO_BROAD: 'A consulta é ampla demais. Escolha um período de até 90 dias ou use mais detalhes.',
  LUME_CLOSED: 'Abra o Lume para consultar sua memória.',
  INVALID_INPUT: 'Confira os campos enviados e tente novamente.',
  UNKNOWN_TOOL: 'Esta ferramenta não existe nesta versão do Lume.',
  INTERNAL_ERROR: 'O Lume não conseguiu concluir a consulta. Tente novamente.'
});

export class McpError extends Error {
  constructor(code) {
    super(MENSAGENS[code] || MENSAGENS.INTERNAL_ERROR);
    this.name = 'McpError';
    this.code = Object.hasOwn(MENSAGENS, code) ? code : 'INTERNAL_ERROR';
  }
}

export function respostaErro(error) {
  const seguro = error instanceof McpError ? error : new McpError('INTERNAL_ERROR');
  return { ok: false, error: { code: seguro.code, message: seguro.message } };
}

