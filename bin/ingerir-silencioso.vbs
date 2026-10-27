' Processa o que chegou, uma vez por dia, sem janela e sem ninguem precisar lembrar.
'
' Por que existe: o guia de instalacao pedia `npm run ingerir` no terminal. Quem recebe
' esta caixa nao vai digitar isso -- nem hoje nem daqui a uma semana. Sem rodar, a
' captura acumula mensagem e a lista de pendencias e leads nunca sai do lugar, o que faz
' o programa parecer quebrado quando na verdade ninguem pediu para ele trabalhar.
'
' A saida vai para data/ingestao.log: quando o dono perguntar "por que nao apareceu
' nada", a resposta esta escrita em vez de ser adivinhada.
Option Explicit

Dim sh, fso, raiz, log, comando
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = raiz
log = raiz & "\data\ingestao.log"

If Not fso.FolderExists(raiz & "\data") Then fso.CreateFolder(raiz & "\data")

' `cmd /c` porque precisamos de redirecionamento de saida para o log. A janela fica
' escondida pelo 0 do Run, entao nada pisca na tela de quem estiver usando o PC.
comando = "cmd /c npm run ingerir >> """ & log & """ 2>&1"
sh.Run comando, 0, False
