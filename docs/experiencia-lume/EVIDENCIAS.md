# Lume vivo — implementação e evidências

Implementado localmente no checkout do produto. A versão instalada, o aceite de utilidade por Fabrício, macOS e hardware de 8 GB permanecem gates próprios. Nenhuma mensagem externa foi enviada neste sprint; nenhum modelo remoto, Jev, hospedagem ou captura do PC foi habilitado para demonstrar a interface.

## Resultado observável

Agora, Memória, Comercial, Entregas e Pessoas compartilham fontes e identidades existentes. Busca global e filtros, detalhe revalidado, classificação/vínculo, resposta pendente e acompanhamento confirmado usam os serviços atuais. Os quatro grupos de Ajustes incluem preferências de tema, movimento e companhia; som começa desligado. O companheiro mostra um assunto por vez, abre o contexto, adia e pausa sem alterar o atendimento.

A projeção é de leitura, sem novo CRM, fila ou migração de banco. Enviado e aceito não são inferidos; ausência de dados e de dependências é explícita. A busca textual permanece local; recursos sem conexão/modelo não simulam respostas semânticas.

## Provas executadas

| Prova | Resultado e limite |
|---|---|
| Inventário | 283 arquivos, 156 rotas, 58 assets; telas estáticas e destinos dinâmicos descritos; zero problemas no `--check`. Contagens não equivalem a percursos testados. |
| Dirigidos independentes | 45/45 no gate persistido, incluindo 13 casos independentes de segurança; 56,792s, zero falhas/cancelamentos/skips. O ajuste final Comercial acrescentou um caso e repetiu o arquivo de UI: 16/16 pela coordenação e pelo revisor (12,672s). |
| Integração HTTP + SQLite | Seis percursos independentes passaram: abertura, detalhe/fonte, busca, filtros,1024×768 e teclado; dados fictícios, sem serviços externos. Um404 esperado de Novidades registra capacidade ausente no harness. |
| Windows Electron | Seis percursos passaram, zero erro de script: primeiro acesso sem conexão, nota/busca literal, Relações/lista, companhia pausada,1024×768 e zoom nativo200%, reinício. Perfil temporário, Electron44.4.1, Node24.21.0. |
| Acervo real | Cópia consistente de 360.601 eventos em leitura; seis telas, detalhe e fonte real passaram, sem erro JS, POST, rede externa ou alteração SQLite. Original aberto somente leitura, nenhum worker ou conector iniciado. Capturas privadas no parecer. Isso não comprova versão instalada. |
| MCP e Relações | Cinco contratos de leitura preservados; revisão repetiu20/20casos de MCP+grafo. |
| Arte | Três chamadas reais GPT Image: identidade, cinco telas nos dois temas, companhia. Conteúdo fictício. PNGs conceituais e prompts em ARTE.md; UI final usa DOM/SVG acessíveis. |

[Revisão independente e gates finais](REVISAO.md): aprovado para o checkout local revisado, sem achado bloqueante aberto. [Critérios técnicos arquivados](DONE-20261026.md). [Detalhes operacionais](OPERACIONAL.md), [fundação](FUNDACAO.md) e [companhia](COMPANHIA-IMPLEMENTACAO.md).

Provas privadas: `work/experiencia-lume-20261026/`, incluindo `native/resultado.json`, screenshots nativos, `e2e-result.json`, `review-acervo/`, `review-directed-final.txt` e logs de regressão. Conteúdo real de conversa não foi adicionado ao Git.

## Falhas encontradas e corrigidas

