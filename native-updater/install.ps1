param(
  [Parameter(Mandatory = $true)][string]$ExtensionDir
)

$ErrorActionPreference = 'Stop'
$extensionId = 'hkoknpdlmemnbllkdijbcdbkkcmpljmf'
$hostName = 'com.mikelingo.updater'
$source = Join-Path $PSScriptRoot 'MikeLingoUpdater.cs'
$installDir = Join-Path $env:LOCALAPPDATA 'MikeLingoUpdater'
$exe = Join-Path $installDir 'MikeLingoUpdater.exe'
$manifest = Join-Path $installDir "$hostName.json"
$resolvedExtension = (Resolve-Path -LiteralPath $ExtensionDir).Path

if (-not (Test-Path -LiteralPath (Join-Path $resolvedExtension 'manifest.json'))) {
  throw "目标不是 MikeLingo 扩展目录：$resolvedExtension"
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
& $csc /nologo /target:exe /optimize+ "/out:$exe" /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll $source
if ($LASTEXITCODE -ne 0) { throw '本机更新助手编译失败' }

[IO.File]::WriteAllText((Join-Path $installDir 'install-path.txt'), $resolvedExtension, (New-Object Text.UTF8Encoding($false)))
$hostConfig = [ordered]@{
  name = $hostName
  description = 'MikeLingo Windows native updater'
  path = $exe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
}
[IO.File]::WriteAllText($manifest, ($hostConfig | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))

foreach ($key in @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)) {
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifest
}

Write-Host "REGISTERED $hostName"
Write-Host "EXTENSION $resolvedExtension"
Write-Host "HOST $exe"
