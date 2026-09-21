$ErrorActionPreference = 'Stop'
$sshdPath = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
if (-not (Test-Path -LiteralPath $sshdPath)) { throw 'Windows OpenSSH sshd.exe not found' }
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    New-Service -Name sshd -DisplayName 'OpenSSH SSH Server' -BinaryPathName ('"' + $sshdPath + '"') -StartupType Automatic | Out-Null
}
Set-Service sshd -StartupType Automatic
Start-Service sshd
Get-Service sshd | Select-Object Name,Status,StartType
