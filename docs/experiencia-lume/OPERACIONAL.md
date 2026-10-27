# Telas operacionais — implementação e prova

Data: 26/10/2026 (America/Sao_Paulo). Dispatch `ctx_32a4d6f59bb0`, tarefa `task_03b92ef70495`, run `run_b9775c3c3689`.

Estado: módulo implementado, testes dirigidos e percurso integrado HTTP/SQLite em perfil sintético verificados. Screenshots do ensaio integrado foram gerados e a tela Agora clara foi inspecionada. Revisão independente, perfil real e aceite continuam no gate da coordenação. Nenhum envio externo, gasto, commit ou alteração de autorização foi executado neste território.

## Arquivos e integração

- `src/painel/experiencia.js`: script clássico, expõe somente `window.LumeVivo.carregar(view)`, `abrirAssunto(id)`, `limpar()`.
- `test/experiencia-ui.test.js`: testes DOM em Microsoft Edge headless/Playwright com CSS real, dados explicitamente sintéticos e sem fixture embutida no produto.
- Este relatório: contratos lidos, prova e limites.

O shell deve carregar o módulo depois de disponibilizar `window.lumeConnectionRequest` e chamar `carregar` ao navegar. O módulo cria `#lv-today`, `#lv-sales`, `#lv-deliveries` dentro das sections homônimas; não substitui HTML, CSS, backend ou controles legados. A coordenação é responsável pelo shell, integração de assets e pelo destino `window.navegarLume`. `hoje/agora`, `Comercial`, `Entregas`, `memoria/pessoas/relacoes` têm aliases para as views internas. O corpo usa `lume-vivo`; classes, ícones do sprite, `data-category`, `data-state` e animações finitas seguem a fundação.

`lume:navigate` cancela a carga pendente e fecha o drawer. `lume:invalidate` chama `limpar`, cancela cargas e remove cards/contextos. O shell deve emitir a invalidação quando fontes/permissões mudarem. Não há polling do módulo.

## Comportamento entregue

Agora apresenta três blocos, até três assuntos iniciais por bloco, expansão por botão acessível, filtro de categoria e fontes compactas com pessoa/autor/data. Identidade dos cards é a identidade persistida do assunto; nomes ou títulos nunca são usados como chave. A projeção fornece a ordem, os acontecimentos, consequências e grupos. Após QA visual da coordenação, os cards passaram a limitar acontecimentos a160caracteres, omitir consequências genéricas e deixar lacunas de prazo/verificação no drawer. O título sublinhado é o botão principal, com nome acessível “Abrir assunto: …”; o texto completo, autoria, tipo e data continuam no detalhe.

Comercial apresenta lista e Kanban opcional por estado do acompanhamento, acessíveis por teclado sem arrastar. Cartão e detalhe separam a etapa confirmada (`negocio.etapa`, borda sólida) da avaliação (`avaliacao`, bloco tracejado com origem inferida ou registrada pelo usuário). Interesse permanece qualitativo, sem porcentagens; avaliação nunca preenche uma etapa confirmada ausente. O teste final contrapõe proposta confirmada e fechamento inferido no mesmo assunto, além de avaliação manual e ausência de registro.

Entregas distingue resultado informado e verificado e mantém envio/aceite sem registro quando o backend retorna `null`. Prazo, responsável, projeto, dependências e próxima verificação ausentes são explícitos. Dependências ainda não fazem parte da projeção; a tela informa essa lacuna, sem inventar relações.

O drawer é um `dialog.showModal()` com nome acessível, Escape, trap de Tab/Shift+Tab, retorno de foco e restauração da posição dos containers roláveis. Cada abertura consulta novamente o assunto por ID e, quando existe ação, revalida `/acoes/item`. A fonte é construída com DOM/textContent, nunca HTML interpretado. Resolver abre `abrirResolverLume` com a ação revalidada, nas mesmas condições de estado do card legado; ação sugerida sem execução oferece somente `abrirAcaoDoAviso`, preservando a confirmação existente. Fonte abre `abrirFonteTarefa(eventoId)`. Controles só aparecem quando a projeção lista os tipos `acao`/`fonte` e o destino existe. Essas operações não enviam mensagens nem iniciam execução automaticamente.

Histórico usa as execuções autorizadas da ação e consulta os registros sob demanda, vinte por página. Quando `execucao_ui.estado=nenhuma`, não consulta a ACL separada de Resolver: não há execução a consultar. `indisponivel` mantém a lacuna explícita. Cursor `antes` e IDs dos eventos evitam duplicação. Resultado informado não vira verificação. Erro de permissão durante uma página de histórico remove também o contexto e os controles do assunto, aborta pedidos concorrentes e mantém opção de revalidar.

