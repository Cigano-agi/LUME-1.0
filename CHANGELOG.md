# Mudanças

## 3.2.0-beta.8 · Lume 1.0 · 27/10/2026

Interface com superfícies suaves e Open Runde local. Personagem vetorial compartilhado com 13 expressões, galeria e duas surpresas finitas. Som opt-in, com cancelamento e deduplicação. Acompanhamento local opcional de aplicativos, com pausa, retenção, exclusões e apagamento.

A identidade comercial permanece 1.0; a versão técnica cresce após a beta.7, preservando appId e perfil. A organização automática mantém o gate semântico existente. A correção de segurança `14dd9f1` limpa temporários do cofre e impede reportar sucesso quando sua remoção falha; passou em 16/16 testes dirigidos e 47/47 na revisão independente conjunta de cofre/ChatGPT.

A rodada integrada 03 passou em **1.079/1.079 testes de 112 arquivos**, sem falha, cancelamento, skip ou todo, no checkout `830111f` com dependências próprias. Os 1.045 arquivos rastreados mantiveram seus hashes e o checkout permaneceu limpo. Duração do test runner: 1.507.182,4393 ms. A revisão independente aprovou o recorte e conferiu log, comando e hashes; a cobertura é a seleção do manifesto, não todo o repositório. O limite CLI de 180 segundos foi retirado sem editar testes para a repetição; o agregado concluiu em 207.860,6422 ms e o timer respondeu em 3.273 ms, abaixo de 5.000 ms. A instalação Windows segue bloqueada antes do NSIS.

A publicação privada foi confirmada em `main` até `830111f`, com Actions desligado: 1.045 arquivos e blobs remotos do README e dos três PNGs conferidos. Este complemento de QA é posterior e depende de seu próprio recibo de envio. A regressão integrada 02 terminou com falhas; o focal posterior de restauração/cofre passou em 10/10, já com o primeiro ajuste. A candidata beta.8 `D0jpBX` e o instalador NSIS estão preparados; o ensaio nativo isolado passou em duas inicializações e saídas normais. O backup operacional e a restauração de ensaio foram concluídos, com recuperação aprovada independentemente. A instalação foi bloqueada pela política de scripts do PowerShell antes do NSIS; a instalada permanece beta.7 e o percurso de fonte real na GUI beta.8 não foi executado. O [registro de verificação](docs/lume-soft/VERIFICACAO.md) identifica os resultados e limites deste corte. Consulte o [estado da entrega](DONE.md).

Este repositório começa com um snapshot curado, sem ancestralidade Git. O histórico detalhado anterior permanece preservado no [repositório de origem](docs/ORIGEM.md).
