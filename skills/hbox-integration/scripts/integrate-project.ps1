[CmdletBinding()]
param(
  [Parameter(ParameterSetName = 'Project', Position = 0)]
  [string]$Path = '.',

  [Parameter(ParameterSetName = 'Project')]
  [switch]$VerifyOnly,

  [Parameter(Mandatory, ParameterSetName = 'Contract')]
  [switch]$ShowContract,

  [uri]$ServerUri = 'http://127.0.0.1:4269'
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
  [Console]::Error.WriteLine('This helper requires PowerShell 7 or newer.')
  exit 2
}

$baseUri = $ServerUri.GetLeftPart([System.UriPartial]::Authority)
if ($ShowContract) {
  try {
    $response = Invoke-WebRequest -Uri (
      '{0}/api/integration/contract' -f $baseUri
    ) -ErrorAction Stop
    [Console]::Out.Write($response.Content)
    exit 0
  } catch {
    [Console]::Error.WriteLine(
      ('Could not read the HBOX contract: {0}' -f $_.Exception.Message)
    )
    exit 2
  }
}

try {
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw 'The project path is not a folder.'
  }
  $projectPath = $resolved.ProviderPath
} catch {
  [Console]::Error.WriteLine(
    ('Could not resolve the project folder: {0}' -f $_.Exception.Message)
  )
  exit 2
}

$headers = @{ Origin = $baseUri }
$body = @{ path = $projectPath } | ConvertTo-Json -Compress
$request = @{
  Method = 'Post'
  Headers = $headers
  ContentType = 'application/json'
  Body = $body
  ErrorAction = 'Stop'
}

try {
  $request['Uri'] = '{0}/api/entries/inspect' -f $baseUri
  $inspection = Invoke-RestMethod @request
} catch {
  [Console]::Error.WriteLine(
    ('Could not inspect the project with HBOX: {0}' -f $_.Exception.Message)
  )
  exit 2
}

[Console]::WriteLine('Effective HBOX integration:')
$inspection.effective | ConvertTo-Json -Depth 8
[Console]::WriteLine(
  ('Icon status: {0}' -f $inspection.icon.status)
)

if (-not $inspection.valid) {
  foreach ($issue in $inspection.issues) {
    [Console]::Error.WriteLine(('Issue: {0}' -f $issue))
  }
  exit 1
}

[Console]::WriteLine('HBOX integration is valid.')
if ($VerifyOnly) {
  exit 0
}

try {
  $statusCode = 0
  $request['Uri'] = '{0}/api/entries/register' -f $baseUri
  $request['StatusCodeVariable'] = 'statusCode'
  $entry = Invoke-RestMethod @request
} catch {
  [Console]::Error.WriteLine(
    ('Could not register the project with HBOX: {0}' -f $_.Exception.Message)
  )
  exit 2
}

$result = if ($statusCode -eq 201) {
  'Registered'
} else {
  'Already registered'
}
[Console]::WriteLine(
  ('{0}: {1} ({2})' -f $result, $entry.name, $entry.id)
)
