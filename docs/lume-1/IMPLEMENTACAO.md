# Lume 1.0 — implementação e verificações

Atualizado em 27/10/2026. Continuação da fase 10, conforme o plano entregue pelo usuário. Implementação local revisada, recuperação operacional ensaiada e instalação normal Windows conferida. A regressão final passou em 881/881 casos. A entrega global permanece parcial: avaliação semântica bloqueada pelo limite de uso da conta, conexão WhatsApp indisponível, abertura pela busca ainda sem prova e limites de desempenho/aceite descritos abaixo.

## Comportamento implementado

O organizador usa a etapa `organizacao_chatgpt` da fila existente, com prioridade para mensagens novas e recentes, cursor de histórico, lotes limitados, lease e retomada. A conta ChatGPT e a autorização de cada fonte são verificadas antes e depois da chamada. O processamento contínuo depende de avaliação independente aprovada para o modelo e o contrato atuais. Não há aprovação da avaliação pela API HTTP, novo serviço, Jev ou fallback pago.

Tags profissionais, assuntos, organizações, projetos, oportunidades, compromissos e acontecimentos conservam trechos literais, origem e atualização. Projetos são rascunhos; oportunidades não confirmam venda. Correções manuais de tags e vínculos prevalecem. Vínculos são corrigidos por intervalo da mensagem: corrigir um projeto não remove outro projeto citado em outro trecho. Alterações e revogações invalidam resultados tardios, inclusive revogação seguida de restauração durante a consulta.

A timeline paginada preserva autoria e data, filtra assunto/pessoa/projeto e mostra compromissos persistidos, correções, mudanças de estado e execução. Resultado informado, verificado, enviado e aceito permanecem separados. As cinco leituras MCP mantêm escopo e revalidação; o pacote inclui todos os imports necessários à leitura das novas ações.

A navegação é Agora, Memória, Vendas, Projetos e Pessoas. Ajustes tem Conexões, Atendimento, Aparência e Dados. Busca, tema, som e Mostrar Lume ficam acessíveis globalmente. A central distingue acontecimentos do acervo e comunicados recebidos. O mapa oferece lista, timeout e tentativa novamente. O personagem vetorial articulado acompanha estados observados, com movimento reduzido, pausa independente do atendimento e áudio opt-in.

A identificação comercial vem de `package.json`: Lume 1.0, versão técnica crescente `3.2.0-beta.7`. O identificador `com.readyworks.assessor` e o perfil `AssessorDesktop` foram preservados. O tour fictício de marketing foi retirado do pacote desktop; fontes do site e guardas de segurança continuam no repositório.

Exceção de limpeza: `src/pessoal/casos-avaliacao.js` conserva 100 cenários explicitamente fictícios usados pelo gate de segurança do atendimento pessoal. O runtime de avaliação importa esse corpus e grava seu relatório em configuração; ele não cria eventos, pessoas, oportunidades ou projetos demonstrativos. A remoção quebraria a avaliação/liberação existente. O requisito literal de todos os cenários fictícios estarem exclusivamente em testes permanece parcial; não se confunde esse corpus funcional com conteúdo real ou com a nova avaliação semântica das conversas.

## Evidências lidas

| Verificação | Resultado neste checkpoint |
|---|---|
| Integração backend adversarial independente | 33/33; revogação, edição, pausa, idempotência, correção por trecho, paginação e MCP |
| MCP, projetos e experiência, revisão independente | 44/44 |
| Interface e experiência, testes dirigidos | 23/23; deltas de mapa e compromissos também passaram |
| E2E HTTP/SQLite da interface | 18 screenshots, dados sintéticos; tags/reload, grupo paginado, filtros, vínculo, temas e reflow |
| Gate integrado local de organização/experiência | 91/91, com fontes sintéticas |
| Regressão sequencial ampla mais recente | 881/881 em 276.052 ms, zero falha/cancelamento/skip; rodada anterior 877/878 preservada |
| Manutenção e companhia após atualizar a simulação de Electron | 14/14 |
| MCP após incluir import ausente no pacote | 22/22 independentes; os três casos inicialmente falhos passaram |
| Verificador de candidata | 8/8 independentes: ASAR, dependências, unpacked, metadata, links e recursos externos |
| Snapshot com concorrência limitada | 8/8 existentes + 3/3 adversariais independentes |
| Snapshot operacional em arquivo e retenções explícitas | 21/21 independentes; recibo real verificado e restauração ensaiada |
| Onboarding e estados reais de prontidão | 9/9 independentes; seis capturas sintéticas |
| Volume/prévia nos controles rápidos | E2E HTTP/SQLite concluído, cinco capturas; deltas e hooks passaram na regressão final, preservadas as rodadas anteriores com falhas de encerramento |
| Preservação de integrações anteriores | 49/49 dirigidos, inventário independente; módulos ainda não conectados excluídos do pacote |
| Apresentação do repositório | 31 links, quatro capturas desktop/mobile, revisão editorial independente |
| Ensaio nativo Windows isolado | Percurso completo e busca global concluídos; 18 capturas, zero erro JS/HTTP ou tentativa externa |
| Filtro do instalador NSIS | 3/3 independentes contra argumentos reais do empacotador; reinstalação/comparação têm prova separada |

