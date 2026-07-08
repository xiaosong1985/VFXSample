# reconcile-vfx-shaders.ps1
# Auto-fill compiled blueprint-shader products after conversion, to avoid runtime
# library/<uuid>@0.shader 404s.
#
# Why: the Unity plugin bakes shaderRes = res://<uuid> into the VFX, but that .bps is
# compiled lazily by the Laya IDE (only when previewed), so @0.shader may be missing.
# This script scans every (shaderName, uuid) referenced by the project's VFX, and for
# any uuid whose library/<uuid>@0.shader is missing, copies the product from any already
# compiled version of the SAME shader name (this project first, else the reference project).
# Compiled products are keyed by shader name (no uuid inside), so cross-uuid reuse is safe.
#
# Usage: powershell -ExecutionPolicy Bypass -File reconcile-vfx-shaders.ps1 [-Project <dir>] [-RefProject <dir>]
param(
  [string]$Project    = "F:\git\LayaAir3.0\VFXSample",
  [string]$RefProject = "F:\git\LayaAir3.0\LayaVFXSample"
)

$lib    = Join-Path $Project    "library"
$refLib = Join-Path $RefProject "library"

# 1) Map shaderName(caption) -> compiled product base path (this project wins, then ref project)
$byName = @{}
foreach ($L in @($lib, $refLib)) {
  if (-not (Test-Path $L)) { continue }
  Get-ChildItem $L -Recurse -Filter "*.json" -ErrorAction SilentlyContinue | ForEach-Object {
    $base = $_.FullName -replace '\.json$',''
    if (-not (Test-Path ($base + '@0.shader'))) { return }
    try { $j = Get-Content $_.FullName -Raw | ConvertFrom-Json } catch { return }
    $cap = $j.caption
    if ($cap -and -not $byName.ContainsKey($cap)) { $byName[$cap] = $base }
  }
}

# 2) Collect uuid -> shaderName from .laya.vfx sources + compiled .lvfx
$refs = @{}
$vfx = @()
$vfx += Get-ChildItem (Join-Path $Project "assets") -Recurse -Filter "*.laya.vfx" -ErrorAction SilentlyContinue
$vfx += Get-ChildItem $lib -Recurse -Filter "*.lvfx" -ErrorAction SilentlyContinue
$rx = [regex]'"(?:customShaderName|shaderName)"\s*:\s*"([^"]+)"\s*,\s*"(?:customShaderRes|shaderRes)"\s*:\s*"res://([0-9a-fA-F-]{36})"'
foreach ($f in $vfx) {
  $t = Get-Content $f.FullName -Raw
  foreach ($m in $rx.Matches($t)) { $refs[$m.Groups[2].Value] = $m.Groups[1].Value }
}

# 3) For each uuid: if product missing, copy by shader name
$ok = 0; $fixed = 0; $need = @()
foreach ($uuid in $refs.Keys) {
  $name = $refs[$uuid]
  $pfx  = $uuid.Substring(0,2)
  if (Test-Path ("$lib\$pfx\$uuid" + '@0.shader')) { $ok++; continue }
  if ($byName.ContainsKey($name)) {
    $srcBase = $byName[$name]
    New-Item -ItemType Directory -Force "$lib\$pfx" | Out-Null
    foreach ($suf in @('.json','@0.shader','@1.shader')) {
      if (Test-Path ($srcBase + $suf)) { Copy-Item ($srcBase + $suf) ("$lib\$pfx\$uuid" + $suf) -Force }
    }
    $fixed++; Write-Output ("  [FIX] " + $name + "  ->  " + $uuid)
  } else {
    $need += ($name + "  (" + $uuid + ")")
  }
}

Write-Output ""
Write-Output ("Shaders referenced: " + $refs.Count + "  |  already-ok: " + $ok + "  |  auto-filled: " + $fixed + "  |  no-source: " + $need.Count)
if ($need.Count -gt 0) {
  Write-Output "WARN: these shaders are not compiled anywhere. Open each .bps in the Laya IDE and save once, then re-run:"
  foreach ($n in $need) { Write-Output ("    " + $n) }
}
