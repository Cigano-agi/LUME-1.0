# Estado do Lume 1.0

## Organização automática — candidata beta.10, 28/10/2026

Objetivo: acompanhar conversas e grupos autorizados por assunto/projeto, com fontes,
interesse comercial visual e perguntas curtas somente para ambiguidades reais.
Escopo e exclusões permanecem separados de atendimento e envio. Continuação do
produto existente; a instalação continua beta.7. A ativação do perfil existente
e sua observação possuem prova separada da avaliação semântica.

- [x] Contexto limitado, continuidade temporal, origem do nome e múltiplos projetos por mensagem; correções e perguntas persistentes.
- [x] Duas análises pela mesma conta/modelo, prazo total de 120 segundos e revalidação das fontes e permissões. Não é revisão independente de conteúdo.
- [x] Bloquear derivações de perguntas de identidade nos casos reproduzidos, inclusive fontes de candidatos e leituras antigas; preservar pedidos legítimos e correções manuais.
- [x] Revisão técnica independente da barreira de identidade: 234/234 testes, sem falha ou skip, incluindo integração e MCP.
- [x] Reservar fontes completas dos candidatos e impedir vínculo genérico sustentado só por identificação nominal. Revisão independente: 134/134 e, após correção dos resumos conciliados, 82/82; são execuções sobrepostas. Contrato atual `9e5e576aa9cba5ba5c5675436529314c5fa2490c398bc31a11c32fa6b80aae7e`.
- [x] Avaliação semântica do contrato atual: principal V9 95/100 e complemento V6 24/25, zero críticos em ambos; rótulos preservados e revisão independente. Os conjuntos dirigidos não estimam precisão geral.
- [x] Revisar bytes e gates do snapshot curado: 45/45 arquivos iguais à origem, 86/86 testes focais; retomada de contexto incompleto em 131/131 na origem. Candidata final09 com pacote 4/4, integridade, fontes e 134 arquivos do payload conferidos; perfil sintético nativo com claro/escuro, 1024 e zoom 200%.
- [x] Ativação realizada após aprovação semântica e recuperação verificada: alcance atual/futuro com exclusões, sem habilitar envios. Primeiro projeto e vínculos automáticos observados no perfil existente. Leitura real de Agora/Projetos/Vendas e fonte em três ações; captura do renderer nativo e zero erro HTTP/JavaScript no percurso.
- [x] Código enviado e conferido nos dois destinos: origem `cc4ed8d`, snapshot `0f1e6c7`; 45 blobs Git do código iguais entre os repositórios. Documentação e privacidade revisadas separadamente, com provas pessoais fora do Git.

Depois da observação, o aplicativo encerrou normalmente e reabriu no perfil
existente, sem argumentos de depuração; a fila retomou. A primeira revisão dos
efeitos reais não encontrou erro crítico no recorte, mas registrou uma consulta
de preço com objeto implícito. Isso não aprova todas as associações futuras.
O aplicativo aberto é a candidata empacotada beta.10; a instalação registrada
continua beta.7. Instalação, ícone efetivo, busca do Windows e utilidade permanecem
pendentes. Nenhuma instalação alternativa ou limpeza dos atalhos foi executada.

As avaliações finais tiveram 200 e 50 respostas, respectivamente. Cinco desvios
principais e um complementar permanecem registrados. Sem prova suficiente para
generalizar as temperaturas quente/frio ou o histórico inteiro. O complemento V5
teve 22/25 e um erro crítico, preservados no registro privado;
motivou a reserva de bases e a barreira de atribuição nominal. A V4 anterior teve
17/25 e quatro críticos. As cópias, respostas e rótulos V6/V9 estão congelados, com
semântica e denominadores preservados. As barreiras lexicais cobrem casos reproduzidos,
sem promessa de interpretação geral. Detalhes em
[Organização automática](docs/lume-1/ORGANIZACAO-AUTOMATICA.md).

A regressão de 126 arquivos no corte anterior `2ab1138` terminou com 1.287/1.289
testes aprovados. Duas expectativas antigas foram corrigidas: o botão de repetir
precisava de seletor específico e o inventário fechado MCP precisava dos helpers
atuais. Os dois arquivos passaram em 19/19 no original e, independentemente, em
19/19 neste repositório após sincronização por lista explícita. Isso não reescreve
o resultado da rodada ampla nem substitui os gates das alterações posteriores.

Verificar: `node --test --test-concurrency=1 test/lume-auto-*.test.js` e
`node test/lume-auto-ui.e2e.mjs --run`. Testes sintéticos não substituem avaliação
real, instalação ou aceite. As provas privadas e o perfil ficam fora do Git.

