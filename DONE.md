# Estado do Lume 1.0

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
