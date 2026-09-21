# 注册登录自启计划任务（可选）：每次登录当前用户时后台运行 sscode-server
# 用法：powershell -ExecutionPolicy Bypass -File scripts\start-windows-autostart.ps1
# 卸载：schtasks /Delete /TN "SScodeServer" /F

$ErrorActionPreference = 'Stop'
$serverRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start-windows.ps1'

$hidden = Join-Path $env:TEMP 'sscode-server-start.vbs'
@"
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$startScript""", 0, False
"@ | Set-Content -Path $hidden -Encoding ASCII

schtasks /Create /TN "SScodeServer" /TR "wscript.exe `"$hidden`"" /SC ONLOGON /F | Out-Null
Write-Host "已注册计划任务 SScodeServer（登录当前用户时后台启动）"
Write-Host "后台日志可用任务管理器查看 node.exe 进程；数据目录 %USERPROFILE%\.sscode"
