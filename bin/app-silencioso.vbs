' Sobe o app sem piscar janela de console. E isto que a Tarefa Agendada chama no logon.
'
' Por que existe: `node bin/app.js` direto no Agendador deixa um console preto aberto
' para sempre na sessao da pessoa. Ela fecha, e a captura do WhatsApp para sem ninguem
' perceber -- que e a falha mais cara deste sistema, porque mensagem perdida nao volta.
'
' Por que nao repete o caminho cravado do `vigia-silencioso.vbs`: aquele aponta para
' `node-v24.19.0-win-x64`, com a versao no meio do caminho. Na maquina de outra pessoa,
' ou depois de um update do Node aqui, esse caminho deixa de existir e a tarefa falha em
' silencio. Aqui o node sai do PATH, e se nao estiver no PATH a pessoa ve o erro.
Option Explicit

Dim sh, fso, raiz, comando
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' A raiz do repositorio e a pasta acima de \bin\.
raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = raiz

If Not fso.FileExists(raiz & "\bin\app.js") Then
  MsgBox "Assessor: nao encontrei bin\app.js em " & raiz, 16, "Assessor"
  WScript.Quit 1
End If

' 0 = janela escondida, False = nao espera terminar.
comando = "node.exe """ & raiz & "\bin\app.js"""
On Error Resume Next
sh.Run comando, 0, False
If Err.Number <> 0 Then
  MsgBox "Assessor: nao consegui iniciar o Node." & vbCrLf & vbCrLf & _
         "Verifique se o Node 24 esta instalado e no PATH:" & vbCrLf & _
         "  winget install OpenJS.NodeJS.LTS" & vbCrLf & vbCrLf & _
         "Erro: " & Err.Description, 16, "Assessor"
  WScript.Quit 1
End If
