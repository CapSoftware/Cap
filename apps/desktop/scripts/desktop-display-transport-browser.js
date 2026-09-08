import { existsSync } from "node:fs";
import path from "node:path";

export function resolveDesktopBenchmarkBrowser({
	platform = process.platform,
	environment = process.env,
	fileExists = existsSync,
} = {}) {
	const override = environment.CAP_DESKTOP_BENCHMARK_BROWSER?.trim();
	if (override) {
		if (fileExists(override)) return override;
		throw new Error(`Benchmark browser does not exist: ${override}`);
	}

	const candidates = [];
	if (platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		);
	} else if (platform === "win32") {
		const roots = [
			environment["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
			environment.PROGRAMFILES ?? "C:\\Program Files",
			environment.LOCALAPPDATA,
		].filter(Boolean);
		for (const root of roots) {
			candidates.push(
				path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
				path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
			);
		}
	} else if (platform === "linux") {
		candidates.push(
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/usr/bin/microsoft-edge",
		);
	}

	const browser = candidates.find(fileExists);
	if (browser) return browser;

	throw new Error(
		`No Chromium browser found for ${platform}; set CAP_DESKTOP_BENCHMARK_BROWSER to its executable path`,
	);
}
