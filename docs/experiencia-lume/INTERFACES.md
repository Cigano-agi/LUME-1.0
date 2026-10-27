# Interfaces da experiência

`GET /api/v3/experiencia` é projeção autorizada de leitura. Mesmo token/origem/serviços atuais; não altera os cinco tools MCP. Busca/fonte usam rotas existentes e predicado de autorização do produto. Nenhum estado visual habilita envio.

Envelope: `{versao:1, atualizadoEm, itens, lacunas, conexao}`. Item: `{id, assunto, pessoas:[], categoria, origem, atualizadoEm, estado, lacunas:[], acoes:[], fonte, acaoId, conversaId, projetoId, prazo, responsavel, grupo}`. Identidade `acao:<id>` ou persistida equivalente. Grupo `precisa|cuidando|mudou`. Categoria `comercial|entregas|combinados|pessoas|memoria`. Prazo ausente=null. Origem distingue informado/corrigido/sugerido. Ações apenas leitura/navegação permitidas; mutações revalidam nas rotas originais.

`window.LumeVivo` oferece `carregar(view)`, `abrirAssunto(id)`, `limpar()`. Root integra show(view) via `window.navegarLume`. Aliases internos: today=Agora, memory=Memória, sales=Comercial, deliveries=Entregas, contacts=Pessoas. Eventos `lume:navigate`/`lume:invalidate` cancelam cargas obsoletas. Timeout15s/retry; respostas antigas não sobrescrevem navegação nova. Sem polling oculto. Fontes via `abrirFonteTarefa`; correção/Resolver via `abrirAcaoDoAviso`/`abrirAvaliacaoVenda`; sem inventar APIs.

Detalhe usa `/api/v3/acoes/item?id=...`, `/api/v3/execucoes?acao_id=...`; timeline `/api/v3/execucoes/timeline` limite20. Conclusão informada não prova verificação/envio/aceite. Fontes/trechos sempre mantêm autoria/data/origem.

Companheiro recebe primeiro assunto pertinente dessa projeção, id/resumo/motivo/destino/prazo apenas com fonte. Campos limitados; IPC só destinos permitidos. Preferências no serviço existente. Root implementa mudanças de autorização/IPC; demais agentes não ampliam fronteiras.

## Contrato implementado

O envelope também informa `pagina` e `proximaPagina`. `GET /api/v3/experiencia?id=acao:<UUID>` consulta um assunto fora da primeira página e revalida sua fonte; não aceita combinar `id` com paginação. O item acrescenta `estadoRotulo`, `acontecimento`, `consequencia`, `projeto`, `avaliacao`, `negocio`, `acompanhamento` e `entrega`. Ausência de recibo de envio/aceite permanece `null`. Dependências não disponíveis são declaradas no detalhe. IDs e vínculos vêm dos registros existentes.

Busca `/api/v3/busca` mantém `q`, `conversa` e cursor `antes` e acrescenta `pessoa`, `assunto`, `de`, `ate`, `tipo`. Pessoa aceita identidade canônica do cadastro ou identificador exato; as datas usam UTC, informado no controle. O filtro de pessoas tem busca e paginação; não pressupõe que a primeira página contém todos os contatos. Conteúdo e filtros usam o mesmo predicado autorizado das fontes.

O detalhe oferece correção de classificação e vínculo por diálogos existentes. `preparar` só aparece com serviço pessoal ativo e `podeEnviar` permitido; o POST existente `/api/v3/pessoal/mensagem/preparar` revalida as condições e guarda proposta pendente. O formulário mostra destinatário e conteúdo exatos, sem botão de aprovação/envio. `acompanhar` exige contexto remoto já autorizado e fonte vigente; `/api/v3/pessoal/acompanhamento` exige `{acaoId, confirmar:true}` e chama o acompanhamento existente. A confirmação não cria permissão nem segunda fila. Os testes não ativam envio externo.

Preferências aditivas: `tema:system|light|dark`, `movimento:system|reduce`, `volume:0..1`, `pausado:boolean`, `adiadoId`, `adiadoAte`, além de `enabled/som`. Campos desconhecidos são recusados. Sem janela nativa, somente aparência/som podem ser gravados. Pausa da companhia não altera atendimento. IPC de abrir usa o assunto do snapshot validado, sem aceitar destinatário/URL livre do renderer; abrir no app revalida a fonte.

Inicialização aguarda `DOMContentLoaded`, garantindo registro dos módulos antes de buscar o perfil e navegar. O ensaio integrado atrasa deliberadamente um asset para prevenir a corrida observada no acervo real.
