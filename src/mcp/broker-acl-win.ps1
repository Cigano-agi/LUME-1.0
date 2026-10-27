param([Parameter(Mandatory=$true)][string]$PathsJson, [Parameter(Mandatory=$true)][int]$StrictFrom)
$ErrorActionPreference = 'Stop'
try {
  $paths = @(ConvertFrom-Json -InputObject $PathsJson)
  if ($paths.Count -lt 1 -or $paths.Count -gt 32 -or $StrictFrom -lt 0 -or $StrictFrom -ge $paths.Count) { throw 'paths' }
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trusted = @($current, 'S-1-5-18', 'S-1-5-32-544')
  $replaceBits = [int64]0x100D0040 # GENERIC_ALL, DELETE, DELETE_CHILD, WRITE_DAC, WRITE_OWNER
  $writeBits = [int64]0x50000116 # GENERIC_WRITE/ALL plus file write/append/attrs
  for ($i = 0; $i -lt $paths.Count; $i++) {
    $path = [string]$paths[$i]
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
    $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'null-dacl' }
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($trusted -notcontains $owner) { throw 'owner' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne 'Allow') { continue }
      if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
      if ($trusted -contains $rule.IdentityReference.Value) { continue }
      $mask = [int64]$rule.FileSystemRights
      if (($mask -band $replaceBits) -ne 0) { throw 'replace-right' }
      if ($i -ge $StrictFrom -and ($mask -band $writeBits) -ne 0) { throw 'write-right' }
    }
  }
  [Console]::Out.WriteLine('{"ok":true}')
} catch {
  [Console]::Out.WriteLine('{"ok":false}')
  exit 1
}
