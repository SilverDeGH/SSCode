# SScode 服务端 Windows 启动脚本
# 用法：powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
# 数据目录默认 %USERPROFILE%\.sscode，auth token 见该目录下 auth-token 文件。

$ErrorActionPreference = 'Stop'
$serverRoot = Split-Path -Parent $PSScriptRoot

$dataDir = Join-Path $env:USERPROFILE '.sscode'
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}

$env:SSCODE_DATA_DIR = $dataDir
$env:SSCODE_PORT = if ($env:SSCODE_PORT) { $env:SSCODE_PORT } else { '7823' }

Write-Host "sscode-server starting in $serverRoot"
Write-Host "data dir: $dataDir"
Set-Location $serverRoot
node src/index.ts
