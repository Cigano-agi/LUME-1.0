# Verificação do Lume 1.0

Corte documental de **27/10/2026**, após o primeiro push privado, os testes focais de restauração/cofre, a revisão do backup operacional 02 e o ensaio nativo da candidata. Versão comercial **1.0**, técnica **3.2.0-beta.8**. A candidata `D0jpBX`, congelada em `14dd9f1`, e o instalador NSIS estão preparados; o ensaio isolado da candidata passou. A recuperação foi aprovada independentemente. **A instalação beta.8 está bloqueada pela política de execução de scripts do PowerShell, antes do NSIS; a instalada permanece beta.7.** Este registro não declara conclusão ou aceite geral.

## Regressão e verificações focais

| Execução | Resultado comprovado | Alcance e pendência |
| --- | --- | --- |
| Regressão 01 | 919 testes, 910 aprovados e nove falhas | As nove falhas envolveram fixtures. Após sua correção, a repetição independente dos quatro arquivos pertinentes passou em 28/28. Isso não reclassifica a execução inicial como aprovada. |
| Regressão 02 | 111 arquivos; 1.063 testes, 1.059 aprovados, três falhas e um cancelamento; 1.564.429 ms | Execução concluída com resultado não aprovado. Os logs originais permanecem preservados. |
| Catálogo de backup | Expectativa de 87 tabelas diante de 88; correção `941e3d1` | A tabela de atividade tem exclusão declarada no catálogo. Correção do teste repetida independentemente: 1/1 aprovado. |
| Snapshot curado | Oito arquivos, 46/46 testes focais aprovados independentemente | Confere o recorte selecionado; não substitui a regressão completa nem a instalação. |
| Timer de restauração, primeira repetição focal | 1/1 aprovado; 3.989 ms após o timer | Recorte posterior à falha ampla, sem apagar o resultado anterior. |
| Restauração/cofre, focal 02 | 10/10 aprovados; 254.223 ms | Agregado de validação em 216.338,478 ms; timer em 3.354 ms, abaixo de 5.000 ms. O cofre já continha o primeiro ajuste: não é aprovação do congelamento anterior. |
| Limpeza do cofre | 16/16 aprovados no conjunto dirigido; revisão independente de cofre/ChatGPT em 47/47 | Correção de produto `14dd9f1`, com cenários sintéticos de falha do sistema de arquivos. Não identifica a causa do EPERM histórico. |

Na regressão 02, a validação agregada de restauração atingiu o limite CLI de **180 segundos**. O caso do timer respondeu em **6.663 ms**, acima do critério de **5.000 ms**. O teste do cofre encontrou **EPERM em rename** de um arquivo temporário sintético. A contagem do catálogo também divergiu. Esses registros distinguem timeout, falha de critério temporal, operação de arquivo e expectativa desatualizada; não estabelecem uma causa comum.

O focal 02 concluiu a validação agregada com suas 15 mutações e casos positivos em **216.338,478 ms**, demonstrando que o teto CLI anterior de 180 segundos interrompia esse agregado. O timer voltou a cumprir o critério em **3.354 ms**. A regressão ampla permanece registrada com seu resultado original; o focal não a reclassifica nem comprova desempenho em outras condições.

A investigação encontrou um temporário órfão no cofre. O critério foi registrado em DONE antes da edição de `desktop/segredos.cjs`. A correção **`14dd9f1`** remove temporários em `finally`, apaga o temporário antes do destino na operação de remoção e usa `unlink` direto, ignorando somente **ENOENT**. Outras falhas são propagadas e impedem sucesso. O conjunto inicial registrou **13 falhas**; a revisão intermediária registrou **15/16**, expondo o uso insuficiente de `existsSync`. A versão final passou em **16/16**; a revisão independente conjunta de cofre e ChatGPT passou em **47/47**, sem skip ou cancelamento. A limpeza ainda pode ser recusada pelo sistema operacional, mas essa recusa não é reportada como sucesso. O focal de restauração/cofre já usava o primeiro ajuste do cofre e não libera retroativamente a fonte anterior.

Fontes privadas preservadas na origem, sob `work/lume-soft-20261027/`: `regression-01.log`, `regression-02.log`, seus manifestos, `main-fixtures-review-final.txt`, `catalog-review-green.log`, `snapshot-review-final.json`, `backup-timer-focal-01.log`, `restore-cofre-focal-02.log`, `cofre-cleanup-red.log`, `cofre-cleanup-review-red.log`, `cofre-cleanup-final-green.log`, `cofre-independent-final.log` e `cofre-independent-review.json`. São referências de procedência, não arquivos distribuídos neste repositório.

## Interface, execução nativa e documentação

O percurso nativo isolado registrou **11 capturas e 22 fluxos**, com duas inicializações e saídas normais, temas, movimento reduzido, zoom de 200%, galeria, surpresas finitas e controles de som. O acompanhamento de apps nesse percurso foi **sintético**, persistido no SQLite de teste; o coletor real permaneceu desligado. A consulta separada ao helper real retornou **inativo** e não prova coleta positiva de um aplicativo ativo. A instrumentação de janela desse ensaio também não substitui a abertura normal da futura candidata instalada. Detalhes em [QA nativa](QA-NATIVA.md), [resultado da interface](UI-RESULTADO.md) e [revisão independente](REVISAO.md).

A verificação editorial anterior registrou **cinco capturas e 55 links**; pertence ao corte original de marketing, não a uma nova renderização deste snapshot. A revisão do snapshot conferiu **42 documentos, 118 referências locais e nenhum destino ausente**, antes desta atualização documental. Arte editorial não é captura do produto nem prova de desempenho. Capturas privadas e conversas não foram exportadas.

