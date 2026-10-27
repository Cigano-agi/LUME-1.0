# Diagnóstico dos cinco campos: recuperação parcial, hipótese abandonada

> Arquivo histórico de pesquisa com casos fictícios. As provas em `work/` citadas abaixo permanecem na origem e não são distribuídas neste snapshot; suas referências são textuais.

26/09/2026 · pesquisa delimitada · run `run_863dfcebd7c8` · task `task_0d30e482213d` · dispatch `ctx_717c74c2d9df`.

**A troca de formato recuperou parte do conteúdo, mas não resolveu fidelidade e cobertura. Abandonar estas composições como próximo passo para integração.** O texto livre preservou o cancelamento parcial, mas omitiu o papel de Marília e enfraqueceu o compromisso de Otávio. Os fatos atômicos atribuíram uma tarefa a Marília e declararam o envio de Otávio concluído, ambos sem apoio. Foram quatro inferências, sem retry, com o mesmo modelo/runtime pinado. Nenhuma saída foi para o app e nenhum gate mudou.

O protocolo anterior à inferência (referência histórica: `../../work/beta06-sintese-fatos/prepared/protocol-before-inference.md`), a rubrica congelada (referência histórica: `../../work/beta06-sintese-fatos/prepared/protocol.json`) e as requisições exatas (referência histórica: `../../work/beta06-sintese-fatos/prepared/requests.json`) foram gravados às **17:36:42 UTC**, antes da primeira chamada às 17:36:49. O restante desta seção conserva os critérios definidos antes da execução.

## Hipótese e consequência definida antes de executar

Pedir cinco resumos nullable pode favorecer abstenção total apesar de fatos explícitos. Uma resposta livre em português ou uma lista de fatos com sujeito, ação, estado, condição e fonte pode recuperar a informação com menos redundância.

Manter essa hipótese como direção de pesquisa somente se ao menos um formato recuperar **11/11 unidades nos dois casos**, sem contradição, fato inventado ou fonte sem sustentação semântica. Se nenhum formato atingir isso, abandonar esta composição como próximo passo; registrar os fatos parcialmente recuperados. Falha de runtime torna o diagnóstico inconclusivo. Schema válido ou referências existentes não aprovam semântica.

Isso não isola a causalidade do `nullable`: instrução de formato e gramática também mudam. A comparação com cinco nulos usa recibos históricos, sem repetir aquela tentativa. Os dois casos são fictícios, conhecidos e selecionados por terem informação explícita; não há holdout nem métrica de precisão generalizável.

## Protocolo fixo

- Exatamente quatro chamadas previstas, sem retries: acordo/livre → acordo/fatos → cancelamento/fatos → cancelamento/livre. A ordem alternada reduz uma confusão simples de aquecimento, sem resolver efeitos de ordem numa amostra tão pequena.
- Pesos e runtime pinados existentes em `work/beta06-sintese-dev`, somente leitura. Conferir SHA-256 do GGUF, ZIP e arquivos extraídos antes da execução; copiar licenças, recibos de origem e hashes para a pasta nova.
- CPU, quatro threads, um slot, sem GPU, modo offline, loopback com autenticação efêmera e ambiente sem chaves herdadas. Sem novos modelos, downloads ou API externa.
- Mesmos parâmetros da tentativa 2: temperatura 0,2, top-p 0,8, top-k 20, min-p 0, presence penalty 0, seed 260926, thinking desativado. Até 1.400 tokens de entrada, 512 de saída, contexto 2.048; 120 s por chamada, oito minutos para o servidor. Sem truncar entrada.
- As duas condições recebem as mesmas fontes e instrução semântica geral. Texto livre cita IDs em prosa; fatos usa JSON Schema com lista que pode ser vazia, strings não nulas, condição vazia se ausente. Não há exemplo factual, resposta esperada, rubrica ou sugestão específica sobre os casos no prompt.
- Congelar protocolo, rubrica, requisições e snapshots de código antes da primeira inferência. Uma pasta exclusiva de execução impede rerun; registrar cada chamada antes do POST. Falha operacional interrompe as restantes. Não reparar respostas.
- Preservar template aplicado, tokens, requisições, SSE bruto, texto, término, uso e timings, memória nativa observada, log do servidor, tempo de carga e encerramento. Guardar versões e hashes. Referência histórica e protocolos antigos ficam intactos.
- Ler manualmente todas as afirmações e fontes. Anotar cada unidade como recuperada, omitida ou contradita com trecho da saída. Verificar também extras, autoria, condição, negação, estado e apoio de cada referência; nomes e schema não contam como evidência factual sozinhos.

