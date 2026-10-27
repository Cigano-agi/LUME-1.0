<#
.SYNOPSIS
  Instala o Assessor nesta maquina, do zero.

.DESCRIPTION
  Instala o que falta (Node 24, Python 3.12, Ollama), baixa o modelo de busca,
  cria o seu vault vazio, escreve a configuracao, registra a tarefa que sobe o app
  no logon e abre o painel no navegador.

  Roda quantas vezes quiser: pula o que ja esta feito e nunca apaga dado.

.PARAMETER ChaveGemini
  Sua chave da API do Gemini. Se nao passar, o instalador pergunta.
  Crie a sua (gratis) em https://aistudio.google.com/apikey

.PARAMETER SemSemantica
  Pula Ollama e o modelo de embeddings (~2,3 GB). A busca textual continua funcionando.

.PARAMETER SemAutostart
  Nao registra a tarefa de logon. Voce sobe o app a mao com `npm start`.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File instalar.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File instalar.ps1 -SemSemantica
#>
[CmdletBinding()]
param(
  [string]$ChaveGemini = '',
  [string]$SeuNome = '',
  [string]$Vault = '',
  [switch]$SemSemantica,
  [switch]$SemAutostart
)

$ErrorActionPreference = 'Stop'
$Raiz = $PSScriptRoot
$NomeTarefa = 'Assessor - captura de WhatsApp'
$NomeTarefaIngestao = 'Assessor - processar conversas'
$NomeTarefaVigia = 'Assessor - vigia da captura'
$ModeloEmbed = 'bge-m3'
$avisos = @()

function Titulo($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Passo($t)  { Write-Host "   $t" }
function Feito($t)  { Write-Host "   [ok] $t" -ForegroundColor Green }
function Pular($t)  { Write-Host "   [ja] $t" -ForegroundColor DarkGray }
function Alerta($t) { Write-Host "   [!]  $t" -ForegroundColor Yellow; $script:avisos += $t }
function Morrer($t) { Write-Host "`n[FALHA] $t" -ForegroundColor Red; exit 1 }

function Existe($nome) { return $null -ne (Get-Command $nome -ErrorAction SilentlyContinue) }

# winget instala no PATH da MAQUINA/USUARIO, mas o processo atual ja leu o PATH dele no
# inicio. Sem reler do registro, o `node` recem-instalado nao e encontrado nesta mesma
# execucao e o instalador falharia logo depois de instalar com sucesso.
function AtualizarPath {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}

function Instalar($id, $rotulo, $comandoEsperado) {
  if (Existe $comandoEsperado) { Pular "$rotulo ja instalado"; return $true }
  Passo "instalando $rotulo (winget $id)..."
  winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
  AtualizarPath
  if (Existe $comandoEsperado) { Feito "$rotulo instalado"; return $true }
  Alerta "$rotulo nao ficou disponivel no PATH. Pode exigir reabrir o terminal."
  return $false
}

Write-Host ''
Write-Host '  ASSESSOR - instalacao' -ForegroundColor White
Write-Host '  Le o seu WhatsApp, guarda o contexto e monta o seu segundo cerebro.' -ForegroundColor DarkGray
Write-Host "  Pasta: $Raiz" -ForegroundColor DarkGray

# --------------------------------------------------------------------------- 1. winget

Titulo '1/8  Ferramentas do sistema'
if (-not (Existe 'winget')) {
  Morrer @"
winget nao encontrado. Ele vem com o "Instalador de Aplicativo" da Microsoft Store.
Instale por la e rode este script de novo:
  https://apps.microsoft.com/detail/9nblggh4nns1
"@
}
AtualizarPath

$temNode = Instalar 'OpenJS.NodeJS.LTS' 'Node.js' 'node'
if (-not $temNode) { Morrer 'Node.js e obrigatorio. Reabra o PowerShell e rode o instalador de novo.' }

$versaoNode = (& node --version).TrimStart('v')
if ([int]($versaoNode.Split('.')[0]) -lt 24) {
  Morrer "Node $versaoNode instalado, mas o app exige 24 ou maior. Atualize com: winget upgrade OpenJS.NodeJS.LTS"
}
Feito "Node v$versaoNode"

$temPython = Instalar 'Python.Python.3.12' 'Python 3.12' 'py'
if (-not $temPython) { Alerta 'Sem Python: os indices de busca nao vao ser construidos.' }

# --------------------------------------------------------------- 2. dependencias do app

Titulo '2/8  Dependencias do app'
Push-Location $Raiz
try {
  if (Test-Path (Join-Path $Raiz 'node_modules')) {
    Pular 'node_modules ja existe'
  } else {
    Passo 'npm ci (versoes travadas pelo package-lock)...'
    & npm ci --no-audit --no-fund 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Morrer 'npm ci falhou. Rode `npm ci` a mao para ver o erro.' }
    Feito 'dependencias instaladas'
  }
} finally { Pop-Location }

