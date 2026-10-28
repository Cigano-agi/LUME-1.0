# Organização automática de conversas

Revisão de 28/10/2026 · Lume 1.0 · candidata técnica 3.2.0-beta.10.

**Estado: avaliação do contrato aprovada nos conjuntos revisados.** A avaliação
principal obteve 95/100 e a complementar, 24/25, ambas sem erro crítico observado.
O processamento contínuo foi ativado no perfil existente após autorização e
conferência da recuperação. A candidata foi aberta com esse perfil e iniciou a
fila real. Isso não equivale a uma instalação nova nem à aprovação do histórico
inteiro; a cobertura continua aparecendo conforme o processamento avança.

O percurso começa nas conversas autorizadas. O Lume procura assuntos, projetos,
compromissos e sinais comerciais, apresenta sugestões com suas mensagens de
origem e mantém as correções feitas pela pessoa. Não é necessário cadastrar um
projeto antes de uma sugestão aparecer.

## O que aparece no aplicativo

| Tela | Comportamento |
| --- | --- |
| Agora | Cobertura observada, pendências de organização e até três perguntas sobre alternativas reais. |
| Projetos | Trabalhos identificados nas mensagens e seus trechos vinculados. Um grupo pode conter vários projetos. |
| Vendas | Interesse comercial por assunto, motivo e fonte. Temperatura não é probabilidade de venda. |
| Pessoas | Tags profissionais, projetos relacionados e acesso à timeline com autoria e data. |
| Memória | Mensagens e acontecimentos pesquisáveis localmente, inclusive quando a conta externa está indisponível. |

Uma pergunta só aparece quando há dois ou três projetos candidatos para o mesmo
trecho. Responder ou adiar fica registrado. Correções de vínculo, organização ou
temperatura prevalecem no processamento seguinte.

## Alcance e privacidade

A organização usa a conta ChatGPT conectada e envolve processamento remoto das
fontes autorizadas. O alcance pode ser o conjunto anteriormente autorizado ou
todas as conversas atuais e futuras, sempre com confirmação específica e respeito
às exclusões. Essa escolha não habilita respostas, atendimento ou envios.

Mensagens novas e os últimos 30 dias têm prioridade; o restante avança em lotes
limitados. A fila e os cursores existentes persistem após reinício. A interface
mostra cobertura e pendências observadas, sem prometer que todo o histórico foi
recuperado ou analisado. Pausa da organização e pausa da companhia são distintas.

Resultados que ficaram limitados pelo contexto ou por uma atribuição nominal
recusada podem ser retomados quando surgem candidatos elegíveis novos. A varredura
existente compara o contexto observado após a aplicação; os próprios efeitos da
análise não provocam repetição. Sem mudança, não há outra chamada. Fontes futuras
continuam fora da análise de uma mensagem anterior, e as verificações de fonte,
permissão e correção permanecem obrigatórias.

Cada inferência conserva contrato, modelo, fonte, autorização e contexto. Uma
mudança na mensagem, na autorização ou nas correções invalida resultados
dependentes. Exportação e MCP também verificam as fontes contextuais; permitir
uma mensagem isolada não torna todo o contexto exportável.

## Como o contexto é limitado

O processamento recebe até 12 mensagens e 16 mil caracteres, com candidatos a
projetos existentes na mesma conversa. A ordem usa a data da mensagem e seu
identificador, inclusive quando o histórico chega depois. Nome igual, sozinho,
não autoriza fundir projetos. Um vínculo aponta para o trecho específico.

A seleção reserva a mensagem-alvo e duas mensagens próximas, depois as bases
completas dos projetos. Referências literais ao nome ou objeto ajudam a escolher
quais candidatos entram; esse ranking não decide o vínculo nem une homônimos.
O restante do orçamento pode incluir até oito mensagens recentes ao todo. Cada
rodada busca até 24 candidatos e apresenta até oito, mantendo também o limite das
fontes. Quando a capacidade se esgota, o contexto sinaliza seu limite e não pode
justificar a criação de um projeto novo pela ausência de um candidato. Os
compromissos e vínculos sustentados pelos candidatos completos continuam possíveis.

