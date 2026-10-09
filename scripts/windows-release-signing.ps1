[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[ValidateSet("Stage", "Restore", "StageInstallers", "RestoreInstallers", "VerifyInstaller")]
	[string] $Operation,
	[string] $Target = $env:RUST_TARGET_TRIPLE,
	[string] $WorkspaceRoot = $env:GITHUB_WORKSPACE,
	[string] $InstallerPath,
	[ValidateSet("cap", "classic")]
	[string] $App
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
	$WorkspaceRoot = (Get-Location).Path
}

$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
if ([string]::IsNullOrWhiteSpace($Target)) {
	throw "A Windows target triple is required."
}

$releaseRoot = Join-Path $WorkspaceRoot "target/$Target/release"
$gpuiReleaseRoot = Join-Path $WorkspaceRoot "apps/desktop-gpui/target/$Target/release"
$sidecarRoot = Join-Path $WorkspaceRoot "apps/desktop/src-tauri/binaries"
$signingRoot = Join-Path $releaseRoot "windows-signing"
$payloadRoot = Join-Path $signingRoot "payload"
$installerRoot = Join-Path $signingRoot "installers"
$manifestPath = Join-Path $signingRoot "payload-manifest.json"
$installerBundleRoots = @(
	(Join-Path $gpuiReleaseRoot "bundle/nsis"),
	(Join-Path $releaseRoot "bundle/nsis")
)

function Get-PayloadDefinitions {
	return @(
		[pscustomobject]@{
			Name = "Cap.exe"
			Path = Join-Path $gpuiReleaseRoot "cap-gpui.exe"
			Apps = @("cap")
		},
		[pscustomobject]@{
			Name = "Cap Classic.exe"
			Path = Join-Path $releaseRoot "Cap Classic.exe"
			Apps = @("classic")
		},
		[pscustomobject]@{
			Name = "cap-cli.exe"
			Path = Join-Path $sidecarRoot "cap-cli-$Target.exe"
			Apps = @("cap", "classic")
		},
		[pscustomobject]@{
			Name = "cap-exporter.exe"
			Path = Join-Path $sidecarRoot "cap-exporter-$Target.exe"
			Apps = @("classic")
		},
		[pscustomobject]@{
			Name = "cap-muxer.exe"
			Path = Join-Path $sidecarRoot "cap-muxer-$Target.exe"
			Apps = @("cap", "classic")
		}
	)
}

function Get-PayloadDefinition([string] $Name) {
	$definition = @(Get-PayloadDefinitions | Where-Object Name -eq $Name)
	if ($definition.Count -ne 1) {
		throw "Unknown or duplicate payload file '$Name'."
	}
	return $definition[0]
}

function Get-Sha256([string] $Path) {
	return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Manifest($Manifest) {
	$encoding = [System.Text.UTF8Encoding]::new($false)
	[System.IO.File]::WriteAllText(
		$manifestPath,
		($Manifest | ConvertTo-Json -Depth 8),
		$encoding
	)
}

function Read-Manifest {
	if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
		throw "Payload manifest '$manifestPath' does not exist."
	}
	$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
	$expectedNames = @(Get-PayloadDefinitions | ForEach-Object Name | Sort-Object)
	if ($manifest.schemaVersion -ne 2 -or $manifest.target -ne $Target -or @($manifest.entries).Count -ne $expectedNames.Count) {
		throw "Payload manifest '$manifestPath' has an unexpected schema."
	}
	$actualNames = @($manifest.entries | ForEach-Object name | Sort-Object)
	if (Compare-Object $expectedNames $actualNames) {
		throw "Payload manifest '$manifestPath' has unexpected executable names."
	}
	return $manifest
}

function Find-UniqueFile([string] $Root, [string] $Name) {
	$matches = @(Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object Name -eq $Name)
	if ($matches.Count -ne 1) {
		throw "Expected exactly one '$Name' under '$Root', found $($matches.Count)."
	}
	return $matches[0]
}