A rodada anterior de 622 casos teve quatro falhas da simulação de Electron sem `setAboutPanelOptions` e três falhas reais do pacote MCP, cujo import estático de `inventario-nativo.js` faltava na lista fechada. Foram corrigidas e repetidas em provas dirigidas. Na rodada de 847 casos, falharam um prazo de drain, a expectativa dessa lista fechada e o encerramento do Edge da fixture Telegram. A expectativa foi atualizada; drain/MCP passaram em 13 casos dirigidos. Telegram passou com diagnóstico de processo, depois de outra falha de encerramento. Os timeouts intermitentes de limpeza continuam registrados; passar as asserções do produto não torna uma execução com hook falho aprovada.

A rodada02, incluindo os testes de Electron/cofre e broker empacotado, terminou em 629.626,6 ms: 878 casos, 877 aprovados, uma falha, zero cancelamento ou skip. Áudio, onboarding, Telegram e seus hooks passaram. O PDF sintético de duas páginas retornou `indisponivel` em 10.346 ms, em vez de `extraido`; o motivo não constava na asserção. Depois de encerrada a carga de conferência do perfil, o mesmo teste original passou independentemente em 321 ms, com o teto de 10.000 ms intacto e sem editar código. Contenção/deadline é hipótese compatível, não causa demonstrada. A prova dessa rodada permanece 877/878 mais 1/1 focal; não se reescreveu seu resultado.

A rodada03, executada após o encerramento do benchmark e sem backup/build/cópias próprios concorrentes, terminou com saída zero: **89 arquivos, 881 testes aprovados, zero falha, cancelamento ou skip, 276.052,4 ms**. Incluiu os três novos casos do filtro NSIS e os gates nativos. O teste original de PDF passou em 2.966 ms, com o mesmo teto de 10.000 ms. Não se alteraram testes para esconder a falha anterior nem se demonstrou retrospectivamente sua causa. Manifesto e log: `work/lume-1-20261026/regression-03-idle*`.

A revisão do áudio reproduziu e corrigiu uma corrida: mudar o volume para zero durante a liberação do AudioContext podia tocar a prévia no volume antigo. Mudança de volume agora invalida a emissão pendente. Os controles mantêm opt-in, pausa, silêncio em janela oculta e gravação somente da preferência alterada. O ensaio instrumentado com áudio silenciado não comprova percepção sonora humana.

Uma cópia SQLite consistente do acervo contém 360.601 eventos. Três consultas locais por percurso mediram: mapa 860–1.613 ms, Pessoas 809–2.172 ms e timeline 169–243 ms, nesta máquina sob carga de backup/build. São observações de uma cópia real, sem rede; não equivalem à prova do aplicativo instalado ou à comparação de regressão de abertura.

## Percursos nativos e recursos

O teste `node test/lume-1-native.e2e.mjs --run` concluiu em perfil sintético isolado. A primeira rodada encontrou uma espera inadequada no harness: a lista anterior ainda estava visível quando o teste procurou a fonte. A correção aguarda o contexto `Fonte E1` e exige o texto exato; não modificou o produto. A segunda rodada, de 04:35:11 a 04:38:26 UTC, passou com 17 capturas. Um ensaio focal de busca global acrescentou uma captura e passou de 04:40:13 a 04:40:27 UTC. As provas usam Electron/serviço reais, fontes sintéticas identificadas e instrumentação declarada para abrir a janela sem solicitar foco pessoal; não são a prova da instalação final.