Quando um trabalho é identificado em uma mensagem e retomado na seguinte, a
sugestão pode conservar as duas fontes: a identidade anterior e o acontecimento
atual. Uma lista pode produzir até oito vínculos distintos por resposta. O limite
de contexto permanece; isso não significa cobertura completa de qualquer texto.

O contexto é parcial: continuidade distante ou atravessando grupos pode não ser
reconhecida. Não há classificação de características sensíveis, importância por
volume de mensagens nem confirmação automática de fechamento, envio ou aceite.
Quando falta evidência, a resposta esperada é abstenção.

A candidata faz duas análises sequenciais pela mesma conta e modelo antes de
gravar o resultado: uma extração provisória e uma revisão de identidade, cobertura
e fontes. Ambas usam o mesmo contexto limitado, com prazo total de dois minutos.
Isso aumenta o uso da conta conectada e não representa revisão independente.
Se a segunda análise falhar, a primeira não é aplicada sozinha. Uma pergunta de
qualquer análise impede o vínculo automático naquele trecho; trocar de candidato
entre as análises gera uma pergunta. Cada chamada tem seu recibo, e as permissões,
correções e fontes são conferidas novamente entre as análises.

A candidata também verifica a sentença original quando o modelo cita um trecho.
Perguntas que comparam identidades não podem virar afirmações só porque a resposta
cortou a interrogação ou selecionou uma das alternativas. Essa regra vale para o
nome de um novo projeto, vínculos e fontes de candidatos futuros. Derivados
automáticos antigos sustentados por essas perguntas ficam fora das leituras;
a mensagem original e uma correção humana explícita permanecem preservadas.
Uma dúvida pode aparecer como assunto neutro, sem inventar a resposta.

Essa barreira cobre construções conhecidas e tem controles para preservar pedidos
legítimos de trabalho. Não é um analisador geral de linguagem nem garantia contra
qualquer erro de identidade.

Uma identificação nominal, sozinha, também não demonstra a qual trabalho pertence
um pedido genérico. A candidata conserva as evidências exatas escolhidas para cada
vínculo, recusa os casos nominais reproduzidos e mantém o compromisso sem atribuição.
O resumo desse compromisso usa o trecho literal, evitando repetir uma associação
rejeitada. Nomes, títulos de materiais e cortesias têm controles sintéticos
específicos; essa é outra defesa lexical limitada, não uma garantia semântica geral.

## Verificação e limites da candidata

A avaliação privada do contrato anterior obteve **92 acertos em 100 mensagens**, com
20 casos críticos e nenhum erro crítico observado de identidade, fonte ou
autorização. Os rótulos foram preparados antes das respostas, e uma revisão
separada confrontou os resultados com esses rótulos. É avaliação assistida, não
aceite humano nem uma estimativa geral de precisão.

Oito falhas semânticas permanecem registradas. O conjunto cobre três casos
positivos de interesse morno; não comprova os casos quentes e frios. A rodada
anterior, com 87 acertos e cinco rejeições de trechos, foi preservada. A correção
aceita quebras de linha literais sem dispensar a conferência exata da fonte.

O complemento separado de continuidade entre mensagens obteve **16/25**: oito
falhas de cobertura ou associação e uma execução inconclusiva. Essa reprovação
revelou limites na recuperação dos candidatos e na origem contextual do nome.
A segunda rodada desse complemento obteve **20/25, com um erro crítico** de
associação ambígua, que passou a influenciar uma mensagem posterior na cópia de
teste. Por isso, ambas as rodadas foram reprovadas. A implementação com duas
análises exige nova avaliação com os mesmos critérios e rótulos. As notas antigas
não autorizam o novo contrato nem o processamento contínuo no perfil real.

