param([Parameter(Mandatory=$true)][string]$Tag)
$ErrorActionPreference = 'Stop'
if ($Tag -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$') { throw 'Invalid image tag' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $repoRoot
try {
  $keyRecord = aws location describe-key --profile airs-10573-deploy --region us-east-2 --key-name airs-agent-staging-maps --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or !$keyRecord.Key) { throw 'Staging map key unavailable; refusing a mapless release' }
  if (($keyRecord.Restrictions.AllowReferers -join ',') -ne 'https://staging.airsagent.com/*' -or ($keyRecord.Restrictions.AllowActions -join ',') -ne 'geo-maps:GetTile') { throw 'Unexpected staging map key restrictions' }
  $env:VITE_MAP_STYLE_URL = 'https://maps.geo.us-east-2.amazonaws.com/v2/styles/Standard/descriptor?key=' + $keyRecord.Key
  $argsForBuild = @('build','--platform','linux/arm64','--target','runtime','--build-arg','VITE_MAP_STYLE_URL','-t',"578856792953.dkr.ecr.us-east-2.amazonaws.com/airs-agent-staging:$Tag")
  if (Test-Path 'work/windows-trust.pem') { $argsForBuild += @('--secret','id=build_ca,src=work/windows-trust.pem') }
  if ($env:AIRS_BUILD_PROXY) { $argsForBuild += @('--build-arg',"HTTPS_PROXY=$env:AIRS_BUILD_PROXY",'--build-arg',"HTTP_PROXY=$env:AIRS_BUILD_PROXY") }
  & docker @argsForBuild .
  if ($LASTEXITCODE -ne 0) { throw 'Staging build failed' }
} finally {
  Remove-Item Env:VITE_MAP_STYLE_URL -ErrorAction SilentlyContinue
  Pop-Location
}
