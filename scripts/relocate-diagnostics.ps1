$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$private = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $repo) 'optimizely-find-research/diagnostics-from-server'))
if ((Split-Path -Leaf $repo) -ne 'optimizely-find-server') { throw 'Unexpected repository root' }
if ($private.StartsWith($repo + [IO.Path]::DirectorySeparatorChar)) { throw 'Private destination must be outside the repository' }
$proof = Join-Path $repo 'data/foundation-proof/store.json'
$before = (Get-FileHash -LiteralPath $proof -Algorithm SHA256).Hash
$relativePaths = @('.tmp', '.test-runtime', 'data/.test-runtime', 'data/.recording-check')
$relativePaths += @(Get-ChildItem -LiteralPath (Split-Path -Parent $proof) -File | Where-Object Name -Match '^round\d+-' | ForEach-Object { 'data/foundation-proof/' + $_.Name })
$moves = @()
foreach ($path in $relativePaths) {
  $source = [IO.Path]::GetFullPath((Join-Path $repo $path))
  $target = [IO.Path]::GetFullPath((Join-Path $private $path))
  if (!$source.StartsWith($repo + [IO.Path]::DirectorySeparatorChar) -or $source -eq $proof) { throw 'Source escaped diagnostic scope' }
  if (!$target.StartsWith($private + [IO.Path]::DirectorySeparatorChar)) { throw 'Destination escaped private folder' }
  if (!(Test-Path -LiteralPath $source)) { continue }
  if (Test-Path -LiteralPath $target) { throw 'Destination already exists; no files moved' }
  $moves += [pscustomobject]@{Source=$source; Target=$target}
}
New-Item -ItemType Directory -Path $private -Force | Out-Null
foreach ($move in $moves) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $move.Target) -Force | Out-Null
  Move-Item -LiteralPath $move.Source -Destination $move.Target
}
if ((Get-FileHash -LiteralPath $proof -Algorithm SHA256).Hash -ne $before) { throw 'Proof store changed' }
Write-Output "Moved $($moves.Count) diagnostic paths; Foundation proof hash unchanged."
node (Join-Path $PSScriptRoot 'check-clean-room.js') $repo
if ($LASTEXITCODE -ne 0) { throw 'Whole-folder clean-room check still fails' }
