# Revisão independente do snapshot

Revisão em 27/10/2026. **APROVADO para curadoria e primeiro push ao repositório privado LUME-1.0**, no freeze descrito ao final. Fontes conferidas, oito arquivos de testes executados no snapshot e documentação revisada. Esta aprovação não declara instalação, aceite da beta.8, aprovação semântica ou conclusão da regressão completa. Os cortes intermediários abaixo preservam a sequência de provas e suas pendências à época.

O snapshot foi preparado a partir do commit `3d2ee026bcc3becabd85dfc31a4e9e9ee217cd5f` do repositório original, sem importar sua ancestralidade Git. O original e seu histórico permanecem preservados. O manifesto inicial declara 1.038 arquivos exportados; a conferência independente usou os objetos Git desse commit, os arquivos efetivamente presentes e os hashes/tamanhos do manifesto.

## Conferência realizada

- **954/954 arquivos de fontes, build, testes e ferramentas** nos diretórios `src`, `desktop`, `native`, `mcpb`, `api`, `central`, `bin`, `scripts`, `test` e `tools` conferem SHA-256 e tamanho do manifesto e correspondem aos bytes dos objetos Git indicados.
- Nenhuma fonte rastreada dos diretórios de produto `src`, `desktop`, `native`, `mcpb`, `api`, `central` e `bin` foi omitida.
- Dos 1.038 arquivos declarados no manifesto inicial, 1.034 eram byte a byte iguais ao commit na leitura. As quatro diferenças eram README, índice documental e os dois templates Python autorizados. Os documentos estavam em edição coordenada; isso será reavaliado no freeze final.
- O inventário naquele corte tinha 1.042 arquivos, incluindo quatro documentos novos de apresentação, origem e orientação. Não havia links simbólicos ou hardlinks, nem divergência entre os IDs Git declarados pelo manifesto e a árvore do commit.
- `vault-modelo/tools/mcp_server.py` e `vault-modelo/tools/whatsapp_index.py` tiveram os exemplos pessoais de comentários/docstrings generalizados no snapshot. A comparação por AST, removendo docstrings e ignorando posições de origem, foi **idêntica ao original nos dois arquivos**. A compilação sintática Python passou, sem executar os módulos ou gerar cache. Não se presume por isso teste funcional do template.

## Recorte de privacidade

Foram confirmadas as exclusões do corpus derivado de contexto empresarial real e de seu consumidor, do teste ligado a uma identidade pessoal e dos verificadores dependentes de auditorias históricas. Não foram importados perfis, bancos, credenciais, pastas de trabalho, planejamento histórico ou ancestralidade Git. Referências documentais a provas privadas não autorizam copiar esses destinos.

A varredura do recorte naquele momento examinou 1.023 arquivos classificados como texto e contou 19 binários. Procurou padrões de credenciais, nomes de arquivos sensíveis e marcadores conhecidos de procedência real. O único alerta foi o delimitador PEM no código de serialização de `src/mcp/broker-identity.js`: o módulo gera a chave em runtime; o arquivo não contém chave privada embutida. As exclusões conhecidas estavam ausentes.

Essa varredura é heurística e não prova ausência universal de informação privada. A seleção documental e a procedência dos assets complementam o scanner. Os metadados de avaliação, hashes e limites publicados não incluem as fontes privadas usadas nos ensaios. O inventário final deve representar os arquivos curados depois do freeze, pois o manifesto inicial descreve a exportação anterior às mudanças documentais e às duas curadorias Python.

## Pendências deste corte

1. Revisar o conjunto documental congelado e seus links, distinguindo provas disponíveis no snapshot de referências ao arquivo histórico preservado.
2. Gerar recibo final de inventário e SHA-256 de todos os arquivos, fora do export.
3. Ler os resultados dos testes executados efetivamente no novo checkout pela coordenação. Os gates do repositório original e a igualdade de fontes não substituem essa execução.

Nenhum navegador, aplicativo nativo ou teste de carga foi iniciado por esta revisão. Fora deste documento autorizado, o revisor não alterou arquivos do snapshot.

## Complemento — testes executados no snapshot e revisão documental

A primeira execução focal da coordenação preservou um resultado **45/46**: o teste do checkout real ainda comparava sua versão com a constante beta.6 usada nas fixtures. A correção revisada altera somente esse teste para obter a versão esperada do `package.json` do checkout. `assertVersionContract` continua exigindo as cinco representações alinhadas, versão válida e formato MCP 0.3; as fixtures beta.6 e os negativos permanecem. Essa é uma alteração de teste posterior ao commit de origem, a ser identificada no inventário final; não é alteração de produto.

