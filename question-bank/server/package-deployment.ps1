param([ValidatePattern('^[a-zA-Z0-9._-]+$')][string]$Version = 'm3', [ValidateSet('m2','m3','m4','m5','m5.1','m6','m7','m8','m8.1')][string]$Milestone = 'm3')
$ErrorActionPreference = 'Stop'
$serverRoot = $PSScriptRoot
$bankRoot = Split-Path -Parent $serverRoot
$artifactRoot = Join-Path $bankRoot ('artifacts/' + $Milestone)
$archive = Join-Path $artifactRoot ('question-bank-server-' + $Version + '.zip')
if (Test-Path -LiteralPath $archive) { throw 'Choose a new version name; existing delivery archives are not overwritten.' }
$stage = Join-Path $artifactRoot ('deploy-source-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($name in @('src','public','package.json','package-lock.json','Dockerfile','.dockerignore','.env.example','DEPLOYMENT.md')) {
    Copy-Item -LiteralPath (Join-Path $serverRoot $name) -Destination $stage -Recurse
}
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -CompressionLevel Optimal
$files = Get-ChildItem -LiteralPath $stage -Recurse -File
$files | ForEach-Object { [pscustomobject]@{ Path=$_.FullName.Substring($stage.Length+1); SHA256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } } | ConvertTo-Json | Set-Content -LiteralPath ($archive + '.files.json')
Get-FileHash -LiteralPath $archive -Algorithm SHA256 | Select-Object Path,Hash | ConvertTo-Json | Set-Content -LiteralPath ($archive + '.sha256.json')
[pscustomobject]@{Archive=$archive;Stage=$stage;FileCount=$files.Count}
