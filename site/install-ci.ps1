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
#      BREAKPATCH_CHANNEL=beta the newest release, betas included). When GitHub's API is limiting
#      requests from this network, the stable release or BREAKPATCH_VERSION comes from the
#      release's download addresses instead (Find-PlainRelease).
#   3. Downloads breakpatch-ci-requirements-windows-x86_64.txt and the two wheels it names from the
#      release (https only, also after redirects; with BREAKPATCH_GITHUB_TOKEN, from the
#      repository's asset addresses on api.github.com, and the token goes to that host only), and
#      checks each against the release's SHA256SUMS.
#   4. Makes a Python 3.11 environment in a new folder in %LOCALAPPDATA%\breakpatch-ci
#      (BREAKPATCH_CI_HOME) and installs from that file with pip --require-hashes
#      --only-binary=:all:, so every package must match its SHA-256 and nothing is built.
#   5. Installs Chromium, the version this engine uses, into that folder's browsers\.
#   6. Switches to the new environment only once all of that worked (the one before stays until
#      then): bin\breakpatch-ci.cmd (BREAKPATCH_CI_BIN) starts it. When the bin folder isn't on
#      PATH yet, in GitHub Actions it goes to GITHUB_PATH for the next steps, anywhere else to
#      this user's PATH; path-added.txt in the install folder notes an entry this installer added.
# The uninstall (BREAKPATCH_UNINSTALL=1, or -Uninstall) removes only what the installer made, and
# takes the bin folder off the user's PATH only when path-added.txt says it put it there. With
# BREAKPATCH_LICENCE_KEY set, it first gives this machine's licence back (breakpatch-ci licence
# release), as site/install-ci does.
# No administrator rights; nothing outside those folders and this user's PATH is changed.
#
# Everything happens in Install-BreakpatchCi, called on the last line: if the download of this
# script is cut short, nothing runs. Works in Windows PowerShell 5.1 and PowerShell 7.
#
# Environment: BREAKPATCH_VERSION, BREAKPATCH_CHANNEL, BREAKPATCH_GITHUB_TOKEN, BREAKPATCH_PYTHON,
# BREAKPATCH_PYTHON_DOWNLOAD (0: never download Python), BREAKPATCH_CI_HOME, BREAKPATCH_CI_BIN,
# BREAKPATCH_UNINSTALL, BREAKPATCH_LICENCE_KEY (with the uninstall), and for tests and mirrors
# (https only) BREAKPATCH_API, BREAKPATCH_DOWNLOADS (ending in /), BREAKPATCH_PYTHON_DOWNLOADS with
# BREAKPATCH_PYTHON_SHA256. As in site/install-ci.

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
  # Puts a variable of this session back as it was; $null: it wasn't there, so it goes. Not
  # [Environment]::SetEnvironmentVariable: PowerShell would pass it $null as "".
  function Restore-EnvVar([string] $name, $value) {
    if ($null -eq $value) { Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue }
    else { Set-Item -LiteralPath "Env:\$name" -Value $value }
  }
  # A path as .NET reads it (PowerShell's own current folder, not the process's).
  function Get-FullPath([string] $p) { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p) }
  function Pretty([string] $p) {
    $h = [Environment]::GetFolderPath('UserProfile')
    if ($h -and $p.StartsWith($h, [StringComparison]::OrdinalIgnoreCase)) { return '~' + $p.Substring($h.Length) }
    return $p
  }

  # Adds a folder to this user's PATH, as written in the registry. [Environment]'s
  # Get/SetEnvironmentVariable(..., 'User') would read the value with %VARS% expanded and write it
  # back as a plain string (REG_SZ), so an entry like %USERPROFILE%\.cargo\bin would be fixed to
  # one profile's path for good, and %JAVA_HOME%-style entries would stop following their
  # variable. Read without expanding, written back as REG_EXPAND_SZ. Then a variable that isn't
  # there is removed the .NET way, only for the WM_SETTINGCHANGE that sends: windows opened after
  # this, from Explorer too, get the new PATH. [NullString]::Value, not $null: PowerShell passes
  # $null to a string parameter as "", and .NET (PowerShell 7's) then writes an empty variable
  # instead of removing it. Windows only; tests on Linux have no registry. $true when it added
  # the entry, $false when it was there already (or there's no registry).
  function Add-UserPath([string] $dir) {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return $false }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
      $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $entries = @($userPath -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
      if ($entries -contains $dir.TrimEnd('\')) { return $false }
      $new = $(if ($userPath.TrimEnd(';')) { $userPath.TrimEnd(';') + ';' } else { '' }) + $dir
      $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
      $key.Dispose()
    }
    [Environment]::SetEnvironmentVariable('BREAKPATCH_CI_PATH_CHANGED', [NullString]::Value, 'User')
    return $true
  }

  # Takes a folder out of this user's PATH again, read and written as in Add-UserPath. Only called
  # for an entry this installer added (path-added.txt), once the folder is gone or empty, so an
  # entry the user had before, or for a folder with the user's own things, stays.
  function Remove-UserPath([string] $dir) {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
      $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $keep = @($userPath -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ne $dir.TrimEnd('\') })
      $new = $keep -join ';'
      if ($new -eq $userPath) { return }
      $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
      $key.Dispose()
    }
    [Environment]::SetEnvironmentVariable('BREAKPATCH_CI_PATH_CHANGED', [NullString]::Value, 'User')
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

  function Assert-Downloads {
    if ($Downloads -cnotmatch '\Ahttps://[^\r\n]*/\z') { Fail 'BREAKPATCH_DOWNLOADS must start with https:// and end with /.' }
  }

  function Assert-Asset([string] $name, [string] $url) {
    $bad = "Breakpatch $version lists a file that isn't from Breakpatch's releases, so nothing was installed. Tell us: https://github.com/BreakPatch/breakpatch/issues"
    if ($name -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._-]*\z') { Fail $bad }
    if ($token) {
      if ($url -cnotmatch ('\A' + [regex]::Escape("$Api/releases/assets/") + '[0-9]+\z')) { Fail $bad }
      return
    }
    Assert-Downloads
    if (-not $url.StartsWith($Downloads, [StringComparison]::Ordinal)) { Fail $bad }
    $rest = $url.Substring($Downloads.Length)
    if ($rest -cnotmatch '\A[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\z' -or $rest.Contains('..')) { Fail $bad }
    if ($url.Split('/')[-1] -ne $name) { Fail $bad }
  }

  # When GitHub's API turns away requests without a token (403 or 429: 60 an hour per address, and
  # CI runners share theirs), the release comes from its download addresses, which that limit
  # doesn't cover: <Downloads>v<version>/<file>. The version is BREAKPATCH_VERSION's, or for the
  # latest release the one in its latest.json (from <Releases>/latest/download/, the address
  # GitHub sends to the Latest release's file), which must match that version's SHA256SUMS. The
  # release's files are the ones its SHA256SUMS lists, each checked like the API's (Assert-Asset,
  # then against SHA256SUMS). With BREAKPATCH_DOWNLOADS, latest is ../latest/download/ next to it.
  # What a release must have for this is in .github/workflows/release.yml's header (the release
  # contract). A file that isn't there gets the API path's message: no latest.json is no release
  # yet, and a release without SHA256SUMS has nothing to install. As plain_release in site/install-ci.
  $limitedMessage = 'GitHub is limiting requests from this network right now. Try again in a few minutes.'
  function Find-PlainRelease([string] $wanted) {
    $script:plain = $true
    Assert-Downloads
    $latestJson = $null
    if ($wanted) {
      $script:version = $wanted
    } else {
      if (-not $Downloads.EndsWith('/download/', [StringComparison]::Ordinal)) { Fail $limitedMessage }
      $latestJson = Join-Path $tmp 'latest.json'
      $s = Get-Url ($Downloads.Substring(0, $Downloads.Length - 'download/'.Length) + 'latest/download/latest.json') $latestJson 'application/octet-stream'
      if ($s -eq 404) { Fail "There's no Breakpatch release yet. See $Releases." }
      if ($s -eq 0) { Fail "Couldn't reach GitHub to find Breakpatch. Check your connection and try again." }
      if ($s -ne 200) { Fail $limitedMessage }
      $v = ''
      try { $v = [string](Get-Content -Raw -LiteralPath $latestJson | ConvertFrom-Json).version } catch { $v = '' }
      if ($v -cnotmatch '\A[0-9][0-9A-Za-z.-]*\z' -or $v.Contains('..')) { Fail "Couldn't read the release from GitHub. Try again in a few minutes." }
      $script:version = $v
    }
    $version = $script:version
    Say "GitHub's API is limiting requests from this network: getting Breakpatch $version from its download address instead."
    $base = "${Downloads}v$version/"
    # Kept for Get-Files: the same copy latest.json is checked with.
    $sumsFile = Join-Path $tmp 'SHA256SUMS'
    $s = Get-Url "${base}SHA256SUMS" $sumsFile 'application/octet-stream'
    if ($s -eq 404 -and $wanted) { Fail "There's no Breakpatch $wanted. The versions are at $Releases." }
    if ($s -eq 404) {
      # The latest release has no SHA256SUMS, so nothing to install: Assert-Release says so.
      $script:assets = @{}
      return
    }
    if ($s -eq 0) { Fail "Couldn't reach GitHub to find Breakpatch. Check your connection and try again." }
    if ($s -ne 200) { Fail $limitedMessage }
    $script:assets = @{ 'SHA256SUMS' = "${base}SHA256SUMS" }
    $listed = @{}
    foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
      $f = ([string]$line).Trim() -split '\s+', 2
      if ($f.Count -ne 2 -or $f[0] -cnotmatch '\A[0-9A-Fa-f]{64}\z') { continue }
      $n = $f[1].TrimStart('*')
      if (-not $listed.ContainsKey($n)) { $listed[$n] = $f[0].ToLowerInvariant() }
      if ($n -cne 'SHA256SUMS' -and $n -cne 'SHA256SUMS.asc') { $script:assets[$n] = "$base$n" }
    }
    if ($latestJson -and (-not $listed.ContainsKey('latest.json') -or (Get-Sha256 $latestJson) -ne $listed['latest.json'])) {
      Fail "Couldn't read the release from GitHub. Try again in a few minutes."
    }
  }

  function Find-Release {
    $script:plain = $false
    $channel = if ($env:BREAKPATCH_CHANNEL) { $env:BREAKPATCH_CHANNEL } else { 'stable' }
    if ($channel -notin @('stable', 'beta')) { Fail "BREAKPATCH_CHANNEL is stable or beta, not $channel." }
    $wanted = ''
    if ($env:BREAKPATCH_VERSION) {
      $wanted = $env:BREAKPATCH_VERSION -creplace '\Av', ''
      if ($wanted -cnotmatch '\A[0-9][0-9A-Za-z.-]*\z') { Fail 'BREAKPATCH_VERSION is a version like 1.2.3 or 0.1.0-beta.1.' }
      $status = Get-Url "$Api/releases/tags/v$wanted"
    } elseif ($channel -eq 'beta') {
      $status = Get-Url "$Api/releases?per_page=10"
    } else {
      $status = Get-Url "$Api/releases/latest"
    }
    $limited = $false
    switch ($status) {
      200 { }
      401 { Fail "GitHub didn't accept BREAKPATCH_GITHUB_TOKEN. It may have expired: make a new one." }
      404 {
        if ($token -and $wanted) { Fail "There's no Breakpatch $wanted, or BREAKPATCH_GITHUB_TOKEN can't read BreakPatch/breakpatch." }
        if ($token) { Fail "There's no Breakpatch release yet, or BREAKPATCH_GITHUB_TOKEN can't read BreakPatch/breakpatch." }
        if ($wanted) { Fail "There's no Breakpatch $wanted. The versions are at $Releases." }
        Fail "There's no Breakpatch release yet. See $Releases."
      }
      { $_ -in 403, 429 } {
        if ($token -and $status -eq 403) { Fail "GitHub refused BREAKPATCH_GITHUB_TOKEN (HTTP 403). Check it can read BreakPatch/breakpatch (Contents: read-only), or try again in a few minutes." }
        $limited = $true
      }
      0 { Fail "Couldn't reach GitHub to find Breakpatch. Check your connection and try again." }
      default { Fail "GitHub didn't answer as expected (HTTP $status). Try again in a few minutes." }
    }
    if ($limited) {
      # The beta channel needs the list of releases, which only the API gives.
      if ($token -or (-not $wanted -and $channel -eq 'beta')) { Fail $limitedMessage }
      Find-PlainRelease $wanted
      return
    }
    $doc = $script:body | ConvertFrom-Json
    if ($doc -is [array]) {
      $doc = @($doc | Where-Object { -not $_.draft }) | Select-Object -First 1
      if (-not $doc) { Fail "There's no Breakpatch release yet. See $Releases." }
    }
    $tag = [string]$doc.tag_name
    if ($tag -cnotmatch '\Av[0-9][0-9A-Za-z.-]*\z') { Fail "Couldn't read the release from GitHub. Try again in a few minutes." }
    $script:version = $tag.Substring(1)
    if ($wanted -and $script:version -cne $wanted) { Fail "GitHub answered with Breakpatch $($script:version), not $wanted. Try again in a few minutes." }
    $script:assets = @{}
    foreach ($a in @($doc.assets)) {
      $script:assets[[string]$a.name] = if ($token) { [string]$a.url } else { [string]$a.browser_download_url }
    }
  }

  function Assert-Release {
    $script:reqs = "breakpatch-ci-requirements-$Platform.txt"
    if (-not $script:assets.ContainsKey($script:reqs) -or -not $script:assets.ContainsKey('SHA256SUMS')) {
      Fail "Breakpatch $($script:version) has no breakpatch-ci for Windows. Try an older version with BREAKPATCH_VERSION, or write to support@breakpatch.dev."
    }
  }

  function Assert-Sum([string] $name) {
    $want = $null
    foreach ($line in $script:sums) {
      $f = $line -split '\s+', 2
      if ($f.Count -eq 2 -and ($f[1] -ceq $name -or $f[1] -ceq "*$name")) { $want = $f[0].ToLowerInvariant(); break }
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
    # Find-PlainRelease has it already: the copy it checked latest.json with.
    if (-not $script:plain -and (Get-Url $script:assets['SHA256SUMS'] (Join-Path $tmp 'SHA256SUMS') 'application/octet-stream') -ne 200) {
      Fail "Couldn't download the checksums. Check your connection and run this again."
    }
    $script:sums = Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS')
    if ((Get-Url $script:assets[$script:reqs] (Join-Path $files $script:reqs) 'application/octet-stream') -ne 200) {
      Fail 'The download stopped. Check your connection and run this again.'
    }
    Assert-Sum $script:reqs
    $lines = Get-Content -LiteralPath (Join-Path $files $script:reqs)
    $wheels = @($lines | ForEach-Object { if ($_ -cmatch '\A\./([A-Za-z0-9][A-Za-z0-9._-]*\.whl) --hash=sha256:[0-9a-f]{64}\z') { $Matches[1] } })
    $local = @($lines | Where-Object { $_ -cmatch '\A[^#A-Za-z0-9 ]' })
    # Comment lines don't count (the file's header names the install command's own address).
    $urls = @($lines | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '://|@ ' })
    if ($wheels.Count -ne 2 -or $local.Count -ne 2 -or $urls.Count -ne 0 -or
        -not ($wheels | Where-Object { $_ -clike 'breakpatch_engine-*' }) -or -not ($wheels | Where-Object { $_ -clike 'breakpatch_team_engine-*' })) {
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
      if ($env:BREAKPATCH_PYTHON_DOWNLOADS -cnotmatch '\Ahttps://[^\r\n]*/\z') { Fail 'BREAKPATCH_PYTHON_DOWNLOADS must start with https:// and end with /.' }
      $base = $env:BREAKPATCH_PYTHON_DOWNLOADS; $want = [string]$env:BREAKPATCH_PYTHON_SHA256
    }
    if ($want -cnotmatch '\A[0-9a-f]{64}\z') { Fail "There's no checksum for the Python download for this PC, so nothing was installed." }
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
  $binIsDefault = $bin.TrimEnd('\', '/') -eq (Join-Path $ciHome 'bin').TrimEnd('\', '/')
  # The bin folder this installer added to the user's PATH, if it did (Add-UserPath).
  $pathMarker = Join-Path $ciHome 'path-added.txt'

  if (($Arguments -contains '-Uninstall') -or ($Arguments -contains '--uninstall') -or $env:BREAKPATCH_UNINSTALL -eq '1') {
    # irm | iex runs this in the window's own session: BREAKPATCH_UNINSTALL goes once it's done, or
    # the next install in that window would uninstall again.
    try {
      $removed = $false
      # The machine licence goes back first, while breakpatch-ci is still here (it needs the key),
      # as in site/install-ci.
      $released = $false
      if ($env:BREAKPATCH_LICENCE_KEY -and (Test-Path -LiteralPath $current)) {
        $envName = [string](Get-Content -LiteralPath $current -TotalCount 1)
        $exe = if ($envName -clike 'env-*') { Get-VenvCommand (Join-Path $ciHome $envName) } else { '' }
        if ($exe -and (Test-Path -LiteralPath $exe) -and ((Read-Native $exe @('licence', 'release')) -match '"released": *true')) { $released = $true }
      }
      if (Test-Path -LiteralPath $shim) {
        if ((Get-Content -Raw -LiteralPath $shim) -match 'breakpatch-ci installer') { Remove-Item -LiteralPath $shim -Force; $removed = $true }
      }
      # Only what the installer makes goes, as in site/install-ci: BREAKPATCH_CI_HOME may be a
      # folder with other things in it. current.txt (and a current.txt.new a run left), the
      # environments (env-<version>-<id>, half-made ones too), the browsers and the downloaded
      # Pythons (python\cpython-*, with any .partial unpacking); then python\, bin\ (when it's the
      # default one, in the install folder) and the folder itself, if that leaves them empty. An
      # env-* that isn't a folder, or is a link (a reparse point), isn't the installer's, and nor is
      # anything else in python\.
      if ((Test-Path -LiteralPath $current) -or (Test-Path -LiteralPath (Join-Path $ciHome 'browsers'))) {
        $pyRoot = Join-Path $ciHome 'python'
        $ours = @($current, "$current.new", (Join-Path $ciHome 'browsers'))
        if (Test-Path -LiteralPath $pyRoot -PathType Container) {
          $ours += @(Get-ChildItem -LiteralPath $pyRoot -Filter 'cpython-*' -Force | ForEach-Object { $_.FullName })
        }
        $ours += @(Get-ChildItem -LiteralPath $ciHome -Directory -Filter 'env-*' -Force |
                   Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | ForEach-Object { $_.FullName })
        foreach ($p in $ours) {
          if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
        }
        if ((Test-Path -LiteralPath $pyRoot -PathType Container) -and -not (Get-ChildItem -LiteralPath $pyRoot -Force)) { Remove-Item -LiteralPath $pyRoot -Force }
        $removed = $true
      }
      if ($removed -and (Test-Path -LiteralPath "$shim.new")) { Remove-Item -LiteralPath "$shim.new" -Force }
      # The PATH entry goes only when this installer added it (path-added.txt names this bin
      # folder), and only once the folder is gone or has nothing else in it. Before "Nothing to
      # remove": an entry left by an uninstall cut short still goes. The note goes either way.
      $unpathed = $false
      if (Test-Path -LiteralPath $pathMarker -PathType Leaf) {
        $added = ([IO.File]::ReadAllText((Get-FullPath $pathMarker), [Text.Encoding]::UTF8)).Trim()
        $binGone = -not (Test-Path -LiteralPath $bin -PathType Container) -or -not (Get-ChildItem -LiteralPath $bin -Force)
        if ($added -and $added.TrimEnd('\') -eq $bin.TrimEnd('\') -and $binGone) { Remove-UserPath $bin; $unpathed = $true }
        Remove-Item -LiteralPath $pathMarker -Force
      }
      if (-not $removed -and -not $unpathed) { Say "breakpatch-ci isn't in $(Pretty $ciHome). Nothing to remove."; return }
      $made = if ($binIsDefault) { @($bin, $ciHome) } else { @($ciHome) }
      foreach ($d in $made) {
        if ((Test-Path -LiteralPath $d -PathType Container) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force }
      }
      if ($unpathed) { Say "Took $(Pretty $bin) off your PATH." }
      if (-not $removed) { return }
      Say "Removed breakpatch-ci and its browser from $(Pretty $ciHome)."
      if ($released) {
        Say "This machine's licence is given back."
      } else {
        Say "This machine's licence may still be taken. Free it in the back office, or next time run breakpatch-ci licence release first (or uninstall with BREAKPATCH_LICENCE_KEY set, which does it for you)."
      }
      return
    } finally {
      Remove-Item Env:\BREAKPATCH_UNINSTALL -ErrorAction SilentlyContinue
    }
  }

  # bin\breakpatch-ci.cmd: cmd.exe reads a .cmd file in the console's code page, never as UTF-16
  # or (with a BOM) UTF-8, so a path written as ASCII lost every letter outside it (an accented
  # user name in C:\Users\ became a ?) and the command couldn't start. In the default bin,
  # inside the install folder, the shim names nothing but its own folder (%~dp0, which cmd fills
  # in itself) and ASCII names, so any profile path works. It reads %~dp0 in a subroutine (call
  # :here): started by its name in quotes ("breakpatch-ci", found on PATH), cmd fills the batch
  # file's own %~dp0 in wrong, with the current folder, but a called label's right. Then a bare
  # exit /b, so it doesn't run on into the subroutine: it keeps breakpatch-ci's exit code as it is
  # (exit /b %ERRORLEVEL% would take a variable named ERRORLEVEL instead, if one were set).
  # Anywhere else it has to name the install folder: it's written in the system's OEM code page,
  # the one a new console starts in (OEMCP; 65001, UTF-8 without a BOM, when Windows' "Use Unicode
  # UTF-8" option is on), and a path that code page can't hold stops the install here, before
  # anything is downloaded, rather than leave a broken command. .NET's own encodings, so it's the
  # same in Windows PowerShell 5.1 and PowerShell 7.
  if ($binIsDefault) {
    $shimLines = @('@echo off', 'rem breakpatch-ci installer: starts the environment named in current.txt', 'setlocal',
                   'call :here', 'set /p BP_CI_ENV=<"%BP_CI_DIR%..\current.txt"', '"%BP_CI_DIR%..\%BP_CI_ENV%\Scripts\breakpatch-ci.exe" %*',
                   'exit /b', ':here', 'set "BP_CI_DIR=%~dp0"', 'exit /b')
  } else {
    $shimLines = @('@echo off', 'rem breakpatch-ci installer: starts the environment named in current.txt', 'setlocal',
                   "set /p BP_CI_ENV=<`"$current`"", "`"$ciHome\%BP_CI_ENV%\Scripts\breakpatch-ci.exe`" %*")
  }
  $shimText = ($shimLines -join "`r`n") + "`r`n"
  $shimEncoding = $null
  if (-not $binIsDefault) {
    try {
      $oemCp = [int](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage' -Name OEMCP -ErrorAction Stop).OEMCP
      if ($oemCp -ne 65001) {
        $shimEncoding = [Text.Encoding]::GetEncoding($oemCp, [Text.EncoderFallback]::ExceptionFallback, [Text.DecoderFallback]::ExceptionFallback)
      }
    } catch { $shimEncoding = $null; $oemCp = 0 }
    if ($oemCp -eq 65001) { $shimEncoding = New-Object Text.UTF8Encoding($false, $true) }
  }
  if (-not $shimEncoding) {    # the default bin (all ASCII), or no OEM code page to be found (not Windows: tests)
    $shimEncoding = [Text.Encoding]::GetEncoding('us-ascii', [Text.EncoderFallback]::ExceptionFallback, [Text.DecoderFallback]::ExceptionFallback)
  }
  try { $null = $shimEncoding.GetBytes($shimText) }
  catch { Fail "The command prompt can't read the install folder's path, $ciHome, in this PC's language settings. Leave BREAKPATCH_CI_BIN unset, or set BREAKPATCH_CI_HOME to a folder with a plainer name, and run this again." }

  $python = Find-Python
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("breakpatch-ci-install-" + [Guid]::NewGuid().ToString('N'))
  $files = Join-Path $tmp 'files'
  New-Item -ItemType Directory -Force -Path $files | Out-Null
  $staged = $null
  try {
    if ($token) {
      # What an Authorization header can carry (RFC 6750's token68), and nothing that could end it.
      if ($token -cnotmatch '\A[A-Za-z0-9._~+/-]+=*\z') { Fail "BREAKPATCH_GITHUB_TOKEN doesn't look like a GitHub token." }
      if (-not $Api.StartsWith($GitHubApi)) { Fail "BREAKPATCH_GITHUB_TOKEN is only ever sent to $GitHubApi, and BREAKPATCH_API isn't there. Unset one of them." }
      Say 'Using BREAKPATCH_GITHUB_TOKEN (private beta).'
    }
    Find-Release
    Assert-Release
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
    # For pip only: irm | iex runs this in the window's own session, so they go back to what they
    # were (unset, usually) once pip is done.
    $pipWas = @{ PIP_DISABLE_PIP_VERSION_CHECK = $env:PIP_DISABLE_PIP_VERSION_CHECK; PIP_NO_INPUT = $env:PIP_NO_INPUT }
    $env:PIP_DISABLE_PIP_VERSION_CHECK = '1'; $env:PIP_NO_INPUT = '1'
    Push-Location $files
    try { $code = Invoke-Native (Join-Path $tmp 'pip.log') $py @('-m', 'pip', 'install', '-q', '--require-hashes', '--only-binary=:all:', '-r', $script:reqs) }
    finally {
      Pop-Location
      foreach ($k in @($pipWas.Keys)) { Restore-EnvVar $k $pipWas[$k] }
    }
    if ($code -ne 0) {
      Get-Content -LiteralPath (Join-Path $tmp 'pip.log') -Tail 8 | Write-Host
      Fail "Couldn't install breakpatch-ci's Python packages. Check this PC can reach pypi.org (or your PIP_INDEX_URL), and run this again."
    }
    Set-Content -LiteralPath (Join-Path $staged $Marker) -Value ('{"version": "' + $version + '", "browsers": "../browsers"}') -Encoding ASCII

    $browsers = Join-Path $ciHome 'browsers'
    Say "Installing Chromium into $(Pretty $browsers)..."
    New-Item -ItemType Directory -Force -Path $browsers | Out-Null
    # Put back as it was afterwards, as with pip's settings above.
    $browsersWas = $env:PLAYWRIGHT_BROWSERS_PATH
    $env:PLAYWRIGHT_BROWSERS_PATH = $browsers
    try { $code = Invoke-Native (Join-Path $tmp 'browser.log') $py @('-m', 'playwright', 'install', 'chromium', '--no-shell') }
    finally { Restore-EnvVar 'PLAYWRIGHT_BROWSERS_PATH' $browsersWas }
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
    # Bytes, in the encoding worked out above (Set-Content's -Encoding differs between 5.1 and 7).
    [IO.File]::WriteAllBytes((Get-FullPath "$shim.new"), $shimEncoding.GetBytes($shimText))
    Move-Item -LiteralPath "$shim.new" -Destination $shim -Force
    if ($old -and $old -ne $name -and $old -like 'env-*') {
      Remove-Item -LiteralPath (Join-Path $ciHome $old) -Recurse -Force -ErrorAction SilentlyContinue
    }
    # Downloaded Pythons (python\cpython-*, as in site/install-ci) no environment uses any more.
    $pyRoot = Join-Path $ciHome 'python'
    if (Test-Path -LiteralPath $pyRoot) {
      Get-ChildItem -LiteralPath $pyRoot -Directory -Filter 'cpython-*' | Where-Object { -not ($pbs -and $_.FullName -eq $script:pbsDir) } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
      if (-not (Get-ChildItem -LiteralPath $pyRoot -Force)) { Remove-Item -LiteralPath $pyRoot -Force }
    }

    Say "breakpatch-ci $version is in $(Pretty $ciHome)."
    # As in site/install-ci: on PATH already, nothing to add; in GitHub Actions, GITHUB_PATH;
    # anywhere else this user's PATH.
    $onPath = @(([string]$env:Path -split ';') | ForEach-Object { $_.TrimEnd('\') }) -contains $bin.TrimEnd('\')
    if ($onPath) {
      Say 'Run it with: breakpatch-ci run --test path\to\test.json'
    } elseif ($env:GITHUB_PATH) {
      # UTF-8 without a BOM, as the runner reads it: Windows PowerShell 5.1's Add-Content writes
      # the ANSI code page, which loses a folder name's accent.
      [IO.File]::AppendAllText($env:GITHUB_PATH, $bin + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
      Say "Added $(Pretty $bin) to GITHUB_PATH: the next steps of this job can run breakpatch-ci."
    } elseif (Add-UserPath $bin) {
      # Noted, so the uninstall takes out only an entry this installer put there.
      [IO.File]::WriteAllText((Get-FullPath $pathMarker), $bin, (New-Object Text.UTF8Encoding($false)))
      Say "Added $(Pretty $bin) to your PATH. Open a new terminal, then run: breakpatch-ci run --test path\to\test.json"
    } else {
      Say "$(Pretty $bin) is on your PATH. Open a new terminal, then run: breakpatch-ci run --test path\to\test.json"
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
