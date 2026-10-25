param(
    [string]$NodeVersion = '22.11.0',
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
    [switch]$ForceNodeDownload
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $projectRoot 'build'
$nodeDir = Join-Path $buildDir 'node'
$downloadDir = Join-Path $buildDir 'downloads'
$distDir = Join-Path $projectRoot 'dist'
$iconPath = Join-Path $PSScriptRoot 'assets\SystemMonitor.ico'
$launcherExe = Join-Path $buildDir 'SystemMonitor.exe'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-Iscc {
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:INNO_SETUP_DIR) {
        $candidates.Add((Join-Path $env:INNO_SETUP_DIR 'ISCC.exe'))
    }

    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    $programFiles = [Environment]::GetFolderPath('ProgramFiles')
    $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')

    $candidates.Add((Join-Path $programFilesX86 'Inno Setup 6\ISCC.exe'))
    $candidates.Add((Join-Path $programFiles 'Inno Setup 6\ISCC.exe'))
    $candidates.Add((Join-Path $localAppData 'Programs\Inno Setup 6\ISCC.exe'))
    $candidates.Add((Join-Path $localAppData 'Programs\Inno\ISCC.exe'))

    $uninstallKeys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1'
    )
    foreach ($key in $uninstallKeys) {
        try {
            $location = (Get-ItemProperty -Path $key -Name 'InstallLocation' -ErrorAction Stop).InstallLocation
            if ($location) {
                $candidates.Add((Join-Path $location 'ISCC.exe'))
                $candidates.Add((Join-Path $location 'Inno Setup 6\ISCC.exe'))
            }
        } catch {
        }
    }

    foreach ($base in @(
        (Join-Path $localAppData 'Programs'),
        $programFilesX86,
        $programFiles
    )) {
        if (-not (Test-Path -LiteralPath $base)) { continue }
        try {
            foreach ($dir in Get-ChildItem -LiteralPath $base -Directory -Filter 'Inno*' -ErrorAction Stop) {
                $candidates.Add((Join-Path $dir.FullName 'ISCC.exe'))
                $candidates.Add((Join-Path $dir.FullName 'Inno Setup 6\ISCC.exe'))
            }
        } catch {
        }
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    throw 'Inno Setup 6 was not found. Install it from https://jrsoftware.org/isdl.php or set INNO_SETUP_DIR.'
}

function Install-NodeRuntime {
    $packageName = "node-v$NodeVersion-win-$Architecture"
    $zipName = "$packageName.zip"
    $mirrors = @(
        'https://npmmirror.com/mirrors/node',
        'https://mirrors.cloud.tencent.com/nodejs-release',
        'https://mirrors.huaweicloud.com/nodejs'
    )

    New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
    $zipPath = Join-Path $downloadDir $zipName
    $hashPath = Join-Path $downloadDir 'SHASUMS256.txt'
    $downloaded = $false

    foreach ($mirror in $mirrors) {
        $baseUrl = "$mirror/v$NodeVersion"
        Write-Host "Downloading $zipName from $mirror"
        try {
            & curl.exe -fL --retry 2 --connect-timeout 20 --max-time 600 -sS -o $zipPath "$baseUrl/$zipName"
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $zipPath)) { throw 'download failed' }
            if ((Get-Item -LiteralPath $zipPath).Length -lt 5000000) { throw 'download too small' }

            & curl.exe -fL --retry 2 --connect-timeout 20 --max-time 120 -sS -o $hashPath "$baseUrl/SHASUMS256.txt"
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $hashPath)) { throw 'checksum download failed' }

            $line = Get-Content -LiteralPath $hashPath | Where-Object { $_ -match ([regex]::Escape($zipName) + '$') } | Select-Object -First 1
            if (-not $line) { throw 'checksum entry missing' }
            $expected = ($line -split '\s+')[0].ToLowerInvariant()
            $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($expected -ne $actual) { throw "checksum mismatch: expected $expected, got $actual" }

            $downloaded = $true
            break
        } catch {
            Write-Warning "Mirror failed: $mirror ($($_.Exception.Message))"
        }
    }

    if (-not $downloaded) {
        throw 'Failed to download Node.js from all configured mirrors.'
    }

    $extractDir = Join-Path $buildDir 'node-extract'
    if (Test-Path -LiteralPath $extractDir) {
        Remove-Item -LiteralPath $extractDir -Recurse -Force
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

    $sourceDir = Join-Path $extractDir $packageName
    $nodeExe = Join-Path $sourceDir 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe)) {
        throw "node.exe not found after extracting $zipName."
    }

    if (Test-Path -LiteralPath $nodeDir) {
        Remove-Item -LiteralPath $nodeDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $nodeDir 'node.exe')
    $license = Join-Path $sourceDir 'LICENSE'
    if (Test-Path -LiteralPath $license) {
        Copy-Item -LiteralPath $license -Destination (Join-Path $nodeDir 'LICENSE')
    }

    Remove-Item -LiteralPath $extractDir -Recurse -Force
}

function Test-NodeRuntime {
    $nodeExe = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe)) { return $false }
    try {
        $version = (& $nodeExe -v).Trim()
        return $version -eq "v$NodeVersion"
    } catch {
        return $false
    }
}

function Compile-Launcher {
    $frameworkDir = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
    $csc = Join-Path $frameworkDir 'csc.exe'
    if (-not (Test-Path -LiteralPath $csc)) {
        $csc = Join-Path (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319') 'csc.exe'
    }
    if (-not (Test-Path -LiteralPath $csc)) {
        throw 'C# compiler csc.exe was not found (.NET Framework 4.x is required).'
    }

    $arguments = @(
        '/nologo',
        '/codepage:65001',
        '/target:winexe',
        '/optimize+',
        "/out:$launcherExe",
        "/win32icon:$iconPath",
        '/r:System.dll',
        '/r:System.Windows.Forms.dll',
        '/r:System.Drawing.dll',
        '/r:System.Management.dll',
        (Join-Path $projectRoot 'launcher\Program.cs'),
        (Join-Path $projectRoot 'launcher\AssemblyInfo.cs')
    )

    & $csc $arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Launcher compilation failed with exit code $LASTEXITCODE."
    }
}

$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if (-not $version) { throw 'package.json does not contain a version.' }

New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

Write-Step "Generating application icon"
& (Join-Path $PSScriptRoot 'make-icon.ps1') -Output $iconPath

Write-Step "Preparing Node.js $NodeVersion ($Architecture)"
if ($ForceNodeDownload -or -not (Test-NodeRuntime)) {
    Install-NodeRuntime
} else {
    Write-Host "Using cached $(Join-Path $nodeDir 'node.exe')"
}

Write-Step "Compiling SystemMonitor.exe"
Compile-Launcher

Write-Step "Compiling installer"
$iscc = Resolve-Iscc
$architectureDefine = if ($Architecture -eq 'arm64') { 'arm64' } else { 'x64compatible' }
$issPath = Join-Path $PSScriptRoot 'SystemMonitor.iss'
& $iscc "/DMyAppVersion=$version" "/DMyArchitecture=$architectureDefine" $issPath
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE."
}

$installerPath = Join-Path $distDir "SystemMonitor-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $installerPath)) {
    throw "Installer was not created: $installerPath"
}

$installerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$installerSize = [Math]::Round((Get-Item -LiteralPath $installerPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Installer ready:" -ForegroundColor Green
Write-Host "  $installerPath"
Write-Host "  $installerSize MB"
Write-Host "  SHA256 $installerHash"
