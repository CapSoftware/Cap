[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[ValidateSet("Stage", "Restore", "VerifyInstaller")]
	[string] $Operation,
	[string] $Target = $env:RUST_TARGET_TRIPLE,
	[string] $WorkspaceRoot = $env:GITHUB_WORKSPACE,
	[string] $InstallerPath
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
$signingRoot = Join-Path $releaseRoot "windows-signing"
$payloadRoot = Join-Path $signingRoot "payload"
$manifestPath = Join-Path $signingRoot "payload-manifest.json"

function Get-PayloadDefinitions {
	return @(
		[pscustomobject]@{
			Name = "Cap.exe"
			Path = Join-Path $releaseRoot "Cap.exe"
		},
		[pscustomobject]@{
			Name = "cap-gpui.exe"
			Path = Join-Path $WorkspaceRoot "apps/desktop/src-tauri/binaries/cap-gpui-$Target.exe"
		},
		[pscustomobject]@{
			Name = "cap-cli.exe"
			Path = Join-Path $WorkspaceRoot "apps/desktop/src-tauri/binaries/cap-cli-$Target.exe"
		},
		[pscustomobject]@{
			Name = "cap-exporter.exe"
			Path = Join-Path $WorkspaceRoot "apps/desktop/src-tauri/binaries/cap-exporter-$Target.exe"
		},
		[pscustomobject]@{
			Name = "cap-muxer.exe"
			Path = Join-Path $WorkspaceRoot "apps/desktop/src-tauri/binaries/cap-muxer-$Target.exe"
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
	if ($manifest.schemaVersion -ne 1 -or $manifest.target -ne $Target -or @($manifest.entries).Count -ne 5) {
		throw "Payload manifest '$manifestPath' has an unexpected schema."
	}
	$expectedNames = @(Get-PayloadDefinitions | ForEach-Object Name | Sort-Object)
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
			bytes = (Get-Item -LiteralPath $definition.Path).Length
			preSignSha256 = Get-Sha256 $definition.Path
			signedSha256 = $null
			signedBytes = $null
			signerThumbprint = $null
			signerSubject = $null
		}
	}
	Write-Manifest ([ordered]@{
		schemaVersion = 1
		target = $Target
		entries = @($entries)
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

function Verify-Installer {
	if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
		throw "-InstallerPath is required for VerifyInstaller."
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
			if ([string]::IsNullOrWhiteSpace($entry.signedSha256)) {
				throw "Manifest entry '$($entry.name)' has no signed hash."
			}
			$extracted = Find-UniqueFile $extractRoot $entry.name
			$signature = Assert-Authenticode $extracted.FullName
			$actualHash = Get-Sha256 $extracted.FullName
			if ($actualHash -ne $entry.signedSha256 -or $signature.SignerCertificate.Thumbprint -ne $entry.signerThumbprint) {
				throw "Installer payload '$($entry.name)' hash differs from the signed payload manifest."
			}
		}
		$manifest.verifiedInstallers = @($manifest.verifiedInstallers) + @([ordered]@{
			name = [System.IO.Path]::GetFileName($installer)
			sha256 = Get-Sha256 $installer
			signerThumbprint = $installerSignature.SignerCertificate.Thumbprint
			signerSubject = $installerSignature.SignerCertificate.Subject
		})
		Write-Manifest $manifest
		Write-Host "Verified installer Authenticode and signed payload hashes."
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
	"VerifyInstaller" { Verify-Installer }
}
