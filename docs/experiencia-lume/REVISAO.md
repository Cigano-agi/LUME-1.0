# Revisão independente — Lume vivo

**APROVADO para o checkout local revisado**, com os limites abaixo. Revisão de 26/10/2026, Dispatch `ctx_bf224b4f6ed5`, run `run_b9775c3c3689`. O parecer cobre implementação e provas locais; instalação distribuída e aceite de Fabrício permanecem separados.

O revisor não implementou o produto, não alterou permissões do perfil real, não enviou mensagens e não fez commits. O território inicial foi `work/experiencia-lume-20261026/review-*` e este documento; a coordenação autorizou depois a persistência da suíte própria em `test/experiencia-seguranca-review.test.js`. Não houve subdelegação, uso pago adicional ou chamada JEV nesta revisão.

## Estado e independência

- Snapshot inicial: HEAD `8cc010dd4c9f1f8001ea9bd1a7836b5ebf07988b`, estado e patch privados em `review-git-inicial.txt` e `review-diff-inicial.patch`.
- FREEZE funcional recebido em `2026-10-27T00:47:44Z`; achados de exclusão e o ajuste visual Comercial produziram deltas posteriores, repetidos separadamente. Último commit de produto conferido: `00591ad`.
- Gates executados no checkout integrado, que inclui alterações anteriores ainda presentes. A aprovação não significa que todo o working tree pertence a este sprint.
- Evidências abaixo estão em `app/work/experiencia-lume-20261026/`, exceto a suíte persistida. Screenshots do acervo são privados e não foram adicionados ao Git pelo revisor.

## Achados e correções verificadas

| Achado | Prova inicial | Correção e repetição |
|---|---|---|
| Acompanhamento aceitava ação de pessoa excluída, embora a projeção já a omitisse. | `review-exclusion-delta.txt`: rejeição esperada ausente. Caminho: `src/pessoal/http.js:32` → `src/pessoal/servico.js:308`. | Serviço recusa a exclusão (`servico.js:311`), loop ignora registro anterior (`:322`) e resumo retira a pessoa (`:350`). Testes de rota, registro prévio e resumo passaram. |
| Excluir durante a consulta assíncrona ainda enfileirava aviso com contexto antigo. | `review-exclusion-r3.txt`: antes da consulta passava; durante a consulta falhava. | `servico.js:324–330` compara política, fonte, ação e registro após o `await`, antes de avisar ou persistir. Exclusão, revogação e edição durante a consulta passaram; nenhum aviso entrou na fila do stub. |
| Bootstrap podia entrar em Hoje antes de o módulo novo existir. | `review-acervo/review-first-attempt.json`: timeout de 30s sem `#lv-today`. Segunda inspeção: `page=today`, módulo carregado, `hasToday=false`; clicar Agora recuperava a tela. | Inicialização aguarda `DOMContentLoaded` em `src/painel/app.js:489`. Repetição com atraso do asset e acervo real abriu Agora diretamente. |
| Título duplicado em Agora e resumos longos ocupavam excessivamente cartão e cabeçalho. | Capturas reais enviadas à coordenação durante a revisão. | Cabeçalho único, título visual abreviado e assunto integral no corpo/nome acessível. Capturas finais `review-acervo/review-today.png` e `review-detalhe.png` foram inspecionadas. |
| Gate anterior567 ainda esperava formato antigo das preferências. | `review-regression567.txt`: 566 PASS / 1 FAIL em `pessoal-companheiro-review.test.js:151`. | Executor atualizou os defaults exatos, mantendo privacidade e persistência. Repetição: 567 PASS, zero falhas/skips/cancelamentos. |

Também foi revalidada a correção do detalhe de ação pessoal sem execução: fonte legível continua acessível sem consultar indevidamente a autorização separada de Resolver. O teste dirigido correspondente passou.

## Segurança, dados e contratos

A projeção usa identidade `acao:<UUID>`, recupera a fonte atual e conserva prazo/responsável ausentes. Alteração de texto, revogação da leitura, exclusão física da fonte e exclusão da pessoa retiraram lista, detalhe e companhia. Renomear a pessoa preservou a identidade da ação.