# ------------------------------------------------------------------------ 3. chave e nome

Titulo '3/8  Sua chave do Gemini'
if (-not $ChaveGemini) {
  Write-Host ''
  Write-Host '   O Assessor usa o Gemini para ler os audios e extrair o que ficou pendente' -ForegroundColor DarkGray
  Write-Host '   nas conversas. A chave e sua, gratuita, e leva 2 minutos:' -ForegroundColor DarkGray
  Write-Host '     https://aistudio.google.com/apikey' -ForegroundColor White
  Write-Host '   (Enter em branco pula: captura e busca funcionam, CRM e audio nao.)' -ForegroundColor DarkGray
  Write-Host ''
  $ChaveGemini = (Read-Host '   Cole a chave aqui').Trim()
}
if ($ChaveGemini) { Feito "chave recebida (...$($ChaveGemini.Substring([Math]::Max(0,$ChaveGemini.Length-6))))" }
else { Alerta 'Sem chave: extracao de CRM e transcricao de audio ficam desligadas.' }

if (-not $SeuNome) {
  $SeuNome = (Read-Host '   Como voce aparece nas buscas? (Enter = "Eu")').Trim()
}
if (-not $SeuNome) { $SeuNome = 'Eu' }

# ------------------------------------------------------------------------------ 4. vault

Titulo '4/8  Seu segundo cerebro'
if (-not $Vault) { $Vault = Join-Path $env:USERPROFILE 'AssessorVault' }
Push-Location $Raiz
try {
  & node 'bin/criar-vault.js' --destino $Vault
  if ($LASTEXITCODE -ne 0) { Morrer 'nao consegui criar o vault' }
} finally { Pop-Location }
Feito "vault em $Vault"

# ----------------------------------------------------------------------- 5. python do vault

Titulo '5/8  Motor de busca do vault'
$pyVault = Join-Path $Vault '.venv\Scripts\python.exe'
if (Test-Path $pyVault) {
  Pular 'venv do vault ja existe'
} elseif ($temPython) {
  Passo 'criando ambiente Python do vault...'
  Push-Location $Vault
  try {
    & py -3.12 -m venv .venv 2>&1 | Out-Null
    if (-not (Test-Path $pyVault)) { & py -3 -m venv .venv 2>&1 | Out-Null }
  } finally { Pop-Location }
}
if (Test-Path $pyVault) {
  Passo 'instalando sqlite-vec, requests e mcp...'
  & $pyVault -m pip install --quiet --disable-pip-version-check --upgrade pip 2>&1 | Out-Null
  & $pyVault -m pip install --quiet --disable-pip-version-check sqlite-vec requests "mcp<2" 2>&1 | Out-Null
  $ok = & $pyVault -c "import sqlite_vec, requests; print('ok')" 2>&1
  if ($ok -match 'ok') { Feito 'indices prontos' } else { Alerta "dependencias do vault falharam: $ok" }
} else {
  Alerta 'sem venv do vault: a busca textual e a semantica nao serao construidas.'
}

# ----------------------------------------------------------------------------- 6. ollama

