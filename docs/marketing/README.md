# Lume — kit editorial do repositório

**Descrição curta:** Lume 1.0 — memória com fontes, companhia discreta e acompanhamento local. Conversas, projetos e próximos passos.

Mensagem principal: **Clareza para o próximo passo.** Texto de apoio: retome o fio da conversa, encontre a fonte e acompanhe o que vem depois.

## Visuais

| Arquivo | Uso e descrição acessível |
| --- | --- |
| [lume-banner.svg](lume-banner.svg) | Banner 1280 × 520. Lume 1.0, título e fantasma amarelo com lanterna. |
| [lume-percurso.svg](lume-percurso.svg) | Diagrama editorial 1280 × 360: recuperar contexto, acompanhar compromissos e conferir resultados. Não é captura de interface. |
| [lume-expressoes.svg](lume-expressoes.svg) | Prancha 1280 × 470 com seis das treze poses do personagem do produto. |
| [preview.html](preview.html) | Apresentação responsiva local dos visuais, identificada como material editorial. |

Os vetores incluem título e descrição. O README usa texto alternativo e repete a mensagem em texto normal. O personagem é gerado pelo mesmo [renderer SVG](../../src/painel/lume-soft-mascote.js) do painel e da companhia. Amarelo `#F4CE46`, tinta `#1E3A34`, marfim, menta e lavanda formam a base visual. Open Runde é incorporada localmente sob OFL; origem e licença em [FONTES](../lume-soft/FONTES.json). Não há conteúdo de conversas, clientes, fixtures operacionais ou captura do perfil real nestes arquivos.

## Linguagem e limites

Apresente contexto, fontes, próximos passos e controles de autorização com palavras concretas. Separe capacidade implementada, verificação e entrega. Não afirme funcionamento totalmente offline, precisão garantida, redução de tempo, disponibilidade pública, aprovação de piloto ou suporte nativo verificado a uma plataforma sem a prova correspondente. A identidade comercial 1.0 não anuncia release final.

Os visuais são editoriais e estáticos. Não simulam uma tela do produto nem comprovam resultados. A página de preview declara essa natureza na própria renderização.

## Reproduzir

```sh
node docs/marketing/gerar-visuais.mjs
node docs/marketing/verificar-visuais.mjs
```

O primeiro comando usa o renderer compartilhado, em Chromium isolado, para compor os SVGs. O segundo confere carregamento, ausência de rolagem horizontal e renderização em desktop/mobile; grava screenshots somente do material editorial em `docs/marketing/provas/`. Ambos usam Playwright no canal `msedge` instalado; outro canal pode ser indicado por `LUME_MARKETING_BROWSER_CHANNEL`. Não abrem Electron nem acessam o perfil pessoal. Veja [VERIFICACAO.md](VERIFICACAO.md) para a execução observada.

Direção criativa: skill local `agency-marketing-content-creator`, com leitura de `PROFILE.upstream.md`; critérios de clareza de mensagem, consistência de marca e adequação do formato foram aplicados. Metas genéricas de marketing do perfil não são resultados nem metas validadas do Lume.
