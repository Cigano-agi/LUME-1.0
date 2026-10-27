' Roda uma rodada do vigia sem piscar console. O Agendador chama isto a cada 15 minutos.
'
' Por que existe: se a captura do WhatsApp parar, ninguem fica sabendo. Mensagem que nao
' foi capturada NAO VOLTA -- o historico so e entregue uma vez, no pareamento. Essa e a
' falha mais cara deste sistema, e ela e silenciosa por natureza.
'
' O vigia roda em processo separado de proposito: se ele morasse dentro do app, morreria
' junto com aquilo que deveria vigiar. Prova de queda real esta em docs/07-PROVAS.md.
'
' O caminho do Node sai do PATH. A versao anterior deste arquivo apontava para
' `node-v24.19.0-win-x64` com a versao no meio do caminho -- um update do Node, ou outra
' maquina, e a tarefa passa a falhar em silencio. Vigia que falha calado e pior que nao
' ter vigia, porque da a impressao de que alguem esta olhando.
Option Explicit

Dim sh, fso, raiz
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = raiz

If Not fso.FileExists(raiz & "\bin\assessor.js") Then WScript.Quit 1

On Error Resume Next
sh.Run "node.exe ""bin\assessor.js"" vigia --uma-rodada --reviver", 0, False
' Sem MsgBox aqui: esta tarefa roda de 15 em 15 minutos e uma caixa de dialogo a cada
' rodada seria pior que a falha. Quem reclama de Node ausente e o app-silencioso.vbs.
