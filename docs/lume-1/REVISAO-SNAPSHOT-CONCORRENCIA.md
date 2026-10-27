# Revisão independente — concorrência do snapshot

Veredito: **APROVADO** para executar o procedimento em destino novo, respeitando as autorizações e o processo parado exigidos pelo próprio script. Não confirma que o snapshot real já foi concluído.

Data: 27/10/2026. Território revisado: `scripts/snapshot-lume-profile.mjs`, diff contra HEAD e fonte integral. SHA-256 conferido: `d64139f92bd37ac6778ec24a75e5e6680c55e97efe8a5c76b4d63774fd24c2e3`. O revisor não escreveu código de produção nem iniciou Electron ou snapshot do perfil real. A intervenção anterior interrompida e seu destino parcial foram relatados pela coordenação, não inspecionados nesta revisão.

## Conclusão técnica

A alteração limita a 16 os trabalhos independentes nas etapas de stat, cópia/hash, verificação e ensaio. Os resultados são armazenados pelo índice original; inventário e manifesto continuam na ordem determinística. A primeira falha impede que os workers retirem novos itens e aguarda a conclusão/fechamento dos trabalhos já iniciados antes de rejeitar.

Comparado ao baseline, não foram removidas nem enfraquecidas as verificações de identidade/stat antes/depois da leitura, tamanho, SHA-256, symlinks/hardlinks, cadeia de diretórios, abertura exclusiva dos destinos, fsync, ACL privada, separação dos três paths, destino fora do Git, checagens processProbe, estabilidade do inventário, ensaio de restauração ou gate final do receipt. Destino parcial não é apresentado como concluído quando uma etapa falha.

Não identifiquei bloqueio novo no diff. A limitação de 16 refere-se a trabalhos por lote; um trabalho de cópia pode manter descritores de origem e destino simultaneamente. Não houve medição do perfil real de 275.193 arquivos/5,89 GB nem extrapolação de tempo total ou consumo em máquina física de 8 GB.

## Provas repetidas pelo revisor

`node --test --test-concurrency=1 --test-timeout=180000 test/snapshot-lume-profile.test.js`: **8/8 PASS**, zero skips/cancelamentos, 15,1 s. Inclui WAL SQLite restaurável, adulteração, processo indisponível/retomado, mutação da fonte, sobreposição, destino existente, Git, junction e symlink.

`node --test --test-concurrency=1 --test-timeout=180000 test/snapshot-lume-profile-review.test.js`: **3/3 PASS**, zero skips/cancelamentos, 16,2 s.

- 65 trabalhos com término controlado em ordem invertida: pico de 16 e resultado na ordem original.
- Falha de um dos primeiros 16: nenhum trabalho novo começou; a chamada permaneceu pendente até os outros 15 terminarem; retornou a falha original sem sucesso prematuro.
- Snapshot e restauração de 81 arquivos sintéticos com tamanhos diversos: todos os bytes/hashes e a ordem do manifesto foram conferidos; alteração do último arquivo foi rejeitada por hash.

Os dois primeiros casos isolam, sem modificação, a função privada do arquivo real para controlar as conclusões de maneira determinística. O terceiro usa a API completa, incluindo diretórios privados e persistência. `git diff --check` também passou.

## Limites do parecer

A aprovação é da mudança de concorrência e dos gates executados. Snapshot real, recibo final, ensaio real, estado do processo no momento da execução e integridade dos dados pessoais continuam sendo comprovados pelo procedimento autorizado da coordenação. Não foi concedida autorização nova para fechar aplicativo, substituir perfil ou instalar release.
