# Backend Lume 1.0 — mapa e revisão independente

Data: 26/10/2026. Escopo: fila, organização, fontes, autorização, correções e avaliação. Estado: mapeamento concluído; implementação e revisão final em andamento. Não houve acesso a credenciais, envio externo, Jev ou alteração da fonte do produto por este revisor.

## Contratos reutilizáveis

| Responsabilidade | Fonte | Consequência |
|---|---|---|
| Identidade da fonte e deduplicação | `src/banco.js:39`, `eventos`, UNIQUE(conversa_id,origem_id) | Reprocessamento não cria uma segunda fonte; autor e conversa são campos diferentes. |
| Fila durável | `src/banco.js:58`, `etapas` | PK(evento_id,etapa), estados pendente/em_curso/concluida/falha/desistida, tentativas, assinatura e lease. A nova etapa deve reutilizar esta tabela. |
| Assistência existente | `src/pessoal/servico.js:201`, `:479` | `running` serializa o serviço pessoal; organização precisa coordenar o acesso ao mesmo ChatGPT. Assistência também pode notificar/enviar e não deve ser usada como atalho de avaliação. |
| ChatGPT próprio | `src/pessoal/chatgpt.js:281` | Responses com `store:false`; callback `validar` antes do despacho. O consumidor precisa revalidar após o await antes de persistir. |
| ACL local/remota | `src/pessoal/contexto.js:12`, `src/leitura-sql.js:25` | Remoto exige LEITURA_SQL e autorização exata em desktop_ia_conversas. LEITURA_PESSOAL_SQL sozinho permite terceiros locais em grupos e não autoriza envio ao modelo. |
| Política pessoal | `src/pessoal/politica.js:14`, `:52`, `:89` | Remoto, exclusão e identidade exata separados de envio. Grupo nunca ganha envio por autorização de DM. |
| Ações e correção | `src/acoes-lume.js:247`, `:295` | Citação literal, assinatura, chave estável e histórico; registrar novamente respeita correção manual existente. |
| Organização atual | `src/pessoal/organizacao.js:24`, `:49`, `:120` | Projeção sobre ações/classificações/projetos. Só aceita origem Jev/manual e criação automática só para notify atual. Não cobre histórico sem extensão. |
| Projeto e fontes | `src/projetos-comerciais/esquema.js:12`, `src/projetos-comerciais/index.js:213` | Projeto rascunho, fonte/trecho com assinatura, invalidação persistente e timeline paginada. Inferência não confirma acordo, execução ou aceite. |
| Correção comercial | `src/vendas/servico.js:166` | Registro manual local separado, com fontes/revisão. Nova inferência não pode apagar a decisão manual. |
| Tags existentes | `src/comandos-whatsapp.js:274`, `:280` | Catálogo e vínculos ligados a comandos de origem. Não fabricar comandos do dono para gravar sugestão automática. |
| Avaliação existente | `src/pessoal/avaliacao-runtime.js:11`, `src/pessoal/avaliacao.js:25` | Recibo único, digest de conteúdo, revisão explícita e aceite separados. Usa 100 casos fictícios; não comprova qualidade em conversas reais. |

`src/laya/fila.js:18` usa `lume_laya_fila`, outra fila específica do motor local. `src/pessoal/classificador.js:8` usa etapas, mas é vinculado ao Jev e seu orçamento. Nenhum desses motores deve ser ativado para cumprir o pedido ChatGPT.

## Extensão mínima acordada

`src/pessoal/organizador.js`, classe `OrganizadorConversas`, etapa `organizacao_chatgpt`. Resultado JSON em etapas, cursor/estado/correções em desktop_config, vínculos de projeto e ações nos serviços existentes. Priorizar novos/30 dias, depois histórico limitado com cursor persistido. Uma requisição por vez, assinatura de fonte e autorização conferidas antes/depois, pausa factual e retomada quando a conta indisponível voltar.