| Percurso observado | Ações dentro do Lume |
|---|---:|
| Tema pelo controle global | Até 2: abrir seletor e escolher; a automação registrou uma operação `selectOption` |
| Abrir painel de conexão | 2 |
| Corrigir uma tag e salvar | 4 |
| Pessoa → timeline → fonte | 3 |
| Mostrar companhia / pausar companhia | 1 cada |
| Busca global → mensagem original | 2, mais uma etapa de digitação registrada separadamente |

A busca global usou Ctrl+K e Enter como duas ações; a digitação é registrada à parte conforme o critério do plano. Pareamento/OAuth externo não foi executado. Reinício preservou tag, tema, movimento reduzido, companhia pausada e silêncio. Zoom nativo 200%, conteúdo 1024×768, teclado/Escape, renderer isolado e ausência de foco da companhia foram conferidos. A captura a 200% mostra o topo com rolagem vertical; não representa toda a tela em uma única imagem.

Cinco amostras por estado nesta máquina de 32 GiB: companhia desligada, CPU mediana 1,95% e working set agregado 563,8 MiB; companhia pausada, 1,07% e 809,5 MiB. RSS do processo principal: 133,2 e 168,7 MiB. Havia carga concorrente; estados distintos e amostra curta não sustentam conclusão de regressão, consumo em carregamento ou adequação a 8 GB. A comparação A/B anterior encontrou aumento em Vendas e permanece em investigação.

Um ensaio posterior com a companhia ativa e sem backup, build ou testes próprios concorrentes executou 15 operações sobre 4.000 eventos sintéticos. Houve 54 amostras: CPU agregada mediana 8,13%, working set agregado máximo 854,94 MiB e RSS principal máximo 144 MiB. Marcadores de carregamento apareceram em sete operações; nas outras oito só há medidas da janela da operação, sem amostra intermediária do carregamento. Não houve erro JS/HTTP ou tentativa externa. A instrumentação adiciona IPC e o working set soma processos, podendo contar páginas compartilhadas; não se apresenta esse ensaio como consumo puro ou prova de hardware de 8 GB.

A comparação final usa sete pares AB/BA de UIs congeladas sobre o mesmo backend atual e a mesma massa sintética. O primeiro ensaio falhou por três respostas 404: o harness não havia injetado o serviço Novidades. A fixture foi corrigida com a classe real, política desligada e transporte externo bloqueado; a rodada falha foi preservada. O primário corrigido passou sem erro HTTP: abertura 760,5 → 764,7 ms; Vendas 297,9 → 301,4 ms; Memória 77,1 → 89,9 ms; Projetos 320,4 → 389,5 ms.

O diagnóstico focal preservou os aumentos acima de 10% como questão a investigar. Nele, Memória e Projetos ficaram abaixo da baseline, enquanto Vendas passou de 291,5 para 380,1 ms. Em Vendas, a quantidade e a sequência de consultas e o hash da resposta, descontado o timestamp raiz, permaneceram iguais; tempo HTTP/servidor cresceu enquanto a mediana de CPU do processo servidor caiu. Não foi isolada uma causa de produto, nem demonstrada ausência de regressão. Há variabilidade entre rodadas, instrumentação SQL no diagnóstico e limites semânticos da massa, inclusive Vendas sem cartões comerciais preenchidos. Os resultados não aprovam desempenho global nem comparam dois binários históricos completos. Tabelas e método em [DESEMPENHO.md](DESEMPENHO.md).

## Distribuição e recuperação

Os destinos Windows encontrados divergiam: Menu Iniciar apontava ao worktree de 12/10, enquanto o atalho da área de trabalho apontava à instalação beta.5. A janela antiga foi capturada por API de janela e encerrada normalmente. A instalação beta.5 foi copiada e conferida separadamente antes da substituição normal; atalhos e resolução pelo Windows têm verificação própria.

A primeira pré-candidata foi rejeitada antes da execução porque alterações concorrentes durante a montagem corromperam offsets do ASAR. O verificador agora confere integridade e igualdade de fontes, inclusive dependências, arquivos unpacked, metadata transformada e áudio externo. A nova montagem usa arquivos congelados e a distribuição oficial do mesmo Electron, conferida contra ZIP/checksums. Não houve substituição manual de ASAR/binário nem alteração de proteção Windows.

