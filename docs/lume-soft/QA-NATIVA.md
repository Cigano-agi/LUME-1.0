# QA nativa da revisão soft

Estado em 27/10/2026, 05:58 UTC: baseline e interface atual passaram no Electron real em perfis sintéticos isolados. A baseline produziu sete capturas; a atual, onze capturas e 22 fluxos registrados. As quatro inicializações terminaram por saída normal observada no Windows; a consulta CIM final não encontrou Electron. A coordenação foi avisada de que a máquina estava livre para os próximos gates. Esta prova não aprova instalação beta.8, coleta de aplicativo ativo, fixação na barra ou comportamento de foco sem instrumentação.

## Provas separadas

1. **Coletor real:** uma amostra, pelo módulo de produção `src/atividade-apps-nativo.js`, após compilação e verificação do manifesto. Retorno `inativo`, 146,88 ms, sem exportar nome do aplicativo ou simular entrada. Recibo `work/lume-soft-20261027/native-activity-single-sample.json`. Não comprova captura de app ativo.
2. **Interface/controller sintéticos:** `test/lume-soft-native.e2e.mjs` inicia Electron real em perfil novo `lume-1-native-qa-soft-*`, com doze mensagens claramente fictícias. O endpoint de acompanhamento é interceptado pelo harness e usa a classe real `AtividadeApps`, SQLite exclusivo e coletor fictício `editor-ensaio.exe`. Isso prova o percurso visual com o controller, não o servidor de autorização nem a coleta nativa.
3. **Baseline visual:** `--baseline` serve HTML/JS/CSS/assets do painel diretamente do commit `2afaca9`. Electron e serviço são os atuais, com o mesmo seed sintético. É comparação de assets da UI, não execução do binário histórico nem comparação entre bancos reais. Os recibos identificam essa limitação.

O harness reutiliza a entrada de teste existente, que troca `show` por `showInactive` e suprime pedidos de foco. Essa instrumentação é declarada. Não prova o comportamento de foco do aplicativo empacotado sem instrumentação. Os controles são acionados por DOM/CDP no aplicativo isolado; o teste de Enter é enviado pelo CDP dessa janela, sem teclado global. Nenhuma aba, janela ou perfil pessoal é operado.

## Roteiro executado

- Temas claro/escuro, Agora/Memória/Ajustes a 1024 × 768 e ausência de overflow horizontal.
- Galeria com pelo menos doze expressões, rótulo explícito de prévia e estado correspondente; aceno lúdico finito e acessível por Enter.
- Som inicialmente desligado, observação de inícios de oscilador sem substituição do áudio, ativação/prévia e silêncio novamente persistido. Não declara audibilidade humana.
- Movimento reduzido e zoom nativo Electron de 200%, com captura de tela isolada.
- Acompanhamento: abrir, iniciar, amostrar cinco segundos fictícios, excluir aplicativo e apagar seus intervalos, pausar e reiniciar preservando configuração. Cada fluxo registrado contém no máximo cinco ações; não se soma digitação arbitrariamente a um clique fictício.
- Reinício preserva tema, movimento reduzido, som desligado e pausa/exclusão do controller sintético reconstruído a partir do SQLite de teste.
- Cinco amostras de RSS, working set e CPU do Electron antes/depois; nenhuma alegação de hardware de 8 GB, macOS ou melhoria causal sem comparação.
- Captura pela API Electron e saída normal verificada no Windows. A prova não depende de esperar indefinidamente pelos pipes do lançador Playwright; eventual falha de fechamento fica no recibo.

## Resultados e comparação

| Execução | Evidência em `work/lume-soft-20261027/` | Resultado |
| --- | --- | --- |
| Baseline corrigida | `native-baseline-05.log`, `baseline-4AuGwv/resultado.json` | PASS, sete capturas, duas inicializações e duas saídas normais |
| Interface atual | `native-current-01.log`, `current-BNSO5a/resultado.json` | PASS, onze capturas, 22 fluxos, treze expressões; sem erros JavaScript/HTTP registrados |
| Comparação | `native-comparison-05.json` | Cinco amostras por estágio; comparação válida apenas no idle inicial da mesma tela |