Repetição independente, executada dentro deste snapshot: **46/46 PASS, exit 0, 2.269,8851 ms**, sem falhas, cancelamentos ou skips. Comando:

```text
node --test --test-concurrency=1 --test-timeout=180000 test/laya-annotations.test.js test/laya-authorized-eval.test.js test/lume-soft-ui-audio.test.js test/lume-soft-ui-motion.test.js test/main-broker-integration.test.js test/maintenance-main.test.js test/release-readiness.test.js test/release-version.test.js
```

O log `snapshot-focal-review-02.log` foi mantido fora do export. Esta execução cobre os oito arquivos listados, incluindo contratos de versão, fixtures de main, áudio/motion em VM e avaliação Laya sintética. Não é a regressão completa, nem inicia GUI, coleta de apps ou backup de perfil real.

Lidos os nove documentos congelados de apresentação, orientação, origem, marketing e experiência. A versão beta.8, o histórico independente e as pendências de instalação, avaliação semântica e push estão distinguidos corretamente neste corte. Na inspeção ampliada de 42 arquivos Markdown foram encontradas 130 referências locais: onze links de provas históricas em `work/` no relatório de pesquisa `SINTESE-FATOS-DIAGNOSTICO-2026-09-26.md` não são distribuídos; um exemplo de URL `/lume-vivo-icons.svg` corresponde ao asset servido pelo painel. Os demais destinos conferiram. Isso não sustenta uma declaração universal de zero links ausentes; não se devem copiar provas privadas para preencher essas referências.

**O gate focal do snapshot está aprovado.** Continuam pendentes o freeze final, seu inventário externo e os resultados restantes da coordenação. O resultado da regressão do repositório original será identificado separadamente, sem extrapolar cobertura para este checkout.

## Fechamento da curadoria para o primeiro push

O freeze final incorporou a qualificação das onze referências a provas históricas como texto, sem copiar seus destinos, e a nota de origem sobre a correção de teste `be17e53`. Esses deltas foram lidos independentemente. Nova verificação estática ampla: **42 arquivos Markdown, 118 referências locais verificadas, nenhum destino ausente**; um exemplo de URL de runtime foi classificado separadamente e corresponde ao SVG presente no painel. Referências textuais a artefatos históricos não distribuídos permanecem explicitamente identificadas.

O recibo externo `snapshot-review-final.json` registra o inventário completo, tamanho e SHA-256 de cada arquivo do snapshot congelado, incluindo este parecer, e a conferência contra o commit de origem. Ele permanece fora do export para não criar autorreferência nem incorporar provas privadas. Os dois templates Python têm apenas a curadoria textual com AST equivalente já comprovada; a única alteração de teste é a correção de versão revisada e exercitada nos **46/46 testes focais**. A fonte do produto permanece a do commit `3d2ee026bcc3becabd85dfc31a4e9e9ee217cd5f`.

**Liberado para inicializar o novo histórico e enviar este snapshot ao destino privado autorizado, preservando o repositório original e Actions desativado.** O push ainda precisa de seu próprio recibo remoto; esta revisão não o declara executado. Instalação, coleta positiva real, qualidade semântica, regressão completa, macOS, hardware de 8 GB e aceite mantêm seus critérios separados. Mudanças posteriores de estado ou conteúdo exigem novo complemento e recibo correspondente.

## Complemento 02 — segurança após o primeiro push

O recibo `github-first-push.json`, mantido fora do export, confirma o primeiro commit remoto **`f6405c5f7f608c9d482091e5e3606bfab12d9c80`**, branch `main`, repositório privado, Actions desativado e 1.043 arquivos. O inventário inicial permanece prova daquele corte. O presente complemento é posterior; seu envio ainda requer recibo próprio.

O delta técnico posterior altera **uma fonte de produto**, `desktop/segredos.cjs`, e **dois testes**: atualiza a contagem/exclusão do catálogo em `backup-acervo-v9.test.js` e acrescenta `lume-soft-cofre-cleanup.test.js`. A base `3d2ee026bcc3becabd85dfc31a4e9e9ee217cd5f` permanece a origem histórica; a exceção de segurança foi implementada pela coordenação no commit `14dd9f17fd3d8a3c9f4b58e23811d157f5be6b26` e revisada independentemente.