Titulo '6/8  Busca semantica'
if ($SemSemantica) {
  Pular 'pulada por -SemSemantica (a busca textual continua funcionando)'
} else {
  $temOllama = Instalar 'Ollama.Ollama' 'Ollama' 'ollama'
  if ($temOllama) {
    # `ollama pull` precisa do servidor de pe. Depois do install ele costuma subir
    # sozinho, mas nao imediatamente -- daí a espera curta antes de desistir.
    $dePe = $false
    foreach ($tentativa in 1..10) {
      try {
        Invoke-RestMethod -Uri 'http://localhost:11434/api/tags' -TimeoutSec 3 | Out-Null
        $dePe = $true; break
      } catch {
        if ($tentativa -eq 1) {
          Passo 'subindo o servidor do Ollama...'
          Start-Process 'ollama' -ArgumentList 'serve' -WindowStyle Hidden -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
      }
    }
    if ($dePe) {
      $jaTem = $false
      try {
        $tags = Invoke-RestMethod -Uri 'http://localhost:11434/api/tags' -TimeoutSec 5
        $jaTem = @($tags.models | Where-Object { $_.name -like "$ModeloEmbed*" }).Count -gt 0
      } catch { }
      if ($jaTem) {
        Pular "$ModeloEmbed ja baixado"
      } else {
        Passo "baixando $ModeloEmbed (~1,2 GB, demora alguns minutos)..."
        & ollama pull $ModeloEmbed
        if ($LASTEXITCODE -eq 0) { Feito "$ModeloEmbed pronto" }
        else { Alerta "falha ao baixar $ModeloEmbed. Rode depois: ollama pull $ModeloEmbed" }
      }
    } else {
      Alerta 'Ollama nao respondeu. Abra o app do Ollama e rode: ollama pull bge-m3'
    }
  }
}

# -------------------------------------------------------------------------------- 7. .env

Titulo '7/8  Configuracao'
$caminhoEnv = Join-Path $Raiz '.env'
$linhas = @(
  '# Escrito pelo instalador. Este arquivo tem a sua chave: nao versione e nao compartilhe.',
  "GEMINI_API_KEY=$ChaveGemini",
  '',
  '# Onde o seu segundo cerebro mora.',
  "PUNK_RECORDS=$($Vault -replace '\\','/')",
  '',
  '# Como voce aparece nas buscas sobre as suas proprias mensagens.',
  "ASSESSOR_DONO=$SeuNome",
  '',
  '# Onde o indexador acha o banco de mensagens.',
  "ASSESSOR_DB=$((Join-Path $Raiz 'data\assessor.db') -replace '\\','/')",
  '',
  '# Porta do painel local. O app so escuta em 127.0.0.1.',
  'ASSESSOR_PORT=8787'
)
if (Test-Path $caminhoEnv) {
  $backup = "$caminhoEnv.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $caminhoEnv $backup
  Passo "config anterior salva em $(Split-Path -Leaf $backup)"
}
# SEM BOM, de proposito. `Set-Content -Encoding utf8` no PowerShell 5.1 escreve BOM, e
# medimos o efeito: o leitor de .env do Node batiza a primeira chave de
# "<BOM>GEMINI_API_KEY", entao `process.env.GEMINI_API_KEY` volta undefined e a chave
# some sem nenhum erro. WriteAllText com UTF8Encoding($false) nao escreve o BOM.
[System.IO.File]::WriteAllText($caminhoEnv,
  ($linhas -join "`r`n") + "`r`n",
  (New-Object System.Text.UTF8Encoding($false)))
Feito '.env escrito'

# --------------------------------------------------------------------------- 8. autostart

Titulo '8/8  Subir sozinho no logon'
if ($SemAutostart) {
  Pular 'pulado por -SemAutostart'
} else {
  # Sem isto o app morre no primeiro reboot e a captura para em silencio -- a falha
  # que mais custa aqui, porque mensagem que nao foi capturada nao volta depois.
  $vbs = Join-Path $Raiz 'bin\app-silencioso.vbs'
  try {
    schtasks /query /tn $NomeTarefa 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { schtasks /delete /tn $NomeTarefa /f 2>&1 | Out-Null }
    schtasks /create /tn $NomeTarefa /tr "wscript.exe `"$vbs`"" /sc onlogon /rl limited /f 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Feito "tarefa '$NomeTarefa' registrada" }
    else { Alerta 'nao consegui registrar a tarefa de logon. Suba com `npm start`.' }
  } catch {
    Alerta "tarefa de logon falhou: $($_.Exception.Message)"
  }

  # Segunda tarefa: processar o que chegou. Sem ela, o guia teria que pedir
  # `npm run ingerir` no terminal -- e quem recebe esta caixa nao vai digitar isso.
  # As pendencias e leads nunca apareceriam, e o programa pareceria quebrado.
  $vbsIngerir = Join-Path $Raiz 'bin\ingerir-silencioso.vbs'
  try {
    schtasks /query /tn $NomeTarefaIngestao 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { schtasks /delete /tn $NomeTarefaIngestao /f 2>&1 | Out-Null }
    # 09:00 e um horario em que a maquina costuma estar ligada, e a leitura pelo modelo
    # leva minutos -- nao pode disputar atencao com a pessoa no meio do expediente.
    schtasks /create /tn $NomeTarefaIngestao /tr "wscript.exe `"$vbsIngerir`"" /sc daily /st 09:00 /rl limited /f 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Feito "processamento diario agendado para as 09:00" }
    else { Alerta 'nao consegui agendar o processamento diario. Rode `npm run ingerir` quando quiser.' }
  } catch {
    Alerta "tarefa de processamento falhou: $($_.Exception.Message)"
  }

  # Terceira tarefa, e a que protege o dado: o vigia. Se a captura parar, mensagem
  # perdida NAO VOLTA -- o historico so e entregue uma vez, no pareamento. Ele roda em
  # processo separado porque, dentro do app, morreria junto com o que deveria vigiar.
  # Avisa por notificacao nativa do Windows, nunca pelo WhatsApp (o aviso de que o
  # WhatsApp caiu nao pode depender do WhatsApp).
  $vbsVigia = Join-Path $Raiz 'binigia-silencioso.vbs'
  try {
    schtasks /query /tn $NomeTarefaVigia 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { schtasks /delete /tn $NomeTarefaVigia /f 2>&1 | Out-Null }
    schtasks /create /tn $NomeTarefaVigia /tr "wscript.exe `"$vbsVigia`"" /sc minute /mo 15 /rl limited /f 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Feito "vigia da captura ativo (checa a cada 15 min)" }
    else { Alerta 'nao consegui agendar o vigia. Se a captura parar, ninguem vai avisar.' }
  } catch {
    Alerta "tarefa do vigia falhou: $($_.Exception.Message)"
  }
}

# ------------------------------------------------------------------------- diagnostico

Titulo 'Conferindo'
Push-Location $Raiz
try {
  & node 'bin/diagnostico.js'
  $bloqueado = ($LASTEXITCODE -ne 0)
} finally { Pop-Location }

if ($bloqueado) {
  Write-Host ''
  Write-Host 'Instalacao incompleta: veja as linhas FALHA acima.' -ForegroundColor Red
  Write-Host 'Cada uma traz o comando que resolve. Rode o instalador de novo depois.' -ForegroundColor Red
  exit 1
}

# ------------------------------------------------------------------------------ subir

Titulo 'Subindo o app'
$vbsPath = Join-Path $Raiz 'bin\app-silencioso.vbs'
Start-Process 'wscript.exe' -ArgumentList "`"$vbsPath`"" -WindowStyle Hidden

$subiu = $false
foreach ($t in 1..20) {
  Start-Sleep -Milliseconds 750
  try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:8787' -TimeoutSec 2 -UseBasicParsing | Out-Null
    $subiu = $true; break
  } catch { }
}

Write-Host ''
if ($subiu) {
  Feito 'painel respondendo em http://127.0.0.1:8787'
  Start-Process 'http://127.0.0.1:8787'
} else {
  Alerta 'o painel nao respondeu a tempo. Abra um terminal aqui e rode: npm start'
}

Write-Host ''
Write-Host '  PRONTO' -ForegroundColor Green
Write-Host ''
Write-Host '  1. No painel, clique em "Conectar WhatsApp".'
Write-Host '  2. No celular: WhatsApp > Aparelhos conectados > Conectar aparelho.'
Write-Host '  3. Escaneie o QR. O historico entra sozinho (pode levar horas).'
Write-Host ''
Write-Host '  O resto e automatico:' -ForegroundColor DarkGray
Write-Host '  todo dia as 09:00 o programa le as conversas novas, separa o que ficou' -ForegroundColor DarkGray
Write-Host '  pendente e quem esta esperando resposta, e atualiza o painel sozinho.' -ForegroundColor DarkGray
Write-Host ''
Write-Host "  Seu segundo cerebro: $Vault" -ForegroundColor DarkGray
Write-Host '  Abra essa pasta no Obsidian para navegar.' -ForegroundColor DarkGray

if ($avisos.Count -gt 0) {
  Write-Host ''
  Write-Host "  $($avisos.Count) aviso(s) - funciona, com funcionalidade reduzida:" -ForegroundColor Yellow
  foreach ($a in $avisos) { Write-Host "    - $a" -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '  Deu problema? Rode `node bin/diagnostico.js` e mande a saida.' -ForegroundColor DarkGray
Write-Host ''
