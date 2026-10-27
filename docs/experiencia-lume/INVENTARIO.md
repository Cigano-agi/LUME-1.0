# Inventário automatizado da experiência Lume

Gerado por `node scripts/inventario-experiencia.mjs`. Verificação sem escrita: `node scripts/inventario-experiencia.mjs --check`. [Dados completos](INVENTARIO.json).

A lista nasce do código atual; não há contagens, rotas ou nomes de telas congelados no verificador. Mudanças exigem regenerar o artefato. O check compara conteúdo e cobertura, verifica parsing e scripts/assets locais; não prova execução nem aceite.

| Categoria | Registros |
| --- | ---: |
| scope | 2 |
| files | 283 |
| routes | 156 |
| assets | 58 |
| screens | 6 |
| dialogs | 50 |
| navigation | 109 |
| states | 810 |
| scripts | 139 |
| apiReferences | 475 |
| dynamic | 7 |
| issues | 0 |

## Telas estáticas

| id | arquivo | hidden |
| --- | --- | --- |
| workspace | src/painel/app.html:17 | true |
| today | src/painel/app.html:25 | false |
| memory | src/painel/app.html:45 | true |
| graph | src/painel/app.html:46 | true |
| settings | src/painel/app.html:59 | true |
| onboarding | src/painel/app.html:6 | true |

## Diálogos declarados

| dialog | arquivo |
| --- | --- |
| dialog | src/painel/acoes.js:378 |
| draft-dialog | src/painel/app.html:94 |
| learn-example | src/painel/app.html:94 |
| terms-dialog | src/painel/app.html:94 |
| download-dialog | src/painel/apresentacao.html:15 |
| dialog | src/painel/beta-loader.js:10 |
| dialog | src/painel/comandos.js:50 |
| dialog | src/painel/negocios.js:110 |
| dialog | src/painel/negocios.js:18 |
| dialog | src/painel/negocios.js:229 |
| note-dialog | src/painel/painel.html:48 |
| connection-dialog | src/painel/painel.html:49 |

## Rotas HTTP reconhecidas

