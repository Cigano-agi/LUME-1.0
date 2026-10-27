# Diagramação e som — 27/10/2026

Pedido: corrigir elementos encostados em Ajustes e na barra superior, revisar as telas principais e conferir o som antes de preparar a apresentação à guilda. Continuação da fase 10; origem `d1dd9ac`, repositório curado `0a772a2`.

## Reprodução e correção

O aplicativo observado estava sendo executado da cópia de recuperação beta.7 em Downloads. Foram feitas 28 capturas privadas do renderer HTTP desse processo, em navegador isolado, permitindo somente GET/HEAD locais. Nenhuma preferência real foi gravada e a janela original permaneceu aberta. Isso reproduz os assets do pacote em execução; não é uma captura da moldura nativa do Electron.

As regras legadas mantinham distância zero entre os cartões de Ajustes. A busca era irmã direta da barra de preferências, sem margem superior compartilhada; o label de tema ainda herdava uma margem incompatível. Memória também misturava filtros novos com um contêiner flex antigo.

A correção em `experiencia.css` e `experiencia-shell.js` acrescenta um cabeçalho comum para alinhar busca, controles e conteúdo. Define 12 px entre controles e 16–20 px entre cartões, separa filtros e ações extras da Memória e organiza os blocos de Pessoas. A inspeção visual posterior encontrou checkboxes acima do texto; a regra foi corrigida para preservar caixa e texto lado a lado. IDs, ações, navegação e preferências foram preservados.

## Som

Os dois sons já existiam no produto. A nova prova captura a saída do sintetizador real do navegador, sem microfone, áudio do computador ou reprodução física. Cinco arquivos WAV cobrem prévias em volumes diferentes e avisos operacionais da companhia com eventos sintéticos e fonte.

A revisão independente confirmou sinal nas frequências esperadas, sem saturação. Volume de 70% produziu amplitude 1,976 vez a de 35%. Os 24 testes focais passaram. A emissão inicial, repetição, pausa, volume zero e recarga têm verificações de silêncio por ausência de novos osciladores; isso não é medição dos alto-falantes. O buffer decodificado de 0,24 s não mede isoladamente toda a curva de volume do som.

O controle rápido governa os sons da companhia. Os avisos nativos de ações têm preferência própria e usam o som do Windows. Essa separação existente foi preservada; a revisão não declara que um único controle altera os dois caminhos.

## Comandos e evidências

```powershell
node test/lume-layout-spacing.e2e.mjs --run --baseline
node test/lume-layout-spacing.e2e.mjs --run
node test/lume-layout-spacing.e2e.mjs --run --appearance-only
node test/lume-layout-audio.e2e.mjs --run
node --test --test-concurrency=1 test/lume-1-interface.test.js test/lume-soft-ui-motion.test.js test/release-version.test.js test/release-readiness.test.js test/release-consumers.test.js
node --test --test-concurrency=1 test/lume-soft-ui-audio.test.js test/experiencia-companheiro-ui.test.js test/experiencia-companheiro.test.js test/lume-1-interface-sound.test.js test/lume-1-interface-sound-review.test.js
```

As provas privadas ficam em `work/lume-layout-20261027`. A primeira comparação entre o mesmo conteúdo sintético no código-base e no checkout corrigido registrou 186 violações de espaçamento antes e nenhuma depois, em 68 capturas por versão. Esses números pertencem aos critérios medidos; não substituem inspeção visual. A correção posterior dos checkboxes e a revisão final possuem recibos próprios.

A repetição independente final produziu 68 capturas, nenhuma violação geométrica, nenhum erro JavaScript e nenhuma requisição externa registrada. O revisor inspecionou visualmente 14 telas e repetiu os 39 testes de interface, movimento e versão, todos aprovados. O ensaio focal de Aparência acrescentou dez capturas, incluindo controles inferiores, reflow em 512 × 384 e navegação por Tab. Os testes usam cliques programáticos e zoom CSS de 200%; não equivalem à operação humana ou ao zoom nativo do Electron. O harness não monitora respostas HTTP de erro.

Recibos independentes: `layout-review.json`, SHA-256 `3f5a6c4ac6346fcf2b652355048a683d8afe2df25206838494993e47713af8ac`; `audio-review.json`, SHA-256 `17ca5845351a65c1db86dbe66fb87921e53a46f6cffd1d6f7da7910a49cc7c09`. As provas de áudio incluem sinal PCM real, com eventos sintéticos na companhia e gesto prévio na página isolada; não comprovam autoplay nativo, produtor IPC real, som de notificação do Windows ou audição humana.

No repositório curado, a comparação anterior pode ser reproduzida com `--baseline --baseline-ref=0a772a2`. O padrão `d1dd9ac` pertence ao repositório de origem, cujo histórico foi preservado separadamente. A regressão anterior de 1.079 testes é uma prova da beta.8; não foi reclassificada como execução integral desta revisão.

## Estado da entrega

Layout e áudio aprovados pela revisão independente no escopo descrito. O build da candidata beta.9 e o empacotamento NSIS terminaram com saída zero. A inspeção estática conferiu 7.051 entradas do ASAR, 441 fontes congeladas e os 134 arquivos do payload extraído, iguais à candidata por caminho, tamanho e SHA-256. O contêiner passou no teste de integridade e usa BCJ nas quatro DLLs ARM64.

O instalador tem 345.603.500 bytes e SHA-256 `15bda2e78586a9828cd0d95ba2a8126f0921bc6be04e194e84f19ac54e067307`. Aplicativo e instalador retornaram **NotSigned**. Versão e recurso do ícone foram conferidos estaticamente; aplicativo, helper e instalador beta.9 não foram executados. Portanto, montagem e inspeção não comprovam funcionamento nativo, instalação, atualização de perfil ou exibição efetiva do ícone pelo Windows.

O [texto para a guilda](ANUNCIO-GUILDA.md) foi revisado como convite ao piloto, sem envio e sem link de download declarado como validado. Instalação, coleta positiva real de atividade, avaliação semântica, aceite de utilidade e provas de plataforma continuam com seus gates próprios. A revisão documental conferiu uma lista de 13 arquivos do snapshot, nove cópias idênticas à origem e 54 referências locais válidas em seis documentos. O diff preserva EOL Windows nos arquivos de interface; o gate `git -c core.whitespace=cr-at-eol diff --check` passou sem alterar a configuração.

Na observação atual, o WhatsApp aparecia conectado e a organização automática continuava pausada, aguardando avaliação de qualidade. Isso atualiza a observação de conexão sem reescrever a falha de autenticação registrada nos ensaios anteriores. A janela beta.7 aberta e o perfil existente foram preservados.
