# Desempenho e carga nativa — 27/10/2026

**Resultado: medido e investigado, sem causa exclusiva isolada para a variação. Não é uma aprovação geral de ausência de regressão nem uma prova de funcionamento em 8 GB.** A comparação principal terminou sem erro HTTP/JavaScript. Memória e Projetos ultrapassaram 10% nessa série; o diagnóstico separado não repetiu esses aumentos, mas voltou a observar aumento em Vendas. Nenhuma amostra foi removida, nenhuma fonte do produto foi alterada e as séries não foram combinadas.

Todos os dados usados aqui são **sintéticos**. Não há conversas reais, credenciais, telas pessoais ou publicação externa neste documento. Caminhos abaixo são relativos ao repositório; os recibos detalhados ficam na área local de evidências `work/`.

## Método e condição

- UI baseline: `f656a2108dc7b8a4d5facce7d8be941650613695`, snapshot preservado. UI atual: `c7f8407d15bca7206eec220eb5dc85cf4f3eddc0`, extraída diretamente por `git archive`; `src/painel` foi conferido contra esse commit.
- Windows, Intel i7-12650H, aproximadamente 32 GiB. A coordenação liberou a janela sem backup, build, avaliação ou testes próprios concorrentes. Processos pessoais foram preservados; isso não equivale a controlar toda atividade do sistema operacional.
- Mesmo servidor HTTP/SQLite real e mesma sessão dentro de cada série; 4.000 eventos, 100 conversas (20 grupos), 100 ações e oito projetos. Hash dos eventos preservado antes/depois. Nenhuma conta/modelo conectado ou chamada externa.
- Edge headless, 1440×1000, tema claro e movimento reduzido; um navegador por série, contexto/cache novos por percurso. Sete pares AB/BA alternados e um par de aquecimento separado; mesma ordem de rotas em cada par, rotacionada entre pares.
- Abertura: DOM carregado, Agora pronto, fontes e dois frames. Navegação: função real do produto, marcadores visíveis de carregamento encerrados e dois frames. Não se acrescentou o piso arbitrário de `networkidle` ao intervalo medido.
- O baseline usa o backend atual compatível. Esta é uma comparação de interface e escolhas de requisições, não de dois binários históricos completos. Pessoas possui escopo/API diferentes; Vendas fica sem oportunidades comerciais nesta massa, embora a projeção completa seja consultada. Não mede Kanban preenchido, inferência de modelo, perfil real, macOS ou equipamento de 8 GB.

## Comparação principal com HTTP completo

Execução: **05:14:04–05:14:51 UTC**, exit0. Todas as respostas, inclusive assets, endpoints legados e aquecimento, foram registradas. Zero HTTP≥400, erro JavaScript, falha de requisição durante o percurso ou tentativa externa. Nenhum prefixo de API foi excluído da avaliação.

Valores em milissegundos. Colchetes mostram P25–P75. “Δ pareado” é a mediana das diferenças percentuais de cada par; é um estimador distinto da diferença entre medianas.

| Percurso | Baseline mediana [P25–P75] | Atual mediana [P25–P75] | Δ ms | Δ medianas | Δ pareado |
|---|---:|---:|---:|---:|---:|
| Abertura | 760,5 [715,0–778,2] | 764,7 [703,2–779,5] | +4,3 | +0,6% | +6,0% |
| Agora | 338,3 [300,0–359,9] | 290,0 [267,2–345,5] | −48,3 | −14,3% | −5,8% |
| Memória | 77,1 [72,4–89,4] | 89,9 [72,4–99,0] | +12,8 | **+16,5%** | +10,5% |
| Vendas | 297,9 [266,1–365,7] | 301,4 [261,6–404,3] | +3,6 | +1,2% | +8,5% |
| Projetos | 320,4 [273,8–514,2] | 389,5 [286,5–419,6] | +69,1 | **+21,6%** | +8,3% |
| Pessoas | 99,3 [88,2–149,3] | 81,7 [71,9–88,1] | −17,6 | −17,7% | −14,0% |
| Ajustes | 30,4 [28,4–32,1] | 32,3 [30,8–47,1] | +1,9 | +6,4% | +6,6% |
| Relações | 84,4 [79,1–99,0] | 87,4 [81,1–94,1] | +3,0 | +3,5% | +3,5% |

A amplitude também importa: abertura baseline 576,4–2.337,4 ms, atual 639,5–1.049,3 ms; Memória 58,2–115,3 contra 67,0–99,2 ms; Projetos 262,6–831,4 contra 261,2–716,5 ms; Vendas 205,0–852,5 contra 240,5–555,7 ms. Todas as amostras e distribuições das demais rotas estão no JSON. Sete pares não sustentam uma obrigação estatística de todas as diferenças ficarem abaixo de 10%; o limiar foi usado para exigir investigação, não para apagar variação ou produzir aprovação automática.