Contrato de extração: assuntos, tags, vínculos (projeto/organização), oportunidades, compromissos e acontecimentos. Todo item tem citação literal única e confiança mínima; arrays vazios significam abstenção. Pessoa/grupo são identidades da fonte, não nomes inferidos. Sugestão não é cadastro confirmado. Correção total de tags por conversa prevalece, inclusive se chegar enquanto o modelo está respondendo.

## Evidência privada anterior e avaliação necessária

`work/pessoal-qa-20261026/avaliacao100-rodada2-revisada.json` preserva 100 execuções/revisões, 97 aprovadas, 20/20 críticas, aceite/liberação falsos. `docs/pessoal/2026-10-26/IMPLEMENTACAO.md:22` e o aviso de `avaliacao.js` identificam explicitamente o corpus como fictício. Portanto, o termo “real” dos relatórios significa execução no modelo real, não conteúdo privado real.

Não localizei corpus de conversas privadas já rotulado nos diretórios `work/pessoal-20261026` e `work/pessoal-qa-20261026`. A documentação aponta snapshot SQLite em `AppData/Roaming/AssessorDesktop/backups/pessoal-20261026`; não foi aberto nem validado por este revisor. A seleção deve ocorrer na cópia consistente autorizada, com leitura somente, sem ampliar a ACL por estar em uma cópia.

A prova nova precisa: (1) amostra estratificada com DMs/grupos autorizados, casos ambíguos/abstenção e mudanças; (2) rótulos independentes por evento/trecho antes da pontuação; (3) execução sequencial exclusivamente pelo ChatGPT conectado, sem iniciar assistência/Telegram/saídas; (4) recibos do provedor e hashes do contrato, fontes, resultado e revisão em work privado; (5) todas as referências/autorias/autorizações corretas e pelo menos 90% de categorias/vínculos corretos. Erro crítico de identidade, fonte ou autorização reprova, ainda que a média seja alta. A revisão deve manter abstidos e falhos no denominador adequado, sem escolher só acertos.

## Testes e veredito

Testes independentes em preparação em `test/lume-1-organizacao-review.test.js`: revogação e edição durante requisição; duplicação; concorrência; correção manual durante requisição e após reinício; retomada; grupo com ACL restrita e autoria; prioridade/cursor. Fixtures e respostas desses testes são explicitamente sintéticas e não aprovam o gate semântico.

Primeira rodada do módulo: 14/14 casos adversariais passaram, após corrigir apenas a fixture do revisor para inicializar o esquema Desktop completo (a exclusão depende de itens_crm). A primeira tentativa dessa fixture foi interrompida por aguardar indevidamente seu próprio modelo sintético após o erro de esquema; nenhuma instância do produto foi encerrada.

A revisão de código produziu três regressões novas, reproduzidas antes da correção:

- Resultado permanentemente recusado por citação inválida voltava à fila em cada varredura: quatro chamadas em quatro passos, esperado uma até fonte/autorização mudar.
- Resposta sem completed era persistida como concluída. O teste também exige modelo revisado e recibo único não vazio, com variantes separadas.
- Pausa durante a consulta assíncrona do estado da conta ocorria antes da criação do AbortController; ao retornar, o serviço ainda enviava uma requisição ao modelo. Esperado zero despacho após a pausa.

O caso HTTP independente passou: sessão/origem, leitura em readOnly sem escrita, bloqueio de correção em readOnly e ausência de endpoint público que aprove avaliação.

Após os três primeiros ajustes, repetição independente passou 18/19. Um quarto achado permanece na rodada intermediária: revogar a fonte e restaurar sua permissão original durante a chamada permite reaproveitar a resposta antiga porque o hash final coincide com o inicial. Mais dois testes confirmam o mesmo problema em `avaliarFonte` sem etapa de runtime, tanto para fonte como para autorização remota. A correção requer revisão monotônica da fonte/autorização; o cache existente `lume_projetos_revisoes(evento_id,versao)` foi apontado como mecanismo reutilizável. Evidência intermediária: `work/lume-1-20261026/backend-review-adversariais-intermediario.txt`.

