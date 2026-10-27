# Revisão independente — snapshot por arquivo único

Data: 27/10/2026. Veredito: **APROVADO para execução coordenada no escopo autorizado**, após a correção descrita abaixo. A revisão não executou snapshot do perfil real nem interrompeu a cópia anterior.

## Código e contrato revisados

`scripts/snapshot-lume-archive.mjs` cria arquivo 7z sem compressão e ensaia restauração integral em diretório novo. `scripts/snapshot-lume-profile.mjs` recebeu somente exportações das guardas já existentes: caminhos absolutos e normalizados, proibição de sobreposição/Git, ACL privada, processo parado, inventário sem links/hardlinks e estabilidade por identidade/tamanho/mtime/ctime.

O executável 7za está fixado por SHA256 `223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3`. A revisão comparou seus bytes com o executável dentro do arquivo oficial já instalado, cujo SHA256 `be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3` coincide com o pin do electron-builder local. Metadados sem segredos em `work/lume-1-20261026/review-7za-toolchain.json`.

A implementação exige o conjunto exato de arquivos e diretórios nos hashes nativos e na listagem técnica do arquivo antes de extrair. A restauração recebe novo inventário e SHA256 por arquivo, comparados com a fonte. Arquivo, manifesto e recibo são sincronizados; o arquivo durável é a fonte de recuperação, e o ensaio prova sua extração. O recibo só é escrito após as verificações. Nenhum hash/conteúdo do perfil real foi lido nesta revisão.

## Defeito reproduzido e correção

A primeira rodada terminou10/12. Uma falha era da expectativa do teste: a mutação mudava o tamanho e era corretamente recusada mais cedo pela listagem técnica. A fixture foi ajustada para alterar um byte sem mudar o tamanho, preservando o critério de recusa e ausência de recibo.

A outra falha era real: a última consulta de processos ocorria **depois** das verificações de estabilidade. Uma mutação da fonte durante essa consulta, retornando processo parado, gerava recibo `verified/rehearsed=true`. O teste reproduziu `Missing expected rejection`. A coordenação moveu a consulta para antes das duas verificações finais de estabilidade; o caso passou sem relaxar a expectativa.

Log RED preservado: `work/lume-1-20261026/backend-review-snapshot-archive-red.txt`.

## Prova independente final

Comando: `node --test --test-concurrency=1 --test-timeout=180000 test/lume-1-snapshot-archive.test.js`.

Resultado: **12/12 PASS**, zero falhas, cancelamentos ou skips,15.932 ms. Log: `work/lume-1-20261026/backend-review-snapshot-archive-final.txt`.

Cobertura:

- Roundtrip com Unicode, espaços iniciais, arquivos ocultos Windows, nomes com ponto, arquivo vazio e diretório vazio; hashes conferidos também pelo Node, independentemente do 7za.
- Processo ativo, consulta incerta e processo reiniciado antes de extrair.
- Destino existente/sobreposto, destino sob Git e ferramenta fora do pin.
- Hardlink, junction interna e raiz ligada rejeitados antes da cópia.
- Fonte alterada antes/depois dos hashes, alterada e restaurada, ou alterada durante a última consulta de processos.
- Arquivo compactado corrompido e restauração alterada depois do hash; ausência de recibo em falha.
- Parsers recusando traversal, duplicatas, contagem/conjunto divergente, cifragem inesperada e indicação de link na listagem técnica.

O piloto anterior confirmou inclusão de ocultos e diretórios com `h -r -scrcSHA256 -ba -sccUTF-8 .`, executado com `cwd` na raiz. A criação de symlink de arquivo foi negada pelo Windows; não houve aumento de privilégio para forçar essa prova. A cobertura real de junction e a recusa por `isSymbolicLink()` estão registradas, mas não equivalem a alegar criação bem-sucedida de file symlink.

## Limites da aprovação

A aprovação cobre código, guardas e fixtures sintéticas. O perfil real de275.193 arquivos ainda exige seu próprio recibo completo; o desempenho nesse volume não foi medido por este revisor. A cópia anterior continua sendo um destino parcial até prova contrária e deve ser preservada. A revisão não concede nova autorização para abrir aplicativos, restaurar sobre o perfil original, publicar ou enviar conteúdo.