GET de experiência e busca funcionou com SQLite em `PRAGMA query_only=ON`, sem incremento de `total_changes()`. HTTP recusou ausência de sessão, origem externa e campos extras. A cópia do acervo também permaneceu sem escrita durante o percurso completo. Esses resultados não afirmam que inicializar schemas seja uma operação sem escrita: a inicialização ocorreu somente na cópia antes de ativar o bloqueio.

Grupos conservaram leitura sem habilitação de envio. Preparar resposta persistiu apenas proposta pendente, sem aprovação ou chamada externa; pausa cancelou a proposta e impediu nova preparação. Acompanhar exigiu confirmação explícita, fonte atual e autorização já existente. A exclusão foi verificada novamente após espera assíncrona. Conteúdo literal foi tratado como texto, inclusive na prova nativa de nota contendo marcação de script.

Resultado informado, verificado, enviado e aceito permaneceram estados distintos; resolver uma ação não inventou recibo ou aceite. IPC do companheiro conserva origem no renderer/main frame exatos, schema fechado e destino limitado ao assunto validado; sandbox/context isolation e bloqueio de janelas externas foram conferidos. Preferência só confirma após recibo de persistência do serviço.

Os cinco contratos MCP de leitura em `src/mcp/schemas.js` foram preservados. Grafo2D e lista equivalente continuam no módulo existente, com fonte, paginação e seleção por teclado. Não foi criado outro armazenamento, fila ou conector pela projeção.

## Gates executados

| Gate independente | Resultado | Evidência |
|---|---|---|
| Projeção, organização e companhia antes do FREEZE | 41/41 PASS | `review-directed-pre-freeze.txt` |
| MCP e grafo | 20/20 PASS | `review-mcp-graph.txt` |
| Suíte final persistida de experiência | 45/45 PASS, 56,792s | `review-persisted-final.txt`; inclui 13 casos independentes de segurança |
| Delta visual Comercial posterior | 16/16 PASS, 12,672s | `review-commercial-delta.txt`; etapas confirmada e inferida diferentes, sem porcentagem ou mutação |
| Regressão sequencial comparável à anterior | 567/567 PASS, 161,137s | `review-regression567-final.txt`; delta posterior de revalidação coberto pelos 45 casos finais |
| HTTP + SQLite + renderer | Seis verificações, zero erro de script | `review-e2e/e2e-result.json`; fixture explicitamente sintética |
| Electron Windows independente | Seis percursos, reinício e preferências preservados, zero erro | `review-native/resultado.json` e oito capturas; perfil temporário próprio |
| Zoom nativo 200% nas seis telas | Viewport CSS 512×384 sobre janela de conteúdo 1024×768; sem overflow horizontal | `review-native-zoom/review-result.json`, capturas `review-content-*.png` |
| Acervo real em cópia consistente | 360.601 eventos, seis telas, detalhe e fonte, zero erro JS/POST/rede externa/escrita | `review-acervo/review-result.json` e capturas privadas |
| Inventário | Check sem falhas; 283 arquivos/156 rotas/58 assets | `review-inventory-final.txt`; contagem não equivale a percurso executado |

O percurso integrado também verificou Enter, Tab/Shift+Tab dentro do diálogo, Escape com retorno ao invocador, Ctrl+K, dois temas, filtros, paginação e ausência de animações infinitas sob reduced-motion. A primeira sondagem de zoom por CSS indicou overflow em Memória; a investigação com zoom nativo real nas seis telas não reproduziu isso. CSS zoom não foi usado como substituto da prova nativa.

O ajuste Comercial final (`00591ad`) separa `negocio.etapa` de `avaliacao.etapa/temperatura` no cartão e detalhe. Avaliação manual continua identificada como registro do dono, e avaliação inferida não se torna etapa confirmada. O diff só acrescenta renderização com DOM/textContent e estilos; o gate dirigido foi repetido depois desse commit. A captura sintética complementar está em `review-commercial-light.png`, `review-commercial-dark.png` e `review-commercial-detail.png`.

O endpoint CDP histórico não respondeu e não havia processo Lume/Electron observável naquele momento. A coordenação autorizou então o backup SQLite consistente, aberto na origem com `readOnly:true`. Nenhum perfil real foi reiniciado, nenhuma sessão/cofre foi copiada e nenhum worker/conector foi iniciado nessa cópia. O ensaio nativo usou outro perfil, fictício. São duas provas diferentes, sem alegar que o aplicativo instalado executa o código novo.