A comparação inicial de abertura encontrou +17% na montagem final09. A investigação
pareada A–B–B–A na mesma máquina não repetiu a regressão: medianas 1,548 s e 1,487 s.
Isso não demonstra ganho causal, desempenho em 8 GB ou validação de macOS. O recurso
PE tem o fantasma amarelo, mas a consulta ao shell ainda retornou ícone genérico;
barra de tarefas e busca do Windows permanecem sem aprovação.

Visibilidade conferida em 28/10/2026: este repositório está público; a origem
permanece privada. Nenhuma mudança de visibilidade foi feita nesta revisão.

## Ícone e mensagem para a guilda — observação posterior de 27/10/2026

Mensagem de WhatsApp reduzida a seis funções, com convite gratuito para solicitar acesso ao piloto. Repositório permanece privado; não foi anunciado download público disponível. Nada enviado à guilda.

A leitura atual encontrou uma instalação registrada beta.7 e cópias de recuperação/desenvolvimento. O Menu Iniciar abre a recuperação beta.7; a área de trabalho aponta para a instalação. Dois atalhos do Electron, um deles fixado, compartilham o AppUserModelID do Lume e apontam para o executável de desenvolvimento. Essa colisão sustenta o diagnóstico do ícone; não houve teste A/B do shell. **Ícone e atalhos ainda não corrigidos; beta.9 não instalada.** A política de scripts segue Restricted e a recusa anterior não foi contornada. Cópias, perfil e atalhos foram preservados. Os recibos com caminhos pessoais ficam fora do Git.

## Revisão de espaçamento e som — beta.9, 27/10/2026

Correções implementadas e revisão independente aprovada para layout e áudio. O [relatório atual](docs/lume-soft/AJUSTES-LAYOUT-SOM.md) registra causas, comandos, resultados e limites. O [anúncio para a guilda](docs/lume-soft/ANUNCIO-GUILDA.md) está preparado como convite ao piloto, sem envio ou link de download validado.

- [x] Reproduzir as telas reais em 28 capturas privadas, somente leitura; manter a janela e as preferências existentes.
- [x] Corrigir cabeçalho, espaçamento de Ajustes, filtros de Memória, blocos de Pessoas e alinhamento de checkboxes.
- [x] Repetir a revisão independente: 68 capturas, zero violações geométricas, 14 telas inspecionadas visualmente e 39/39 testes focais. Zoom CSS de 200% e viewport 1.024 × 768; não equivalem a zoom nativo ou aceite humano.
- [x] Provar áudio real sintetizado com cinco WAVs, volume proporcional e negativos de emissão; 24/24 testes focais independentes. Sem audição física, autoplay nativo ou notificação Windows comprovados.
- [x] Finalizar inspeção estática da candidata beta.9 e instalador normal: 134 arquivos do payload conferidos. App/Setup NotSigned e não executados; instalação segue como prova separada.
- [x] Concluir revisão dos documentos e sincronização por lista explícita. Corte `5e713cf` confirmado por Git/API em `main`: repositório privado, Actions desligado, 1.049 arquivos, sete blobs remotos conferidos. Origem preservada e enviada no corte `d923818`.

Versão comercial **1.0**, técnica **3.2.0-beta.9**. A janela observada usa a cópia de recuperação beta.7; a instalação não foi substituída. O bloqueio anterior do script de instalação permanece, sem nova tentativa ou contorno. Na observação atual o WhatsApp aparecia conectado; isso atualiza o estado da conexão sem reescrever a falha histórica. Organização automática ainda pausada para avaliação de qualidade; coleta positiva real, busca do Windows, instalação, utilidade, macOS e 8 GB continuam pendentes.

Verificar: `node test/lume-layout-spacing.e2e.mjs --run`; para a base deste repositório, acrescentar `--baseline --baseline-ref=0a772a2`. Áudio: `node test/lume-layout-audio.e2e.mjs --run`. Comandos focais completos no relatório. Nenhuma captura real ou perfil é distribuído pelo Git.

A revisão independente do pacote repetiu os 134 hashes, gate estático, integridade do contêiner, versão/fontes e Authenticode. Comparou o payload já extraído, sem repetir a extração. Recibo privado `package-review.json`, SHA-256 `1b690e40ac02ee2a7d41724650ae99de8c90e226e8cd4ec1b811b3992d0899d2`. Galeria, cinco WAVs e candidata foram entregues em pasta privada de Downloads. O anúncio não foi enviado e a beta.9 não foi executada ou instalada. Este fechamento documental sucede o corte identificado; não encerra os gates anteriores de instalação e aceite.

## Histórico preservado — revisão beta.8

**QA atual — rodada 03:** 1.079/1.079 testes aprovados em 112 arquivos, no checkout limpo `830111f`, em 27/10/2026. Zero falha, cancelamento, skip ou todo. Revisão independente aprovada nesse recorte, com conferência de log, comando e hashes. A aprovação tem o escopo do manifesto e não fecha o bloqueio da instalação Windows.