Na atual, foram exercitados temas claro/escuro, Agora/Memória/Ajustes, zoom de 200%, movimento reduzido, galeria de treze expressões, aceno por Enter, surpresa de três toques e constelação finita. O áudio iniciou desligado, teve ativação e prévia observadas pelo contador de osciladores e voltou ao silêncio, preservado no reinício. Isso não equivale a avaliação auditiva humana.

O controller sintético acumulou 5.000 ms, excluiu o executável fictício e seus intervalos, pausou e preservou pausa/exclusão no SQLite após reinício. Cada fluxo registrado teve entre uma e três ações, abaixo do teto de cinco. O coletor real permaneceu desabilitado no perfil do aplicativo (`realCollectorEnabledInProfile: false`). A remoção dos intervalos aqui foi causada pela exclusão do aplicativo; este percurso não exercitou o botão de apagar todo o histórico.

| Mediana do idle inicial | Baseline | Atual | Diferença |
| --- | ---: | ---: | ---: |
| RSS do processo principal | 139.419.648 bytes | 138.858.496 bytes | −0,40% |
| Working set agregado | 586.364 KiB | 584.816 KiB | −0,26% |
| CPU agregada reportada pelo Electron | 0,0897% | 0,0505% | Variação em idle; sem atribuição causal |

Não houve aumento superior a 10% nesse recorte comparável. Cinco amostras em idle não são benchmark de carga nem estimativa estatística de ganho. Os estágios depois das interações mostram páginas e percursos diferentes e não sustentam comparação controlada. A máquina observada tem Intel Core i7-12650H e aproximadamente 32 GiB de RAM; não há prova de hardware de 8 GB ou macOS. Os tempos de abertura atuais foram 1.880 e 2.181 ms; são tempos deste ensaio instrumentado, sem promessa de desempenho da versão instalada.

Foram lidas visualmente as capturas críticas: Agora claro de ambas as versões, Agora escuro atual, galeria atual, zoom 200% de ambas, acompanhamento ativo sintético e pausa após reinício. Textos e estados ficaram legíveis, com rolagem vertical esperada e sem overflow horizontal detectado pelo harness. A captura a 200% mostra um recorte ampliado da página, não todos os controles simultaneamente. A revisão independente da execução final fica a cargo da coordenação.

## Falhas preservadas e causa do harness

As quatro tentativas anteriores continuam em seus diretórios; nenhuma foi convertida em PASS:

- `baseline-FiS0I5` / log 01: reload expirou em 15 s; o mapeamento antigo não cobria `/app`. O diálogo de encerramento do núcleo foi observado durante a limpeza; esse fato sozinho não estabelecia a causa do timeout inicial.
- `baseline-DRnhgl` / log 02: `new URL(page.url())` encontrou URL vazia, antes de completar a navegação inicial.
- `baseline-Myl9tX` / log 03: esperar apenas `DOMContentLoaded`, já com `/app` mapeado, ainda permitiu reload precoce e timeout. O fechamento restrito à janela própria foi registrado como recuperação do ensaio, sem aprovar essa execução.
- `baseline-Zdjtu5` / log 04: antes de qualquer reload, a verificação nativa encontrou `webContents.isLoading() === true`, apesar de o estado de load do Playwright já ter sido aguardado. A asserção falhou e a saída foi normal.

A coordenação identificou a corrida com `desktop/main.cjs`: a inicialização aguarda `loadURL('/app')`; recarregar antes de essa Promise terminar pode abortá-la, encerrar o núcleo e abrir um diálogo síncrono. A correção ficou somente no harness: aguardar `did-finish-load`/`did-stop-loading` enquanto `isLoading()` for verdadeiro, rejeitar falha real de navegação, dar uma volta adicional ao event loop e validar `/app`, `readyState: complete` e `loading: false` antes de instalar rotas e recarregar. O teto continuou em 15 s. Baseline 05 e atual passaram com essa barreira, confirmando a correção da recarga precoce no ensaio; não houve mudança de produto para acomodá-lo.

## Reprodução após coordenação de carga

```text
node test/lume-soft-native.e2e.mjs --run --baseline
node test/lume-soft-native.e2e.mjs --run
```

Sem `--run`, apenas informa que está preparado e encerra sem abrir Electron. Cada execução cria diretório novo `work/lume-soft-20261027/baseline-*` ou `current-*`, com capturas e `resultado.json`. Não repetir medições sem regressão material ou novo gate coordenado. Falhas e diretórios anteriores são preservados; não se altera limite ou produto para fabricar aprovação.
