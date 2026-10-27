# Documentação do Lume

O ponto de entrada do produto é o [README principal](../README.md). A revisão beta.9 corrige diagramação e espaçamento e confere os sons da companhia. A instalação permanece beta.7; o bloqueio anterior do script ocorreu antes do NSIS. O envio anterior confirmado é `0a772a2`, com Actions desligado. Estados históricos continuam identificados por data e não substituem a entrega atual. Consulte os [ajustes e provas atuais](lume-soft/AJUSTES-LAYOUT-SOM.md), o [texto para a guilda](lume-soft/ANUNCIO-GUILDA.md) e o [registro anterior](lume-soft/VERIFICACAO.md).

| Preciso encontrar… | Comece aqui |
| --- | --- |
| O que está sendo entregue e o que falta | [DONE](../DONE.md) |
| Regressão, envios confirmados e limites do corte atual | [Verificação atual](lume-soft/VERIFICACAO.md) |
| Origem do snapshot e limites da curadoria | [Origem deste repositório](ORIGEM.md) |
| A revisão atual do Lume 1.0 | [Experiência, presença e ritmo](lume-soft/README.md) |
| O escopo vigente do Lume 1.0 | [Contrato atual](lume-soft/CONTRATO.md) e [organização das conversas](lume-1/CONTRATO.md) |
| Interface atual, provas e limites | [Resultado da UI](lume-soft/UI-RESULTADO.md) |
| Implementação anterior de organização | [Implementação](lume-1/IMPLEMENTACAO.md) |
| Revisão atual e revisão anterior | [Revisão soft](lume-soft/REVISAO.md) e [revisão integrada anterior](lume-1/REVISAO-INTEGRADA.md) |
| Companhia, coleta local e empacotamento Windows | [Desktop atual](lume-soft/DESKTOP.md) e [registro anterior](lume-1/DESKTOP.md) |
| Medições de navegação, carga e seus limites | [Desempenho](lume-1/DESEMPENHO.md) |
| Backup operacional e retenções declaradas | [Revisão do backup operacional](lume-1/REVISAO-BACKUP-OPERACIONAL.md) |
| Como executar e contribuir | [Guia de contribuição](../CONTRIBUTING.md) |
| Fluxos, design e fundamentos da experiência | [Lume vivo](experiencia-lume/README.md) |
| Critérios de autorização, fontes e ciclo | [Contrato de organização](lume-1/CONTRATO.md) |
| Banner, linguagem e visuais de apresentação | [Kit editorial](marketing/README.md) |

## Ler os registros no contexto certo

`lume-soft/` registra a revisão atual. `lume-1/` conserva a implementação de organização e a instalação beta.7; `experiencia-lume/` documenta sua fundação. O repositório de origem conserva as demais decisões, experimentos e verificações anteriores. Quando houver divergência, confira o contrato vigente e o estado da tarefa antes de usar uma instrução antiga.

Logs extensos, dados de avaliação autorizados, perfis e capturas privadas ficam em destinos locais fora do Git. Um caminho citado em um relatório pode apontar para uma prova privada indisponível no checkout. Isso inclui as capturas históricas de `COMPANHIA-IMPLEMENTACAO.md` e as referências a `STATUS.md`, `.planning/STATE.md` e `docs/pessoal/` em `DECISOES.md`. Esses metadados foram mantidos como registro histórico; para decisões atuais, use o [contrato curado](lume-soft/CONTRATO.md) e [DONE](../DONE.md). A ausência de uma prova privada não deve ser preenchida com conteúdo pessoal ou uma execução inventada.
