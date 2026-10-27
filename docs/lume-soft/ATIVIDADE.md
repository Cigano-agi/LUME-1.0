# Seu ritmo — acompanhamento local de aplicativos

O painel **Agora → Ver meu ritmo** abre o mesmo controle de **Ajustes → Dados**. A coleta começa desligada. **Iniciar acompanhamento** registra a escolha; **Pausar** interrompe as amostras, **Desligar** conserva o resumo existente sem coletar e **Apagar e desligar** remove os registros e revoga essa escolha.

## O que é observado

No Windows x64, um pequeno coletor consulta a janela em primeiro plano e identifica o nome de seu executável, como `editor.exe`. O caminho completo necessário à API do sistema é descartado dentro do coletor. Não solicita título de janela, linha de comando, URL, texto, imagem, áudio ou teclas. Não injeta código nos aplicativos.

Uma amostra é solicitada a cada cinco segundos. Dois registros próximos do mesmo aplicativo permitem acrescentar a duração estimada ao resumo diário. Trocas entre amostras podem não ser vistas; portanto, esse total não mede atenção, produtividade ou tempo exato. Não há retrospectiva anterior à ativação nem preenchimento de lacunas.

Após sessenta segundos de inatividade, bloqueio, suspensão, erro ou demora excessiva, a continuidade é encerrada. Mudança incompatível do relógio, passagem de dia e reinício também quebram o intervalo. A coleta é serial: uma consulta por vez, inclusive durante cancelamento. O helper deve encerrar antes de o serviço fechar o banco.

## Controles e dados

- Retenção padrão de sete dias, configurável entre um e trinta. A limpeza ocorre também ao consultar a atividade desligada.
- Até cem aplicativos excluídos. Excluir um aplicativo remove seus agregados anteriores e invalida amostras em andamento.
- Até duzentas identidades por dia; o limite é mostrado, sem inventar cobertura.
- Só são guardados dia local, identidade do executável, duração estimada, quantidade de intervalos observados e atualização.
- Os registros ficam no banco do perfil, separados de mensagens, pessoas, projetos e filas de organização. Não participam de envio ao ChatGPT, MCP ou acompanhamento técnico remoto.
- Backup do acervo não inclui atividade ou consentimento. Exclusão total ou restauração no perfil atual interrompe e desabilita a coleta; uma nova ativação é necessária. Restaurar o acervo em outro perfil preserva a configuração da origem, enquanto o novo perfil começa desligado.

O backup operacional do perfil inteiro, quando explicitamente executado para recuperação da instalação, pode incluir o banco e suas preferências. Isso é diferente da exportação do acervo pela interface. Exclusão local não apaga cópias já feitas nem promete apagamento forense do disco.

## Implementação e verificação

Domínio em [atividade-apps.js](../../src/atividade-apps.js), coletor restrito em [LumeActivity.cs](../../native/app-activity/LumeActivity.cs), adaptador em [atividade-apps-nativo.js](../../src/atividade-apps-nativo.js). O servidor existente exige perfil, sessão e origem local; o navegador não pode enviar amostras ou duração.

Testes independentes cobrem pausa/revogação em voo, duplicação, relógios, reinício, retenção, respostas contaminadas, corrupção, HTTP, exclusão total e roundtrip de backup. Veja [REVISAO](REVISAO.md). Plataformas sem coletor mostram indisponibilidade, sem dados de demonstração. A primeira consulta real nesta máquina retornou **inativo**; isso prova execução e abstenção, não uma amostra positiva de aplicativo.
