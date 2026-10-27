# Fundação e biblioteca

Manrope empacotada em fonts, sem fontes do sistema substituindo-a. Corpo16px, metadados14px, títulos24–32px. Espaço múltiplo4px, alvos principais44×44px, raios12/20/28px. Marfim/claro e grafite/escuro, texto e bordas próprios com contraste. Assinatura amarela e fantasma de silhueta existente, volume suave, expressão legível.

Comercial verde/ramificações; Entregas azul/peças; Combinados âmbar/elos; Pessoas coral/órbitas; Memória violeta/camadas. Nome e ícone acompanham a cor. Vermelho só problema que exige atenção. Estado de execução tem indicador próprio, independente de categoria.

Biblioteca real: navegação, cartão de assunto/decisão, fonte/recibo, conexão, busca/filtro, atendimento, painel lateral, diálogo, toast/vazio. Manter DOM semântico, labels, status/alert, foco visível e retorno ao invocador. Conteúdo responsivo em1024×768 e zoom200%; painéis empilham sem cortar ações. Nada de métricas decorativas ou textos longos de boas-vindas na rotina.

Motion: controle140–180ms, estado/expansão220–280ms, navegação/painel320–420ms com desaceleração; fantasma700–1200ms finito, associado a evento. Opacidade/transform; sem layout saltando/loop contínuo. Reduced-motion retira animações; suspender fora da tela. Som inicia desligado, volume/prévia, dois motivos (decisão/conclusão), deduplicado, silencioso na pausa; nunca por mensagem ingerida.

Classes da vista nova prefixadas `lv-` e raiz `.lume-vivo`. Biblioteca deve atender elementos nativos legados sem remover funcionalidade. Tokens `--lv-bg`, `--lv-surface`, `--lv-ink`, `--lv-muted`, `--lv-border`, `--lv-yellow`, `--lv-commercial`, `--lv-delivery`, `--lv-agreement`, `--lv-people`, `--lv-memory` e seus fundos/bordas. Tema por `html[data-theme=dark]`, conforme controlador existente.
