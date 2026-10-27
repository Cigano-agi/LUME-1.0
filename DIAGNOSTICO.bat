@echo off
REM Duplo clique quando algo nao estiver funcionando.
REM A saida e feita para ser fotografada e mandada para quem der suporte.
title Diagnostico do Assessor
cd /d "%~dp0"
node bin\diagnostico.js
echo.
echo ============================================================
echo   Tire uma foto desta tela e mande para o Fabricio.
echo   As linhas FALHA dizem o que precisa ser resolvido.
echo ============================================================
echo.
pause
