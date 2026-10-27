# Companhia e preferências · implementação de26/10/2026

Escopo deste Dispatch: desktop/companheiro.html, companheiro.css, companheiro.js, src/painel/experiencia-preferencias.js, test/experiencia-companheiro-ui.test.js e este relatório. Segurança, IPC, backend, main, preload, janela, estilos da fundação e integração do aplicativo pertencem à coordenação e não foram editados. Sem commits ou subdelegação.

## Comportamento implementado

O companheiro começa compacto e expande um cartão com um único `payload.assunto`. Pessoa, motivo e prazo só aparecem quando presentes; o contexto só é exibido como assunto quando possui fonte válida. Dados recebidos entram via textContent, sem HTML executável. O número interno da fonte não é transformado em uma citação inventada: o cartão informa fonte vinculada e oferece Abrir contexto pela ponte atual, que conhece o assunto autorizado.

Abrir, adiar30min, pausar/retomar companhia, som e ocultar usam exclusivamente a ponte existente. Expandir só atualiza o DOM após confirmação do IPC. Erro/timeout de8s informa ausência de confirmação sem anunciar sucesso. A pausa não modifica atendimento e esse limite aparece no cartão. Não há chat, captura do PC, nova integração, envio ou gasto.

O SVG existente do fantasma foi preservado. CSS independente usa Manrope empacotada, corpo16px, metadados/botões14px, título24px, alvos≥44px e tokens próprios claro/escuro. A janela compacta respeita320×240; o modo expandido recebe320×400 da janela existente e permite rolagem vertical para textos longos e ações, sem corte horizontal. Os screenshots expandidos abaixo são full-page e, portanto, maiores que400px; não representam uma janela nativa com altura maior.

Gesto900ms com uma iteração, associado à mudança de estado/assunto; sem animação em loop. `movimento=reduce`, preferência do sistema e visibilidade impedem o gesto. Nenhum texto transforma disponibilidade em prova de execução: o estado trabalhando usa o rótulo “Conferindo”.

Som desligado por padrão. Motivo decisão requer assunto com fonte e grupo precisa; conclusão requer grupo mudou e estado explícito concluido/concluida/verificado/aceito. A primeira fotografia do estado fica silenciosa. Deduplicação usa notificacaoId em memória e sessionStorage, limitada aos últimos200IDs; não há alegação de deduplicação eterna entre novas sessões. Avisos vistos enquanto oculto/sem som também são registrados. Pausa, ocultação, som desligado e pagehide interrompem os osciladores ativos; resume de áudio bloqueado é descartado após400ms. Frequências: decisão620/930Hz, conclusão523,25/659,25Hz; ganho escala com volume0–1. Não há arquivo de áudio remoto.

## Integração e contrato de preferências

Incluir `/experiencia-preferencias.js` após app.js/pessoal.js, na allowlist/assets desktop e no empacotamento. Chamar `window.LumePreferencias.carregar()` após sessão/perfil prontos e ao retornar foco. O script também consulta ao abrir Aparência e companhia. A coordenação confirmou essas integrações durante o Dispatch; a validação nativa permanece no relatório próprio da coordenação.

O script insere o cartão `#lv-preferencias` em `#settings-group-appearance-cards`. Não move filhos do box de pessoal.js: oculta o details legado `#pessoal-companion` e acrescenta atalho, preservando closures. Labels legados theme-mode/ui-sounds também são ocultados no mesmo local, e os controles continuam sincronizados.

IDs finais: `lv-preferences-form`, `lv-pref-enabled`, `lv-pref-som`, `lv-pref-pausado`, `lv-pref-tema`, `lv-pref-movimento`, `lv-pref-volume`, `lv-pref-volume-value`, `lv-pref-save`, `lv-pref-refresh`, `lv-pref-status`, `lv-preview-decisao`, `lv-preview-conclusao`. `window.LumePreferencias.estado()` retorna cópia da preferência confirmada.