| método | rota | arquivo |
| --- | --- | --- |
| POST | /api/v3/notetaker/sessoes | src/notetaker/http.js:53 |
| POST | /api/v3/semantica/pausar | src/painel/servidor.js:1002 |
| POST | /api/v3/ia/config | src/painel/servidor.js:1005 |
| POST | /api/v3/ia/remover-chave | src/painel/servidor.js:1006 |
| POST | /api/v3/ia/permissao | src/painel/servidor.js:1007 |
| POST | /api/v3/ia/preparar | src/painel/servidor.js:1008 |
| POST | /api/v3/ia/responder | src/painel/servidor.js:1009 |
| POST | /api/notas | src/painel/servidor.js:1013 |
| POST | /api/config/chave | src/painel/servidor.js:1016 |
| POST | /api/crm/falso-positivo | src/painel/servidor.js:1031 |
| POST | /api/conectar | src/painel/servidor.js:1039 |
| POST | /api/desconectar | src/painel/servidor.js:1047 |
| POST | /api/grupos/sincronizar | src/painel/servidor.js:1048 |
| POST | /api/crm/estado | src/painel/servidor.js:1055 |
| POST | /api/caixas/backfill | src/painel/servidor.js:1067 |
| GET | /api/v3/dados/backup-v10/arquivo | src/painel/servidor.js:234 |
| GET | / | src/painel/servidor.js:252 |
| GET | /api/v3/versao | src/painel/servidor.js:254 |
| GET | /api/v3/perfil | src/painel/servidor.js:255 |
| GET | /api/v3/conversas/cobertura-midia | src/painel/servidor.js:258 |
| GET | /api/v3/historico | src/painel/servidor.js:258 |
| GET | /api/v3/compartilhamento//importados | src/painel/servidor.js:263 |
| GET | /api/v3/compartilhamento/ | src/painel/servidor.js:267 |
| GET | /api/v3/compartilhamento//item | src/painel/servidor.js:271 |
| GET | /api/v3/compartilhamento//timeline | src/painel/servidor.js:271 |
| GET | /api/v3/compartilhamento//item | src/painel/servidor.js:275 |
| GET | /api/v3/vendas/jev | src/painel/servidor.js:287 |
| GET | /api/v3/vendas/avaliacao | src/painel/servidor.js:290 |
| GET | /api/v3/historico | src/painel/servidor.js:296 |
| GET | /api/v3/execucoes/timeline | src/painel/servidor.js:302 |
| GET | /api/v3/execucoes | src/painel/servidor.js:309 |
| GET | /api/v3/execucoes/item | src/painel/servidor.js:309 |
| GET | /api/v3/experiencia | src/painel/servidor.js:317 |
| GET | /api/v3/clareza | src/painel/servidor.js:322 |
| GET | /api/v3/laya | src/painel/servidor.js:326 |
| GET | /api/v3/audio | src/painel/servidor.js:330 |
| GET | /api/v3/telegram-hoje | src/painel/servidor.js:334 |
| GET | /api/v3/lembretes | src/painel/servidor.js:338 |
| GET | /api/v3/atualizacoes | src/painel/servidor.js:345 |
| GET | /api/v3/novidades | src/painel/servidor.js:346 |
| GET | /api/v3/mcp | src/painel/servidor.js:347 |
| GET | /api/v3/mcp/pacote | src/painel/servidor.js:351 |
| GET | /api/v3/central | src/painel/servidor.js:361 |
| GET | /api/v3/tarefas/estado | src/painel/servidor.js:365 |
| GET | /api/v3/acoes/conversas | src/painel/servidor.js:366 |
| GET | /api/v3/central/feedback-rascunho | src/painel/servidor.js:372 |
| GET | /api/v3/acoes/estado | src/painel/servidor.js:376 |
| GET | /api/v3/acoes/analise | src/painel/servidor.js:381 |
| GET | /api/v3/acoes | src/painel/servidor.js:385 |
| GET | /api/v3/pessoal | src/painel/servidor.js:395 |
| GET | /api/v3/acoes/item | src/painel/servidor.js:404 |
| GET | /api/v3/tarefas | src/painel/servidor.js:409 |
| GET | /api/v3/compartilhamento | src/painel/servidor.js:422 |
| GET | /api/v3/dados | src/painel/servidor.js:423 |
| GET | /api/v3/semantica | src/painel/servidor.js:424 |
| GET | /api/v3/busca-semantica | src/painel/servidor.js:425 |
| GET | /api/v3/ia/estado | src/painel/servidor.js:435 |
| GET | /api/v3/fonte | src/painel/servidor.js:436 |
| GET | /api/v3/comandos | src/painel/servidor.js:439 |
| GET | /api/v3/whatsapp-labels | src/painel/servidor.js:451 |
| GET | /api/v3/tags | src/painel/servidor.js:456 |
| GET | /api/v3/resumo | src/painel/servidor.js:467 |
| GET | /api/v3/grafo | src/painel/servidor.js:478 |
| GET | /api/v3/grafo/fontes | src/painel/servidor.js:478 |
| GET | /api/v3/conversas | src/painel/servidor.js:486 |
| GET | /api/v3/negocios | src/painel/servidor.js:506 |
| GET | /api/v3/busca | src/painel/servidor.js:538 |
| GET | / | src/painel/servidor.js:543 |
| GET | /api/sessao | src/painel/servidor.js:544 |
| GET | /api/config | src/painel/servidor.js:545 |
| GET | /api/progresso | src/painel/servidor.js:546 |
| GET | /api/precisao | src/painel/servidor.js:549 |
| GET | /api/rascunho | src/painel/servidor.js:553 |
| GET | /api/estado | src/painel/servidor.js:556 |
| GET | /api/conversas | src/painel/servidor.js:561 |
| GET | /api/mensagens | src/painel/servidor.js:562 |
| GET | /api/qr | src/painel/servidor.js:567 |
| GET | /api/grupos | src/painel/servidor.js:585 |
| GET | /api/crm | src/painel/servidor.js:622 |
| GET | /api/caixas | src/painel/servidor.js:661 |
| POST | /api/v3/dados/backup-v10/importar | src/painel/servidor.js:683 |
| POST | /api/v3/audio/preparar | src/painel/servidor.js:695 |
| POST | /api/v3/compartilhamento/preparar-importacao | src/painel/servidor.js:695 |
| POST | /api/v3/dados/preparar-restauracao | src/painel/servidor.js:695 |
| POST | /api/v3/aceite | src/painel/servidor.js:698 |
| POST | /api/conectar | src/painel/servidor.js:699 |
| POST | /api/grupos/sincronizar | src/painel/servidor.js:699 |
| POST | /api/v3/laya/classificar | src/painel/servidor.js:702 |
| POST | /api/v3/guia | src/painel/servidor.js:711 |
| POST | /api/v3/telegram-hoje | src/painel/servidor.js:716 |
| POST | /api/v3/telegram-hoje/desativar | src/painel/servidor.js:722 |
| POST | /api/v3/whatsapp-labels | src/painel/servidor.js:728 |
| POST | /api/v3/lembretes | src/painel/servidor.js:736 |
| POST | /api/v3/lembretes/testar | src/painel/servidor.js:737 |
| POST | /api/v3/central/feedback-rascunho | src/painel/servidor.js:745 |
| POST | /api/v3/historico/recuperar | src/painel/servidor.js:834 |
| POST | /api/v3/negocios/preparar | src/painel/servidor.js:897 |
| POST | /api/v3/negocios/salvar | src/painel/servidor.js:898 |
| POST | /api/v3/politica | src/painel/servidor.js:992 |
| POST | /api/v3/resolver | src/painel/servidor.js:993 |
| POST | /api/v3/nota | src/painel/servidor.js:994 |
| POST | /api/v3/semantica/ativar | src/painel/servidor.js:995 |
| GET | /api/v3/pessoal/classificador | src/pessoal/http.js:15 |
| GET | /api/v3/pessoal/companheiro | src/pessoal/http.js:16 |
| GET | /api/v3/pessoal/avaliacao | src/pessoal/http.js:17 |
| GET | /api/v3/pessoal/avaliacao/relatorio | src/pessoal/http.js:18 |
| GET | /api/v3/pessoal/chatgpt | src/pessoal/http.js:19 |
| GET | /api/v3/pessoal/chatgpt/modelos | src/pessoal/http.js:20 |
| POST | /api/v3/pessoal/companheiro | src/pessoal/http.js:25 |
| POST | /api/v3/pessoal/mensagem/preparar | src/pessoal/http.js:29 |
| POST | /api/v3/pessoal/acompanhamento | src/pessoal/http.js:30 |
| POST | /api/v3/pessoal/mensagem/aprovar | src/pessoal/http.js:34 |
| POST | /api/v3/pessoal/avaliacao/iniciar | src/pessoal/http.js:38 |
| POST | /api/v3/pessoal/avaliacao/proximo | src/pessoal/http.js:39 |
| POST | /api/v3/pessoal/avaliacao/revisar | src/pessoal/http.js:40 |
| POST | /api/v3/pessoal/avaliacao/aceitar | src/pessoal/http.js:41 |
| POST | /api/v3/pessoal/config | src/pessoal/http.js:42 |
| POST | /api/v3/pessoal/conversa | src/pessoal/http.js:43 |
| POST | /api/v3/pessoal/atendimento | src/pessoal/http.js:44 |
| POST | /api/v3/pessoal/classificador | src/pessoal/http.js:45 |
| POST | /api/v3/pessoal/vinculo | src/pessoal/http.js:48 |
| POST | /api/v3/pessoal/credencial | src/pessoal/http.js:49 |
| POST | /api/v3/pessoal/chatgpt/login | src/pessoal/http.js:55 |
| POST | /api/v3/pessoal/chatgpt/modelo | src/pessoal/http.js:56 |
| POST | /api/v3/pessoal/chatgpt/conta | src/pessoal/http.js:57 |
| POST | /api/v3/pessoal/chatgpt/testar | src/pessoal/http.js:59 |
| GET | /api/v3/pessoal | src/pessoal/http.js:6 |
| POST | /api/v3/pessoal/chatgpt/sair | src/pessoal/http.js:60 |
| POST | /api/v3/pessoal/chatgpt/retomar | src/pessoal/http.js:61 |
| GET | /api/v3/pessoal/conversas | src/pessoal/http.js:7 |
| GET | /api/v3/pessoal/organizacao | src/pessoal/http.js:8 |

## Cobertura e limites

- JSON preserva arquivo/linha, condições, navegação declarada e chamadas, estados ARIA/DOM, importações e scripts, assets e hashes dos arquivos lidos. Estados são pontos de código; sua presença não comprova transições nem acessibilidade.
- AST Babel reaproveitado do Playwright instalado; erros de sintaxe falham o check. Vendor é registrado por hash, sem extrair implementação de terceiros. HTML e templates usam extração de atributos, não renderização completa de DOM.
- Rotas condicionais e conjuntos são detectados; prefixos, regex e expressões dinâmicas permanecem identificados em dynamic/routes. Guardas e referências de cliente ficam separados de handlers. Notetaker contém regex dependentes de ramo; não são achatadas em URLs fictícias.
- Importações calculadas, aliases de navegação e construção arbitrária de HTML podem exigir inspeção manual; isto não é prova de cobertura comportamental exaustiva.
- Baseline privada: `work/experiencia-lume-20261026/baseline-result.json`; método, limitações e APIs reais em `work/experiencia-lume-20261026/inventario-relatorio.md`.
