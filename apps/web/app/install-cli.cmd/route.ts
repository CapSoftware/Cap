const script = `@echo off
setlocal
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Invoke-RestMethod https://cap.so/install-cli.ps1 | Invoke-Expression"
exit /b %ERRORLEVEL%
`;

export async function GET() {
	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