O backup operacional terminou em 27/10/2026 às 04:29:52 UTC: 29.170 arquivos e 5.875.024.361 bytes, incluindo banco, cofre, preferências, contexto de criptografia do sistema e 22.677 arquivos da sessão ativa do WhatsApp. O arquivo de recuperação foi conferido e restaurado; todos os hashes da restauração coincidiram, e o inventário original permaneceu estável. O recibo declara `verified:true` e `rehearsed:true`; o hash do manifesto também foi conferido pela coordenação. Arquivo SHA-256 `140859817c8a007153c5146e3c57d012fe78e9a586298e00865c9100a95f7e5e`.

Dez diretórios históricos exatos de autenticação inválida/reparo, totalizando 246.023 arquivos, ficaram intactos no perfil original e fora dessa cópia operacional. Seus conteúdos não foram verificados por hash nem ganharam redundância. O recibo declara essa retenção; não se trata de backup integral dos 275 mil arquivos. Tentativas parciais anteriores foram preservadas e não são consideradas recuperação válida. Recuperação válida em `Downloads/Lume/2026-10-26-Lume-1.0/03-recuperacao-operacional`.

A candidata04 foi montada com fonte congelada no commit `c7f8407`, Electron oficial 44.4.1 e verificador completo: 7.035 entradas, 318 arquivos da aplicação, nenhum item proibido. As 292 fontes correspondem ao commit, com normalização apenas de finais de linha; dois recursos gerados de ACL têm conferência própria. Os módulos não conectados `codex-runner.js` e `jobs.js` estão ausentes. Metadados PE confirmam `Lume`, `3.2.0-beta.7` e ícone embutido idêntico a `desktop/icon.ico`. A consulta Authenticode retorna `NotSigned`; isso, isoladamente, não prova bloqueio pelo Windows. Execução, instalação e ícone efetivamente exibido têm gates separados.

O primeiro instalador normal terminou com saída zero, mas omitiu quatro DLLs que o 7-Zip havia comprimido com filtro ARM64. A falha foi detectada pela comparação integral. O hook de build agora seleciona BCJ; o delta passou em três testes independentes contra o empacotador real. A montagem05, sobre a mesma candidata congelada, foi instalada normalmente em `LOCALAPPDATA/Programs/Lume`: 132/132 arquivos e 962.451.141 bytes coincidem com a candidata, sem ausências ou diferenças. O único arquivo adicional é o desinstalador esperado. SHA-256 do instalador: `b74375cbf4b464459979bb56565704708f2cfbab196f837a68e0700861153b51`. Não se copiaram DLLs manualmente nem se contornou proteção Windows.

No perfil original, a primeira observação não encontrou janela em 30 segundos e foi encerrada normalmente; a causa não foi determinada. A observação seguinte concluiu dois boots, com janela disponível em 11.053 e 6.226 ms, versão beta.7 e diretório de perfil originais. A fonte consultada respondeu 200 com conteúdo, os 360.601 eventos permaneceram presentes e ambos os encerramentos retornaram zero. O WhatsApp apresentou `auth_invalida` nos dois boots: preservação dos arquivos não significa conexão ativa. As capturas do perfil são privadas e ficam fora do Git.

A conferência anterior à abertura encontrou banco, sessão ativa e contexto de criptografia iguais ao backup. A única mudança foi a credencial ChatGPT renovada durante a avaliação autorizada; uma cópia suplementar criptografada, com acesso restrito ao usuário do Windows, foi conferida em `09-suplemento-cofre`. O backup original não foi alterado.

O helper de ajuste do atalho foi bloqueado antes de executar: PowerShell recusou o `.ps1` pela política de scripts (`UnauthorizedAccess`). Não houve Bypass, mudança de política nem execução equivalente por outro host. A leitura independente final, às 05:22:24 UTC, encontrou os atalhos de Desktop e Menu Iniciar apontando para `Programs/Lume/Lume.exe`, com argumentos vazios; não foi determinado quando ou por que o destino do Menu Iniciar mudou em relação à observação anterior. O helper recusado não realizou essa alteração. O campo de ícone do Menu Iniciar é `,0`; sua apresentação efetiva continua sem prova. Não se executou o resultado da busca nem o percurso até uma fonte pela interface instalada. As duas capturas instaladas usam `capturePage`; o ícone foi extraído separadamente pela API Windows. Nenhum atalho antigo foi apagado. Os destinos convergem na leitura atual, mas abertura pela busca e apresentação no Windows permanecem gates próprios.