Regressão independente do delta SAVEPOINT: `node --test --test-concurrency=1 --test-timeout=180000 test/acoes-lume.test.js test/projetos-comerciais.test.js test/projetos-comerciais-acoes.test.js test/pessoal-ciclo.test.js test/pessoal-organizacao.test.js`: **118/118 PASS**, zero falha/cancelamento/skip, 24.747 ms. Log `work/lume-1-20261026/backend-review-regressoes.txt`.

Baseline anterior ao módulo: `node --test --test-concurrency=1 --test-timeout=180000 test/pessoal-organizacao-review.test.js test/pessoal-contexto.test.js test/pessoal-chatgpt.test.js test/projetos-comerciais.test.js` terminou 52/53. A única falha foi o teste de ferramentas com deadline total de70 ms, que esperava cancelamento de stream mas pode expirar antes de abrir o stream sob carga. A repetição isolada com `--test-name-pattern='deadline total não renova'` passou 1/1 sem alteração de teste, código ou prazo. Isso não converte a primeira rodada inteira em aprovação.

Repetição após revisão monotônica de fonte e autorização: `node --test --test-concurrency=1 --test-timeout=180000 test/lume-1-organizacao-review.test.js`: **21/21 PASS**, zero falhas/cancelamentos/skips, 1.941 ms. Log `work/lume-1-20261026/backend-review-adversariais-final.txt`. Os quatro achados técnicos acima estão corrigidos neste corte. A fila usa revisão persistente além do hash, invalida token/resultado em edição ou mudança de autorização e protege a chamada avulsa de avaliação.

## Rótulos privados anteriores à avaliação

O snapshot privado novo foi aberto pelo revisor com `DatabaseSync(...,{readOnly:true})`: 360.601 eventos, 6 opt-ins remotos e zero etapa nova de organização naquela leitura. Não houve leitura de configuração de credenciais. A coordenação selecionou 100 fontes autorizadas, 70 por termos operacionais e 30 sem esses termos; a seleção tem zero grupos.

O revisor leu e rotulou as 100 fontes **antes de receber qualquer output**. Artefato privado `work/lume-1-20261026/eval-expectativas-review.json`, SHA256 `855a481e5028d281e07fdd3c8df05014ea499e83a9bd2c37af53570f9eb763e4`. São 20 casos críticos de identidade/fonte/abstenção e 23 fontes com extração operacional obrigatória. As demais admitem abstenção conservadora ou interpretação fiel sem completar contexto ausente. Não reescrever os rótulos depois de ver a resposta.

Limite material: maioria das fontes é fragmentária, lida isoladamente. O recorte mede precisão e abstenção dessa extração, não composição de contexto entre mensagens, cobertura de grupos reais nem aceite do dono. A ausência de grupos não autoriza ampliar opt-ins. Nenhum conteúdo privado foi incluído neste relatório ou no Git.

Veredito técnico deste corte: **APROVADO nos 21 adversariais e 118 regressões especificadas**. Avaliação semântica real e revisão da integração final permanecem **PENDENTES**. Não há declaração de aceite, instalação ou produto entregue.

## Integração posterior — revisão de 27/10/2026

O corte anterior permanece válido para seu diff. A nova projeção em `experiencia-lume.js` motivou provas adicionais sobre integração, sem repetir os118 casos anteriores sem causa.

`test/mcp-core.test.js`, `test/experiencia-projecao.test.js` e `test/experiencia-seguranca-review.test.js` passaram **32/32**, com os cinco nomes MCP de leitura preservados, objetos de entrada fechados, cursor/escopo, fonte opaca, revogação durante chamada e revalidação de derivados. Log `work/lume-1-20261026/backend-review-mcp-experiencia.txt`.

Os testes novos reproduziram antes dos ajustes:

- Autorização base `ignorar → observar` durante chamada não invalidava a resposta antiga; trigger de `autorizacoes` corrigiu essa lacuna.
- Edição de fonte mantendo nome/trecho de projeto colidia com idempotência antiga e ficava em falha; criação por fonte atual passou após ajuste.
- Correção de vínculo escondia o projeto anterior no JSON, mas seu filtro SQL ainda selecionava a fonte; filtro e projeção foram corrigidos.
- Experiência mantinha vínculo e tags automáticos após correção manual; as projeções corrigidas passaram.
- Timeline não carregava compromisso durável, resumo corrigido e estado atual. A projeção dos registros existentes passou após ajuste.

Rodada intermediária posterior: **28/32 PASS**, quatro falhas explícitas em `backend-review-integracao-r2.txt`: corrigir resumo de ação e reextrair duplicou projeto por usar uma revisão que também muda com ação; projeto manual local era ocultado por revogar apenas permissão remota; paginação interrompia em100 projetos; correção de um trecho ocultava também outro projeto independente na mesma mensagem. Nenhum teste foi relaxado para eliminar esses achados.

Adicionalmente, o teste de integração MCP da nova ação revelou retorno vazio para `lume_listar_pendencias` mesmo com fonte legível e escopo MCP explícito. A consulta ainda exige a linha legada `lume_acoes_conversas`, enquanto o organizador registra ações locais pela autoridade atual. A correção deve manter `LEITURA_SQL`, escopo MCP e revalidação, sem criar consentimento fictício.

Repetição independente após os ajustes: **33/33 PASS**, zero falhas/cancelamentos/skips, em `backend-review-integracao-r3.txt`. O organizador reutiliza o projeto exato ainda válido, preserva projetos manuais sob revogação apenas remota, pagina além de100, corrige vínculos por intervalo e mantém os outros trechos. A timeline inclui compromisso durável, resumo corrigido, confirmação/resolução, histórico e estado de execução, removendo a fonte revogada. O MCP usa a autoridade atual com `LEITURA_SQL`, escopo externo e revalidação preservados.

Regressão independente dirigida ao delta: `node --test --test-concurrency=1 --test-timeout=180000 test/mcp-core.test.js test/projetos-comerciais.test.js test/experiencia-projecao.test.js test/experiencia-seguranca-review.test.js`: **44/44 PASS**, zero falhas/cancelamentos/skips, em `backend-review-mcp-experiencia-final.txt`. Os cinco contratos MCP de leitura permanecem fechados e cobertos. As118 regressões anteriores não foram repetidas sem nova causa.

Veredito da integração neste checkpoint: **APROVADO nos gates técnicos especificados**. A avaliação semântica real permanece **PENDENTE** e os rótulos privados permanecem intactos. Nenhuma instância Electron foi iniciada por este revisor; o resultado não declara instalação, aceite ou qualidade real do modelo.

## Revisão independente do wrapper de build — 27/10/2026

Leitura de `scripts/lume-1-build.mjs`, configuração electron-builder, hooks e gate de release. O wrapper exige Windows x64, versão exata do Electron e hash do ZIP contra checksums do pacote instalado; compara os arquivos locais com o ZIP e as cópias isoladas novamente. Usa diretórios únicos, `shell:false`, `--publish never` e preserva o gate candidate (atualizações desligadas/feed nulo). O revisor não executou o wrapper nem a build.

Dois defeitos reproduzidos em `test/lume-1-build-review.test.js`: alterar o executável ACL em `app.asar.unpacked` era aceito; alterar a fonte de dependência JavaScript depois de criar o ASAR também era aceito. O verificador pulava `info.unpacked` e toda a árvore `node_modules`, mas declarava `integrityVerified/sourceVerified` verdadeiros. Rodada independente inicial: **0/2 PASS**, ambas com `Missing expected exception`. Os testes usam somente arquivos temporários sintéticos.

Outros limites comunicados à coordenação: links não podem ser ignorados silenciosamente; `package.json` precisa validar metadata esperada apesar das transformações do builder; recursos externos de áudio exigem verificação própria ou declaração explícita do escopo do recibo. O comentário de imutabilidade de `node_modules` não descreve o processo inteiro, pois `beforePack` chama o patch Baileys existente e os geradores nativos.