## Diagnóstico separado de requisições e SQL

Execução: **05:15:19–05:15:57 UTC**, exit0, sete pares e aquecimento, apenas Memória/Projetos/Vendas, sem screenshots durante a série. Zero erro HTTP/JavaScript ou tentativa externa. O tracing SQL acrescenta overhead e seus tempos não substituem o primário.

| Percurso | Baseline mediana [P25–P75] ms | Atual mediana [P25–P75] ms | Δ medianas | Δ pareado |
|---|---:|---:|---:|---:|
| Abertura | 812,2 [684,1–908,5] | 785,7 [769,0–944,8] | −3,3% | +2,5% |
| Memória | 71,5 [67,4–77,1] | 69,9 [65,8–95,8] | −2,2% | +7,5% |
| Projetos | 338,0 [322,3–413,4] | 321,6 [282,6–361,4] | −4,9% | −4,4% |
| Vendas | 291,5 [276,7–350,3] | 380,1 [265,9–427,8] | **+30,4%** | +8,5% |

**Não houve chamada adicional nas rotas diagnosticadas:** sete GET por rota em cada variante, um por percurso. Memória usou exatamente `/api/v3/busca?q=&conversa=`; Projetos e Vendas usaram `/api/v3/experiencia`.

| Rota / medida mediana | Baseline | Atual |
|---|---:|---:|
| Memória: HTTP / servidor | 14,4 / 8,5 ms | 15,2 / 7,7 ms |
| Memória: SQL executados / soma de duração SQL | 404 / 3,9 ms | 404 / 3,1 ms |
| Projetos: HTTP / servidor | 281,3 / 270,5 ms | 266,8 / 231,0 ms |
| Projetos: CPU do processo Node / duração SQL | 218 / 66,8 ms | 203 / 58,6 ms |
| Projetos: trabalho do renderer | 38,3 ms | 45,4 ms |
| Vendas: HTTP / servidor | 261,7 / 252,2 ms | 327,0 / 316,8 ms |
| Vendas: CPU do processo Node / duração SQL | 235 / 63,5 ms | 203 / 73,4 ms |
| Vendas: trabalho do renderer | 12,0 ms | 15,6 ms |

Memória devolveu 22.466 bytes e a mesma sequência de 404 operações SQL nas duas variantes. Projetos/Vendas executaram **2.165 operações SQL por resposta**, na mesma sequência, e devolveram 58.808 bytes. O hash comparável de `/experiencia` foi idêntico nas 28 respostas dessas duas rotas: `b7164032345b787c73df1bfca333f09c245541592c1f0fb357856a5bf0a13ded`. Esse hash exclui **somente** `atualizadoEm` da raiz, que representa a hora da consulta; o corpo bruto também foi registrado. A sequência SQL teve hash `c71797e40a5e23008a53a63d3bf6bf3355efd62ca4b4c1113c29b347d797558e`.

O endpoint compartilhado reúne ações de três estados, contexto, projetos e acontecimentos; a categoria comercial é filtrada depois no cliente. Os traces mostram repetição de consultas de fontes/contexto e de metadados de tabelas. Esse é um custo absoluto identificável do backend comum, **não trabalho adicional comprovado da nova UI**. O tracing contabiliza `get/all/run`, sem valores de parâmetros; exclui o custo de preparação SQL e parte do trabalho JavaScript. A CPU é do processo que reúne servidor e harness. Medianas de etapas não devem ser somadas como decomposição exata de uma requisição.

Em Vendas, o aumento focal de 88,6 ms se concentrou na espera HTTP/servidor, enquanto a CPU mediana caiu e o renderer cresceu 3,5 ms. As hipóteses de chamadas extras, sequência SQL distinta ou payload maior foram enfraquecidas pelos dados. **A causa exclusiva da diferença de relógio não foi isolada.** Memória/Projetos não repetiram seus aumentos no focal; Vendas variou entre séries. Não é sustentado afirmar que todo o efeito veio do backup, que há uma regressão constante de 30%, ou que a nova UI está isenta de regressão. Nenhum ajuste de produto foi justificado apenas por essa variação.

## Carga nativa com companhia ativa

Execução: **05:10:26–05:10:44 UTC**, exit0, antes do A/B e em perfil QA novo. 4.000 eventos sintéticos e 100 conversas; cinco percursos de busca global → Pessoas → timeline. Preferências verificadas: companhia habilitada, sem pausa, som desligado, movimento `system`; o sistema não solicitava redução de movimento. Companhia permaneceu no estado factual `aguardando`, sem inventar trabalho. Atendimento pessoal continuou com suas permissões próprias.