Após os dois boots, a inspeção de metadados confirmou banco/WAL/SHM, Local State, ambos os cofres e `wa-auth` presentes, com 22.677 entradas na sessão ativa e as mesmas dez pastas históricas. Banco e sessão tiveram atualização de data durante a execução: não se afirma igualdade de bytes após o boot. O instalador privado foi entregue em `08-instalador`, com origem/cópia e SHA-256 conferidos; essa entrega de arquivo não executou novamente o instalador nem publicou uma release.

## Avaliação autorizada e limite observado

A amostra de 100 mensagens autorizadas e os rótulos independentes foram preservados antes da chamada. Há 20 casos críticos, 23 fontes com extração operacional obrigatória e nenhum grupo real. Hash das expectativas: `855a481e5028d281e07fdd3c8df05014ea499e83a9bd2c37af53570f9eb763e4`.

Após a restauração, Electron acessou o cofre pelo mecanismo normal do sistema, sem exportar credenciais. A conta existente estava conectada, com plano habilitado e modelo `gpt-6.1-sol`. A primeira chamada real, R001, terminou em 4.448 ms com `subscription_sharing_usage_limit_exceeded`. Houve **zero extração concluída**; não existe nota de qualidade desta avaliação. O adapter registrou a pausa na cópia de avaliação. Não houve repetição, troca de conta, habilitação de Jev ou gasto adicional. O processamento automático do histórico permanece sem atestado de avaliação e bloqueado.

## Repositório e apresentação

O README apresenta o produto como em validação, com banner amarelo, personagem vetorial e diagrama editorial. O índice de documentação, guia de contribuição e kit visual apontam para contratos e provas, sem apresentar ilustrações como screenshots do aplicativo. A privacidade do repositório e o nome remoto histórico foram preservados. O push da branch `feat/lume-06-context-cycle` foi executado e o corte `7b482a1` confirmado no remoto. A apresentação está nessa branch; a branch padrão não mudou. Publicação de release do aplicativo continua sujeita aos seus próprios gates.

## Gates ainda abertos

- Retomar a avaliação quando a conta existente voltar a permitir uso; manter o histórico bloqueado até >=90% e zero erro crítico, sem alterar rótulos. A cobertura de grupos reais continua ausente.
- Comprovar abertura pela busca/menu Iniciar, ícone e fonte na interface instalada. Os destinos dos dois atalhos convergem na leitura final; a abertura não foi executada. Instalação normal, versão, perfil, reinício e fonte por API passaram; o helper recusado pela política PowerShell não foi contornado. WhatsApp apresentou autenticação inválida, sem novo pareamento nesta entrega.
- Reproduzir o problema histórico do mapa no aplicativo instalado. O timeout foi reproduzido sinteticamente e a consulta atual respondeu sobre a cópia real; isso não estabelece a causa histórica.
- Resolver a incerteza de desempenho em um cenário representativo: comparação e diagnóstico foram executados, mas os aumentos variaram entre rodadas e sua causa não foi isolada. CPU/RAM em carga, QA nativo a 200%, teclado e silêncio têm provas sintéticas; não substituem desempenho e percurso no perfil instalado nem hardware de 8 GB.
- Aceite de utilidade com Fabrício, macOS nativo, máquina física de 8 GB, percepção sonora e leitor de tela. Não há aceite presumido.
- Os termos completos versionados `beta-2026-10-01-leitura-pessoal` ainda citam a organização anterior com Laya/Gemini. O resumo operacional e o consentimento específico foram conferidos, mas os termos vinculados ao aceite histórico não foram silenciosamente reescritos. A coerência jurídica permanece pendente antes de distribuição externa.

Provas privadas e logs ficam em `work/lume-1-20261026`, fora do Git. Revisões públicas de código estão em `BACKEND-REVISAO.md`, `DESKTOP.md` e `REVISAO-SNAPSHOT-CONCORRENCIA.md`. Nenhum conteúdo de conversa ou credencial integra este relatório.