## Rubrica fora do prompt

| Caso | Unidade crítica | Apoio |
|---|---|---|
| acordo | A1: Otávio é responsável pelo envio; Marília fez o pedido | E1/E2 |
| acordo | A2: enviar a lista de peças | E1/E2 |
| acordo | A3: compromisso confirmado e futuro, sem conclusão | E2 |
| acordo | A4: prazo até 28/09 | E1/E2 |
| acordo | A5: prazo às 11h | E1/E2 |
| cancelamento | C1: Sérgio é o responsável | E1/E2 |
| cancelamento | C2: enviar as fotos | E1/E2 |
| cancelamento | C3: fotos na segunda, sem inventar data de calendário | E1/E2 |
| cancelamento | C4: fotos seguem vigentes depois do cancelamento, sem conclusão | E2 |
| cancelamento | C5: revisão da etiqueta é outra ação | E1/E2 |
| cancelamento | C6: só a etiqueta foi cancelada; terça não é prazo vigente | E2 |

Um trecho pode sustentar várias unidades quando tiver de fato o conteúdo necessário. Não exigir que a resposta diga literalmente “não concluído” se o futuro confirmado está claro. A1 exige a distinção de papéis, e não apenas o nome do executor. C6 permite mencionar terça como prazo histórico explicitamente cancelado. Qualquer mudança dessa rubrica depois da execução precisa ser identificada como revisão, sem recontar retroativamente o critério congelado.

## Revisão independente da infraestrutura anterior

Leitura dos scripts, testes e recibos anteriores; nenhum desses arquivos foi alterado. A revisão é independente da autoria anterior. As novas saídas receberam leitura detalhada do autor deste diagnóstico; o coordenador também leu as quatro saídas e confirmou autoria/conclusão falsas, omissões A1/A3 e IDs ausentes em `msg_26076b98ef8f`, de 26/09/2026 às 17:39:26 UTC. Não é avaliação humana nem cega.

- **Defeito reproduzido no parser SSE anterior:** aceita conteúdo depois de `finish_reason:stop`, incorporando-o à resposta, e aceita `[DONE]` repetido. O novo teste sintético demonstra ambos sem modelo; o decoder desta experiência os recusa. Os **12 streams anteriores passaram** na leitura estrita, sem inferir novamente (auditoria (referência histórica: `../../work/beta06-sintese-fatos/prior-stream-audit.json`)). Portanto o defeito não ocorreu nos recibos preservados e não explica os nulos observados.
- **Encerramento anterior sem confirmação obrigatória:** `stop` espera no máximo cinco segundos, mas não transforma ausência de saída em erro. O novo runner registra falha de cleanup se não observar encerramento. Ainda não há Job Object para morte abrupta do pai; permanece bloqueio para adaptação ao produto, já reconhecido no relatório anterior.
- **Auditoria incompleta do template anterior:** calcula `/apply-template` e `/tokenize`, mas não grava o template efetivo e os IDs de tokens. O novo runner os preserva; mensagens e parâmetros anteriores já estavam preservados.
- **Confusão de causa já reconhecida:** a tentativa 2 mudou prompt, temperatura e penalidade juntos. A redução de memória também mudou quantização/runtime; não comprova melhora semântica nem efeito isolado do nullable.
- **Limite preservado:** citações são localizações literais, sem validação automática de apoio semântico. O teste deliberadamente falso continua passando estrutura e é explicitamente recusado como aprovação.

