# Installs or updates breakpatch-ci, Breakpatch Team's command line for CI, on Windows.
#
#   irm https://breakpatch.dev/install-ci.ps1 | iex                                  install or update
#   $env:BREAKPATCH_VERSION = "1.2.3"; irm https://breakpatch.dev/install-ci.ps1 | iex   a given version
#   $env:BREAKPATCH_CHANNEL = "beta";  irm https://breakpatch.dev/install-ci.ps1 | iex   the newest, betas too
#   $env:BREAKPATCH_UNINSTALL = "1";   irm https://breakpatch.dev/install-ci.ps1 | iex   remove it
#   (or save it and run: powershell -ExecutionPolicy Bypass -File install-ci.ps1 [-Uninstall])
#
# The Windows twin of https://breakpatch.dev/install-ci (site/install-ci); it does the same, the
# Windows way. A preview: breakpatch-ci runs tests on Windows; record them on a Mac.
#   1. Checks this is 64-bit Windows on x64, and finds Python 3.11 (BREAKPATCH_PYTHON, the py
#      launcher's 3.11, or python on PATH if it's 3.11). Without one it downloads a pinned build of
#      Python 3.11 from python-build-standalone (github.com/astral-sh/python-build-standalone),
#      checked against the SHA-256 written in this script, into the install folder.
#   2. Asks GitHub for the latest release of BreakPatch/breakpatch (or BREAKPATCH_VERSION, or with
#      BREAKPATCH_CHANNEL=beta the newest release, betas included).
#   3. Downloads breakpatch-ci-requirements-windows-x86_64.txt and the two wheels it names from the
#      release (https only, also after redirects; with BREAKPATCH_GITHUB_TOKEN, from the
#      repository's asset addresses on api.github.com, and the token goes to that host only), and
#      checks each against the release's SHA256SUMS.
#   4. Makes a Python 3.11 environment in a new folder in %LOCALAPPDATA%\breakpatch-ci
#      (BREAKPATCH_CI_HOME) and installs from that file with pip --require-hashes
#      --only-binary=:all:, so every package must match its SHA-256 and nothing is built.
#   5. Installs Chromium, the version this engine uses, into that folder's browsers\.
#   6. Switches to the new environment only once all of that worked (the one before stays until
#      then): bin\breakpatch-ci.cmd (BREAKPATCH_CI_BIN) starts it. The bin folder is added to
#      this user's PATH, and in GitHub Actions to GITHUB_PATH for the next steps.
# No administrator rights; nothing outside those folders and this user's PATH is changed.
#
# Everything happens in Install-BreakpatchCi, called on the last line: if the download of this
# script is cut short, nothing runs. Works in Windows PowerShell 5.1 and PowerShell 7.
#
# Environment: BREAKPATCH_VERSION, BREAKPATCH_CHANNEL, BREAKPATCH_GITHUB_TOKEN, BREAKPATCH_PYTHON,
# BREAKPATCH_PYTHON_DOWNLOAD (0: never download Python), BREAKPATCH_CI_HOME, BREAKPATCH_CI_BIN,
# BREAKPATCH_UNINSTALL, and for tests and mirrors (https only) BREAKPATCH_API, BREAKPATCH_DOWNLOADS,
# BREAKPATCH_PYTHON_DOWNLOADS with BREAKPATCH_PYTHON_SHA256. As in site/install-ci.

