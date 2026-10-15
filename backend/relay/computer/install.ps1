# Served with a release URL, digest and backend origin injected by the Relay backend.
# Published as `irm <origin>/install.ps1 | iex` for Windows PowerShell 5.1 and PowerShell 7.
# Keep all work inside functions: a truncated download must not run half a script.
# Never call `exit`: the script runs inside the user's own PowerShell session.
# ASCII only: Windows PowerShell may decode the download as Latin-1.

function Get-RelayFile([string]$Uri, [string]$OutFile) {
    for ($attempt = 1; ; $attempt++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile -TimeoutSec 300
            return
        } catch {
            if ($attempt -ge 3) { throw "Download failed: $Uri ($($_.Exception.Message))" }
            Start-Sleep -Seconds 2
        }
    }
}

function Test-RelaySha256([string]$Path, [string]$Expected) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -eq $Expected
}

function Find-RelayNode {
    $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { return $null }
    $reported = (& $command.Source --version 2>$null | Select-Object -First 1)
    if ($reported -notmatch '^v(\d+)\.(\d+)\.') { return $null }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]
    if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 19)) { return $command.Source }
    return $null
}

function Install-RelayNode([string]$Root, [string]$Temp, [string]$Arch, [string]$Tar) {
    Write-Host 'Installing a private Node.js 24 runtime...'
    $origin = 'https://nodejs.org/dist/latest-v24.x'
    Get-RelayFile "$origin/SHASUMS256.txt" (Join-Path $Temp 'SHASUMS256.txt')
    $pattern = "^([a-f0-9]{64})\s+(node-v24\.\d+\.\d+-win-$Arch\.zip)$"
    $line = Get-Content -LiteralPath (Join-Path $Temp 'SHASUMS256.txt') | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $line -or $line -notmatch $pattern) { throw 'Cannot find a supported Node.js runtime.' }
    $sha = $Matches[1]; $file = $Matches[2]
    $archive = Join-Path $Temp 'node.zip'
    Get-RelayFile "$origin/$file" $archive
    if (-not (Test-RelaySha256 $archive $sha)) { throw 'Node.js download checksum mismatch.' }
    $unpacked = Join-Path $Temp 'node'
    New-Item -ItemType Directory -Path $unpacked | Out-Null
    & $Tar -xf $archive -C $unpacked
    if ($LASTEXITCODE -ne 0) { throw 'Could not unpack Node.js.' }
    $name = $file -replace '\.zip$', ''
    $runtimes = Join-Path $Root 'runtimes'
    New-Item -ItemType Directory -Force -Path $runtimes | Out-Null
    $runtime = Join-Path $runtimes $name
    if (-not (Test-Path -LiteralPath $runtime)) { Move-Item -LiteralPath (Join-Path $unpacked $name) -Destination $runtime }
    return (Join-Path $runtime 'node.exe')
}

function Read-RelaySecret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Read-RelayWorkspace {
    $workspace = (Read-Host 'Local workspace directory (absolute path)').Trim().Trim('"')
    if ($workspace -eq '~') { $workspace = $HOME }
    elseif ($workspace.StartsWith('~\') -or $workspace.StartsWith('~/')) { $workspace = Join-Path $HOME $workspace.Substring(2) }
    if (-not $workspace) { throw 'Workspace directory must not be empty.' }
    return $workspace
}

function Install-Relay([string[]]$RelayArgs) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'This installer is for Windows. On macOS or Linux, run the install.sh command instead.' }
    $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($cpu) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw 'Unsupported CPU architecture.' } }
    # Windows' own bsdtar; Git's tar would read C:\ as a remote host.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) { throw 'Relay needs Windows 10 version 1803 or newer (tar.exe is missing).' }
    $RelayArgs = @($RelayArgs | Where-Object { $_ -ne $null })
    if ($RelayArgs -notcontains '--backend-url') { $RelayArgs = @('--backend-url', @@BACKEND_URL@@) + $RelayArgs }
    $root = Join-Path $env:LOCALAPPDATA 'Relay'
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'releases') | Out-Null
    $temp = Join-Path $root ('.install.' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temp | Out-Null
    $tokenSet = $false
    try {
        Write-Host 'Downloading Relay...'
        $bundle = Join-Path $temp 'daemon.tar.gz'
        Get-RelayFile @@BUNDLE_URL@@ $bundle
        if (-not (Test-RelaySha256 $bundle '@@BUNDLE_SHA256@@')) { throw 'Relay download checksum mismatch.' }
        $client = Join-Path $temp 'client'
        New-Item -ItemType Directory -Path $client | Out-Null
        & $tar -xzf $bundle -C $client
        if ($LASTEXITCODE -ne 0) { throw 'Could not unpack the Relay download.' }
        $node = Find-RelayNode
        if (-not $node) { $node = Install-RelayNode $root $temp $arch $tar }
        $release = Join-Path $root 'releases\@@BUNDLE_SHA256@@'
        if (-not (Test-Path -LiteralPath $release)) { Move-Item -LiteralPath $client -Destination $release }
        $legacySetup = $RelayArgs -contains '--sandbox-id'
        # The token travels only via the child environment, never argv or history.
        if ($legacySetup -and -not $env:RELAY_DAEMON_NODE_TOKEN) {
            $token = Read-RelaySecret 'Relay node token'
            if (-not $token) { throw 'Node token must not be empty.' }
            $env:RELAY_DAEMON_NODE_TOKEN = $token
            $tokenSet = $true
        }
        if (-not $legacySetup -and $RelayArgs -notcontains '--workspace') {
            $RelayArgs = $RelayArgs + @('--workspace', (Read-RelayWorkspace))
        }
        # Windows PowerShell 5.1 quotes an argument with spaces as "C:\My Work\", where the
        # trailing backslash escapes the closing quote; drop it from every path-like argument.
        $RelayArgs = @($RelayArgs | ForEach-Object { if ($_.Length -gt 3 -and $_.EndsWith('\')) { $_.TrimEnd('\') } else { $_ } })
        & $node (Join-Path $release 'node_modules\relay-daemon\dist\install.js') @RelayArgs
        if ($LASTEXITCODE -ne 0) { throw "Relay installation failed (exit code $LASTEXITCODE)." }
    } finally {
        if ($tokenSet) { Remove-Item Env:RELAY_DAEMON_NODE_TOKEN -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Relay $args
