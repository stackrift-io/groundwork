# Install Groundwork for OpenCode (Windows PowerShell; also PowerShell 7 on macOS and Linux).
# Run it from this folder: powershell -File install.ps1
# Copies this folder to ~\.config\opencode\groundwork\, then writes the /groundwork command and the gw-orchestrator agent
# into ~\.config\opencode\commands\ and ~\.config\opencode\agents\. The stage agents are not installed globally:
# /groundwork init generates them per repository in .opencode\agents\.
$ErrorActionPreference = "Stop"

$Src = $PSScriptRoot
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$Config = Join-Path (Join-Path $UserHome ".config") "opencode"
$Dest = Join-Path $Config "groundwork"

foreach ($f in @("commands/groundwork.md", "agents/gw-orchestrator.md", "scripts/gw.mjs")) {
  if (-not (Test-Path (Join-Path $Src $f))) {
    Write-Error "Run this script from the Groundwork OpenCode folder (commands\, agents\ and scripts\ must sit next to it)."
  }
}
if ((Test-Path $Dest) -and ((Resolve-Path $Src).Path -eq (Resolve-Path $Dest).Path)) {
  Write-Error "This is the installed copy; run the installer from the downloaded folder instead."
}

New-Item -ItemType Directory -Force -Path $Config | Out-Null
# One backup folder for everything this install replaces: the old install folder, and the command and the orchestrator agent
# it overwrites (under previous-config\), whoever wrote them.
$CmdFile = Join-Path (Join-Path $Config "commands") "groundwork.md"
$AgentFile = Join-Path (Join-Path $Config "agents") "gw-orchestrator.md"
if ((Test-Path $Dest) -or (Test-Path $CmdFile) -or (Test-Path $AgentFile)) {
  $BackupDir = Join-Path $Config "groundwork-backups"
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  $Stamp = Get-Date -Format yyyyMMdd-HHmmss
  $Backup = Join-Path $BackupDir "groundwork-$Stamp"
  $n = 1
  while (Test-Path $Backup) { $Backup = Join-Path $BackupDir "groundwork-$Stamp-$n"; $n++ }
  if (Test-Path $Dest) { Move-Item $Dest $Backup } else { New-Item -ItemType Directory -Force -Path $Backup | Out-Null }
  foreach ($Pair in @(@($CmdFile, "commands"), @($AgentFile, "agents"))) {
    if (Test-Path $Pair[0]) {
      $To = Join-Path (Join-Path $Backup "previous-config") $Pair[1]
      New-Item -ItemType Directory -Force -Path $To | Out-Null
      Copy-Item -Force $Pair[0] (Join-Path $To (Split-Path -Leaf $Pair[0]))
    }
  }
  Write-Host "Existing install backed up to $Backup"
}
Copy-Item -Recurse $Src $Dest

# The command names the absolute Groundwork home (forward slashes): OpenCode has no plugin-root variable.
$Commands = Join-Path $Config "commands"
$Agents = Join-Path $Config "agents"
New-Item -ItemType Directory -Force -Path $Commands | Out-Null
New-Item -ItemType Directory -Force -Path $Agents | Out-Null
$GwHome = $Dest.Replace("\", "/")
$Text = [IO.File]::ReadAllText((Join-Path $Src "commands/groundwork.md")).Replace("@@GW_HOME@@", $GwHome)
[IO.File]::WriteAllText((Join-Path $Commands "groundwork.md"), $Text, (New-Object System.Text.UTF8Encoding $false))
Copy-Item -Force (Join-Path $Src "agents/gw-orchestrator.md") (Join-Path $Agents "gw-orchestrator.md")

Write-Host "Groundwork installed at $Dest"
Write-Host "Start OpenCode in a repository and type: /groundwork init"
