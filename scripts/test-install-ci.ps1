# Tests site/install-ci.ps1, breakpatch-ci's install command for Windows, on a real Windows
# machine against a real release: the half scripts/test-install-ci.sh can't do with pwsh on
# Linux. The registry (the user's PATH), the .cmd that cmd.exe runs, a user folder with a space
# and an accent in it, Windows' own tar and code pages, and the release's real files.
#
#   powershell -ExecutionPolicy Bypass -File scripts\test-install-ci.ps1 [-Version 0.1.0-beta.2]
#   pwsh -File scripts\test-install-ci.ps1
#
# .github/workflows/windows-install.yml runs it by hand (Actions, Windows install, Run workflow)
# in Windows PowerShell 5.1 and in PowerShell 7 on windows-latest. Without -Version (or
# BP_TEST_VERSION) it installs GitHub's Latest release. It downloads the release's files, the
# Python packages from PyPI, Chromium twice and Python 3.11 from python-build-standalone once,
# so it needs the network and takes a while. Every install goes into a folder of its own in
# RUNNER_TEMP (or %TEMP%), standing in for %LOCALAPPDATA%. The user's PATH in HKCU\Environment
# is changed for real, and put back as it was at the end: on a PC of your own, run it as a user
# you don't mind that for.
#
# The cases, each running install-ci.ps1 from this working tree in a new PowerShell like the one
# running this (powershell.exe or pwsh.exe), the way a CI step or a new window would:
#   1. Install into %LOCALAPPDATA%\breakpatch-ci for a user named "Jos<e acute> Test", with the
#      Python 3.11 the machine has. breakpatch-ci --version through bin\breakpatch-ci.cmd (from
#      PowerShell, and from cmd.exe with PATH as a new window gets it from the registry) says
#      the version; the .cmd is plain ASCII with CRLF line endings and passes the exit code on;
#      the user's PATH in HKCU\Environment has the bin folder once, is REG_EXPAND_SZ, and a
#      %USERPROFILE%\... entry in it is still written that way; path-added.txt in the install
#      folder notes that the installer added it. It starts when cmd.exe is given
#      its name in quotes too. One thing a .cmd may not do is a warning (::warning), not a
#      failure: let a batch file that runs it without `call` go on afterwards.
#   2. Install again: still one PATH entry, one environment, the old one gone.
#   3. In GitHub Actions (GITHUB_PATH set): the folder goes to GITHUB_PATH as UTF-8, the
#      registry isn't touched.
#   4. irm | iex in one window: PIP_INDEX_URL, PIP_NO_INPUT, PIP_DISABLE_PIP_VERSION_CHECK and
#      PLAYWRIGHT_BROWSERS_PATH are as they were afterwards, and Chromium didn't go into the
#      user's PLAYWRIGHT_BROWSERS_PATH.
#   5. With BP_TEST_GITHUB_TOKEN set, an install with it as BREAKPATCH_GITHUB_TOKEN (the
#      asset addresses on api.github.com, and the redirect without the token).
#   6. Uninstall in that window ($env:BREAKPATCH_UNINSTALL = "1"; irm | iex): a file and a folder
#      of the user's in the install folder stay, the installer's own files (path-added.txt too)
#      and bin\ go, the PATH entry the installer added goes, and BREAKPATCH_UNINSTALL is cleared.
#      Again: "Nothing to remove."
#   7. Another user folder with no Python on PATH and BREAKPATCH_CI_BIN elsewhere: Python 3.11
#      is downloaded (its SHA-256, Windows' tar), the .cmd names the install folder in the OEM
#      code page and runs in a new console, which starts in it (from this test's own console,
#      when that has another code page, only a warning); then the uninstall removes it all,
#      the PATH entry the installer added included.
#   8. BREAKPATCH_CI_BIN a folder that was on the user's PATH before the install: the installer
#      notes nothing (no path-added.txt), and the uninstall leaves the entry where it was.
#
# Each failure is a "FAIL" line in the log and, in GitHub Actions, an annotation
# (::error title=test-install-ci.ps1::...) saying which step failed with the key lines of what
# it printed, because only the check run's annotations can be read where the maintainers work,
# not the job's log. GitHub keeps 10 error annotations per step: after 8, the rest are listed in
# one more. Works in Windows PowerShell 5.1 and PowerShell 7. ASCII only, so 5.1 reads it right.