O cofre passa a limpar temporários cifrados em `finally`, preservar o destino anterior se o rename falhar e remover o temporário antes do arquivo definitivo. `unlinkSync` ignora somente `ENOENT`: erros de acesso não viram confirmação de ausência ou sucesso. A revisão identificou esse último risco no primeiro helper, houve reprodução RED e correção antes da aprovação. Os cenários são sintéticos; não houve acesso a credenciais reais e a causa do `EPERM` histórico continua indeterminada.

Conferência da cópia: na execução abaixo, os dois arquivos de segurança eram byte-idênticos aos arquivos revisados na origem. Depois dos testes, a coordenação substituiu somente os finais de linha da fonte do snapshot pelos bytes do objeto Git `14dd9f17`. A conferência independente confirma que a fonte final tem 6.611 bytes e é byte-idêntica ao objeto Git, SHA-256 `41164f5e73225833bfa0f569c9304678eaa3f9fa3739f6d8057f5a880f783c4f`. A representação efetivamente testada tinha 6.649 bytes, 38 CRLF e SHA-256 `b819c2ce656baad33397ae12faa4e1366dbb6217aaccdc34830255ff0301b2f5`; após normalizar CRLF para LF, é exatamente igual à fonte final. O novo teste também permanece byte-idêntico ao objeto do commit. A alteração exclusiva de EOL não muda comportamento; `vault-canonical-copy.json` registra a cópia canônica fora do export.

Repetição independente neste checkout: **47/47 PASS, exit 0, 4.820,8259 ms**, com 16 casos de limpeza, integração do cofre e ChatGPT pessoal simulado. Comando: `node --test --test-concurrency=1 --test-timeout=180000 test/lume-soft-cofre-cleanup.test.js test/desktop-segredos.test.js test/pessoal-chatgpt.test.js`. O catálogo já havia passado independentemente em **1/1**. A regressão integrada da origem permanece registrada como **1.059/1.063 PASS, três falhas e um cancelamento**. O focal de restauração/cofre 10/10 foi anterior à correção final de `unlinkSync` e não é atribuído a este freeze.

**Delta técnico de segurança aprovado.** O recibo externo `snapshot-review-delta-02.json` fixa os hashes desta fonte, dos testes e dos dois pareceres autorizados, sem dados privados. Os logs de execução ficam fora do export. Isso não aprova automaticamente outros deltas documentais em andamento, nem presume instalação da beta.8, conclusão da regressão ampla, coleta positiva real ou aceite.

## Complemento final — curadoria do segundo envio

O delta documental final foi confrontado com DONE, os recibos da candidata, da recuperação e da tentativa de instalação recusada. **Aprovado para o envio privado autorizado; produto globalmente parcial.** Beta.8 preparada, sem instalação ou aceite. A política do PowerShell recusou o wrapper antes do NSIS; nenhuma rota alternativa foi executada. Beta.7 permanece instalada. O primeiro push `f6405c5` não comprova o envio deste complemento.

A revisão independente conferiu o arquivo de recuperação, todos os 29.236 hashes restaurados e os 133 arquivos da cópia do programa. Dez pastas históricas ficaram somente na origem, sem cópia ou hash de conteúdo. O ensaio da candidata sustenta duas inicializações e saídas normais em perfil sintético, atividade desligada e preferências persistidas, com limites descritos na [revisão atual](lume-soft/REVISAO.md). A captura inicial transitória não prova contraste ou instalação.

Somente a fonte do cofre é exceção de produto frente ao snapshot inicial: bytes iguais ao objeto Git `14dd9f17`, equivalentes por EOL à versão exercitada nos 47 testes independentes. As duas alterações de teste são a contagem explícita do catálogo e o novo conjunto de limpeza. Os demais deltas são documentais. Regressão ampla parcial, focais e limites de avaliação real permanecem identificados sem reclassificação retroativa.

O recibo privado `snapshot-review-final-delta.json` registra lista fechada de arquivos autorizados, hashes, conferência da base, links locais e verificação dos oito artefatos preparados. Provas privadas não foram incorporadas ao novo Git. Nenhuma alteração de índice, commit ou push foi executada por este revisor. Novos envios e mudança de estado da instalação exigem recibos próprios.

## Confirmação posterior do segundo push

O recibo privado `github-second-push.json` registra o envio de **`35c290cdaa6412d12faf9c8e21ef81d8d9fa4e3e`**, com 1.045 arquivos. A revisão consultou independentemente a API: `main` aponta para esse commit, o repositório permanece privado e Actions está desativado. Assim, as referências acima ao segundo envio pendente descrevem o corte anterior, já superado por essa prova. Este complemento factual é posterior ao envio confirmado e requer recibo próprio; não muda o estado parcial do produto, a instalação beta.8 bloqueada ou os gates pendentes.