GET/POST usa `window.lumeConnectionRequest('/api/v3/pessoal/companheiro', patch, {timeout:15000})`. Somente campos tocados pelo usuário e diferentes do estado atual entram no patch. Uma consulta durante edição preserva os campos editados e atualiza os demais; isso evita sobrescrever preferências alteradas pelo companheiro. Falha de gravação mantém edição e pede atualização antes de repetir; não grava o cache como sucesso. Estado indisponível bloqueia enabled/pausado, mas mantém tema/movimento/som/volume editáveis; o backend correspondente foi ajustado pela coordenação e seu teste foi executado nesta verificação.

Após confirmação, aplica `lume-theme-choice`, `lume-interface-sounds` (`on`/`off`, efetivamente off na pausa), `lume-interface-volume` e cache `lume-companion-preferences`. O cache restaura a aparência até a consulta do backend; o backend é autoridade quando responde. `html.dataset.themeChoice`, `.theme`, `.motion`, `.soundVolume`, `.companionPaused` e o evento `window` `lume:preferences` sincronizam o aplicativo. O select legado theme-mode recebe change quando necessário para atualizar a closure de lume-theme-mode.js; o teste inclui o controlador real e mudanças da preferência do sistema após reload.

Prévia é acionada apenas pelos botões Ouvir decisão/conclusão e segue o volume escolhido. Fica desabilitada com som desligado ou pausa vigente/selecionada. Um patch de retomada deve ser confirmado antes da prévia. A coordenação adapta lume-motion.js para consumir o evento/datasets e limitar os motivos de som; esse arquivo não foi editado neste território.

## Provas

Comando no diretório app:

```powershell
node --test --test-concurrency=1 --test-timeout=180000 test/experiencia-companheiro-ui.test.js test/pessoal-companheiro.test.js test/experiencia-companheiro.test.js
```

O teste de UI usa Edge instalado via Playwright em perfil temporário headless, bridge/API fictícias e interceptação local de assets. O áudio é instrumentado para verificar frequências, ganho, deduplicação e interrupção; não comprova percepção sonora por uma pessoa. Os testes de backend/IPC existentes usam suas próprias fixtures. Nenhum perfil pessoal ou dado de conversa foi acessado.

Cobertura: ausência de bridge/fonte; texto malicioso literal; alvos44; abrir/adiar/pausar/retomar e erro; dois motivos de som/volume/deduplicação/primeiro estado/pausa/visibilidade; reload com memória de avisos; tema e reduced-motion; patch e persistência; preservação das closures; gravação falha; aparência sem janela nativa; escolha do sistema após reload; atualização concorrente sem sobrescrever campos não editados.

Screenshots sintéticos gerados e inspecionados na origem, com conteúdo fictício explícito. As cinco capturas abaixo não são distribuídas neste snapshot; os nomes preservam a referência da prova histórica, sem solicitar a cópia dos arquivos privados:

- Companhia clara compacta: `work/experiencia-companhia-20261026/companhia-light-compacta.png`.
- Companhia clara expandida: `work/experiencia-companhia-20261026/companhia-light-expandida.png`.
- Companhia escura compacta: `work/experiencia-companhia-20261026/companhia-dark-compacta.png`.
- Companhia escura expandida: `work/experiencia-companhia-20261026/companhia-dark-expandida.png`.
- Preferências claras em fixture: `work/experiencia-companhia-20261026/preferencias-light.png`.

A inspeção identificou e corrigiu um acento corrompido no HTML do companheiro e ausência de charset na fixture de preferências. As imagens foram regeneradas. `git diff --check` passou nos três arquivos desktop, com apenas aviso de normalização LF/CRLF do Git.

Resultado final: **15/15 PASS**, zero falhas/cancelamentos/skips,21,36s; oito testes de UI deste Dispatch e sete de backend/IPC existentes, executados sequencialmente no mesmo comando. Nenhuma prova sintética equivale a aceite, instalação, teste de macOS/8GB, áudio ouvido, leitor de tela ou percurso com assunto real. QA Electron com reinício/zoom e revisão independente estão sob responsabilidade da coordenação; não foram alegadas como executadas por este worker.
