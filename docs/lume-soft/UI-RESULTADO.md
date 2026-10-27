# UI suave — implementação e prova

Executada em 27/10/2026. Fontes da direção: dez referências visuais anexadas pelo usuário e [contrato vigente](CONTRATO.md). Este relato cobre o painel e os componentes vetoriais/sonoros compartilhados; não aprova instalação, coleta nativa, desempenho em hardware de 8 GB ou os gates semânticos anteriores.

## Resultado implementado

A fundação existente `experiencia.css` foi revisada diretamente: Open Runde local, canvas marfim, texto verde profundo, amarelo para decisões, menta/lavanda nos contextos, bordas discretas e sombras difusas. As variáveis de compatibilidade continuam ligando os componentes legados à mesma paleta; os IDs, controles, fontes e percursos existentes foram preservados. O tema escuro usa superfícies e contraste próprios. A busca global tem texto descritivo e o horário da consulta é secundário ao título. Cartões só sublinham a ação do título em hover/foco.

`lume-soft-mascote.js/.css` fornece um único SVG articulado com braços, lanterna, olhos, boca e acessórios, usado pelo painel e pela integração desktop da coordenação. Há sete estados operacionais e seis poses de prévia. Aparência contém a galeria acessível das treze expressões, sempre identificadas como prévia. O aceno de três toques/Enter na marca e a constelação da lanterna são interações lúdicas distintas: finitas, silenciosas, iniciadas pelo usuário e sem alegação de trabalho real.

`lume-soft-audio.js` é o único sintetizador. Preferências e desktop o consomem; o sintetizador antigo foi retirado. Som continua desligado até escolha explícita; a prévia revalida volume, pausa, visibilidade e geração após a retomada assíncrona do AudioContext. Eventos operacionais exigem assinatura e a integração desktop conserva a deduplicação da sessão e o silêncio da primeira renderização.

Motion usa 180/280/420 ms. Gestos do personagem e constelação têm término definido; CSS/WAAPI respeitam movimento reduzido e aba oculta. Elementos fora da área visível não iniciam gesto; observadores interrompem os que saem dela. As animações não aguardam nem bloqueiam a resposta dos dados.

`lume-soft-atividade.js` apresenta Seu ritmo antes dos blocos de Agora e em Ajustes → Dados. A interface oferece consentimento explícito, iniciar, pausar/retomar, desligar, retenção, exclusões por executável, paginação e apagar com confirmação específica. Apagar desliga; iniciar novamente limpa uma pausa anterior. O texto explica duração estimada, intervalo de amostragem, inatividade, armazenamento local e ausência de conteúdo/títulos/URLs/teclas. As APIs e a autoridade sobre coleta permanecem no módulo da coordenação.

## Provas executadas

| Comando | Resultado |
| --- | --- |
| `node --test --test-concurrency=1 test/lume-soft-ui-audio.test.js test/lume-1-interface-sound.test.js test/lume-1-interface-sound-review.test.js` | 12 testes passaram: opt-in, prévia, volume, patch parcial, pausa/hidden, deduplicação, corrida durante resume, timeout e pagehide. |
| `node test/lume-soft-ui.e2e.mjs --run` | Passou em HTTP/SQLite reais, navegador Edge headless isolado. Último recibo: 05:47:57–05:48:04 UTC. Zero erro HTTP, zero erro JS, zero chamada externa. |
| `node --check` nos módulos alterados/novos | Sintaxe válida. |

O E2E conferiu comportamento das treze poses, duas surpresas pelo teclado e seus términos, gesto de 420 ms, bloqueio fora da tela, reduced-motion, controles de atividade persistidos em SQLite, consentimento revogado ao apagar, prévia compartilhada após opt-in e silêncio persistido. Incluiu 1024 × 768, zoom CSS 200% e viewport 512 × 384 para reflow; sem overflow horizontal global. A coleta de aplicativos foi declaradamente substituída por disponibilidade sintética no teste; nenhum aplicativo real foi amostrado por este harness.

As doze capturas privadas ficam em `work/lume-soft-20261027/ui/`: Agora, Memória, Vendas, Projetos, Pessoas, galeria claro/escuro, atividade desligada/pausada e galeria nos três recortes de escala. Foram lidas visualmente para conferir hierarquia, suavidade das superfícies, poses, legibilidade e reflow. São dados sintéticos identificados; não fazem parte do Git. O recibo é `result.json` nesse diretório.

A primeira rodada falhou porque a asserção leu o texto inicial de atividade antes de a consulta terminar. O recibo `result-first-timing.json` foi preservado. A espera passou a exigir o estado recebido da API; a execução posterior concluiu sem relaxar a asserção. Os testes standalone de áudio foram atualizados para carregar o módulo compartilhado, permitindo remover o fallback de produto.

## Correção posterior à revisão independente

O congelamento de 05:48:04 UTC identifica o corte do E2E e das capturas acima. A revisão independente posterior encontrou uma regressão no adaptador `lumeMascotState`: o caminho do SVG compartilhado descartava a assinatura do evento e chamava o renderer novamente a cada polling, mesmo sem mudança operacional.

O teste `test/lume-soft-ui-motion.test.js` reproduziu o problema: **RED com duas falhas em três testes**, incluindo repetição com estado/assinatura idênticos e replay após ocultar e retornar à página. O log permanece em `work/lume-soft-20261027/ui/motion-dedup-red.log`. A correção normaliza o estado e compara estado mais assinatura antes de atualizar o personagem; só memoriza uma atualização aceita pelo renderer. Mudança de estado ou de evento continua permitida, e as prévias explícitas permanecem repetíveis. Cancelamento por aba oculta ou movimento reduzido foi preservado.

Após a correção, `node --test test/lume-soft-ui-motion.test.js` passou **3/3**. A revisão independente repetiu motion e áudio em VM, com **8/8 aprovados**. Essa verificação focal não abriu navegador nem substituiu o recibo anterior de HTTP/SQLite. No mesmo ajuste foram corrigidos o texto UTF-8 “Som indisponível” e a descrição editorial da prancha, que exibe seis das treze expressões disponíveis no painel.

## Limites

O navegador foi silenciado pelo parâmetro de lançamento: houve prova de agendamento Web Audio, não avaliação auditiva humana. As capturas e os percursos deste relato são sintéticos, não uma sessão pessoal. A presença de controles de atividade não comprova o coletor nativo; essa prova tem relatório próprio. Não houve edição de termos legais, leitura de conteúdo de outros aplicativos ou acesso a abas/perfis pessoais. Revisão independente, pacote e percurso nativo são coordenados separadamente e não devem ser inferidos deste relato.

As fontes UI voltaram a ser congeladas após a correção focal e sua revisão 8/8. O horário de 05:48:04 UTC permanece referência do corte anterior de E2E/capturas, não do congelamento definitivo. Nenhum commit foi criado pelo executor da UI.