A terceira rodada complementar obteve **21/25, zero críticos** e ainda ficou
abaixo do mínimo. A quarta obteve **17/25, quatro críticos**: uma pergunta de
identidade gerou associações que afetaram mensagens posteriores na cópia. Esses
resultados motivaram a barreira de evidências descrita acima. A avaliação principal
da terceira rodada foi interrompida pela coordenação após 22 resultados; não
conta como aprovação ou falha do modelo. A principal da quarta não foi executada.

O contrato com a barreira exige novas avaliações completas de 100 e 25 casos,
com pelo menos 90% e zero erros críticos em cada conjunto. Os rótulos semânticos
continuam iguais. Os avisos de sentenças interrogativas são metadados novos do
contexto, com hashes e comparação de proveniência próprios. Uma expectativa do
complemento depende de fonte ausente do input; a limitação permanece registrada,
sem mudar o denominador ou forçar uma classificação comercial para passar.

A quinta rodada complementar obteve **22/25, um crítico**. A cadeia interrogativa
anterior deixou de ocorrer, mas a seleção de contexto excluiu um projeto válido
e um pedido genérico recebeu associação sustentada apenas por identidade nominal.
A principal V8 não foi executada. As correções de seleção e atribuição acima
respondem a essas causas, com nova avaliação obrigatória. A quinta rodada continua
reprovada e não foi convertida em aprovação pelos testes sintéticos posteriores.

A sexta rodada complementar, no contrato atual, obteve **24/25, zero críticos**,
com 50 respostas reais e nenhuma falha técnica. O projeto antes duplicado manteve
o ID original; o pedido antes atribuído sem evidência conservou somente o compromisso.
A expectativa comercial com fonte ausente continua como não acerto. Essa rodada
passou no seu critério. A avaliação principal V9 terminou depois com **95/100,
zero críticos**, 200 recibos únicos e nenhuma falha técnica. A revisão independente
conferiu 152 trechos literais e uma origem contextual. Os cinco desvios permanecem:
um fragmento que deveria produzir abstenção, uma divergência conservadora em relação
ao rótulo, uma pergunta convertida em pendência e duas pendências omitidas.

Os critérios foram atingidos separadamente, sem alterar os rótulos. São conjuntos
dirigidos, conhecidos nas revisões anteriores, não uma amostra inédita nem uma
estimativa de precisão em todas as conversas. Não comprovam todas as temperaturas
comerciais. O patch posterior da fila, que retoma contexto incompleto, passou em
131 testes de revisão independente; o snapshot curado passou em 86 testes focais.
Essas contagens não são somadas às avaliações semânticas.

Na ativação, somente alcance, atestado de qualidade, estado ligado e cursor da
organização foram alterados. As exclusões e as políticas de atendimento/envio
permaneceram iguais; a conferência foi repetida após a abertura. A rotina usa a
conta já conectada, sem cadastrar serviço novo ou trocar de modelo.

A execução inicial criou projeto e vínculos automaticamente no perfil existente.
O percurso real de Agora, Projetos e Vendas foi inspecionado em navegador isolado;
uma fonte foi conferida em três ações, comparando texto, conversa e origem. Houve
também captura do renderer nativo já aberto. Nenhum desses testes é prova de
instalação ou de que todo o histórico já foi organizado.

O aplicativo encerrou normalmente e reabriu com o mesmo perfil, sem argumentos
de depuração, retomando a fila. Uma revisão separada do primeiro projeto e suas
cinco fontes não observou erro crítico; registrou ressalva em um vínculo de
consulta de preço com objeto implícito. As sugestões continuam corrigíveis.

As duas avaliações não são somadas silenciosamente. A candidata
empacotada tem inspeção de integridade e fontes; ensaio nativo, uso do perfil real,
instalação e utilidade têm provas próprias. A instalação registrada permanece
anterior à candidata; não há novo download público validado neste documento.

Para reproduzir os testes sintéticos, sem conversas pessoais ou chamadas reais:

```sh
node --test --test-concurrency=1 test/lume-auto-*.test.js
node test/lume-auto-ui.e2e.mjs --run
```

As provas reais, bancos, nomes, mensagens e capturas pessoais ficam fora do Git.
O estado operacional e as pendências estão em [DONE.md](../../DONE.md).