function Assert-Authenticode([string] $Path) {
	$signature = Get-AuthenticodeSignature -FilePath $Path
	if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) {
		throw "Authenticode verification failed for '$Path': $($signature.Status)."
	}
	return $signature
}

function Get-BundledInstallers {
	$installers = @(foreach ($root in $installerBundleRoots) {
		if (Test-Path -LiteralPath $root -PathType Container) {
			Get-ChildItem -LiteralPath $root -Filter *.exe -File
		}
	})
	return $installers
}

function Stage-Payload {
	if (Test-Path -LiteralPath $signingRoot) {
		Remove-Item -LiteralPath $signingRoot -Recurse -Force
	}
	$null = New-Item -ItemType Directory -Path $payloadRoot -Force
	$entries = foreach ($definition in Get-PayloadDefinitions) {
		if (-not (Test-Path -LiteralPath $definition.Path -PathType Leaf)) {
			throw "Required payload executable '$($definition.Path)' does not exist."
		}
		$destination = Join-Path $payloadRoot $definition.Name
		$null = Copy-Item -LiteralPath $definition.Path -Destination $destination -Force -PassThru
		[ordered]@{
			name = $definition.Name
			apps = @($definition.Apps)
			bytes = (Get-Item -LiteralPath $definition.Path).Length
			preSignSha256 = Get-Sha256 $definition.Path
			signedSha256 = $null
			signedBytes = $null
			signerThumbprint = $null
			signerSubject = $null
		}
	}
	Write-Manifest ([ordered]@{
		schemaVersion = 2
		target = $Target
		entries = @($entries)
		installers = @()
		verifiedInstallers = @()
	})
	Write-Host "Staged $($entries.Count) first-party Windows payload executables."
}

function Restore-Payload {
	$manifest = Read-Manifest
	$signedRoot = Join-Path $WorkspaceRoot "signed-windows-payload"
	if (-not (Test-Path -LiteralPath $signedRoot -PathType Container)) {
		throw "Signed payload directory '$signedRoot' does not exist."
	}

	foreach ($entry in $manifest.entries) {
		$definition = Get-PayloadDefinition $entry.name
		if ((Get-Sha256 $definition.Path) -ne $entry.preSignSha256) {
			throw "Unsigned payload '$($entry.name)' changed after staging."
		}
		$signedFile = Find-UniqueFile $signedRoot $entry.name
		$signature = Assert-Authenticode $signedFile.FullName
		$null = Copy-Item -LiteralPath $signedFile.FullName -Destination $definition.Path -Force -PassThru
		$null = Assert-Authenticode $definition.Path
		$entry.signedSha256 = Get-Sha256 $definition.Path
		$entry.signedBytes = (Get-Item -LiteralPath $definition.Path).Length
		$entry.signerThumbprint = $signature.SignerCertificate.Thumbprint
		$entry.signerSubject = $signature.SignerCertificate.Subject
	}
	Write-Manifest $manifest
	Write-Host "Restored and Authenticode-verified signed Windows payload executables."
}

function Stage-Installers {
	$manifest = Read-Manifest
	if (Test-Path -LiteralPath $installerRoot) {
		Remove-Item -LiteralPath $installerRoot -Recurse -Force
	}
	$null = New-Item -ItemType Directory -Path $installerRoot -Force
	$installers = @(Get-BundledInstallers)
	if ($installers.Count -ne 2) {
		throw "Expected the Cap and Cap Classic installers, found $($installers.Count)."
	}
	$staged = foreach ($installer in $installers) {
		$destination = Join-Path $installerRoot $installer.Name
		if (Test-Path -LiteralPath $destination) {
			throw "Two installers are both named '$($installer.Name)'."
		}
		$null = Copy-Item -LiteralPath $installer.FullName -Destination $destination -PassThru
		[ordered]@{
			name = $installer.Name
			path = $installer.FullName
			preSignSha256 = Get-Sha256 $installer.FullName
		}
	}
	$manifest.installers = @($staged)
	Write-Manifest $manifest
	Write-Host "Staged $($staged.Count) Windows installers for Authenticode signing."
}