Foram **54 amostras e 15 operações**. O sampler foi configurado para 100 ms, com intervalos efetivos registrados; snapshots também cercaram cada operação. Marcadores visíveis de carregamento apareceram em **7 operações** (2 buscas, 2 Pessoas, 3 timelines). Nas oito restantes, `busySamples=0`: são medidas da janela da operação, não prova de uma amostra no meio do carregamento.

- CPU agregada mediana observada: **8,13%**.
- Pico da soma de working sets reportados pelo Electron: **854,94 MiB**; pico de RSS do processo principal: **144 MiB**.
- Janela instrumentada de ação: buscas aproximadamente 123–264 ms, Pessoas 77–190 ms e timeline 162–405 ms. Os snapshots antes/depois ficam separados, mas o sampler IPC concorrente ainda afeta essa janela; **não é latência pura do produto**.
- Os processos medidos incluem Browser, GPU, Network Service, serviço local e renderizadores. A soma de working sets não é uma medida de páginas físicas únicas. A taxa de CPU é a reportada pelo Electron; não uma porcentagem universal de capacidade do computador.
- Zero erro JavaScript/HTTP ou tentativa externa. Instância de QA encerrada e ausência de processos próprios conferida antes do A/B. A screenshot do estado ativo foi inspecionada e permanece somente na evidência local.

Esses números não foram extrapolados para 8 GB. Também não medem sincronização de uma conta real, inferência remota, processamento contínuo ou macOS.

## Tentativas preservadas e recibos

A primeira rodada final, `full-idle-20261027`, falhou por três 404 de `/api/v3/novidades` (duas na atual, uma no baseline). O harness omitia a dependência que o desktop injeta. Foi corrigido **somente o teste**, instanciando a classe real `Novidades`, com política padrão desligada e fetch externo proibido; o revisor conferiu equivalência com `desktop/service.js`. Não se trocou o erro por resposta fictícia. Todos os pares e o erro original foram preservados. Os percentuais dessa tentativa, isoladamente, não aprovam nem desaprovam o produto. A queda de tempos entre séries não foi atribuída causalmente a essa correção.

Os ensaios anteriores feitos durante backup permanecem em `work/lume-1-20261026/performance-ab-f656a21/`; não são a série final nem foram misturados às medianas acima. A falha intermediária de sintaxe no script de sumarização offline foi corrigida antes de produzir `analysis.json`; ela não executou navegador nem modificou medições.

Recibos locais (todos sintéticos):

- `work/lume-1-20261026/performance-final-c7f8407/full-idle-20261027/result.json` — tentativa HTTP falha preservada.
- `work/lume-1-20261026/performance-final-c7f8407/full-idle-http-complete/result.json` — primário final, amostras e distribuição completas.
- `work/lume-1-20261026/performance-final-c7f8407/diagnostic-sql-idle/result.json` — diagnóstico completo, aproximadamente 77 MB devido ao SQL repetido.
- `work/lume-1-20261026/performance-final-c7f8407/analysis.json` — resumo compacto de métricas, SQL, hashes, bytes e CPU por rota; gerado por `analyze.mjs` no mesmo diretório.
- `work/lume-1-20261026/native-loading/resultado.json` — preferências, processos, CPU/RAM, amostras, carregamento e limites.
- `work/lume-1-20261026/native/resultado.json` e `busca-global-resultado.json` — percurso nativo funcional anterior, persistência e busca/fonte em duas ações mais uma etapa de digitação registrada separadamente; separado da comparação de desempenho.

Reprodução exige `--run` explícito nos testes `test/lume-1-native-loading.e2e.mjs`, `test/lume-1-performance-final.mjs` e no benchmark legado. Antes do A/B, preparar `src/painel` dos commits exatos acima em `work/lume-1-20261026/performance-ab-f656a21/baseline-tree/src/painel` e `work/lume-1-20261026/performance-final-c7f8407/current-tree/src/painel`; o harness lê essas árvores e não as cria. Esses snapshots locais não acompanham o Git. O primário usa sete pares; o focal acrescenta `LUME_PERF_DIAGNOSTIC=1`, `LUME_PERF_TRACE_SQL=1` e `LUME_PERF_FOCUS=memory,deliveries,sales`. Usar um novo `LUME_PERF_LABEL`, registrar a condição real em `LUME_PERF_CONDITIONS` e aguardar janela liberada. Nenhum gate com erro HTTP ou causa pendente deve ser convertido em aprovação geral do produto.
