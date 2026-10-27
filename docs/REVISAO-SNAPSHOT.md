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