Veredito do wrapper neste corte: **REPROVADO**, aguardando correção e repetição dos testes independentes antes de construir candidata. Isso não altera a aprovação dos gates de integração acima.

Revisão do primeiro ajuste: os dois RED iniciais passaram, assim como metadata principal e conteúdo/conjunto de recursos externos. A leitura de `@electron/asar` revelou que `statFile` segue links por padrão; a fixture com link interno confirmou que a rejeição era ineficaz. A coordenação corrigiu para `statFile(...,false)` e o teste passou. O próximo teste usou o `createTransformer` real do electron-builder instalado e reproduziu uma rejeição indevida de pacote válido: metadata de dependências recebe limpeza normal, portanto não pode ser comparada byte a byte com o JSON bruto. Rodada intermediária: **7/8 PASS**; nenhuma build nativa foi executada para encontrar isso.

Repetição final independente após a correção de metadata: `node --test test/lume-1-build-review.test.js test/lume-1-desktop-build.test.js`: **8/8 PASS**, zero falhas/cancelamentos/skips, 913,8932 ms. O teste aceita a transformação produzida pelo builder instalado e rejeita alteração de `main` tanto no pacote principal como na dependência. Todos os arquivos do ASAR, inclusive dependências e unpacked, recebem checagem de integridade/fonte; links são rejeitados sem resolução; áudio extraResources recebe comparação de conjunto, tamanho e hash. A limpeza de metadata espelha a versão instalada do builder e preserva os campos executáveis. O comentário passou a reconhecer os hooks normais de preparação.

Veredito final do wrapper: **APROVADO para construir a candidata interna pelo fluxo revisado**. Esta aprovação cobre o código e os testes do wrapper, não comprova uma build ainda não executada, assinatura de release, instalação ou funcionamento da candidata. A build deve produzir os recibos e passar as verificações sem relaxá-las. O revisor não iniciou Electron nem executou binários nativos.

## Regressão MCP detectada pela suíte ampla — 27/10/2026

A coordenação informou622 testes,615 aprovados e7 falhos; este revisor investigou somente os três de MCP. A leitura identificou o novo import estático `src/execucao/projeto.js:5 → inventario-nativo.js`, ausente da lista fechada do empacotador MCPB. Um pacote real extraído falhou em import-only com `ERR_MODULE_NOT_FOUND`, antes de iniciar broker, ACL ou processo nativo. Prova: `work/lume-1-20261026/review-mcp-import-only.json`. As três falhas originais foram reproduzidas dirigidamente: **0/3 PASS**, log `backend-review-mcp-regressao-red.txt`.

A coordenação acrescentou o módulo já existente na lista do MCPB, preservando os cinco contratos de leitura. O revisor acrescentou `test/lume-1-mcp-package-review.test.js`, que extrai o pacote e importa o grafo sem chamar o launcher nem `startFromEnvironment`. Esse teste passou. A mudança não inclui o helper de inventário nem autoriza sua execução; a correção resolve a dependência estática necessária à importação das ferramentas de leitura.

Repetição independente: `node --test --test-concurrency=1 --test-timeout=180000 --test-skip-pattern="builder lê ASAR físico real" test/mcp-package-broker.test.js test/mcp-desktop-integration.test.js test/mcp-self-test-broker.test.js test/lume-1-mcp-package-review.test.js`: **22/22 PASS**, zero falhas/cancelamentos,77.575 ms. Log `work/lume-1-20261026/backend-review-mcp-regressao-final.txt`. O teste que realmente inicia Electron para ler ASAR foi excluído explicitamente da seleção por causa do backup em andamento; não foi declarado executado. Os testes selecionados usam Node e helper ACL em perfis sintéticos, sem CLI relativa do Lume ou perfil pessoal real.

Veredito desse delta do empacotador MCPB: **APROVADO nos testes dirigidos**. Os três erros MCP da rodada ampla foram corrigidos e reprovados antes da correção. O resultado não transforma a rodada ampla original em615+7 aprovações nem cobre as quatro fixtures de maintenance tratadas pela coordenação.