function Restore-Installers {
	$manifest = Read-Manifest
	$signedRoot = Join-Path $WorkspaceRoot "signed-windows-installer"
	if (-not (Test-Path -LiteralPath $signedRoot -PathType Container)) {
		throw "Signed installer directory '$signedRoot' does not exist."
	}
	if (@($manifest.installers).Count -ne 2) {
		throw "No staged installers are recorded in '$manifestPath'."
	}
	foreach ($installer in $manifest.installers) {
		if ((Get-Sha256 $installer.path) -ne $installer.preSignSha256) {
			throw "Unsigned installer '$($installer.name)' changed after staging."
		}
		$signedFile = Find-UniqueFile $signedRoot $installer.name
		$null = Assert-Authenticode $signedFile.FullName
		$null = Copy-Item -LiteralPath $signedFile.FullName -Destination $installer.path -Force -PassThru
		$null = Assert-Authenticode $installer.path
	}
	Write-Host "Restored and Authenticode-verified the signed Windows installers."
}

function Verify-Installer {
	if ([string]::IsNullOrWhiteSpace($InstallerPath) -or [string]::IsNullOrWhiteSpace($App)) {
		throw "-InstallerPath and -App are required for VerifyInstaller."
	}
	$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
	$installerSignature = Assert-Authenticode $installer
	$manifest = Read-Manifest
	$extractRoot = Join-Path $signingRoot "installer-extract"
	if (Test-Path -LiteralPath $extractRoot) {
		Remove-Item -LiteralPath $extractRoot -Recurse -Force
	}
	$null = New-Item -ItemType Directory -Path $extractRoot -Force
	try {
		$sevenZip = Get-Command 7z -ErrorAction Stop
		& $sevenZip.Source x $installer "-o$extractRoot" -y | Out-Host
		if ($LASTEXITCODE -ne 0) {
			throw "Could not extract Windows installer '$installer'."
		}
		foreach ($entry in $manifest.entries) {
			$included = @($entry.apps) -contains $App
			$extracted = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File | Where-Object Name -eq $entry.name)
			if (-not $included) {
				if ($extracted.Count -ne 0) {
					throw "The $App installer unexpectedly contains '$($entry.name)'."
				}
				continue
			}
			if ([string]::IsNullOrWhiteSpace($entry.signedSha256)) {
				throw "Manifest entry '$($entry.name)' has no signed hash."
			}
			if ($extracted.Count -ne 1) {
				throw "Expected exactly one '$($entry.name)' in the $App installer, found $($extracted.Count)."
			}
			$signature = Assert-Authenticode $extracted[0].FullName
			$actualHash = Get-Sha256 $extracted[0].FullName
			if ($actualHash -ne $entry.signedSha256 -or $signature.SignerCertificate.Thumbprint -ne $entry.signerThumbprint) {
				throw "Installer payload '$($entry.name)' hash differs from the signed payload manifest."
			}
		}
		$manifest.verifiedInstallers = @($manifest.verifiedInstallers) + @([ordered]@{
			app = $App
			name = [System.IO.Path]::GetFileName($installer)
			sha256 = Get-Sha256 $installer
			signerThumbprint = $installerSignature.SignerCertificate.Thumbprint
			signerSubject = $installerSignature.SignerCertificate.Subject
		})
		Write-Manifest $manifest
		Write-Host "Verified the $App installer's Authenticode and signed payload hashes."
	}
	finally {
		if (Test-Path -LiteralPath $extractRoot) {
			Remove-Item -LiteralPath $extractRoot -Recurse -Force
		}
	}
}

switch ($Operation) {
	"Stage" { Stage-Payload }
	"Restore" { Restore-Payload }
	"StageInstallers" { Stage-Installers }
	"RestoreInstallers" { Restore-Installers }
	"VerifyInstaller" { Verify-Installer }
}