[CmdletBinding()]
param(
  [string] $Version = $env:BP_TEST_VERSION
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$shellExe = (Get-Process -Id $PID).Path
$shellLabel = "$([IO.Path]::GetFileNameWithoutExtension($shellExe)) $($PSVersionTable.PSVersion)"
$script:step = 'set-up'
$script:pass = 0
$script:failures = New-Object System.Collections.ArrayList
$script:overflow = New-Object System.Collections.ArrayList
$script:shown = 0

# ---------------------------------------------------------------- reporting

# An annotation for the check run, in GitHub Actions only. One line: % and line breaks escaped.
function Write-Annotation([string] $kind, [string] $text) {
  if ($env:GITHUB_ACTIONS -ne 'true') { return }
  if ($text.Length -gt 3800) { $text = $text.Substring(0, 3800) + ' [...]' }
  $text = $text.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
  Write-Host "::$kind title=test-install-ci.ps1::$text"
}
function Enter-Step([string] $name) {
  $script:step = $name
  Write-Host ''
  Write-Host "$shellLabel`: $name"
}
function Ok([string] $what) {
  $script:pass++
  Write-Host "  ok    $what"
}
function Write-Detail([string] $detail) {
  if ($detail) { foreach ($l in ($detail -split "`r?`n")) { Write-Host "        $l" } }
}
function Bad([string] $what, [string] $detail = '') {
  $line = "$($script:step): $what"
  [void]$script:failures.Add($line)
  Write-Host "  FAIL  $what"
  Write-Detail $detail
  $text = "[$shellLabel] $line"
  if ($detail) { $text += "`n" + $detail }
  if ($script:shown -lt 8) { $script:shown++; Write-Annotation 'error' $text } else { [void]$script:overflow.Add($line) }
}
function Warn([string] $what, [string] $detail = '') {
  Write-Host "  WARN  $what"
  Write-Detail $detail
  $text = "[$shellLabel] $($script:step): $what"
  if ($detail) { $text += "`n" + $detail }
  Write-Annotation 'warning' $text
}

# What a run printed that says why it failed: its exit code, stderr, and stdout's last lines.
function Get-RunSummary($r, [int] $n = 12) {
  $lines = New-Object System.Collections.ArrayList
  if ($r.TimedOut) { [void]$lines.Add("still running after $($r.Seconds) s, stopped") } else { [void]$lines.Add("exit code $($r.Code)") }
  $err = @(($r.Err -split "`r?`n") | Where-Object { $_.Trim() })
  if ($err.Count -gt 0) {
    [void]$lines.Add('stderr:')
    foreach ($l in ($err | Select-Object -Last $n)) { [void]$lines.Add("  $l") }
  }
  $out = @(($r.Out -split "`r?`n") | Where-Object { $_.Trim() })
  if ($out.Count -gt 0) {
    [void]$lines.Add("stdout (last $n lines):")
    foreach ($l in ($out | Select-Object -Last $n)) { [void]$lines.Add("  $l") }
  }
  return ($lines -join "`n")
}

# ---------------------------------------------------------------- running things

# A program with exactly this command line (no PowerShell quoting in between, the same in 5.1
# and 7), these variables changed in its environment ($null removes one), output captured, and
# stopped (with what it started) after $timeoutSec.
function Invoke-Child([string] $exe, [string] $arguments, [hashtable] $vars = @{}, [string] $cwd = '', [int] $timeoutSec = 300) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = $arguments
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  if ($cwd) { $psi.WorkingDirectory = $cwd }
  foreach ($k in @($vars.Keys)) {
    if ($null -eq $vars[$k]) { $psi.EnvironmentVariables.Remove($k) } else { $psi.EnvironmentVariables[$k] = [string]$vars[$k] }
  }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $p = [Diagnostics.Process]::Start($psi)
  $p.StandardInput.Close()
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $timedOut = -not $p.WaitForExit($timeoutSec * 1000)
  if ($timedOut) {
    $null = Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList "/PID $($p.Id) /T /F" -NoNewWindow -Wait -PassThru
    try { $p.Kill() } catch { Write-Verbose "already stopped: $_" }
    $null = $p.WaitForExit(30000)
  } else {
    $p.WaitForExit()
  }
  $out = if ($outTask.Wait(30000)) { $outTask.Result } else { '' }
  $err = if ($errTask.Wait(30000)) { $errTask.Result } else { '' }
  $code = if ($timedOut) { -1 } else { $p.ExitCode }
  return [pscustomobject]@{ Code = $code; Out = [string]$out; Err = [string]$err; TimedOut = $timedOut; Seconds = [int]$watch.Elapsed.TotalSeconds }
}

# install-ci.ps1 from the working tree with -File, as a CI step or `powershell -File` runs it;
# with -Session, through scripts' wrapper that runs it with irm | iex's Invoke-Expression in one
# PowerShell and then prints the variables named in BP_TEST_SHOW, as "BPTEST NAME=[value]".
function Invoke-Installer([hashtable] $vars, [switch] $Session) {
  $all = @{}
  foreach ($k in $baseVars.Keys) { $all[$k] = $baseVars[$k] }
  foreach ($k in $vars.Keys) { $all[$k] = $vars[$k] }
  $file = if ($Session) { $sessionWrapper } else { $installer }
  Write-Host "  (running install-ci.ps1$(if ($Session) { ' with Invoke-Expression' }))"
  $r = Invoke-Child $shellExe "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$file`"" $all $root 1500
  Write-Host "  (done in $($r.Seconds) s, exit $($r.Code))"
  return $r
}

# The run worked and said each of these.
function Test-Run($r, [string[]] $says) {
  if ($r.Code -ne 0) { Bad 'install-ci.ps1 failed' (Get-RunSummary $r); return $false }
  Ok 'install-ci.ps1 exit 0'
  foreach ($s in $says) {
    if ($r.Out.Contains($s)) { Ok "says: $s" } else { Bad "doesn't say: $s" (Get-RunSummary $r) }
  }
  return $true
}

# The .cmd from PowerShell: its exit code, stdout and stderr.
function Invoke-Shim([string] $shim, [string[]] $argv) {
  $was = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $o = @(& $shim @argv 2>&1)
    $out = @($o | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    $err = @($o | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out -join "`n").Trim(); Err = ($err -join "`n").Trim() }
  } catch {
    return [pscustomobject]@{ Code = -1; Out = ''; Err = "$_" }
  } finally {
    $ErrorActionPreference = $was
  }
}

# ---------------------------------------------------------------- the user's PATH