Sete testes direcionados passaram antes da preparação e na verificação final, sem inferência. Cobrem isolamento de rubrica, conjunto fixo, igualdade de amostragem, abstenção permitida, falsidade estruturalmente válida, término do stream e CLI fechada. Log final (referência histórica: `../../work/beta06-sintese-fatos/test-final.txt`). Comando: `node --test test/sintese-fatos-diagnostico.test.js`.

A CPU foi liberada pela mensagem `msg_1c84c6d36212`, de 26/09/2026 às 17:33:20 UTC; o início foi avisado por `msg_9b0b82413c0e`. O processo encerrou às **17:37:42 UTC**, após aproximadamente 54 segundos de servidor. O PID 37048 foi confirmado ausente às 17:38:08 (prova (referência histórica: `../../work/beta06-sintese-fatos/process-exit-check.json`)); CPU devolvida por `msg_55ad8db5ec27`. O isolamento é coordenado entre agentes, sem garantia de exclusividade de todos os processos do Windows.

## O que o modelo realmente respondeu

**Acordo, texto livre — saída integral:**

> Otávio consegue enviar a lista de peças até 28/09 às 11h.

O executor, objeto e prazo aparecem. “Consegue” informa capacidade, mas não preserva claramente o compromisso explícito “Envio”. Marília e seu papel desaparecem. Nenhum ID de fonte foi emitido, apesar da instrução.

**Acordo, fatos atômicos — dois fatos:**

| Sujeito | Ação | Estado emitido | Condição | Fonte emitida |
|---|---|---|---|---|
| Marília | enviar a lista de peças | em andamento | 28/09 às 11h | E1 |
| Otávio | enviar a lista de peças | concluído | 28/09 às 11h | E2 |

E1 é uma pergunta de Marília a Otávio; não sustenta Marília executar a tarefa, muito menos estar em andamento. E2 é um compromisso futuro, não prova de conclusão. **Há falso estado sensível explícito.** IDs existentes e JSON válido não resgatam esses fatos.

**Cancelamento, texto livre — saída integral:**

> Em 26 de setembro de 2026, Sérgio informou que enviará as fotos na segunda-feira e revisará a etiqueta na terça-feira. Posteriormente, ele cancelou a revisão da etiqueta e mantém as fotos para a segunda-feira.

Preserva autoria, duas ações, ordem temporal, cancelamento restrito e fotos vigentes. A data de 26/09 corresponde ao metadado das fontes e é apresentada como data da fala, não como conversão de segunda-feira para prazo de calendário. A primeira frase narra o compromisso anterior; a segunda o atualiza. Novamente faltam IDs de fontes na saída.

**Cancelamento, fatos atômicos — três fatos:**

| Sujeito | Ação | Estado emitido | Condição emitida | Fonte |
|---|---|---|---|---|
| Sérgio | envia as fotos | segunda | 2026-09-26T10:00:00-03:00 | E1 |
| Sérgio | revisar a etiqueta | terça | 2026-09-26T10:00:00-03:00 | E1 |
| Sérgio | cancelei só a revisão da etiqueta | segunda | 2026-09-26T10:01:00-03:00 | E2 |

O texto das ações preserva parte da informação, inclusive o cancelamento. Entretanto, os dias da semana ocupam `estado`, timestamps da mensagem viram condições da tarefa e não há confirmação explícita de que as fotos continuam após a atualização. E2 não sustenta “segunda” como estado/data do cancelamento. Não tratar a presença das palavras corretas como fato completo correto.

Saídas e SSE integral: pasta da execução (referência histórica: `../../work/beta06-sintese-fatos/run`) · recibo único (referência histórica: `../../work/beta06-sintese-fatos/run/result.json`). Não houve pós-processamento, preenchimento por regra ou reparo de conteúdo.

## Cobertura pela rubrica congelada

Leitura manual pelo autor desta experiência, com todas as fontes e saídas abertas. Recuperado exige a unidade inteira; omissão pode ser parcial. Contradições e extras são registrados separadamente, mesmo quando o mesmo trecho preserva outras unidades. Estes números descrevem os dois casos conhecidos; **não são precisão ou recall de produto**.