Os harnesses de revisão preservam logs de diagnóstico próprios. Erros de preparação de teste — uso inicial de `db.pragma`, stub de encerramento incompleto e erro sintático transitório — foram corrigidos somente nos arquivos do revisor e não foram apresentados como falhas do produto.

## Desempenho comparável e investigação

Três rodadas por UI, Edge headless novo, mesma máquina, viewport1440×1000, reduced-motion, mesmo backend/hash, mesmo banco vazio e mesma ordem de rotas. UI antiga servida do snapshot `baseline-ui`; atual servida de `src/painel` no corte `14941ad`, antes do delta exclusivamente visual Comercial. Os números não medem a renderização de cartões comerciais povoados. Provas: `review-perf-baseline.json`, `review-perf-current.json`, `review-perf-comparison.json`.

| Mediana | UI anterior | UI atual | Variação |
|---|---:|---:|---:|
| Abertura | 1.331,5ms | 1.273,7ms | −4,3% |
| Agora | 250,9ms | 45,7ms | −81,8% |
| Memória | 51,8ms | 60,0ms | +15,8% |
| Ajustes | 24,5ms | 28,7ms | +17,3% |
| Busca da memória | 28,3ms | 42,0ms | +48,3% |

Os três aumentos acima de10% foram investigados com12 amostras aquecidas por rota, alternando a ordem antiga/atual em contextos separados, aguardando `show()` e dois frames. CDP mediu layout, estilo, script e trabalho do renderer; Resource Timing identificou as requisições. Prova: `review-perf-investigation.json`.

- Memória:37,9→33,4ms, −11,9%; busca:23,7→24,8ms, +4,6%. O aumento da primeira rodada não se manteve nesse método alternado.
- Ajustes:8,5→10,1ms, +18,8%, diferença absoluta1,6ms. Não houve HTTP; layout0,756→0,752ms e trabalho do renderer5,63→6,47ms. As faixas de amostras se sobrepõem. Há75 elementos adicionais na interface atual; atribuir causalidade exata exige profiling mais profundo. O pequeno custo observado não bloqueia esta entrega local, mas o percentual permanece registrado.
- Heap JS após os percursos ficou aproximadamente3,3–3,8MB em ambas as interfaces. Não é a memória total do Electron.
- Na cópia real, cinco projeções de assunto para companhia levaram16,4–32,7ms, mediana20,2ms; RSS do processo de ensaio no checkpoint:131,8MiB. Não inclui renderer, transcrição ou modelo.
- A medição de ingestão da coordenação foi lida em `ingestao-recursos.json`:1000 eventos sintéticos/zero falhas/1.306ms, pico RSS84,2MiB, maior snapshot13,8ms. Esse benchmark não foi repetido pelo revisor e permanece identificado como evidência da coordenação.

## Reprodução e limites

```powershell
node --test --test-concurrency=1 --test-timeout=180000 test/experiencia-*.test.js
node --test --test-concurrency=1 --test-timeout=180000 test/pessoal-*.test.js test/telegram-*.test.js test/autorizacao.test.js test/contexto-app.test.js test/socket.test.js test/desktop.test.js test/segredos.test.js test/clareza-dia.test.js test/nomes-conversa.test.js test/contatos-desktop.test.js
node work/experiencia-lume-20261026/review-e2e.mjs
node work/experiencia-lume-20261026/review-native.mjs
node work/experiencia-lume-20261026/review-native-zoom.mjs
node work/experiencia-lume-20261026/review-performance.mjs baseline
node work/experiencia-lume-20261026/review-performance.mjs current
node work/experiencia-lume-20261026/review-compare-performance.mjs
node work/experiencia-lume-20261026/review-perf-investigate.mjs
node scripts/inventario-experiencia.mjs --check
```

Não há achado bloqueante aberto no código revisado. Permanecem sem comprovação específica: aceite de utilidade/tom, percepção sonora humana, leitor de tela, execução nativa macOS, hardware físico8GB, instalação/assinatura/distribuição e execução do código novo no perfil instalado. Esses itens não foram convertidos em aceite por inferência. A captura avançada do PC e operação remota contínua permanecem fora do produto ativado neste sprint.