1. O detalhe consultava a permissão separada de Resolver mesmo sem execução e recebia409, ocultando a fonte legível. Reproduzido; a consulta agora ocorre só quando existe execução, preservando a ACL.
2. O bootstrap podia navegar antes de carregar o módulo Agora. Confirmado no acervo real e reproduzido atrasando o asset700ms; agora aguarda `DOMContentLoaded`. A segunda execução integrada passou.
3. Títulos reais extensos e cabeçalho duplicado tornavam a tela longa demais. Título do cartão limitado visualmente, nome acessível integral, cabeçalho único; assunto completo no corpo do detalhe.
4. A rota de acompanhamento herdava uma lacuna do serviço: aceitava fonte de pessoa excluída. O serviço agora recusa, o loop ignora registros anteriores e o resumo omite essas pessoas. A consulta assíncrona também revalida a fonte, ação, política e registro antes de agendar qualquer aviso, cobrindo exclusão durante a espera. Revisão independente mantém a prova RED;38/38casos do ciclo e ações passaram após a correção.
5. O gate anterior567 tinha uma expectativa de preferências antiga. Atualizada para os campos aditivos exatos; asserções de privacidade/persistência preservadas. Primeira rodada: 566 PASS/1 FAIL; repetição: 567/567 PASS, zero falhas/cancelamentos/skips,161,137s. O delta posterior de revalidação após consulta foi repetido separadamente.

## Desempenho e recursos

Baseline preservado da UI anterior. A comparação independente usou o mesmo backend e máquina, Edge headless novo em três rodadas: abertura mediana 1.331 → 1.274 ms (-4,3%); Agora 251 → 46 ms. Memória, Ajustes e busca apresentaram aumentos percentuais acima de 10% na primeira rodada, de 4–14 ms, e foram investigados.

A investigação alternou UI anterior/atual doze vezes por rota e mediu CDP/HTTP: Memória 37,9 → 33,4 ms (-11,9%); busca 23,7 → 24,8 ms (+4,6%); Ajustes 8,5 → 10,1 ms (+18,8%, +1,6 ms), sem HTTP e com layout 0,756 → 0,752 ms. O resíduo de Ajustes está registrado, sem indicar gargalo de rede; o parecer conserva ambas as rodadas e limites da amostra. Máquina Windows/i7-12650H/~32 GB de RAM; não representa 8 GB.

Ensaio delimitado com `ContextoApp.receber`, SQLite em memória e atualização do companheiro:1000mensagens fictícias, zero falhas,1.306ms no total, pico RSS84,2MiB do processo, maior projeção do companheiro13,8ms. Não inclui transcrição, inferência, rede ou renderer. Medição nativa com companhia ativa registra separadamente RSS do processo principal; não equivale ao consumo total do Electron. Não extrapolar suporte de hardware.

## Comandos reproduzíveis

```powershell
node scripts/inventario-experiencia.mjs --check
node --test --test-concurrency=1 --test-timeout=180000 test/experiencia-*.test.js
node test/experiencia-lume.e2e.mjs
node test/experiencia-native.e2e.mjs
node --test --test-concurrency=1 --test-timeout=180000 test/pessoal-*.test.js test/telegram-*.test.js test/autorizacao.test.js test/contexto-app.test.js test/socket.test.js test/desktop.test.js test/segredos.test.js test/clareza-dia.test.js test/nomes-conversa.test.js test/contatos-desktop.test.js
```

## Proveniência e preservação

Origem847c24e, branch `feat/lume-06-context-cycle`. Patch/estado anteriores preservados antes da escrita. Commits8cc010d(contratos/arte),035df10(implementação),f4589dd(exclusão),14941ad(revalidação após consulta) e00591ad(etapa comercial confirmada/avaliada). Em cinco arquivos já alterados, o índice foi construído por comparação de três versões para gravar somente o delta deste sprint; o working tree anterior foi preservado. Atualizações de STATUS/STATE também entraram no índice sem incluir alterações anteriores. Gates se referem ao checkout integrado, que inclui trabalho anterior ainda não commitado.

Run Orca `run_b9775c3c3689`; inventário `ctx_bf19aab689a0`, fundação `ctx_13645e193127`, telas `ctx_32a4d6f59bb0`, companhia `ctx_c1e2266389ca`, revisão `ctx_bf224b4f6ed5`. Chamadas reais com recibos do runtime, Astra/high conforme política vigente. GSD recuperado sem reinicialização; fase10 segue vigente. JEV não foi chamado; essa cobertura não é alegada.

## Limites de aceite

Execução nativa macOS, teste físico em8GB, percepção sonora humana, leitor de tela, instalação/assinatura/distribuição e aceite de utilidade continuam sem prova específica. Captura avançada de aplicativos/PC e operação remota contínua são especificações para corte posterior. A revisão visual e estrutural de macOS não equivale a execução nativa.
