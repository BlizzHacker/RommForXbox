# Build the Cartridge (RomM for Xbox) UWP app into a sideloadable MSIX.
# Run from an x64 Native Tools / normal PowerShell AFTER the Visual Studio
# "Universal Windows Platform build tools" workload is installed.
#
#   powershell -ExecutionPolicy Bypass -File build-msix.ps1
#
# Produces: shell\RommForXbox.Shell\AppPackages\...\*.msix (+ a .cer to trust).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj = Join-Path $root 'shell\RommForXbox.Shell\RommForXbox.Shell.csproj'

# Locate MSBuild from the Build Tools 2022 install.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild `
    -find MSBuild\**\Bin\MSBuild.exe | Select-Object -First 1
if (-not $msbuild) { throw "MSBuild not found. Install the VS Build Tools + UWP workload." }
Write-Host "MSBuild: $msbuild"

# Sanity: the UWP AppxPackage targets must exist, or the workload isn't installed.
$appxTargets = Split-Path $msbuild -Parent |
    Join-Path -ChildPath '..\..\Microsoft\VisualStudio\v17.0\AppxPackage\Microsoft.AppXPackage.Targets'
if (-not (Test-Path $appxTargets)) {
    Write-Warning "AppxPackage targets not found at $appxTargets"
    Write-Warning "Install: vs_installer modify --add Microsoft.VisualStudio.Workload.UniversalBuildTools"
}

# Restore NuGet (WebView2, Microsoft.UI.Xaml, NETCore.UWP), then build + package.
& $msbuild $proj /t:restore /p:Configuration=Release /p:Platform=x64 /v:m
& $msbuild $proj `
    /t:Build `
    /p:Configuration=Release `
    /p:Platform=x64 `
    /p:AppxBundle=Never `
    /p:UapAppxPackageBuildMode=SideloadOnly `
    /p:AppxPackageSigningEnabled=true `
    /p:PackageCertificateKeyFile=RommForXbox.Shell_TemporaryKey.pfx `
    /p:PackageCertificatePassword=cartridge `
    /v:m

Write-Host "`n=== Output packages ===" -ForegroundColor Cyan
Get-ChildItem -Recurse -Path (Join-Path $root 'shell\RommForXbox.Shell') `
    -Include *.msix, *.msixbundle, *.cer -ErrorAction SilentlyContinue |
    Select-Object FullName, Length | Format-Table -AutoSize