| Unidade | Livre | Fatos atômicos |
|---|---|---|
| A1 | Omitido parcialmente: “Otávio consegue”; falta Marília como solicitante | Contradito: Marília aparece como executora “em andamento” |
| A2 | Recuperado: “enviar a lista de peças” | Recuperado: “enviar a lista de peças” |
| A3 | Omitido: “consegue” enfraquece o compromisso | Contradito: “concluído” |
| A4 | Recuperado: “até 28/09” | Recuperado: “28/09” |
| A5 | Recuperado: “às 11h” | Recuperado: “às 11h” |
| C1 | Recuperado: “Sérgio informou” | Recuperado: “sujeito”: “Sérgio” |
| C2 | Recuperado: “enviará as fotos” | Recuperado: “envia as fotos” |
| C3 | Recuperado: “mantém as fotos para a segunda-feira” | Contradito parcialmente: preserva “segunda”, mas a condição vira o timestamp de sábado 26/09 |
| C4 | Recuperado: “Posteriormente [...] mantém as fotos” | Omitido: falta a confirmação das fotos após E2; não foi declarado concluído |
| C5 | Recuperado: “revisará a etiqueta” | Recuperado: “revisar a etiqueta” |
| C6 | Recuperado: “cancelou a revisão [...] mantém as fotos” | Recuperado na ação “cancelei só a revisão da etiqueta”, posterior ao compromisso de E1; o estado/condição desse fato segue errado |

Contagem conservadora: **livre 9/11**, sendo 3/5 no acordo e 6/6 no cancelamento; **fatos 7/11**, sendo 3/5 e 4/6. A preservação de “segunda” em C3 é registrada, mas não conta como prazo correto quando a condição acrescenta outra data. C6 recebe crédito pelo conteúdo do verbo de cancelamento apesar do campo `estado` incorreto. Mesmo uma leitura mais permissiva de C3/C4 não alteraria a decisão: autoria falsa e conclusão inventada no acordo já reprovam o formato.

Fontes: texto livre não emitiu referências em nenhum caso. Fatos do acordo citam E1/E2 existentes com semântica falsa; fatos do cancelamento localizam mensagens pertinentes às ações, porém seus estados/condições não são sustentados. **Zero dos dois formatos passou o critério integral nos dois casos.**

## Recursos, integridade e limites

Host: Windows 10.0.26200, Intel i7-12650H, 16 processadores lógicos, 34.087.874.560 bytes de RAM, Node 24.19.0. Não é hardware de 8 GB; macOS não foi executado. Carga do servidor até `/health`: **1,77 s**. Primeira resposta a partir do início do servidor: **7,92 s**, após conferência de hash que já leu o modelo; não é disco/cache frio.

| Chamada | Tokens entrada/saída | Primeiro conteúdo | Resposta completa |
|---|---:|---:|---:|
| acordo/livre | 352 / 25 | 4,66 s | 6,12 s |
| acordo/fatos | 429 / 137 | 4,85 s | 15,52 s |
| cancelamento/fatos | 419 / 244 | 4,48 s | 22,45 s |
| cancelamento/livre | 342 / 62 | 4,50 s | 8,06 s |

Todas terminaram com `stop` e `[DONE]`, sem timeout, length ou retry. Duas respostas livres não vazias e dois JSONs estruturalmente válidos; esse dado não aprova conteúdo. Cache de prompt reportado: zero nas quatro chamadas. Não calcular p95 representativo com esse conjunto, nem confundir tempo de texto incorreto com tempo de síntese útil.

Pico nativo observado: **2.136.084.480 bytes (1,99 GiB)** em 103 leituras de 500 ms, incluindo carga. CPU acumulada observada: 190,80 s. Pico do driver: 120.422.400 bytes; maior working set amostrado do observador: 82.415.616 bytes. São picos separados, não soma simultânea; não incluem Electron/SO/outros aplicativos e a amostragem pode perder o pico final.

| Artefato | SHA-256 |
|---|---|
| GGUF Qwen3-1.7B Q4_K_M | `b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897` |
| ZIP llama.cpp b11146 | `14cf1303ca9ac3abd94816850532f9f9a69ac66fbaca3776fc6f9061c2fac1d1` |
| Protocolo congelado | `4ca07b8a45d4d38bd5060454653bbe67c744c7708db75f9445092f58c2a66210` |

