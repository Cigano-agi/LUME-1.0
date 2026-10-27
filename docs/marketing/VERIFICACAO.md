# Verificação da apresentação

## Revisão soft · novo repositório · 27/10/2026

A apresentação deste snapshot limpo corresponde à identidade comercial **Lume 1.0** e à versão técnica **3.2.0-beta.8**. Foi refeita com o mesmo renderer vetorial do personagem utilizado no painel e na companhia: banner de 1280 × 520, percurso de 1280 × 360 e prancha com seis das treze expressões em 1280 × 470. Open Runde está incorporada sob OFL, com origem e hashes em [FONTES](../lume-soft/FONTES.json). O README usa os PNGs verificados para conservar a composição no GitHub; os SVGs e o gerador continuam disponíveis no kit.

Foram lidos README, changelog e índice contra a versão técnica beta.8, contrato, UI e testes. O texto descreve acompanhamento de aplicativos opcional/local, suas limitações e os gates separados de instalação, qualidade semântica e aceite. Os desenhos são identificados como material editorial; nenhum dado pessoal ou captura do perfil real foi acrescentado.

O destino **[Cigano-agi/LUME-1.0](https://github.com/Cigano-agi/LUME-1.0)** foi criado privado, com descrição e tópicos. A automação Actions está desligada para não iniciar jobs ao receber os commits. Ele receberá um snapshot curado, sem ancestralidade, a partir do commit de origem `3d2ee026bcc3becabd85dfc31a4e9e9ee217cd5f`. O repositório anterior, seu histórico e suas worktrees permanecem preservados; veja [ORIGEM](../ORIGEM.md). A configuração de remotos feita na origem não implica configuração Git neste snapshot.

A beta.8 ainda não foi instalada. A regressão integrada 02 está em execução e o push do snapshot está pendente. Criação do repositório, renderização editorial, instalação e publicação de commits são etapas distintas; os recibos posteriores devem ser registrados em [DONE](../../DONE.md).

A renderização final na origem foi repetida pela coordenação às 06:02:58 UTC, após corrigir o texto alternativo para dizer seis das treze poses. Passou em desktop 1280 px e mobile 390 px: três imagens carregadas por página, zero overflow horizontal, zero requisições externas, zero erros JS, 55 links locais e cinco capturas editoriais. A inspeção independente conferiu banner e prancha; a coordenação também leu a composição mobile final. O [recibo preservado](provas/render-receipt.json) acompanha os PNGs exportados; o log `work/lume-soft-20261027/marketing-final.log` é privado e não distribuído. Esses números pertencem àquela renderização, não a uma nova execução no snapshot.

As evidências e comandos históricos abaixo referem-se ao repositório anterior e à beta.7. Não constituem recibo do novo push ou da nova candidata.

## Registro histórico · apresentação anterior

Verificado em 27/10/2026. O README, o índice de documentação, o guia de contribuição e o kit editorial foram revisados e commitados. A descrição remota e os tópicos foram atualizados pela CLI GitHub já autenticada, conforme o pedido adicional. O repositório continua privado, com o mesmo nome e a mesma branch padrão. O push tem recibo separado no fechamento da tarefa.

## Fontes de conteúdo

- `package.json`: Node >=24, scripts existentes, nome comercial, versão técnica beta.7 e publicação desligada no comando Windows.
- `docs/lume-1/CONTRATO.md` e contrato da fase 10: percursos, fontes, autorização, identidade e gates separados.
- `docs/lume-1/IMPLEMENTACAO.md` e `DONE.md`: distinção entre implementação, evidência de desenvolvimento, avaliação, instalação e aceite.
- `desktop/main.cjs`: perfil normal `AssessorDesktop`; abrir o checkout não equivale a usar perfil descartável.
- `desktop/icon.svg`: personagem existente reutilizado na composição vetorial, sem modificar o asset do aplicativo.

O README anterior continua disponível no histórico Git do repositório de origem, não na ancestralidade deste snapshot. Não foram duplicados nomes de clientes, necessidades pessoais ou relatos operacionais antigos na apresentação de marketing.

## Renderização observada

Comandos executados:

```text
node docs/marketing/gerar-visuais.mjs
node docs/marketing/verificar-visuais.mjs
git diff --check -- README.md CONTRIBUTING.md docs/README.md docs/marketing
```

O renderer usa Playwright com Edge Chromium em modo headless e contextos novos, sem perfil pessoal. O canal Chromium padrão não estava instalado; a execução foi ajustada para o canal `msedge` já instalado e já utilizado nos testes do projeto. Não houve instalação de navegador ou alteração de política.

Resultado observado: desktop 1280 px e mobile 390 px sem overflow horizontal da página; duas imagens carregadas com texto alternativo; SVGs sem erro de parser, com título e descrição; zero erros de página; zero requisições externas; 31 links locais conferidos. Quatro screenshots editoriais gerados. O conteúdo mobile foi revisto para os três passos ficarem empilhados, sem texto cortado. Banner, diagrama e ambas as composições foram inspecionados visualmente.

Provas:

- [Apresentação desktop](provas/apresentacao-desktop.png)
- [Apresentação mobile](provas/apresentacao-mobile.png)
- [Banner](provas/lume-banner.png)
- [Percurso editorial](provas/lume-percurso.png)
- [Recibo de renderização](provas/render-receipt.json)

Os SVGs são os assets de apresentação; os PNGs acima documentam sua renderização. A página é editorial, não uma captura do produto ou prova de funcionalidade. Não houve execução do Electron, leitura de conversas ou credenciais reais, publicação ou chamada paga. Nenhuma inferência de qualidade semântica, disponibilidade de release ou aceite foi acrescentada.

Skill aplicada: `agency-marketing-content-creator`, incluindo seu `PROFILE.upstream.md`. Não foi necessária geração ou edição raster por imagegen: o personagem vetorial existente foi reutilizado, e os PNGs são screenshots do material editorial.

A coordenação repetiu `node docs/marketing/verificar-visuais.mjs` em 27/10/2026, com saída zero: 31 links locais, quatro capturas, nenhum overflow nas duas larguras, nenhuma requisição externa e nenhum erro de página. Leu o README e o guia contra os scripts do projeto e inspecionou a composição desktop. Revisão editorial aprovada. Commit e push permanecem etapas distintas da instalação e do aceite do produto.

Após acrescentar o relatório de desempenho ao índice, uma conferência final de existência dos caminhos validou 32 links locais nos mesmos quatro documentos. Essa última conferência foi estática, sem nova execução do navegador; as quatro capturas editoriais anteriores continuam sendo a prova visual.

A descrição remota conferida por `gh repo view`: “Lume — memória local com fontes, contexto e próximos passos. Conversas, projetos e compromissos com autorização explícita.” Tópicos: desktop, electron, local-first e personal-knowledge-management. O conector não retornou o repositório privado; a CLI existente foi usada, sem nova conta ou alteração de acesso.

Antes do push, a inspeção heurística dos objetos novos desde a branch remota até `c7f8407` percorreu 1.547 blobs de texto, sem arquivo de banco, sessão ou cofre nos caminhos. O único achado foi um delimitador PEM usado por uma função que gera identidade em runtime; não havia chave embutida. Essa inspeção não é garantia universal de ausência de dados: 136 blobs binários não foram interpretados como texto, e as provas visuais devem conservar sua origem sintética/editorial. Dados e screenshots do perfil pessoal permaneceram fora do Git. O delta posterior até `7b482a1` também foi conferido: 24 blobs de texto, nenhum achado, um binário não interpretado como texto e nenhum arquivo grande.

O comando `git push origin HEAD:feat/lume-06-context-cycle` terminou com saída zero; `git ls-remote` confirmou `7b482a116f8aa4e8f2882f1609da04f001e11e0e` em 27/10/2026. A [apresentação está na branch de trabalho](https://github.com/Cigano-agi/assessor-2.0/tree/feat/lume-06-context-cycle). O repositório continua privado e a branch padrão `Cigano-agi/caixa-socio` não foi alterada. Não houve merge, publicação de release ou envio de capturas privadas. Esse recibo registra o corte funcional/documental; os commits posteriores de fechamento permanecem na mesma branch.
