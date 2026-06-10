const programFilesX86 = "$" + "{env:ProgramFiles(x86)}";

const script = String.raw`$ErrorActionPreference = "Stop"

function Find-CapAppPath {
	$candidates = @(
		"$env:LOCALAPPDATA\Programs\Cap\Cap.exe",
		"$env:LOCALAPPDATA\Cap\Cap.exe",
		"$env:ProgramFiles\Cap\Cap.exe",
		"${programFilesX86}\Cap\Cap.exe"
	)

	foreach ($candidate in $candidates) {
		if (Test-Path $candidate) {
			return $candidate
		}
	}

	return $null
}

function Install-CapDesktop {
	$downloadUrl = "https://cap.so/download/windows"
	$installerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("Cap-" + [System.Guid]::NewGuid().ToString("N") + ".exe")

	try {
		Write-Host "Downloading Cap Desktop..."
		Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $installerPath
		Write-Host "Installing Cap Desktop..."
		$process = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru

		if ($process.ExitCode -ne 0) {
			Write-Error "Cap Desktop installer failed with exit code $($process.ExitCode)."
			exit 1
		}
	} finally {
		Remove-Item -Force $installerPath -ErrorAction SilentlyContinue
	}
}

$appPath = $env:CAP_APP_PATH
$forceDesktopInstall = $env:CAP_DESKTOP_FORCE_INSTALL

if (-not $appPath) {
	$appPath = Find-CapAppPath
} elseif (-not (Test-Path $appPath)) {
	Write-Error "Cap Desktop was not found at $appPath."
	exit 1
}

if (-not $appPath) {
	Install-CapDesktop
	$appPath = Find-CapAppPath

	if (-not $appPath) {
		Write-Error "Cap Desktop was installed, but Cap.exe was not found. Open Cap Desktop once, then run this script again."
		exit 1
	}
}

if ($forceDesktopInstall) {
	Install-CapDesktop
	$appPath = Find-CapAppPath

	if (-not $appPath) {
		Write-Error "Cap Desktop was installed, but Cap.exe was not found. Open Cap Desktop once, then run this script again."
		exit 1
	}
}

if ((Get-Item $appPath).PSIsContainer) {
	$appDir = $appPath
} else {
	$appDir = Split-Path -Parent $appPath
}

$cliTarget = Join-Path $appDir "cap-cli.exe"

if (-not (Test-Path $cliTarget)) {
	Write-Host "This Cap Desktop install does not include the CLI. Reinstalling Cap Desktop..."
	Install-CapDesktop
	$appPath = Find-CapAppPath

	if (-not $appPath) {
		Write-Error "Cap Desktop was installed, but Cap.exe was not found. Open Cap Desktop once, then run this script again."
		exit 1
	}

	if ((Get-Item $appPath).PSIsContainer) {
		$appDir = $appPath
	} else {
		$appDir = Split-Path -Parent $appPath
	}

	$cliTarget = Join-Path $appDir "cap-cli.exe"

	if (-not (Test-Path $cliTarget)) {
		Write-Error "This Cap Desktop install does not include the CLI."
		exit 1
	}
}

$shimTarget = $cliTarget
$knownRoots = @(
	@{ Value = $env:LOCALAPPDATA; Token = "%LOCALAPPDATA%" },
	@{ Value = $env:ProgramFiles; Token = "%ProgramFiles%" },
	@{ Value = "${programFilesX86}"; Token = "%ProgramFiles(x86)%" }
)

foreach ($root in $knownRoots) {
	$value = $root["Value"]
	$token = $root["Token"]

	if ($value -and $cliTarget.StartsWith($value, [System.StringComparison]::OrdinalIgnoreCase)) {
		$suffix = $cliTarget.Substring($value.Length)
		if (-not $suffix -or $suffix.StartsWith('\') -or $suffix.StartsWith('/')) {
			$shimTarget = "$token$suffix"
			break
		}
	}
}

$installDir = if ($env:CAP_CLI_INSTALL_DIR) { $env:CAP_CLI_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".cap\bin" }
$shimPath = Join-Path $installDir "cap.cmd"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null

if (Test-Path $shimPath) {
	$contents = Get-Content $shimPath -Raw
	if (-not ($contents.Contains($cliTarget) -or $contents.Contains($shimTarget) -or $contents -match '\\Cap\\cap-cli\.exe')) {
		Write-Error "$shimPath already exists and is not managed by Cap. Remove it or set CAP_CLI_INSTALL_DIR, then run this script again."
		exit 1
	}
}

@"
@echo off
"$shimTarget" %*
"@ | Set-Content -Encoding Oem $shimPath

& $shimPath --help | Out-Null

Write-Host "Installed cap at $shimPath"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$userEntries = if ($userPath) { $userPath -split ";" } else { @() }
$sessionEntries = $env:Path -split ";"

if ($sessionEntries -contains $installDir) {
	Write-Host "cap is ready to use."
} elseif ($env:CAP_NO_MODIFY_PATH) {
	Write-Host "Add this to your user PATH, then open a new terminal:"
	Write-Host ('[Environment]::SetEnvironmentVariable("Path", "' + $installDir + ';' + $userPath + '", "User")')
} else {
	if ($userEntries -notcontains $installDir) {
		$newUserPath = if ($userPath) { "$installDir;$userPath" } else { $installDir }
		[Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
	}
	$env:Path = "$installDir;$env:Path"
	Write-Host "Added cap to your PATH. It is ready in this window and in new terminals."
}
`;

export async function GET() {
	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
