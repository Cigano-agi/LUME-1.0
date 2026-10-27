@echo off
REM Duplo clique aqui. E so isso.
REM
REM Este arquivo existe porque a instrucao anterior era "abra o terminal e cole
REM `powershell -ExecutionPolicy Bypass -File instalar.ps1`" -- o que supoe que a pessoa
REM ja abriu um terminal antes na vida. Nao supor isso e a diferenca entre instalar e
REM desistir na primeira tela.
REM
REM `-NoProfile` porque o perfil do PowerShell de quem ja mexeu na maquina pode redefinir
REM comando e quebrar a instalacao por um motivo que ninguem vai conseguir descobrir.

title Instalacao do Assessor
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
set CODIGO=%ERRORLEVEL%

echo.
if %CODIGO% NEQ 0 (
  echo ============================================================
  echo   A instalacao nao terminou.
  echo.
  echo   Tire uma foto ou copie o texto acima e mande para o Fabricio.
  echo   As linhas marcadas com FALHA dizem o que resolver.
  echo ============================================================
) else (
  echo Pode fechar esta janela.
)
echo.
pause
