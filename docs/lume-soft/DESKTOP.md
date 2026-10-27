# Lume soft — coletor nativo, distribuição e barra de tarefas

Leitura e implementação delimitadas em 27/10/2026. Contrato em [CONTRATO.md](CONTRATO.md). O coletor, sua autorização e a integração no aplicativo pertencem à coordenação; este documento não declara tracking nativo ou fixação aprovados antes das respectivas provas.

## Builder do acompanhamento

`scripts/build-app-activity.mjs` exporta `buildAppActivity()` e `verifyAppActivity()`. O build aceita somente host Windows x64 e compila `native/app-activity/LumeActivity.cs` para `native/app-activity/bin/lume-activity.exe`. Não executa o helper. Usa o compilador Framework x64 local `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, fixado pelo SHA-256 `46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00`, igual ao padrão já usado pelos builders nativos existentes. Não instala compilador, troca runtime ou altera proteção.

O manifesto contém exatamente `schema:1`, `platform:win32`, `arch:x64`, `file:lume-activity.exe`, `sha256` e `sourceSha256`. A compilação usa C# 5, otimização, avisos como erros e referência padrão a System.Web.Extensions. Fonte e compilador são conferidos antes/depois; o destino anterior só é substituído se seu manifesto/binário forem coerentes e permanecerem inalterados durante a compilação. Staging é exclusivo por invocação. Links, hardlinks de arquivos e pares incompletos são rejeitados; saída incerta é preservada. O build não assina o executável nem comprova que o Windows permitirá sua execução.

`verifyAppActivity({root,verifySource:true})` confere manifesto, bytes do executável e fonte no layout acima. `root` precisa ser absoluto e o padrão é a raiz do repositório. Para pacote que não distribui o C#, `verifySource:false` mantém a conferência do binário, manifesto e caminhos; apenas omite a comparação com a fonte ausente. Um manifesto local não é assinatura de autenticidade nem autorização para executar um arquivo desconhecido.

Comandos:

```text
node --test test/lume-soft-build.test.js
node scripts/build-app-activity.mjs
```

Os sete testes dirigidos passaram e foram repetidos pelo revisor independente: corrupção de binário, fonte alterada/ausente, campos/plataforma/hashes inválidos, traversal no manifesto, pares incompletos, tipos de caminho, hardlinks/junction e plataforma/arquitetura incompatíveis. Os bytes de prova são explicitamente sintéticos e nunca executados. Sintaxe do builder e diff-check passaram.

A primeira tentativa real revelou uma exigência excessiva do builder: o csc do Windows possui dois hardlinks de servicing, embora seus bytes coincidam com o hash fixado. A correção limitou a exceção ao compilador; fonte, helper e manifesto continuam exigindo um link. Não foi bloqueio de execução do Windows. A compilação seguinte passou e `verifyAppActivity()` confirmou helper SHA-256 `128e31582eb1fd38f615a6fd7ef6842305e4e3547ced207a171f286dba95cd51`, fonte SHA-256 `81dc6123ca4556f5e61fcaef230462ec4200b597dec72c692d20e34e15d3870f`. A revisão independente aprovou o builder no escopo verificado, sem executar o helper.

Uma única chamada real por `criarColetorApps().coletar()` em 27/10/2026 05:42:13 UTC retornou `inativo`, somente o campo `estado`, em 146,88 ms. Nome de aplicativo não foi impresso; nenhuma entrada do usuário foi simulada. Recibo privado `work/lume-soft-20261027/native-activity-single-sample.json`. Isso comprova execução e retorno factual de inatividade, não identificação de um aplicativo ativo nem duração acumulada real. O ensaio sintético de UI/controller é separado.

## Integração e beta.8

O produto anterior não possui coletor foreground nem dependência active-win/FFI/Koffi. A integração deve usar o lifecycle existente de `desktop/main.cjs`, invalidar resultados em voo na pausa/revogação e encerrar o helper antes de concluir saída. `powerMonitor` do Electron oferece suspensão, bloqueio e ociosidade, sem ler teclas. A companhia mantém `showInactive`, janela fora da barra e preferência independente do acompanhamento. Fonte oficial: [powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor), consultada em 27/10/2026.

As APIs mínimas estudadas são [GetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow), [GetWindowThreadProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid) e [QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew), consultadas em 27/10/2026. O caminho completo obtido pela última API deve ser reduzido dentro do coletor ao identificador permitido; título, documento, URL, conteúdo e teclas ficam fora do contrato. Janela ausente e acesso negado precisam produzir indisponibilidade, sem escalonamento.

A versão técnica proposta é `3.2.0-beta.8`, maior que a beta.7 instalada; a comparação pelo módulo existente foi executada somente leitura. Nome comercial permanece Lume 1.0, appId `com.readyworks.assessor` e perfil AssessorDesktop. A coordenação sincroniza package.version, extraMetadata.version, dois campos do lock e manifesto MCP. Novo helper/manifesto precisam entrar explicitamente nos arquivos Windows e unpacked, e o hook deve chamar o builder. O NSIS mantém o filtro BCJ já verificado; `--prepackaged` exige a variável explícita porque não executa beforePack. Novo build requer freeze, inspeção de fontes/ASAR/recursos, candidata isolada e instalação normal com recuperação.

## Fixação oficial: capacidade e limite atual

A documentação Microsoft de [fixação na barra de tarefas](https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/pin-to-taskbar), consultada em 27/10/2026, informa remoção da restrição Limited Access Feature a partir de KB5074105, builds 26200.7705/26100.7705. A leitura local registrou Windows 25H2, build 26200.9711. A chave `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModel\LimitedAccessFeatures\com.microsoft.windows.taskbar.pin` existe, mas não contém o valor seed publicado; pelo algoritmo documentado isso não exige token. Não foi alterado o registro.

Ainda precisam ser consultados suporte desktop de TaskbarManager, `IsPinningAllowed` e estado atual. A solicitação exige aplicativo em primeiro plano, entrada no Menu Iniciar e aprovação no diálogo do sistema. Não é API de fixação silenciosa; a Microsoft orienta não chamá-la pelo instalador. Resultado verdadeiro da API e nova leitura do estado são necessários para declarar sucesso. Não se chamou a API nem se automatizou sua confirmação.

O [sample oficial TaskbarManager](https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/TaskbarManager/README.md) contém versões C++/C# desktop com e sem identidade de pacote. Seu aviso histórico de token obrigatório não substitui a documentação atual por versão do Windows. A consulta local não encontrou Windows SDK no caminho padrão nem dotnet/cl/msbuild no PATH; isso não prova ausência de outras instalações, mas o csc Framework usado no tracking, sozinho, não comprova capacidade de compilar o sample WinRT.

Proposta delimitada para investigação posterior: um executável separado pode primeiro consultar capacidade/estado, sem credenciais, rede ou perfil do Lume. Deve usar o sample e APIs públicas, possuir vínculo verificável com a identidade correta e distinguir sua própria identidade da aplicação Lume. Não há prova ainda de que um processo auxiliar independente possa solicitar a fixação do executável instalado em nome dele. Se isso exigir integração no processo de UI, uma ponte nativa própria será necessária. Não fabricar AUMID, usar verbos de shell não documentados ou escrever diretamente os dados da barra como substituto dessa validação.

Sob a proibição vigente de mouse, teclado e foco global, a confirmação nativa não pode ser simulada. A alternativa funcional atual continua sendo acesso pelos atalhos existentes, sem chamar isso de fixação. A recusa anterior de `shortcut-launch-05.ps1` permanece: aquele helper não executou e não será chamado por Bypass, inline ou outro host. A autorização de fixação não remove essa barreira. Nenhum atalho foi lançado ou alterado nesta investigação.
