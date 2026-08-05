# AIRS Agent - Platform Administrator setup (Windows PowerShell wrapper).
#
#   .\scripts\platform-admin-setup.ps1 -Email wflack@anconisonpmg.com
#
# Reads AIRS_BOOTSTRAP_DATABASE_URL / AIRS_PUBLIC_BASE_URL from the current
# session (or the -DatabaseUrl / -BaseUrl parameters). Never store real
# credentials in this file or in a committed .env.
param(
  [Parameter(Mandatory = $true)][string]$Email,
  [string]$DatabaseUrl = $env:AIRS_BOOTSTRAP_DATABASE_URL,
  [string]$BaseUrl = $(if ($env:AIRS_PUBLIC_BASE_URL) { $env:AIRS_PUBLIC_BASE_URL } else { "http://localhost:3000" }),
  [int]$TtlSeconds = 259200,
  [switch]$NewLink,
  [switch]$ApplyMigrations,
  [switch]$ReportOnly
)

$ErrorActionPreference = "Stop"

if (-not $DatabaseUrl) {
  Write-Error "Set AIRS_BOOTSTRAP_DATABASE_URL or pass -DatabaseUrl (operator/owner role, not airs_app)."
  exit 1
}

$env:AIRS_BOOTSTRAP_DATABASE_URL = $DatabaseUrl
$env:AIRS_PUBLIC_BASE_URL = $BaseUrl

$cliArgs = @("--email", $Email, "--ttl", "$TtlSeconds")
if ($NewLink)         { $cliArgs += "--new-link" }
if ($ApplyMigrations) { $cliArgs += "--apply-migrations" }
if ($ReportOnly)      { $cliArgs += "--report-only" }

node "$PSScriptRoot/platform-admin-setup.mjs" @cliArgs
$code = $LASTEXITCODE

# Do not leave the operator connection string in the shell session.
Remove-Item Env:AIRS_BOOTSTRAP_DATABASE_URL -ErrorAction SilentlyContinue

exit $code