Versão comercial **1.0**, técnica **3.2.0-beta.8**. Snapshot do produto em validação, conforme o [contrato atual](docs/lume-soft/CONTRATO.md). Candidata `D0jpBX` e instalador preparados sobre `14dd9f1`, com ensaio nativo isolado aprovado. Recuperação aprovada independentemente. **Instalação bloqueada pela política de scripts do PowerShell antes do NSIS; instalada ainda beta.7.** A regressão integrada 02 terminou com 1.059 aprovações, três falhas e um cancelamento em 1.063 testes. O focal posterior de restauração/cofre passou em 10/10; a correção final do cofre teve revisão independente de 47/47. Publicação privada confirmada em `main` até `830111f`, com Actions desligado. Este complemento de QA ainda depende de seu próprio recibo de envio. Detalhes e limites no [registro de verificação](docs/lume-soft/VERIFICACAO.md).

- [x] Interface suave, temas, fontes locais, 13 expressões e duas surpresas finitas.
- [x] Som opt-in, prévia/volume, deduplicação e movimento reduzido.
- [x] Acompanhamento local de apps com consentimento, pausa, exclusões, retenção e apagar; dados separados das conversas.
- [x] Percursos nativos isolados: 11 capturas, 22 fluxos, reinício e zoom de 200%; revisão independente.
- [x] Registrar o resultado da regressão integrada 02, preservando as falhas e o cancelamento.
- [x] Concluir o focal de restauração/cofre: 10/10, sem reclassificar a regressão ampla ou a fonte anterior.
- [x] Corrigir a limpeza de temporários do cofre após registrar o critério: teste dirigido final 16/16 e revisão independente de cofre/ChatGPT 47/47.
- [x] Concluir a rodada integrada 03 no escopo de 112 arquivos: 1.079/1.079 aprovados, sem falha, cancelamento, skip ou todo; checkout `830111f` e 1.045 arquivos rastreados inalterados. Revisão independente aprovada nesse recorte; não é aprovação de todo o repositório ou instalação.
- [x] Empacotar a candidata beta.8 `D0jpBX`, com saída zero do build.
- [x] Exercitar a candidata sem modificar o executável: duas inicializações e saídas normais, companhia sem eventos de foco observados, atividade desligada e três capturas privadas.
- [x] Concluir backup operacional 02 e restauração de ensaio, com hashes iguais no escopo copiado.
- [x] Concluir a revisão independente da recuperação: arquivo, 29.236 arquivos restaurados e 133 arquivos do programa conferidos.
- [ ] Instalação beta.8 bloqueada: PSSecurityException / UnauthorizedAccess na execução normal de `install-beta8.ps1`; NSIS não executado, sem contorno da política.
- [ ] Executar o percurso de fonte real na GUI beta.8 instalada; harness preparado e não executado.
- [ ] Prova positiva do coletor em app ativo; consulta real executada retornou inativo.
- [ ] Abertura pela busca do Windows e fixação por mecanismo permitido.
- [ ] Organização semântica com mensagens autorizadas: conta existente atingiu cota; histórico permanece fechado até avaliação.
- [ ] Conexão WhatsApp, utilidade humana, macOS nativo e máquina física de 8 GB.
- [x] Revisar o snapshot curado e confirmar o primeiro push privado para LUME-1.0, sem importar o histórico anterior.
- [x] Confirmar o segundo push `35c290c` por Git/API, com 1.045 arquivos e blobs remotos do README e dos três PNGs conferidos.

Não há assinatura de release ou publicação automática. Os [relatórios](docs/README.md) distinguem provas sintéticas, execução nativa, instalação e aceite. O histórico da origem foi preservado; o novo repositório recebe somente o snapshot curado, sem ancestralidade. A fonte atual inclui a base `3d2ee026` e a exceção de segurança `14dd9f1`, já copiada com seu teste para o snapshot. O backup do programa instalado tem 133 arquivos e 962.624.997 bytes conferidos por hash. O operacional 02 tem 29.236 arquivos e 5.873.143.313 bytes, com hashes, estabilidade da origem no escopo copiado e restauração de ensaio conferidos. Dez pastas históricas ficaram retidas na origem, sem cópia nem hash de conteúdo. A recusa anterior LUME_NOT_STOPPED permanece preservada. A revisão independente aprovou os artefatos de recuperação; a recusa de instalação é de política de scripts, não SmartScreen ou assinatura. Não há recibo de instalação beta.8 nem alteração da beta.7. O segundo envio tem recibo próprio; estas notas posteriores não declaram outro push nem instalação.
