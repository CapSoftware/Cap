const programFilesX86 = "$" + "{env:ProgramFiles(x86)}";

const script = String.raw`$ErrorActionPreference = "Stop"

$appPath = $env:CAP_APP_PATH

if (-not $appPath) {
	$candidates = @(
		"$env:LOCALAPPDATA\Programs\Cap\Cap.exe",
		"$env:LOCALAPPDATA\Cap\Cap.exe",
		"$env:ProgramFiles\Cap\Cap.exe",
		"${programFilesX86}\Cap\Cap.exe"
	)

	foreach ($candidate in $candidates) {
		if (Test-Path $candidate) {
			$appPath = $candidate
			break
		}
	}
}

if (-not $appPath) {
	Write-Error "Cap Desktop was not found. Install Cap from https://cap.so/download, then run this script again."
	exit 1
}

if ((Get-Item $appPath).PSIsContainer) {
	$appDir = $appPath
} else {
	$appDir = Split-Path -Parent $appPath
}

$cliTarget = Join-Path $appDir "cap-cli.exe"

if (-not (Test-Path $cliTarget)) {
	Write-Error "This Cap Desktop install does not include the CLI. Update Cap, then run this script again."
	exit 1
}

$installDir = if ($env:CAP_CLI_INSTALL_DIR) { $env:CAP_CLI_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".cap\bin" }
$shimPath = Join-Path $installDir "cap.cmd"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null

if (Test-Path $shimPath) {
	$contents = Get-Content $shimPath -Raw
	if (-not ($contents.Contains($cliTarget) -or $contents -match '\\Cap\\cap-cli\.exe')) {
		Write-Error "$shimPath already exists and is not managed by Cap. Remove it or set CAP_CLI_INSTALL_DIR, then run this script again."
		exit 1
	}
}

@"
@echo off
"$cliTarget" %*
"@ | Set-Content -Encoding ASCII $shimPath

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
