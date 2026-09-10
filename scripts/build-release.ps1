param(
  [string]$NodeVersion = '24.21.0'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
$stagingRoot = Join-Path $releaseRoot '.staging'
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$packageName = "分镜审核台-v$version-Windows"
$packageRoot = Join-Path $stagingRoot $packageName
$zipPath = Join-Path $releaseRoot "$packageName.zip"
$cacheRoot = Join-Path $releaseRoot 'cache'
$nodeArchive = Join-Path $cacheRoot "node-v$NodeVersion-win-x64.zip"
$nodeExtract = Join-Path $cacheRoot "node-v$NodeVersion-win-x64"

function Assert-ChildPath([string]$Candidate, [string]$Parent) {
  $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作非发布目录：$candidateFull"
  }
}

New-Item -ItemType Directory -Force -Path $releaseRoot, $cacheRoot | Out-Null
Assert-ChildPath $stagingRoot $releaseRoot
if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

$sourceItems = @(
  'app',
  'server',
  'plugin',
  'node_modules',
  'scripts/install.mjs',
  'docs',
  'package.json',
  '一键安装.cmd',
  '一键启动.cmd'
)

foreach ($item in $sourceItems) {
  $source = Join-Path $projectRoot $item
  $destination = Join-Path $packageRoot $item
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/安装与使用.md') -Destination (Join-Path $packageRoot '使用说明.md') -Force

if (-not (Test-Path -LiteralPath $nodeArchive)) {
  $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
  Write-Host "下载官方 Node.js 运行环境：$nodeUrl"
  Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeArchive
}

if (-not (Test-Path -LiteralPath $nodeExtract)) {
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $cacheRoot -Force
}

$runtimeDir = Join-Path $packageRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeExtract 'node.exe') -Destination (Join-Path $runtimeDir 'node.exe') -Force
Copy-Item -LiteralPath (Join-Path $nodeExtract 'LICENSE') -Destination (Join-Path $runtimeDir 'NODE-LICENSE.txt') -Force

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
Set-Content -LiteralPath "$zipPath.sha256.txt" -Value "$hash  $([System.IO.Path]::GetFileName($zipPath))" -Encoding ascii

Write-Host "发布包已生成：$zipPath"
Write-Host "SHA256：$hash"