$envKeyName = 'Environment'
# HKCU\Environment's Path as written (%VARS% not expanded) and its kind; $null when there's none.
function Get-UserPath {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($envKeyName)
  if (-not $k) { return $null }
  try {
    if (@($k.GetValueNames()) -notcontains 'Path') { return $null }
    return [pscustomobject]@{
      Value = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      Kind = $k.GetValueKind('Path')
    }
  } finally {
    $k.Close()
  }
}
function Write-UserPath($saved) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($envKeyName)
  try {
    if ($null -eq $saved) { $k.DeleteValue('Path', $false) } else { $k.SetValue('Path', $saved.Value, $saved.Kind) }
  } finally {
    $k.Close()
  }
}
# How many of the PATH's entries are this folder, as Windows reads them (%VARS% expanded).
function Get-EntryCount([string] $raw, [string] $dir) {
  $want = $dir.TrimEnd('\')
  return @($raw -split ';' | Where-Object { $_ -and [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -eq $want }).Count
}
# PATH as a window opened now gets it: the machine's, then the user's from the registry.
function Get-NewWindowPath {
  $u = Get-UserPath
  $user = if ($u) { [Environment]::ExpandEnvironmentVariables($u.Value) } else { '' }
  return [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + $user
}

# The user's PATH has $dir $want times; when it should be there, also: REG_EXPAND_SZ (as .NET
# and reg.exe see it), and the %USERPROFILE% entry planted at the start still written that way.
function Test-UserPath([string] $dir, [int] $want, [string] $label) {
  $u = Get-UserPath
  if (-not $u) { Bad "HKCU\Environment has no Path value at all"; return }
  $n = Get-EntryCount $u.Value $dir
  if ($n -eq $want) { Ok "the user's PATH has $label $want time(s)" }
  else { Bad "the user's PATH has $label $n time(s), expected $want" "HKCU\Environment Path (as written): $($u.Value)" }
  if (@($u.Value -split ';') -contains $planted) { Ok "the user's PATH still has $planted, unexpanded" }
  else { Bad "the user's PATH lost $planted, or it was expanded" "HKCU\Environment Path (as written): $($u.Value)" }
  if ($u.Kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) { Ok "the user's PATH is REG_EXPAND_SZ" }
  else { Bad "the user's PATH is $($u.Kind), not ExpandString (REG_EXPAND_SZ)" }
  $q = Invoke-Child "$env:SystemRoot\System32\reg.exe" 'query HKCU\Environment /v Path'
  if ($q.Code -eq 0 -and $q.Out -match '(?im)^\s*Path\s+REG_EXPAND_SZ\s') { Ok 'reg.exe query says REG_EXPAND_SZ' }
  else { Bad "reg.exe query doesn't say REG_EXPAND_SZ" (Get-RunSummary $q) }
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($envKeyName)
  try { $left = @($k.GetValueNames()) -contains 'BREAKPATCH_CI_PATH_CHANGED' } finally { $k.Close() }
  if (-not $left) { Ok 'no BREAKPATCH_CI_PATH_CHANGED left in HKCU\Environment' } else { Bad 'BREAKPATCH_CI_PATH_CHANGED is left in HKCU\Environment' }
}

# ---------------------------------------------------------------- checks of an install

# path-added.txt in the install folder names the bin folder the installer added to the user's
# PATH (so the uninstall takes that entry out, and no other); with no $bin, there's none.
function Test-PathNote([string] $ciHome, [string] $bin = '') {
  $note = Join-Path $ciHome 'path-added.txt'
  $has = Test-Path -LiteralPath $note
  if (-not $bin) {
    if (-not $has) { Ok 'no path-added.txt: the installer added nothing to PATH' } else { Bad "there's a path-added.txt: $([IO.File]::ReadAllText($note, [Text.Encoding]::UTF8))" }
    return
  }
  $named = if ($has) { [IO.File]::ReadAllText($note, [Text.Encoding]::UTF8).Trim() } else { '' }
  if ($named -eq $bin) { Ok 'path-added.txt names the bin folder the installer added to PATH' }
  else { Bad "path-added.txt names '$named', expected $bin" }
}

function Get-EnvDir([string] $ciHome) {
  if (-not (Test-Path -LiteralPath $ciHome)) { return @() }
  return @(Get-ChildItem -LiteralPath $ciHome -Directory -Filter 'env-*' -Force)
}
function Get-CurrentEnv([string] $ciHome) {
  $c = Join-Path $ciHome 'current.txt'
  if (-not (Test-Path -LiteralPath $c)) { return '' }
  return [string](Get-Content -LiteralPath $c -TotalCount 1)
}

# The console code page this test runs in (cmd.exe reads a batch file in it): GitHub Actions' job
# console needn't be the OEM code page a new console starts in. 0 when there's none to read.
function Get-ConsoleCodePage {
  try { return [Console]::OutputEncoding.CodePage } catch { return 0 }
}

# breakpatch-ci in $ciHome, started by $shim: from PowerShell, and from cmd.exe by name with
# PATH as a new window would have it, in another folder. $shimCp: the code page a .cmd that names
# the install folder is written in (case 7), as install-ci.ps1 promises it for a new console. When
# this console's is another, the .cmd is started in a new console (Invoke-Child's: hidden, in the
# OEM code page), and from this one only as a warning: cmd.exe can't read the path in it here.
function Test-Installed([string] $ciHome, [string] $shim, [int] $shimCp = 0) {
  $envName = Get-CurrentEnv $ciHome
  if ($envName -match '^env-') { Ok "current.txt names $envName" } else { Bad "current.txt names '$envName'" }
  $n = @(Get-EnvDir $ciHome).Count
  if ($n -eq 1) { Ok 'one environment in the install folder' } else { Bad "$n environments in the install folder, expected 1" }
  $browsers = Join-Path $ciHome 'browsers'
  if ((Test-Path -LiteralPath $browsers) -and @(Get-ChildItem -LiteralPath $browsers -Directory -Filter 'chromium*').Count -gt 0) { Ok 'Chromium is in the install folder''s browsers' }
  else { Bad "no chromium* folder in browsers" "browsers: $(@(Get-ChildItem -LiteralPath $ciHome -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ', ')" }
  $venvPy = Join-Path $ciHome "$envName\Scripts\python.exe"
  $exe = Join-Path $ciHome "$envName\Scripts\breakpatch-ci.exe"
  if (-not ($envName -and (Test-Path -LiteralPath $venvPy) -and (Test-Path -LiteralPath $exe))) { Bad "the environment has no Scripts\python.exe or Scripts\breakpatch-ci.exe"; return }
  $v = Invoke-Child $venvPy '-c "import sys; print(sys.version_info[:2] == (3, 11))"'
  if ($v.Out.Trim() -eq 'True') { Ok 'the environment is Python 3.11' } else { Bad "the environment isn't Python 3.11" (Get-RunSummary $v) }
  $left = @(Get-ChildItem -LiteralPath $tmp -Force -Filter 'breakpatch-ci-install-*' -ErrorAction SilentlyContinue)
  if ($left.Count -eq 0) { Ok "the installer's temporary folder is gone" } else { Bad "the installer left $($left[0].Name) in TEMP" }

  if (-not (Test-Path -LiteralPath $shim)) { Bad "there's no $shim"; return }
  $consoleCp = Get-ConsoleCodePage
  $newConsole = $shimCp -ne 0 -and $consoleCp -ne $shimCp
  $s = Invoke-Shim $shim @('--version')
  if ($s.Code -eq 0 -and $s.Out -eq $Version) { Ok "breakpatch-ci.cmd --version (from PowerShell): $Version" }
  elseif ($newConsole) {
    Warn "breakpatch-ci.cmd --version from this PowerShell says '$($s.Out)', exit $($s.Code): the .cmd names the install folder in code page $shimCp, this console's is $consoleCp, and cmd.exe reads a batch file in the console's code page. A new console starts in $shimCp." "stderr: $($s.Err)"
  } else { Bad "breakpatch-ci.cmd --version (from PowerShell) says '$($s.Out)', exit $($s.Code); expected $Version" "stderr: $($s.Err)" }
  if ($newConsole) {
    $s = Invoke-Child $env:ComSpec "/d /s /c `"`"$shim`" --version`"" @{} $root 120
    if ($s.Code -eq 0 -and $s.Out.Trim() -eq $Version) { Ok "breakpatch-ci.cmd --version in a new console (code page $shimCp): $Version" }
    else { Bad "breakpatch-ci.cmd --version in a new console didn't say $Version" (Get-RunSummary $s) }
  }
  $c = Invoke-Child $env:ComSpec '/d /c breakpatch-ci --version' @{ Path = (Get-NewWindowPath) } $root 120
  if ($c.Code -eq 0 -and $c.Out.Trim() -eq $Version) { Ok "cmd /c breakpatch-ci --version, PATH from the registry: $Version" }
  else { Bad "cmd /c breakpatch-ci --version with PATH from the registry didn't say $Version" (Get-RunSummary $c) }
  # A quoted name found on PATH: cmd.exe fills a batch file's own %~dp0 in wrong for that (the
  # current folder), so the .cmd reads it in a subroutine, where it's right.
  $c = Invoke-Child $env:ComSpec '/d /s /c ""breakpatch-ci" --version"' @{ Path = (Get-NewWindowPath) } $root 120
  if ($c.Code -eq 0 -and $c.Out.Trim() -eq $Version) { Ok "cmd /c `"breakpatch-ci`" --version (quoted name): $Version" }
  else { Bad "cmd /c `"breakpatch-ci`" --version (the name in quotes, found on PATH) didn't say $Version" (Get-RunSummary $c) }
  # The exit code comes through the .cmd: the same as the environment's own breakpatch-ci.exe's.
  $direct = Invoke-Child $exe '--bp-test-no-such-option'
  $via = if ($newConsole) { Invoke-Child $env:ComSpec "/d /s /c `"`"$shim`" --bp-test-no-such-option`"" @{} $root 120 } else { Invoke-Shim $shim @('--bp-test-no-such-option') }
  if ($direct.Code -eq 0) { Write-Host "  (breakpatch-ci.exe exits 0 for an unknown option: exit code pass-through not checked)" }
  elseif ($via.Code -eq $direct.Code) { Ok "the .cmd passes the exit code on ($($via.Code))" }
  else { Bad "breakpatch-ci.exe exits $($direct.Code) for an unknown option, the .cmd $($via.Code)" }
  # A variable named ERRORLEVEL (which %ERRORLEVEL% would read) doesn't hide the exit code.
  if ($direct.Code -ne 0) {
    $set = Invoke-Child $env:ComSpec '/d /c breakpatch-ci --bp-test-no-such-option' @{ Path = (Get-NewWindowPath); ERRORLEVEL = '0' } $root 120
    if ($set.Code -eq $direct.Code) { Ok "with a variable ERRORLEVEL=0 set, the .cmd still passes the exit code on ($($set.Code))" }
    else { Bad "with a variable ERRORLEVEL=0 set, the .cmd exits $($set.Code), breakpatch-ci.exe $($direct.Code)" (Get-RunSummary $set) }
  }
}

# ---------------------------------------------------------------- set-up

$e = [string][char]0x00E9   # e acute, written so the file stays ASCII
$planted = '%USERPROFILE%\bp-test-unexpanded'
$savedPath = $null
$registryTouched = $false
$root = $null
$token = $env:BP_TEST_GITHUB_TOKEN
Remove-Item Env:\BP_TEST_GITHUB_TOKEN -ErrorAction SilentlyContinue   # nothing this starts gets it, but case 5's install
$stoppedBy = $null

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Write-Host 'test-install-ci.ps1 tests install-ci.ps1 on Windows. On Linux, scripts/test-install-ci.sh runs it with pwsh.'
    exit 2
  }
  $repo = Split-Path -Parent $PSScriptRoot
  $installer = Join-Path $repo 'site\install-ci.ps1'
  if (-not (Test-Path -LiteralPath $installer)) { throw "There's no $installer." }

  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }
  $versionVar = $null
  if ($Version) {
    $Version = $Version -replace '^v', ''
    $versionVar = $Version
  } else {
    $headers = @{}
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    $latest = Invoke-RestMethod -Uri 'https://api.github.com/repos/BreakPatch/breakpatch/releases/latest' -Headers $headers -UserAgent 'breakpatch-test-install-ci'
    $Version = ([string]$latest.tag_name) -replace '^v', ''
  }

  $base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
  $root = Join-Path $base ('bp-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
  $tmp = Join-Path $root 'tmp'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $sessionWrapper = Join-Path $root 'session.ps1'
  Set-Content -LiteralPath $sessionWrapper -Encoding ASCII -Value @(
    '$ProgressPreference = ''SilentlyContinue'''
    'Get-Content -Raw -LiteralPath $env:BP_TEST_INSTALLER | Invoke-Expression'
    'foreach ($n in ([string]$env:BP_TEST_SHOW -split '','')) { if ($n) { ''BPTEST '' + $n + ''=['' + [Environment]::GetEnvironmentVariable($n) + '']'' } }'
  )
  # Every run: no GITHUB_PATH (unless given), no BREAKPATCH_* from outside, TEMP of its own.
  $baseVars = @{
    GITHUB_PATH = $null; TMP = $tmp; TEMP = $tmp; BP_TEST_INSTALLER = $installer; BP_TEST_SHOW = $null
    BREAKPATCH_VERSION = $versionVar; BREAKPATCH_CHANNEL = $null; BREAKPATCH_GITHUB_TOKEN = $null; BREAKPATCH_UNINSTALL = $null
    BREAKPATCH_CI_HOME = $null; BREAKPATCH_CI_BIN = $null; BREAKPATCH_PYTHON = $null; BREAKPATCH_PYTHON_DOWNLOAD = $null
    BREAKPATCH_PYTHON_DOWNLOADS = $null; BREAKPATCH_PYTHON_SHA256 = $null; BREAKPATCH_API = $null; BREAKPATCH_DOWNLOADS = $null
  }

  $oemCp = [int](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage' -Name OEMCP).OEMCP
  $long = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue)
  Write-Host "test-install-ci.ps1: $shellLabel on $([Environment]::OSVersion.VersionString), OEM code page $oemCp, console code page $(Get-ConsoleCodePage), LongPathsEnabled $(if ($long) { $long.LongPathsEnabled } else { '-' })"
  Write-Host "installing breakpatch-ci $Version ($(if ($versionVar) { 'BREAKPATCH_VERSION' } else { 'GitHub''s Latest' })) with $installer"
  Write-Host "test folder: $root"

  # The user's PATH, put back at the end; meanwhile it also has a %USERPROFILE% entry, which
  # must stay written that way.
  $savedPath = Get-UserPath
  $registryTouched = $true
  $raw = if ($savedPath) { $savedPath.Value.TrimEnd(';') } else { '' }
  Write-UserPath ([pscustomobject]@{ Value = $(if ($raw) { "$raw;$planted" } else { $planted }); Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString })

  # ------------------------------------------------------------ 1. install

  $user1 = Join-Path $root "Users\Jos$e Test"
  $local1 = Join-Path $user1 'AppData\Local'
  $home1 = Join-Path $local1 'breakpatch-ci'
  $bin1 = Join-Path $home1 'bin'
  $shim1 = Join-Path $bin1 'breakpatch-ci.cmd'
  New-Item -ItemType Directory -Force -Path $local1 | Out-Null

  Enter-Step '1. install, user folder with a space and an accent'
  $r = Invoke-Installer @{ LOCALAPPDATA = $local1 }
  $installed1 = Test-Run $r @("Installing breakpatch-ci $Version...", "breakpatch-ci $Version is in", 'to your PATH. Open a new terminal')
  if ($installed1) {
    if ($r.Out.Contains('downloading Python')) { Write-Host '  (this machine had no Python 3.11 the installer could use: it downloaded one)' }
    Test-Installed $home1 $shim1
    $bytes = [byte[]]@()   # not from an if: that would unroll the bytes (and none would be $null)
    if (Test-Path -LiteralPath $shim1) { $bytes = [IO.File]::ReadAllBytes($shim1) }
    $text = [Text.Encoding]::ASCII.GetString($bytes)
    if (@($bytes | Where-Object { $_ -ge 0x80 }).Count -eq 0) { Ok 'the .cmd is plain ASCII' } else { Bad 'the .cmd has bytes outside ASCII' }
    if ($text.StartsWith('@echo off') -and ([regex]::Matches($text, "`r`n").Count -eq ([regex]::Matches($text, "`n").Count))) { Ok 'the .cmd has no BOM and CRLF line endings' }
    else { Bad 'the .cmd has a BOM or bare LF line endings' $text }
    if ($text.Contains('%~dp0') -and -not $text.Contains($root)) { Ok 'the .cmd finds the install folder from its own (%~dp0)' } else { Bad "the .cmd doesn't use %~dp0, or names the folder" $text }
    # A batch file (a `shell: cmd` step is one) that runs breakpatch-ci without `call`: cmd.exe
    # doesn't come back from another batch file, so its next lines don't run.
    $caller = Join-Path $root 'caller.cmd'
    Set-Content -LiteralPath $caller -Encoding ASCII -Value @('@echo off', 'breakpatch-ci --version', 'echo bp-test-after')
    $c = Invoke-Child $env:ComSpec "/d /c `"$caller`"" @{ Path = (Get-NewWindowPath) } $root 120
    if ($c.Out.Contains('bp-test-after')) { Ok 'a batch file goes on after breakpatch-ci' }
    else { Warn 'a batch file that runs breakpatch-ci (without call) stops there: breakpatch-ci is a .cmd' (Get-RunSummary $c) }
    Test-UserPath $bin1 1 'bin'
    Test-PathNote $home1 $bin1
  }

  # Cases 2 to 6 build on the first install.
  if (-not $installed1) {
    Write-Host ''
    Write-Host "$shellLabel`: 2. to 6. skipped, the first install failed"
  } else {
    # ------------------------------------------------------------ 2. again

    Enter-Step '2. install again'
    $before = Get-CurrentEnv $home1
    $r = Invoke-Installer @{ LOCALAPPDATA = $local1 }
    if (Test-Run $r @("Reinstalling breakpatch-ci $Version...")) {
      Test-Installed $home1 $shim1
      $now = Get-CurrentEnv $home1
      if ($before -and $now -ne $before -and -not (Test-Path -LiteralPath (Join-Path $home1 $before))) { Ok 'a new environment, and the one before is gone' }
      else { Bad "the environment before ($before) is still there, or wasn't replaced ($now)" }
      Test-UserPath $bin1 1 'bin'
    }

    # ------------------------------------------------------------ 3. GITHUB_PATH

    Enter-Step '3. install in GitHub Actions (GITHUB_PATH)'
    $ghPath = Join-Path $root 'github_path'
    [IO.File]::WriteAllBytes($ghPath, [byte[]]@())
    $regBefore = (Get-UserPath).Value
    $r = Invoke-Installer @{ LOCALAPPDATA = $local1; GITHUB_PATH = $ghPath }
    if (Test-Run $r @('to GITHUB_PATH: the next steps of this job can run breakpatch-ci.')) {
      $bytes = [IO.File]::ReadAllBytes($ghPath)
      try {
        $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
        $lines = @($text -split "`r?`n" | Where-Object { $_ })
        if ($lines.Count -eq 1 -and $lines[0] -eq $bin1) { Ok 'GITHUB_PATH has the bin folder, in UTF-8' }
        else { Bad "GITHUB_PATH doesn't have just the bin folder" "GITHUB_PATH: $text`nexpected: $bin1" }
      } catch {
        Bad "GITHUB_PATH isn't UTF-8 (GitHub reads it as UTF-8, so the folder's accent is lost)" "bytes: $(($bytes | ForEach-Object { $_.ToString('x2') }) -join ' ')"
      }
      if ((Get-UserPath).Value -eq $regBefore) { Ok "the user's PATH in the registry wasn't touched" } else { Bad "the user's PATH in the registry changed" }
    }

    # ------------------------------------------------------------ 4. one window

    Enter-Step '4. irm | iex in one window: its variables as they were'
    $myBrowsers = Join-Path $root 'my browsers'
    $show = 'PIP_INDEX_URL,PIP_NO_INPUT,PIP_DISABLE_PIP_VERSION_CHECK,PLAYWRIGHT_BROWSERS_PATH'
    $r = Invoke-Installer -Session @{
      LOCALAPPDATA = $local1; BP_TEST_SHOW = $show
      PIP_INDEX_URL = 'https://pypi.org/simple/'; PIP_NO_INPUT = 'mine'; PIP_DISABLE_PIP_VERSION_CHECK = $null; PLAYWRIGHT_BROWSERS_PATH = $myBrowsers
    }
    if (Test-Run $r @("Reinstalling breakpatch-ci $Version...")) {
      foreach ($want in @('BPTEST PIP_INDEX_URL=[https://pypi.org/simple/]', 'BPTEST PIP_NO_INPUT=[mine]', 'BPTEST PIP_DISABLE_PIP_VERSION_CHECK=[]', "BPTEST PLAYWRIGHT_BROWSERS_PATH=[$myBrowsers]")) {
        if (@($r.Out -split "`r?`n") -contains $want) { Ok "afterwards: $want" } else { Bad "afterwards not $want" (Get-RunSummary $r) }
      }
      if (-not (Test-Path -LiteralPath $myBrowsers)) { Ok "nothing went into the window's PLAYWRIGHT_BROWSERS_PATH" } else { Bad "something went into the window's PLAYWRIGHT_BROWSERS_PATH" }
      Test-Installed $home1 $shim1
      Test-UserPath $bin1 1 'bin'
    }

    # ------------------------------------------------------------ 5. token

    Enter-Step '5. install with BREAKPATCH_GITHUB_TOKEN'
    if (-not $token) {
      Write-Host '  (skipped: no BP_TEST_GITHUB_TOKEN)'
    } else {
      $r = Invoke-Installer @{ LOCALAPPDATA = $local1; BREAKPATCH_GITHUB_TOKEN = $token }
      if (-not ($r.Out + $r.Err).Contains($token)) { Ok "the token isn't in the output" } else { Bad 'the token is in the output' }
      if (Test-Run $r @('Using BREAKPATCH_GITHUB_TOKEN (private beta).', "Reinstalling breakpatch-ci $Version...")) {
        Test-Installed $home1 $shim1
      }
    }

    # ------------------------------------------------------------ 6. uninstall

    Enter-Step '6. uninstall in that window'
    $notes = Join-Path $home1 'my notes.txt'
    $mine = Join-Path $home1 'python\mine'
    Set-Content -LiteralPath $notes -Value 'keep me' -Encoding ASCII
    New-Item -ItemType Directory -Force -Path $mine | Out-Null
    Set-Content -LiteralPath (Join-Path $mine 'keep.txt') -Value 'mine too' -Encoding ASCII
    $r = Invoke-Installer -Session @{ LOCALAPPDATA = $local1; BREAKPATCH_UNINSTALL = '1'; BP_TEST_SHOW = 'BREAKPATCH_UNINSTALL' }
    if (Test-Run $r @('Removed breakpatch-ci and its browser from', 'BPTEST BREAKPATCH_UNINSTALL=[]')) {
      if ((Test-Path -LiteralPath $notes) -and (Get-Content -LiteralPath $notes) -eq 'keep me' -and (Test-Path -LiteralPath (Join-Path $mine 'keep.txt'))) { Ok "the user's file and python\mine are still there" }
      else { Bad "the user's file or python\mine went" }
      $left = @(Get-ChildItem -LiteralPath $home1 -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object)
      if (($left -join ',') -eq 'my notes.txt,python') { Ok "the installer's own files are gone (current.txt, env-*, browsers, bin)" }
      else { Bad "left in the install folder: $($left -join ', ')" }
      if (-not (Test-Path -LiteralPath $bin1)) { Ok 'bin\ is gone' } else { Bad 'bin\ is still there' }
      Test-UserPath $bin1 0 'bin'
    }
    $r = Invoke-Installer @{ LOCALAPPDATA = $local1; BREAKPATCH_UNINSTALL = '1' }
    $null = Test-Run $r @('Nothing to remove.')
  }

  # ------------------------------------------------------------ 7. downloaded Python, other bin

  Enter-Step '7. no Python on PATH, BREAKPATCH_CI_BIN elsewhere (OEM code page)'
  $user2 = Join-Path $root "Users\Ren$e Two"
  $local2 = Join-Path $user2 'AppData\Local'
  $home2 = Join-Path $local2 'breakpatch-ci'
  $bin2 = Join-Path $user2 'ci tools'
  $shim2 = Join-Path $bin2 'breakpatch-ci.cmd'
  New-Item -ItemType Directory -Force -Path $local2 | Out-Null
  # Windows' own folders and this PowerShell's: no py launcher (C:\Windows), no python.
  $sys = Join-Path $env:SystemRoot 'System32'
  $bare = "$sys;$sys\Wbem;$sys\WindowsPowerShell\v1.0\;$(Split-Path -Parent $shellExe)"
  $oem = $null
  try {
    $oem = if ($oemCp -eq 65001) { New-Object Text.UTF8Encoding($false, $true) } else { [Text.Encoding]::GetEncoding($oemCp, [Text.EncoderFallback]::ExceptionFallback, [Text.DecoderFallback]::ExceptionFallback) }
    $null = $oem.GetBytes($home2)
  } catch { $oem = $null }
  $r = Invoke-Installer @{ LOCALAPPDATA = $local2; BREAKPATCH_CI_BIN = $bin2; Path = $bare }
  if (-not $oem) {
    # This PC's OEM code page can't hold the accent: the installer must say so, and stop.
    if ($r.Code -ne 0 -and $r.Err.Contains("The command prompt can't read the install folder's path")) { Ok "code page $oemCp can't hold the path, and the installer says so" }
    else { Bad "code page $oemCp can't hold the path, and the installer didn't stop and say so" (Get-RunSummary $r) }
  } elseif (Test-Run $r @('This PC has no Python 3.11 that breakpatch-ci can use: downloading Python', "breakpatch-ci $Version is in")) {
    $pbs = @(Get-ChildItem -LiteralPath (Join-Path $home2 'python') -Directory -Filter 'cpython-*' -ErrorAction SilentlyContinue)
    if ($pbs.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $pbs[0].FullName 'python.exe'))) { Ok "the downloaded Python is in python\$($pbs[0].Name)" }
    else { Bad 'no python\cpython-*\python.exe in the install folder' }
    $cfg = Join-Path $home2 "$(Get-CurrentEnv $home2)\pyvenv.cfg"
    # @() around the if: its result is unrolled, and one line or none has no .Count in strict mode.
    $homeLine = @(if (Test-Path -LiteralPath $cfg) { [IO.File]::ReadAllLines($cfg, [Text.Encoding]::UTF8) | Where-Object { $_ -match '^home\s*=' } })
    if ($homeLine.Count -eq 1 -and $homeLine[0].IndexOf((Join-Path $home2 'python\cpython-'), [StringComparison]::OrdinalIgnoreCase) -ge 0) { Ok 'the environment is made from the downloaded Python' }
    else { Bad "the environment isn't made from the downloaded Python" "pyvenv.cfg: $($homeLine -join ' | ')" }
    Test-Installed $home2 $shim2 $oemCp
    try {
      $text = $oem.GetString([IO.File]::ReadAllBytes($shim2))
      if ($text.Contains("`"$home2\current.txt`"") -and $text.Contains("`"$home2\%BP_CI_ENV%\Scripts\breakpatch-ci.exe`" %*")) { Ok "the .cmd names the install folder, in code page $oemCp" }
      else { Bad "the .cmd doesn't name the install folder in code page $oemCp" $text }
    } catch { Bad "the .cmd isn't in code page $oemCp" }
    Test-UserPath $bin2 1 'the other bin'
    Test-PathNote $home2 $bin2
    $r = Invoke-Installer @{ LOCALAPPDATA = $local2; BREAKPATCH_CI_BIN = $bin2; BREAKPATCH_UNINSTALL = '1' }
    if (Test-Run $r @('Removed breakpatch-ci and its browser from', 'off your PATH.')) {
      if (-not (Test-Path -LiteralPath $shim2)) { Ok 'the .cmd is gone' } else { Bad 'the .cmd is still there' }
      if (-not (Test-Path -LiteralPath $home2)) { Ok 'the install folder is gone, downloaded Python, path-added.txt and all' }
      else { Bad "left: $(@(Get-ChildItem -LiteralPath $home2 -Recurse -Force | Select-Object -First 10 | ForEach-Object { $_.FullName.Substring($home2.Length) }) -join ', ')" }
      Test-UserPath $bin2 0 'the other bin'
    }
  }

  # ------------------------------------------------------------ 8. bin on PATH before the install

  Enter-Step '8. BREAKPATCH_CI_BIN on the user''s PATH already: it stays there after the uninstall'
  $user3 = Join-Path $root 'Users\Pre Path'
  $local3 = Join-Path $user3 'AppData\Local'
  $home3 = Join-Path $local3 'breakpatch-ci'
  $bin3 = Join-Path $user3 'my tools'
  New-Item -ItemType Directory -Force -Path $local3 | Out-Null
  New-Item -ItemType Directory -Force -Path $bin3 | Out-Null
  # In the registry only, as a window opened before it was added would have it: the installer's
  # own PATH hasn't got it, so it asks the registry.
  $u = Get-UserPath
  Write-UserPath ([pscustomobject]@{ Value = "$($u.Value.TrimEnd(';'));$bin3"; Kind = $u.Kind })
  Test-UserPath $bin3 1 'the bin folder of the user''s, before the install'
  $r = Invoke-Installer @{ LOCALAPPDATA = $local3; BREAKPATCH_CI_BIN = $bin3 }
  if (Test-Run $r @("breakpatch-ci $Version is in", 'is on your PATH. Open a new terminal')) {
    if (-not $r.Out.Contains("to your PATH")) { Ok "it doesn't say it added the folder to PATH" } else { Bad 'it says it added the folder to PATH' (Get-RunSummary $r) }
    Test-PathNote $home3
    Test-UserPath $bin3 1 'the bin folder of the user''s'
    $r = Invoke-Installer @{ LOCALAPPDATA = $local3; BREAKPATCH_CI_BIN = $bin3; BREAKPATCH_UNINSTALL = '1' }
    if (Test-Run $r @('Removed breakpatch-ci and its browser from')) {
      if (-not $r.Out.Contains('off your PATH')) { Ok "it doesn't say it took the folder off PATH" } else { Bad 'it says it took the folder off PATH' (Get-RunSummary $r) }
      if (-not (Test-Path -LiteralPath (Join-Path $bin3 'breakpatch-ci.cmd'))) { Ok 'the .cmd is gone' } else { Bad 'the .cmd is still there' }
      Test-UserPath $bin3 1 'the bin folder of the user''s, after the uninstall'
    }
  }
} catch {
  $stoppedBy = $_
} finally {
  if ($registryTouched) {
    try { Write-UserPath $savedPath } catch { Write-Host "Couldn't put the user's PATH back: $_" }
  }
  if ($root -and (Test-Path -LiteralPath $root)) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($stoppedBy) {
  $where = if ($stoppedBy.InvocationInfo) { " (line $($stoppedBy.InvocationInfo.ScriptLineNumber): $(([string]$stoppedBy.InvocationInfo.Line).Trim()))" } else { '' }
  $line = "$($script:step): stopped early: $($stoppedBy.Exception.Message)$where"
  [void]$script:failures.Add($line)
  Write-Host "  FAIL  stopped early: $($stoppedBy.Exception.Message)$where"
  Write-Annotation 'error' "[$shellLabel] $line"
}
if ($script:overflow.Count -gt 0) {
  Write-Annotation 'error' ("[$shellLabel] $($script:overflow.Count) more failures:`n" + ($script:overflow -join "`n"))
}
Write-Host ''
if ($script:failures.Count -eq 0) {
  Write-Host "test-install-ci.ps1 ($shellLabel): all $($script:pass) checks passed"
  exit 0
}
Write-Host "test-install-ci.ps1 ($shellLabel): $($script:failures.Count) failed, $($script:pass) passed:"
foreach ($f in $script:failures) { Write-Host "  $f" }
exit 1