Todos os GETs passam por `lumeConnectionRequest(path, undefined, {timeout:15000, signal})`. As versões de requisição protegem a UI mesmo quando uma resposta chega após abort. Não há repetição automática. Erros recuperáveis oferecem botão de retry; erros de permissão removem conteúdo anterior. Paginação da projeção preserva identidade e permite buscar assunto por ID fora da primeira página.

## Contratos reais consultados

- `src/experiencia-lume.js`: envelope versão1, `itens`, `lacunas`, `conexao`, `pagina`, `proximaPagina`; `estadoRotulo`, `acontecimento`, `consequencia`, `pessoas[{id,nome}]`, `fonte.eventoId/autor/recebidoEm/trecho/tipo`, `acoes[{tipo,rotulo}]`, `entrega` e `acompanhamento.proximaVerificacao`.
- `src/painel/servidor.js`: `/api/v3/experiencia` aceita `pagina/limite` e consulta por `id`; `/acoes/item?id=…`; `/execucoes?acao_id=…`; `/execucoes/timeline?id=<execucao>&limite=20&antes=…`.
- `src/execucao/servico.js`: `listar` retorna `{execucoes}` com revalidação das fontes; `historico` retorna `{timeline,antes}`.
- `src/painel/acoes.js`, `tarefas.js`: contratos dos fluxos existentes de Resolver, ação e fonte.
- `src/painel/graph.js`: o grafo2D já tem lista equivalente, foco, paginação, seleção e acesso às fontes. Memória ganha apenas um botão contextual para esse destino; o módulo não cria um segundo grafo.

A primeira leitura mostrou que busca aceitava apenas `q/conversa/antes`; a incompatibilidade com filtros adicionais foi comunicada ao root. Durante este Dispatch, a coordenação implementou os filtros `pessoa/assunto/de/ate/tipo` no backend e assumiu sua UI em `app.js`. Pessoas também fica no shell existente da coordenação, com controles e políticas atuais. Este módulo não altera as permissões, pausa, grupos, exclusões, intervenção manual ou envio.

## Prova executada

No diretório `app`:

```text
node --check src/painel/experiencia.js
node --test --test-concurrency=1 --test-timeout=180000 test/experiencia-ui.test.js
```

Resultado final: **14/14 PASS**, zero falhas, skips ou cancelamentos. O teste carrega `experiencia.js` e `experiencia.css` reais num navegador isolado a1024×768 com reduced-motion; respostas da API são sintéticas e controladas para reproduzir concorrência e revogação.

Casos executados: limite/expansão de Agora; resposta atrasada após troca de tela; invalidação com resposta tardia; foco/trap/Escape/scroll e texto sem interpretação HTML; troca rápida de assunto; revogação e retry; ações ausentes/estados reais de entrega; vazio/timeout/identidade duplicada; paginação/deduplicação/foco da timeline; paginação de assuntos/Kanban; integração dos identificadores de fonte/Resolver; revogação durante timeline; reaproveitamento de Relações/busca/Pessoas.

Primeira rodada:10/11 PASS; o locator do teste continuava procurando “Ver mais2” após o botão trocar para “Mostrar menos” e passou a selecionar outro bloco. Corrigido para identificar o botão por `aria-controls`; segunda rodada11/11 PASS com CSS real. Depois foram acrescentados dois casos e executada a rodada13/13. Nenhum gate foi enfraquecido.

A revisão integrada da coordenação identificou um defeito adicional: uma ação pessoal legível, sugerida e sem execução consultava `/execucoes`, recebia409 pela ACL própria de Resolver e perdia o contexto. Reproduzido com `node test/experiencia-lume.e2e.mjs` e no novo teste DOM RED, ambos falhando antes da correção. Corrigida a condição de consulta/CTA sem mudar backend, ACL ou confirmação; a suíte passou14/14. Após compactação visual dos cards,14/14 foi executado novamente com sucesso.

O comando integrado `node test/experiencia-lume.e2e.mjs` foi repetido após correção e após compactação. Ambas as rodadas finais concluíram com5checks, zero erros de script e zero erros HTTP: shell real, assunto/fontes, busca global no SQLite, filtros de memória e ausência de overflow global a1024×768. O ensaio é sintético, mas executa renderer, HTTP e SQLite reais. O JSON e as capturas gerados pelo teste da coordenação ficam em `work/experiencia-lume-20261026/e2e-result.json` e `ui-*.png`. `ui-today-light.png` foi inspecionado: cards compactados preservam título acionável, trecho, estado e fonte, com primeiro cartão inteiro visível na captura1440×1000. Esta inspeção não cobre todos os temas/percursos.

## Limites de comprovação

Esta prova não mede perfil real, serviços externos reais, leitor de tela, instalação, macOS, hardware8GB ou aceite de Fabrício. O gate de perfil real e a revisão visual ampla continuam sob responsabilidade da coordenação. A revisão independente deve repetir os gates e ler os arquivos, sem tomar este relato como prova suficiente.
