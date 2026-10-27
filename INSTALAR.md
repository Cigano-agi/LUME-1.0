# Assessor — instalação

---

## Instalar

**Dê dois cliques em `INSTALAR.bat`.**

É isso. Ele instala tudo o que falta na sua máquina e abre o programa no navegador.

> Se o Windows mostrar uma tela azul dizendo *"O Windows protegeu o seu computador"*,
> clique em **Mais informações** → **Executar assim mesmo**. Isso aparece porque o
> arquivo veio da internet, não porque tem algo errado com ele.

Durante a instalação ele vai perguntar **como você quer aparecer nas buscas** (seu
primeiro nome basta). Só isso.

Quando terminar, o navegador abre sozinho. Clique em **Conectar WhatsApp** e, no
celular, vá em **WhatsApp → Aparelhos conectados → Conectar aparelho** e aponte a câmera
para o código na tela.

Pronto. Suas conversas começam a entrar.

---

## O que esperar nas primeiras horas

O WhatsApp entrega o histórico aos poucos. Pode levar de alguns minutos a algumas horas,
dependendo de quanta conversa você tem.

**Você não precisa fazer nada nesse tempo.** Pode fechar o navegador, usar o PC
normalmente, até reiniciar — o programa continua trabalhando sozinho em segundo plano e
volta a subir quando você liga o computador.

O número de mensagens aparece no painel. Enquanto ele estiver crescendo, é porque está
funcionando.

**Todo dia às 9h** o programa lê as conversas novas e atualiza a lista de quem está
esperando resposta e quais leads existem. Você não precisa mandar ele fazer isso.

---

## O que você ganha

Abra `http://127.0.0.1:8787` quando quiser. As abas respondem perguntas:

| Aba | Responde |
|---|---|
| **Hoje** | o que eu preciso ver agora? |
| **Pendências** | o que eu prometi e não entreguei? quem ficou sem resposta? |
| **Leads** | quem demonstrou interesse em comprar? |
| **Conversas** | busca em tudo que já foi dito, de anos atrás |
| **Comunidades** | o que rolou nos grupos enquanto eu não olhava |

Em cada item tem um botão **Ver conversa**, que te leva direto para a mensagem que gerou
aquilo. Quando é conversa direta, tem também um link que **abre a pessoa no seu WhatsApp**
para você dar o follow-up na hora.

**Nenhum robô responde ninguém por você.** O programa só lê. Não existe envio de mensagem
aqui — nem automático, nem manual.

---

## A chave do Gemini

Para o programa conseguir *ler* as conversas e separar o que é pendência e o que é lead,
ele precisa de uma chave do Google. É grátis.

O próprio painel te guia: aparece um aviso no topo com um botão que abre a página certa,
você copia a chave, cola no campo e clica em testar. **Ele testa antes de salvar** e diz
na hora se funcionou.

Sem a chave, o programa continua:
- ✅ capturando todas as suas mensagens
- ✅ com a busca funcionando em tudo

E não faz:
- ❌ separar pendências e leads
- ❌ transformar áudio em texto

Dá para colocar a chave depois, quando quiser.

---

## Quando der problema

**Dê dois cliques em `DIAGNOSTICO.bat`.**

Ele confere cada parte do programa e escreve o que está funcionando e o que não está.
Tire uma foto da tela e mande para o Fabrício — está tudo escrito ali, inclusive o que
fazer para resolver.

### As três dúvidas mais comuns

**"Sumiu"** — o programa roda em segundo plano, sem ícone. Abra
`http://127.0.0.1:8787` no navegador. Vale salvar nos favoritos.

**"Parou de aparecer coisa nova"** — abra o painel e olhe o aviso de conexão no topo. Se
o WhatsApp desconectou o aparelho, é só parear de novo pelo botão.

**"Meu celular precisa ficar ligado?"** — sim, como no WhatsApp Web. E o PC também
precisa estar ligado para capturar.

---

## Privacidade — vale ler

- **Suas conversas ficam no seu computador.** O programa escuta só em `127.0.0.1`, que é
  o endereço interno da sua própria máquina. Ninguém na sua rede, no seu escritório ou na
  internet consegue abrir isso.
- **O que sai daqui:** quando o programa lê as conversas (aquele processamento das 9h), o
  texto vai para o Google, pela chave do Gemini, e volta com a análise. Se você não quiser
  isso, **não configure a chave** — captura e busca continuam funcionando e são 100%
  locais.
- **Nem o Fabrício vê suas conversas.** Não existe servidor nosso no meio. É o seu PC, a
  sua chave e a sua conta do Google.
- **Para sair:** dois cliques em `DESINSTALAR.bat`, e depois apague a pasta. No celular,
  remova o aparelho em **WhatsApp → Aparelhos conectados**.

---

<details>
<summary>Para quem mexe com terminal</summary>

| Comando | O que faz |
|---|---|
| `npm start` | sobe o painel |
| `npm run diagnostico` | relatório de saúde, com o conserto de cada falha |
| `npm run ingerir` | força o processamento agora, sem esperar as 9h |
| `npm run indexar` | reconstrói os índices de busca |
| `node bin/backup.js` | cópia de segurança do banco, conferida |
| `node bin/frescor.js --dry` | mostra itens que já morreram, sem gravar |

Quase tudo aceita `--dry`. Configuração em `.env` (veja `.env.exemplo`).
Opções do instalador: `-SemSemantica` (pula 2,3 GB de download), `-SemAutostart`.

</details>