function Install-BreakpatchCi {
  param([string[]] $Arguments)
  Set-StrictMode -Version 2
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Windows PowerShell's progress bar makes downloads crawl

  $GitHubApi = 'https://api.github.com/'
  $Platform = 'windows-x86_64'
  $Releases = 'https://github.com/BreakPatch/breakpatch/releases'
  $Api = if ($env:BREAKPATCH_API) { $env:BREAKPATCH_API } else { "${GitHubApi}repos/BreakPatch/breakpatch" }
  $Downloads = if ($env:BREAKPATCH_DOWNLOADS) { $env:BREAKPATCH_DOWNLOADS } else { "$Releases/download/" }
  $Docs = 'https://breakpatch.dev/docs/#breakpatch-ci-on-windows'
  $Marker = 'breakpatch-ci.json'
  # Python 3.11 from python-build-standalone (as in site/install-ci), with its SHA-256.
  $PbsRelease = '20260924'
  $PbsVersion = '3.11.16'
  $PbsTriple = 'x86_64-pc-windows-msvc'
  $PbsSha256 = 'f86b3cbd425e1c446b56aa24e20a7be1223c1a8146e5e3a68c8e18d08b76e810'
  $PbsDownloads = 'https://github.com/astral-sh/python-build-standalone/releases/download/'

  # The token stays in this function only: nothing it runs gets it in its environment.
  $token = $env:BREAKPATCH_GITHUB_TOKEN
  Remove-Item Env:\BREAKPATCH_GITHUB_TOKEN -ErrorAction SilentlyContinue

  function Say([string] $m) { Write-Host $m }
  function Fail([string] $m) { throw (New-Object System.Exception($m)) }
  # A program, with its output in a log (or discarded). Windows PowerShell 5.1 turns a native
  # program's stderr into errors, which 'Stop' would throw on: not here.
  function Invoke-Native([string] $log, [string] $exe, [string[]] $argv) {
    $was = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      if ($log) { & $exe @argv *> $log } else { & $exe @argv *> $null }
      return $LASTEXITCODE
    } catch {
      return 127
    } finally {
      $ErrorActionPreference = $was
    }
  }
  function Read-Native([string] $exe, [string[]] $argv) {
    $was = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return ([string](& $exe @argv 2>$null)).Trim() } catch { return '' } finally { $ErrorActionPreference = $was }
  }
  function Pretty([string] $p) {
    $h = [Environment]::GetFolderPath('UserProfile')
    if ($h -and $p.StartsWith($h, [StringComparison]::OrdinalIgnoreCase)) { return '~' + $p.Substring($h.Length) }
    return $p
  }

  # ------------------------------------------------------------ checks

  function Test-Platform {
    $need = 'breakpatch-ci for Windows runs on 64-bit Windows 10 or 11 on x64 (a preview).'
    if ($env:OS -ne 'Windows_NT') { Fail "$need This isn't Windows: use https://breakpatch.dev/install-ci there." }
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
      'AMD64' { }
      'ARM64' { Fail "$need This PC has an arm processor: Windows on arm isn't supported yet." }
      default { Fail "$need This PC is $arch." }
    }
  }

  # A Python in an environment: Scripts\python.exe on Windows.
  function Get-VenvPython([string] $dir) {
    $win = Join-Path $dir 'Scripts\python.exe'
    if (Test-Path -LiteralPath $win) { return $win }
    return (Join-Path (Join-Path $dir 'bin') 'python')    # tests run this on Linux PowerShell
  }
  function Get-VenvCommand([string] $dir) {
    $win = Join-Path $dir 'Scripts\breakpatch-ci.exe'
    if (Test-Path -LiteralPath $win) { return $win }
    return (Join-Path (Join-Path $dir 'bin') 'breakpatch-ci')
  }

  # The python's version, architecture and venv; $null when it won't do (with -Strict, why not).
  function Test-Python([string[]] $cmd, [switch] $Strict) {
    $how = 'Install Python 3.11 (python.org, or in GitHub Actions actions/setup-python with python-version 3.11), then run this again. If it is somewhere else, set BREAKPATCH_PYTHON to it.'
    $exe = $cmd[0]; $pre = @(); if ($cmd.Count -gt 1) { $pre = $cmd[1..($cmd.Count - 1)] }
    # No double quotes in the code: Windows PowerShell 5.1 passes them to programs wrongly.
    $out = Read-Native $exe ($pre + @('-c', 'import sys, platform; print(''%d.%d %s %s'' % (sys.version_info[:2] + (platform.machine(), sys.executable)))'))
    if (-not $out) { if ($Strict) { Fail "Couldn't run $($cmd -join ' '). $how" }; return $null }
    $parts = ([string]$out).Trim().Split(' ', 3)
    if ($parts[0] -ne '3.11') { if ($Strict) { Fail "breakpatch-ci needs Python 3.11, and $($cmd -join ' ') is Python $($parts[0]). $how" }; return $null }
    if ($parts[1] -notin @('AMD64', 'x86_64')) { if ($Strict) { Fail "$($cmd -join ' ') is for $($parts[1]), not this PC (x64). $how" }; return $null }
    if ((Invoke-Native $null $exe ($pre + @('-c', 'import venv, ensurepip'))) -ne 0) { if ($Strict) { Fail "$($cmd -join ' ') can't make Python environments (its venv module is missing). $how" }; return $null }
    return $parts[2]
  }

  # $script:python: a Python 3.11 to make the environment with, or $null for the download.
  function Find-Python {
    if ($env:BREAKPATCH_PYTHON) {
      if (-not (Get-Command $env:BREAKPATCH_PYTHON -ErrorAction SilentlyContinue)) { Fail "BREAKPATCH_PYTHON is $env:BREAKPATCH_PYTHON, which isn't there." }
      return (Test-Python @($env:BREAKPATCH_PYTHON) -Strict)
    }
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) { $candidates += , @('py', '-3.11') }
    foreach ($n in @('python3.11', 'python', 'python3')) {
      if (Get-Command $n -ErrorAction SilentlyContinue) { $candidates += , @($n) }
    }
    foreach ($c in $candidates) {
      $found = Test-Python $c
      if ($found) { return $found }
    }
    if ($env:BREAKPATCH_PYTHON_DOWNLOAD -eq '0') {
      if ($candidates.Count -eq 0) { Fail 'breakpatch-ci needs Python 3.11, and this PC has none. Install Python 3.11 (python.org), then run this again.' }
      return (Test-Python $candidates[0] -Strict)
    }
    return $null
  }

  # ------------------------------------------------------------ downloads

  Add-Type -AssemblyName System.Net.Http
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $false       # followed by hand below: https only, no token after the first hop
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromMinutes(10)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('breakpatch-install-ci')

  # Get-Url URL [OutFile] [Accept]: the body (as text, or into OutFile). Returns the HTTP status;
  # 0 when there was no answer. The token goes to api.github.com only, never after a redirect.
  function Get-Url([string] $url, [string] $outFile, [string] $accept = 'application/vnd.github+json') {
    $first = $true
    for ($hop = 0; $hop -lt 6; $hop++) {
      if (-not $url.StartsWith('https://')) { return 0 }
      $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $url)
      $req.Headers.Accept.ParseAdd($accept)
      if ($first -and $token -and $url.StartsWith($GitHubApi)) {
        $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
      }
      try { $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult() }
      catch { return 0 }
      $code = [int]$resp.StatusCode
      if ($code -ge 300 -and $code -lt 400 -and $resp.Headers.Location) {
        $url = ([Uri]::new([Uri]$url, $resp.Headers.Location)).AbsoluteUri
        $first = $false
        $resp.Dispose()
        continue
      }
      if ($code -eq 200) {
        if ($outFile) {
          $fs = [IO.File]::Create($outFile)
          try { [void]$resp.Content.CopyToAsync($fs).GetAwaiter().GetResult() } finally { $fs.Dispose() }
        } else {
          $script:body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
      }
      $resp.Dispose()
      return $code
    }
    return 0
  }

  function Get-Sha256([string] $path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }

  function Assert-Asset([string] $name, [string] $url) {
    $bad = "Breakpatch $version lists a file that isn't from Breakpatch's releases, so nothing was installed. Tell us: https://github.com/BreakPatch/breakpatch/issues"
    if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { Fail $bad }
    if ($token) {
      if ($url -notmatch ('^' + [regex]::Escape("$Api/releases/assets/") + '[0-9]+$')) { Fail $bad }
      return
    }
    if (-not $Downloads.StartsWith('https://')) { Fail 'BREAKPATCH_DOWNLOADS must start with https://.' }
    if (-not $url.StartsWith($Downloads)) { Fail $bad }
    $rest = $url.Substring($Downloads.Length)
    if ($rest -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' -or $rest.Contains('..')) { Fail $bad }
    if ($url.Split('/')[-1] -ne $name) { Fail $bad }
  }

  function Find-Release {
    $channel = if ($env:BREAKPATCH_CHANNEL) { $env:BREAKPATCH_CHANNEL } else { 'stable' }
    if ($channel -notin @('stable', 'beta')) { Fail "BREAKPATCH_CHANNEL is stable or beta, not $channel." }
    $wanted = ''
    if ($env:BREAKPATCH_VERSION) {
      $wanted = $env:BREAKPATCH_VERSION -replace '^v', ''
      if ($wanted -notmatch '^[0-9][0-9A-Za-z.-]*$') { Fail 'BREAKPATCH_VERSION is a version like 1.2.3 or 0.1.0-beta.1.' }
      $status = Get-Url "$Api/releases/tags/v$wanted"
    } elseif ($channel -eq 'beta') {
      $status = Get-Url "$Api/releases?per_page=10"
    } else {
      $status = Get-Url "$Api/releases/latest"
    }
    switch ($status) {
      200 { }
      401 { Fail "GitHub didn't accept BREAKPATCH_GITHUB_TOKEN. It may have expired: make a new one." }
      404 {
        if ($wanted) { Fail "There's no Breakpatch $wanted. The versions are at $Releases." }
        Fail "There's no Breakpatch release yet. See $Releases."
      }
      { $_ -in 403, 429 } { Fail 'GitHub is limiting requests from this network right now. Try again in a few minutes.' }
      0 { Fail "Couldn't reach GitHub to find Breakpatch. Check your connection and try again." }
      default { Fail "GitHub didn't answer as expected (HTTP $status). Try again in a few minutes." }
    }
    $doc = $script:body | ConvertFrom-Json
    if ($doc -is [array]) {
      $doc = @($doc | Where-Object { -not $_.draft }) | Select-Object -First 1
      if (-not $doc) { Fail "There's no Breakpatch release yet. See $Releases." }
    }
    $tag = [string]$doc.tag_name
    if ($tag -notmatch '^v[0-9][0-9A-Za-z.-]*$') { Fail "Couldn't read the release from GitHub. Try again in a few minutes." }
    $script:version = $tag.Substring(1)
    if ($wanted -and $script:version -ne $wanted) { Fail "GitHub answered with Breakpatch $($script:version), not $wanted. Try again in a few minutes." }
    $script:assets = @{}
    foreach ($a in @($doc.assets)) {
      $script:assets[[string]$a.name] = if ($token) { [string]$a.url } else { [string]$a.browser_download_url }
    }
    $script:reqs = "breakpatch-ci-requirements-$Platform.txt"
    if (-not $script:assets.ContainsKey($script:reqs) -or -not $script:assets.ContainsKey('SHA256SUMS')) {
      Fail "Breakpatch $($script:version) has no breakpatch-ci for Windows. Try an older version with BREAKPATCH_VERSION, or write to support@breakpatch.dev."
    }
  }

  function Assert-Sum([string] $name) {
    $want = $null
    foreach ($line in $script:sums) {
      $f = $line -split '\s+', 2
      if ($f.Count -eq 2 -and ($f[1] -eq $name -or $f[1] -eq "*$name")) { $want = $f[0].ToLowerInvariant(); break }
    }
    if (-not $want) { Fail "Breakpatch $version has no checksum for $name, so nothing was installed." }
    if ((Get-Sha256 (Join-Path $files $name)) -ne $want) {
      Fail "The download of $name doesn't match its checksum, so nothing was installed. Run this again. If it keeps happening, tell us: https://github.com/BreakPatch/breakpatch/issues"
    }
  }

  function Get-Files {
    $version = $script:version
    Assert-Asset $script:reqs $script:assets[$script:reqs]
    Assert-Asset 'SHA256SUMS' $script:assets['SHA256SUMS']
    if ((Get-Url $script:assets['SHA256SUMS'] (Join-Path $tmp 'SHA256SUMS') 'application/octet-stream') -ne 200) {
      Fail "Couldn't download the checksums. Check your connection and run this again."
    }
    $script:sums = Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS')
    if ((Get-Url $script:assets[$script:reqs] (Join-Path $files $script:reqs) 'application/octet-stream') -ne 200) {
      Fail 'The download stopped. Check your connection and run this again.'
    }
    Assert-Sum $script:reqs
    $lines = Get-Content -LiteralPath (Join-Path $files $script:reqs)
    $wheels = @($lines | ForEach-Object { if ($_ -match '^\./([A-Za-z0-9][A-Za-z0-9._-]*\.whl) --hash=sha256:[0-9a-f]{64}$') { $Matches[1] } })
    $local = @($lines | Where-Object { $_ -match '^[^#A-Za-z0-9 ]' })
    # Comment lines don't count (the file's header names the install command's own address).
    $urls = @($lines | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '://|@ ' })
    if ($wheels.Count -ne 2 -or $local.Count -ne 2 -or $urls.Count -ne 0 -or
        -not ($wheels | Where-Object { $_ -like 'breakpatch_engine-*' }) -or -not ($wheels | Where-Object { $_ -like 'breakpatch_team_engine-*' })) {
      Fail "Breakpatch $version's breakpatch-ci files can't be read, so nothing was installed. Write to support@breakpatch.dev."
    }
    foreach ($w in $wheels) {
      if (-not $script:assets.ContainsKey($w)) { Fail "Breakpatch $version's breakpatch-ci is missing $w, so nothing was installed. Write to support@breakpatch.dev." }
      Assert-Asset $w $script:assets[$w]
      if ((Get-Url $script:assets[$w] (Join-Path $files $w) 'application/octet-stream') -ne 200) {
        Fail 'The download stopped. Check your connection and run this again.'
      }
      Assert-Sum $w
    }
  }

  # The pinned python-build-standalone build, into <home>\python\cpython-<version>+<release>.
  function Get-PinnedPython {
    $dir = Join-Path (Join-Path $ciHome 'python') "cpython-$PbsVersion+$PbsRelease"
    $script:pbsDir = $dir
    foreach ($exe in @((Join-Path $dir 'python.exe'), (Join-Path (Join-Path $dir 'bin') 'python3.11'))) {
      if ((Test-Path -LiteralPath $exe) -and (Test-Python @($exe))) {
        Say "Using Python $PbsVersion from $(Pretty $dir)."
        return $exe
      }
    }
    $base = $PbsDownloads; $want = $PbsSha256
    if ($env:BREAKPATCH_PYTHON_DOWNLOADS) {
      if ($env:BREAKPATCH_PYTHON_DOWNLOADS -notmatch '^https://.*/$') { Fail 'BREAKPATCH_PYTHON_DOWNLOADS must start with https:// and end with /.' }
      $base = $env:BREAKPATCH_PYTHON_DOWNLOADS; $want = [string]$env:BREAKPATCH_PYTHON_SHA256
    }
    if ($want -notmatch '^[0-9a-f]{64}$') { Fail "There's no checksum for the Python download for this PC, so nothing was installed." }
    Say "This PC has no Python 3.11 that breakpatch-ci can use: downloading Python $PbsVersion (python-build-standalone $PbsRelease)..."
    $file = Join-Path $tmp "cpython-$PbsVersion-$PbsTriple.tar.gz"
    if ((Get-Url "$base$PbsRelease/cpython-$PbsVersion%2B$PbsRelease-$PbsTriple-install_only_stripped.tar.gz" $file 'application/octet-stream') -ne 200) {
      Fail "Couldn't download Python 3.11. Check your connection and run this again, or install Python 3.11 and set BREAKPATCH_PYTHON."
    }
    if ((Get-Sha256 $file) -ne $want) {
      Fail "The download of Python 3.11 doesn't match its checksum, so nothing was installed. Run this again. If it keeps happening, tell us: https://github.com/BreakPatch/breakpatch/issues"
    }
    $partial = "$dir.partial"
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $partial | Out-Null
    # tar.exe: Windows 10 1803 and later
    if ((Invoke-Native $null 'tar' @('-xzf', $file, '-C', $partial)) -ne 0) { Remove-Item -LiteralPath $partial -Recurse -Force; Fail "Couldn't unpack the Python download." }
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $partial 'python') -Destination $dir
    Remove-Item -LiteralPath $partial -Recurse -Force
    foreach ($exe in @((Join-Path $dir 'python.exe'), (Join-Path (Join-Path $dir 'bin') 'python3.11'))) {
      if (Test-Path -LiteralPath $exe) {
        $null = Test-Python @($exe) -Strict
        Say "Python $PbsVersion is in $(Pretty $dir)."
        return $exe
      }
    }
    Fail "The Python download isn't what the installer expected, so nothing was installed."
  }

  # ------------------------------------------------------------ install and uninstall

  Test-Platform
  $ciHome = if ($env:BREAKPATCH_CI_HOME) { $env:BREAKPATCH_CI_HOME } else { Join-Path $env:LOCALAPPDATA 'breakpatch-ci' }
  $bin = if ($env:BREAKPATCH_CI_BIN) { $env:BREAKPATCH_CI_BIN } else { Join-Path $ciHome 'bin' }
  $shim = Join-Path $bin 'breakpatch-ci.cmd'
  $current = Join-Path $ciHome 'current.txt'     # the environment in use: no symbolic links without admin rights

  if (($Arguments -contains '-Uninstall') -or ($Arguments -contains '--uninstall') -or $env:BREAKPATCH_UNINSTALL -eq '1') {
    $removed = $false
    if (Test-Path -LiteralPath $shim) {
      if ((Get-Content -Raw -LiteralPath $shim) -match 'breakpatch-ci installer') { Remove-Item -LiteralPath $shim -Force; $removed = $true }
    }
    if ((Test-Path -LiteralPath $current) -or (Test-Path -LiteralPath (Join-Path $ciHome 'browsers'))) {
      Remove-Item -LiteralPath $ciHome -Recurse -Force
      $removed = $true
    }
    if (-not $removed) { Say "breakpatch-ci isn't in $(Pretty $ciHome). Nothing to remove."; return }
    Say "Removed breakpatch-ci and its browser from $(Pretty $ciHome)."
    Say "The machine licence is still in Breakpatch's data folder. Run breakpatch-ci licence release first to give the seat back, or free it in the back office."
    return
  }

  $python = Find-Python
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("breakpatch-ci-install-" + [Guid]::NewGuid().ToString('N'))
  $files = Join-Path $tmp 'files'
  New-Item -ItemType Directory -Force -Path $files | Out-Null
  $staged = $null
  try {
    if ($token) {
      if ($token -notmatch '^[A-Za-z0-9_]+$') { Fail "BREAKPATCH_GITHUB_TOKEN isn't a GitHub token (they're letters, digits and _ only)." }
      if (-not $Api.StartsWith($GitHubApi)) { Fail "BREAKPATCH_GITHUB_TOKEN is only ever sent to $GitHubApi, and BREAKPATCH_API isn't there. Unset one of them." }
      Say 'Using BREAKPATCH_GITHUB_TOKEN (private beta).'
    }
    Find-Release
    $version = $script:version
    $was = $null
    if (Test-Path -LiteralPath $current) {
      $envName = (Get-Content -LiteralPath $current -TotalCount 1)
      $markerPath = Join-Path (Join-Path $ciHome $envName) $Marker
      if (Test-Path -LiteralPath $markerPath) { $was = (Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json).version }
    }
    if (-not (Test-Path -LiteralPath $current)) { Say "Installing breakpatch-ci $version..." }
    elseif ($was -eq $version) { Say "Reinstalling breakpatch-ci $version..." }
    elseif ($was) { Say "Updating breakpatch-ci $was to $version..." }
    else { Say "Updating breakpatch-ci to $version..." }
    Say "Windows is a preview: breakpatch-ci runs tests there, and they're recorded on a Mac."

    Get-Files
    $token = $null
    $pbs = $false
    if (-not $python) { $python = Get-PinnedPython; $pbs = $true }

    New-Item -ItemType Directory -Force -Path $ciHome | Out-Null
    $staged = Join-Path $ciHome ("env-$version-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    if ((Invoke-Native (Join-Path $tmp 'venv.log') $python @('-m', 'venv', $staged)) -ne 0) { Fail "$python couldn't make a Python environment in $(Pretty $ciHome)." }
    $py = Get-VenvPython $staged
    Say 'Installing the Python packages (checked against their hashes)...'
    $env:PIP_DISABLE_PIP_VERSION_CHECK = '1'; $env:PIP_NO_INPUT = '1'
    Push-Location $files
    try { $code = Invoke-Native (Join-Path $tmp 'pip.log') $py @('-m', 'pip', 'install', '-q', '--require-hashes', '--only-binary=:all:', '-r', $script:reqs) }
    finally { Pop-Location }
    if ($code -ne 0) {
      Get-Content -LiteralPath (Join-Path $tmp 'pip.log') -Tail 8 | Write-Host
      Fail "Couldn't install breakpatch-ci's Python packages. Check this PC can reach pypi.org (or your PIP_INDEX_URL), and run this again."
    }
    Set-Content -LiteralPath (Join-Path $staged $Marker) -Value ('{"version": "' + $version + '", "browsers": "../browsers"}') -Encoding ASCII

    $browsers = Join-Path $ciHome 'browsers'
    Say "Installing Chromium into $(Pretty $browsers)..."
    New-Item -ItemType Directory -Force -Path $browsers | Out-Null
    $env:PLAYWRIGHT_BROWSERS_PATH = $browsers
    try { $code = Invoke-Native (Join-Path $tmp 'browser.log') $py @('-m', 'playwright', 'install', 'chromium', '--no-shell') }
    finally { Remove-Item Env:\PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue }
    if ($code -ne 0) {
      Get-Content -LiteralPath (Join-Path $tmp 'browser.log') -Tail 5 | Write-Host
      Fail "Couldn't install Chromium. Check your connection and run this again."
    }
    $got = Read-Native (Get-VenvCommand $staged) @('--version')
    if ($got -ne $version) { Fail "The new breakpatch-ci doesn't start (it says '$got'), so the one before is still in use. Write to support@breakpatch.dev." }

    # Switch: the pointer file, then the command, then the old environment goes.
    if ((Test-Path -LiteralPath $shim) -and -not ((Get-Content -Raw -LiteralPath $shim) -match 'breakpatch-ci installer')) {
      Fail "$(Pretty $shim) is there already and isn't this installer's. Move it away, or set BREAKPATCH_CI_BIN, and run this again."
    }
    $old = if (Test-Path -LiteralPath $current) { Get-Content -LiteralPath $current -TotalCount 1 } else { $null }
    $name = Split-Path -Leaf $staged
    Set-Content -LiteralPath "$current.new" -Value $name -Encoding ASCII
    Move-Item -LiteralPath "$current.new" -Destination $current -Force
    $staged = $null
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $lines = @('@echo off', 'rem breakpatch-ci installer: starts the environment named in current.txt', 'setlocal',
               "set /p BP_CI_ENV=<`"$current`"", "`"$ciHome\%BP_CI_ENV%\Scripts\breakpatch-ci.exe`" %*")
    Set-Content -LiteralPath "$shim.new" -Value $lines -Encoding ASCII
    Move-Item -LiteralPath "$shim.new" -Destination $shim -Force
    if ($old -and $old -ne $name -and $old -like 'env-*') {
      Remove-Item -LiteralPath (Join-Path $ciHome $old) -Recurse -Force -ErrorAction SilentlyContinue
    }
    # Downloaded Pythons no environment uses any more.
    $pyRoot = Join-Path $ciHome 'python'
    if (Test-Path -LiteralPath $pyRoot) {
      Get-ChildItem -LiteralPath $pyRoot -Directory | Where-Object { -not ($pbs -and $_.FullName -eq $script:pbsDir) } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
      if (-not (Get-ChildItem -LiteralPath $pyRoot)) { Remove-Item -LiteralPath $pyRoot -Force }
    }

    Say "breakpatch-ci $version is in $(Pretty $ciHome)."
    $onPath = ($env:Path -split ';') -contains $bin
    if ($env:GITHUB_PATH) {
      Add-Content -LiteralPath $env:GITHUB_PATH -Value $bin
      Say "Added $(Pretty $bin) to GITHUB_PATH: the next steps of this job can run breakpatch-ci."
    } elseif (-not $onPath) {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if (-not (($userPath -split ';') -contains $bin)) {
        [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $bin), 'User')
      }
      Say "Added $(Pretty $bin) to your PATH. Open a new terminal, then run: breakpatch-ci run --test path\to\test.json"
    } else {
      Say 'Run it with: breakpatch-ci run --test path\to\test.json'
    }
    Say "How to use it: $Docs"
  } finally {
    if ($staged -and (Test-Path -LiteralPath $staged)) { Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    $client.Dispose()
  }
}

try {
  Install-BreakpatchCi -Arguments $args
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  # Typed at a prompt (irm | iex), exit would close the window: just stop. In a script (a CI step,
  # or -File) the failure must fail it.
  if ($PSCommandPath) { exit 1 }
}
