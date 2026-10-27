# Windows-only diagnostic. Creates and inspects one random Node pipe, then stops its child.
$ErrorActionPreference = 'Stop'
$pipeName = 'lume-ipc-probe-' + [guid]::NewGuid().ToString('N')
$pipePath = '\\.\pipe\' + $pipeName
$fixture = Join-Path $PSScriptRoot '..\test\fixtures\profile-ipc-probe.mjs'
$node = (Get-Command node -ErrorAction Stop).Source

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PipeSecurityNative {
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint info,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr LocalFree(IntPtr memory);
}
'@

function Category($sid, $currentSid) {
  if ($null -eq $sid) { return 'Unknown' }
  if ($sid.Value -eq $currentSid.Value) { return 'CurrentUser' }
  switch ($sid.Value) {
    'S-1-5-18' { return 'System' }
    'S-1-5-32-544' { return 'Admin' }
    'S-1-1-0' { return 'Everyone' }
    'S-1-5-7' { return 'Anonymous' }
    default { return 'Other' }
  }
}

$child = $null
$client = $null
$childExited = $false
$result = $null
$failed = $false
try {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $node
  $start.Arguments = '"' + $fixture + '" server "' + $pipePath + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $child = [System.Diagnostics.Process]::Start($start)
  $ready = $child.StandardOutput.ReadLineAsync()
  if (-not $ready.Wait(5000) -or $ready.Result -ne 'READY') { throw 'server_not_ready' }

  $reply = & $node $fixture client $pipePath
  if ($LASTEXITCODE -ne 0) { throw 'node_client_failed' }

  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName,
    [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect(3000)
  $owner = [IntPtr]::Zero; $group = [IntPtr]::Zero
  $dacl = [IntPtr]::Zero; $sacl = [IntPtr]::Zero; $descriptor = [IntPtr]::Zero
  $code = [PipeSecurityNative]::GetSecurityInfo($client.SafePipeHandle.DangerousGetHandle(),
    6, 5, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$descriptor)
  if ($code -ne 0) { throw ('GetSecurityInfo_code_' + $code) }
  if ($descriptor -eq [IntPtr]::Zero) { throw 'descriptor_missing' }
  try {
    $size = [PipeSecurityNative]::GetSecurityDescriptorLength($descriptor)
    if ($size -le 0 -or $size -gt 65536) { throw 'descriptor_length_invalid' }
    $bytes = New-Object byte[] $size
    [Runtime.InteropServices.Marshal]::Copy($descriptor, $bytes, 0, [int]$size)
    $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($bytes, 0)
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $aces = @()
    $otherCount = 0
    if ($null -ne $raw.DiscretionaryAcl) {
      foreach ($ace in $raw.DiscretionaryAcl) {
        if ($ace -isnot [System.Security.AccessControl.KnownAce]) { $otherCount++; continue }
        $category = Category $ace.SecurityIdentifier $currentSid
        if ($category -eq 'Other' -or $category -eq 'Unknown') { $otherCount++; continue }
        $aces += [pscustomobject]@{
          category = $category
          type = $ace.AceType.ToString()
          mask = ('0x{0:X8}' -f ($ace.AccessMask -band 0xffffffffL))
          flags = $ace.AceFlags.ToString()
        }
      }
    }
    $result = [pscustomobject]@{
      runtime = (& $node --version)
      client = 'same-account Node client succeeded'
      inspection = 'GetSecurityInfo succeeded'
      owner = (Category $raw.Owner $currentSid)
      daclPresent = ($null -ne $raw.DiscretionaryAcl)
      aces = $aces
      otherAceCount = $otherCount
    }
  } finally {
    [void][PipeSecurityNative]::LocalFree($descriptor)
  }
} catch {
  $failed = $true
  $result = [pscustomobject]@{ inspection = 'failed'; error = $_.Exception.GetType().Name; code = $_.Exception.HResult }
} finally {
  if ($null -ne $client) { $client.Dispose() }
  if ($null -ne $child) {
    if (-not $child.HasExited) { $child.Kill(); [void]$child.WaitForExit(5000) }
    $childExited = $child.HasExited
    if (-not $childExited) { $failed = $true; $result = [pscustomobject]@{ inspection = 'failed'; error = 'child_not_exited' } }
    $child.Dispose()
  }
}
$result | Add-Member -NotePropertyName childExited -NotePropertyValue $childExited -Force
$result | ConvertTo-Json -Depth 5
if ($failed) { exit 1 }
