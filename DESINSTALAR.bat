@echo off
REM Remove as tarefas agendadas. NAO apaga suas mensagens nem o seu segundo cerebro --
REM apagar dado de alguem sem perguntar nao e coisa que um desinstalador deva fazer.
title Desinstalar o Assessor
cd /d "%~dp0"

echo Isto vai parar o Assessor de subir sozinho e de processar as conversas.
echo.
echo Suas mensagens (pasta data) e seu segundo cerebro (AssessorVault) NAO serao
echo apagados. Se quiser remove-los, apague as pastas a mao depois.
echo.
set /p RESP="Continuar? (S/N) "
if /i not "%RESP%"=="S" ( echo Cancelado. & pause & exit /b 0 )

schtasks /delete /tn "Assessor - captura de WhatsApp" /f 2>nul
schtasks /delete /tn "Assessor - processar conversas" /f 2>nul
schtasks /delete /tn "Assessor - vigia da captura" /f 2>nul
taskkill /f /im node.exe 2>nul

echo.
echo Pronto. As tarefas foram removidas e o programa foi encerrado.
echo No celular, remova o aparelho em WhatsApp ^> Aparelhos conectados.
echo.
pause
