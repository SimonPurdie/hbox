[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [uri]$ActivationUri,

  [switch]$ResolveOnly
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
  exit 2
}

if (
  $ActivationUri.Scheme -ne 'hbox-launch' -or
  $ActivationUri.Host -ne 'launch'
) {
  exit 2
}

$ticket = $ActivationUri.AbsolutePath.Trim('/')
if ($ticket -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
  exit 2
}

$request = @{
  Uri = 'http://127.0.0.1:4269/api/native-launch/{0}' -f $ticket
  Headers = @{ 'X-HBOX-Native-Launcher' = '1' }
  ErrorAction = 'Stop'
}

try {
  $launch = Invoke-RestMethod @request
} catch {
  exit 1
}

$arguments = @($launch.args)
if (
  $launch.command -notin @('explorer.exe', 'wt.exe') -or
  $arguments.Where({ $_ -isnot [string] }).Count -ne 0
) {
  exit 2
}

if ($ResolveOnly) {
  $launch | ConvertTo-Json -Depth 4
  exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HboxForeground {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AllowSetForegroundWindow(uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr window);
}
'@

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = [string]$launch.command
$startInfo.UseShellExecute = $false
foreach ($argument in $arguments) {
  $startInfo.ArgumentList.Add($argument)
}

try {
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) {
    exit 1
  }

  [HboxForeground]::AllowSetForegroundWindow(
    [uint32]$process.Id
  ) | Out-Null
  try {
    $process.WaitForInputIdle(2000) | Out-Null
    $process.Refresh()
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
      [HboxForeground]::SetForegroundWindow(
        $process.MainWindowHandle
      ) | Out-Null
    }
  } catch {
    # Explorer and Terminal can pass work to an existing process.
  }
} catch {
  exit 1
}
