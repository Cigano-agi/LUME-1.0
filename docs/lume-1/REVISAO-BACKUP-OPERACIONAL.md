# Revisão independente — backup operacional com retenções

Data: 27/10/2026. Veredito: **APROVADO para o escopo operacional com exclusões explícitas**. Não é aprovação de um backup integral, de uma execução real do snapshot ou da instalação do aplicativo.

Fonte revisada: `scripts/snapshot-lume-archive.mjs`, SHA-256 `ddfbcd0748ccd970a6b5e459966ca9bc56c78c157a6e23387cde0bd9d89b759e`. O revisor não alterou o script. Escrita restrita ao teste independente e a este relatório.

## Decisão e limites

Pode-se produzir uma cópia verificável do perfil operacional excluindo apenas os caminhos históricos explícitos informados em `retainedSessions`, preservados no original. O script exige nomes históricos válidos, existência como diretório dentro do inventário da origem e presença de `data/wa-auth`. A seleção é clonada no início e não admite wildcard, ativo, outra pasta, caminho absoluto, traversal, duplicata ou caminho ausente.

A aprovação depende de o operador usar exatamente a lista inventariada dos dez diretórios autorizados. O script aceita listas explícitas de até cem diretórios históricos válidos; não conhece, por si só, a lista autorizada desta instalação. A opção CLI vincula o JSON à string absoluta exata de `source`.

Arquivos retidos não são copiados nem recebem hash de conteúdo. O manifesto e recibo declaram `scope: operational-profile` e, por caminho, `copied: false`, `contentVerified: false`, `preservedAtSource: true`, contagem e tamanho. O `verified: true` corresponde ao conteúdo incluído no arquivo e no ensaio de restauração. As pastas retidas continuam sujeitas à conferência final de inventário, identidade, tamanho e timestamps. Isso não equivale a validar sua autenticidade, utilidade de recuperação ou conteúdo.

O original preserva a única cópia dessas quarentenas. Perda do disco/perfil original também as perde. Uma restauração futura não pode substituir/remover o original usando esta cópia parcial como se fosse integral. O script cria destinos novos e rejeita sobreposição e destinos existentes.

## Evidência de fonte

- `scripts/snapshot-lume-archive.mjs:70`: clone da lista antes de operações assíncronas.
- `:87`: valida tipo, limite, unicidade, formato histórico e presença no inventário; `:89` exige o diretório ativo.
- `:90`: recorte por igualdade do caminho ou descendência com separador; evita prefixos semelhantes.
- `:93`: exclusões nativas `-x!` com nomes exatos, sem wildcard.
- `:119`: estabilidade final verifica o inventário completo da origem, incluindo retenções.
- `:122` e `:125`: manifesto e recibo declaram escopo e ausência de cópia/verificação de conteúdo retido.
- `:139`: CLI rejeita lista vinculada a outra origem.
- `scripts/snapshot-lume-profile.mjs:89`: inventário rejeita junction/symlink e arquivos com hardlinks; a retenção não evita esse inventário.
- `scripts/snapshot-lume-profile.mjs:143`: comparação final de todos os caminhos e metadados.

## Prova executada

Comando:

```text
node --test --test-concurrency=1 --test-timeout=180000 test/lume-1-snapshot-archive.test.js test/lume-1-snapshot-retained.test.js
```

Resultado: **21/21 PASS**, zero falhas, skips ou cancelamentos; 9,783 segundos na execução conjunta. `git diff --check` do novo teste passou. O novo teste sozinho também passou 9/9 antes da regressão conjunta.

Foi utilizado o executável real `7za.exe` cujo SHA-256 é fixado pelo script (`223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3`). Não houve mock de compactação ou extração. Fixtures sintéticas foram criadas em diretórios novos de TEMP e removidas somente após validar que o caminho de limpeza permanecia nesse território.

Os nove casos novos comprovam:

1. Dez pastas históricas explícitas não aparecem no arquivo 7z nem na restauração. Sessão ativa, credenciais, banco, WAL/SHM, marcadores, histórico não listado, nome com sufixo semelhante e mesmo nome em outra subárvore são incluídos. Bytes e hashes foram conferidos independentemente; a listagem nativa do arquivo também foi inspecionada.
2. Ativo, outras pastas, traversal, wildcard, caminhos absolutos, duplicatas, caixa divergente, separador não canônico, item ausente e arquivo comum usado como diretório são recusados antes de criar destino.
3. Retenção sem o diretório ativo é recusada.
4. Junction em diretório retido e hardlink dentro de conteúdo retido são recusados.
5. Mutação de conteúdo retido com o mesmo tamanho impede recibo no inventário final.
6. Novo arquivo dentro de pasta retida impede recibo no inventário final.
7. Mutação do array do chamador após início não amplia as exclusões.
8. CLI com lista vinculada a outra origem é recusada antes de copiar.
9. Lista vazia mantém o comportamento integral e inclui as pastas históricas.

Os doze casos de regressão repetiram os gates de Unicode/ocultos/vazios, processo ativo/incerto, destino existente/sobreposto/Git, ferramenta não confiável, links, corrupção de fonte/arquivo/restauração e alteração tardia de fonte durante a consulta de processos.

Nenhum perfil real, conteúdo de credenciais reais, Electron, candidata ou instalador foi aberto por esta revisão. A execução real precisa produzir seu próprio manifesto e recibo; estes testes não o substituem.