GGUF/ZIP e arquivos extraídos foram conferidos antes da carga. Versão executada: `0.5.0-dev (build 11146, commit 7fe450e19)`. Licenças Apache-2.0 do modelo e MIT do runtime, recibos e docs públicos já arquivados foram copiados com hash para prepared (referência histórica: `../../work/beta06-sintese-fatos/prepared`); não houve download. O manifesto (referência histórica: `../../work/beta06-sintese-fatos/prepared/manifest.json`) liga código, protocolo, prompts, casos e origem. O recibo liga esse manifesto à execução. Template aplicado e tokens reais estão em cada arquivo `*-template.json`/`*-tokens.json`. A verificação de integridade final (referência histórica: `../../work/beta06-sintese-fatos/integrity-final.json`) confere snapshots e origens e inventaria as evidências.

## Decisão e próxima ação

**Abandonar estas composições como próximo passo de integração.** Tirar os cinco campos removeu o colapso total em nulos, mas não recuperou todos os fatos com fidelidade; forçar fatos preenchidos também expôs autoria e conclusão falsas. A hipótese estreita “mudar o formato basta para uma extração fiel” falhou pelo critério congelado. Continua indeterminada a contribuição causal isolada do `nullable`, pois prompt e gramática mudaram juntos; não a declarar provada ou refutada isoladamente.

Arquivar a hipótese com estes quatro resultados e conservar o formato livre somente como referência diagnóstica da recuperação parcial. Antes de qualquer novo ensaio, a coordenação precisa definir outra hipótese que ataque compromisso versus conclusão, autoria e atualização de estado, com protocolo próprio. Não continuar ajustando neste conjunto para anunciar precisão. Este despacho não recomenda integrar um renderizador de cinco campos sobre os fatos emitidos: ele propagaria erros já demonstrados.

Os gates originais continuam intactos: ≥100 casos PT-BR cegos/≥20 críticos, recall crítico ≥90%, precisão ≥80%, zero falso estado sensível, 100% de fontes semanticamente corretas, p95 quente ≤15 s/frio ≤60 s no hardware mínimo, revisão humana autorizada e percurso instalado.

## Limites de entrega

**Construído, testado e medido em pesquisa; hipótese encerrada sem aprovação semântica.** Sem produção, instalação, publicação, commit deste worker ou aceite. Nenhum artefato anterior foi editado, nenhuma credencial/perfil privado foi acessado, nenhum modelo adicional ou delegação foi criado.

QA aplicado com `cigano-qa-entrega`: visual **não aplicável**, relatório textual e CLI sem composição visual; copy **revisada**, resultado e limites primeiro, sem afirmar causalidade isolada ou precisão; utilidade operacional/marketing **revisada**, decisão concreta baseada em saídas, sem promessa comercial; produto/PM **atendido para o diagnóstico**, protocolo anterior, quatro chamadas, falhas e evidências acessíveis, sem ampliar o escopo. Os sete testes passaram com zero falhas/skips. A coordenação revisou independentemente as quatro saídas; os gates de produto permanecem pendentes.

Checkpoint: tarefa diagnóstica concluída, CPU devolvida e nenhuma nova inferência autorizada neste despacho. O coordenador informou que corrigirá o parser anterior e converterá o teste de reprodução em regressão **depois do settlement**, sem mudar snapshots/recibos; essa manutenção futura fica fora desta entrega e deverá ser registrada como posterior aos hashes congelados.

**Manutenção posterior pela coordenação:** após settlement e liberação do worker,
o parser anterior foi corrigido para negar os dois fechamentos inválidos. O teste
de reprodução passou a exigir recusa em ambos os parsers; sua versão congelada
continua no snapshot da experiência. O harness antigo também passou a exigir
confirmação de encerramento e a gravar template/tokens. 47 testes direcionados
passaram; 16 streams preservados foram relidos sem inferência e sem divergência
das respostas arquivadas. A composição continua reprovada, sem rerun autorizado.