O recibo `candidate-native/evidence.json`, de **06:45:58–06:46:05 UTC**, registra aprovação da candidata empacotada em perfil sintético isolado: **duas inicializações e saídas normais**, preferências preservadas, atividade disponível e desligada, companhia sem eventos de foco observados e **três capturas**. O executável permaneceu sem alterações; foram usados DOM e observadores somente leitura, sem patches de `show`/`focus`. Isso não afirma que a janela principal nunca recebe foco. A captura do onboarding foi feita durante uma transição de opacidade e não serve como prova de contraste. O ensaio não comprova instalação nem fonte real no perfil pessoal. Detalhes em [distribuição desktop](DESKTOP.md).

## Envios confirmados e procedência

O recibo privado `github-first-push.json` confirma, em **27/10/2026 às 06:21:32 UTC**, o primeiro push para **Cigano-agi/LUME-1.0**, repositório privado, branch **main**, commit **`f6405c5f7f608c9d482091e5e3606bfab12d9c80`**, com **Actions desligado**. Foram conferidos os blobs remotos de quatro arquivos: README e os PNGs de banner, percurso e expressões. Esse recibo comprova o envio inicial; não comprova que alterações documentais ou correções posteriores já foram enviadas.

O **segundo push foi confirmado** em **27/10/2026 às 06:54:39 UTC**, pelo recibo privado `github-second-push.json`: commit **`35c290cdaa6412d12faf9c8e21ef81d8d9fa4e3e`**, 1.045 arquivos, confirmação remota por Git/API e conferência dos blobs do README e dos três PNGs. O repositório permanece privado e Actions desligado. Esse é o **último envio comprovado neste registro**; estas notas documentais posteriores pertencem à mesma linhagem e não declaram outro envio. O push não comprova instalação, distribuição pública ou aceite.

O produto-base vem de **`3d2ee026bcc3becabd85dfc31a4e9e9ee217cd5f`** na origem. Os complementos **`be17e53`** (teste de versão) e **`941e3d1`** (expectativa do catálogo) são correções de teste. A fonte atual inclui também a exceção de segurança **`14dd9f1`**, em `desktop/segredos.cjs`, e seu novo teste. Ambos integram o segundo envio confirmado, **`35c290c`**. A contagem anterior de fontes inalteradas descreve somente a revisão anterior a essa exceção. O commit inicial `f6405c5` continua sendo a prova histórica do primeiro envio. O snapshot começa sem importar a ancestralidade anterior por curadoria de privacidade. O repositório original, seu histórico, arquivos e worktrees foram preservados.

## Recuperação e limites ainda abertos

O backup do programa já instalado preservou **133 arquivos e 962.624.997 bytes**, com hashes conferidos e fonte estável. O recibo `backup-installed.log` declara que não inclui perfil nem credenciais e não executou instalação.

O **backup operacional do perfil, tentativa 02, foi concluído**: **29.236 arquivos e 5.873.143.313 bytes**, conferência de hashes, estabilidade da origem no escopo copiado e restauração de ensaio com os mesmos arquivos e hashes. O recibo privado `01-recuperacao-perfil/receipt.json` registra `verified:true` e `rehearsed:true`. **Dez pastas históricas permanecem na origem, sem cópia nem verificação do conteúdo por hash**; a prova do escopo operacional não se estende a elas. A revisão independente final conferiu o arquivo de backup, os **29.236 arquivos restaurados** e os **133 arquivos do programa**, com estado `approved-recovery-artifacts` em `backup-review-final.json`.

A primeira tentativa permanece registrada como **LUME_NOT_STOPPED**, antes da cópia. A consulta exata seguinte encontrou zero processos do Lume; a tentativa 02 manteve a proteção, preservando os demais processos. Nenhum resultado da primeira tentativa foi convertido em aprovação.

A execução normal de `work/lume-soft-20261027/install-beta8.ps1` foi recusada pelo PowerShell com **PSSecurityException / UnauthorizedAccess**, pois a execução de scripts está desabilitada. A recusa ocorreu **antes de iniciar o NSIS**: não há recibo de instalação, execução do instalador ou alteração da instalação beta.7. Não foi uma recusa de SmartScreen ou assinatura. Não houve tentativa por Bypass, comando inline ou outro host. O harness privado `installed-source-gui.mjs` permanece **preparado e não executado**; portanto não existe prova nova de fonte real na GUI instalada beta.8.

Continuam sem conclusão neste registro:

- Conclusão da validação integrada além dos recortes focais registrados, preservando as falhas históricas.
- Instalação beta.8 bloqueada pela política de execução do script; abertura/reinício e fonte real na GUI instalada não foram executados. O ensaio isolado e a saída zero do build não comprovam instalação.
- Coleta positiva real de aplicativo ativo, abertura pela busca do Windows e fixação na barra por mecanismo permitido.
- Qualidade semântica com mensagens autorizadas: a conta existente atingiu cota; o histórico permanece fechado até avaliação aprovada. Não houve novo pareamento, conta ou modelo para superar esse limite.
- Conexão WhatsApp, aceite humano de utilidade, execução nativa no macOS e máquina física de 8 GB.

Os resultados de [desempenho](../lume-1/DESEMPENHO.md) e os ensaios nativos têm suas condições declaradas; não sustentam alegação de hardware de 8 GB ou ganho causal generalizado. Novos resultados exigem recibo próprio e atualização explícita deste estado.
