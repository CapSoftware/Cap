import { describe, expect, it } from "vitest";
import { resolveDesktopBenchmarkBrowser } from "./desktop-display-transport-browser.js";

describe("resolveDesktopBenchmarkBrowser", () => {
	it("preserves the existing macOS Google Chrome selection", () => {
		const chrome =
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		expect(
			resolveDesktopBenchmarkBrowser({
				platform: "darwin",
				environment: {},
				fileExists: (candidate) => candidate === chrome,
			}),
		).toBe(chrome);
	});

	it("finds Microsoft Edge in Windows Program Files", () => {
		const edge = "D:\\Programs\\Microsoft\\Edge\\Application\\msedge.exe";
		expect(
			resolveDesktopBenchmarkBrowser({
				platform: "win32",
				environment: {
					"PROGRAMFILES(X86)": "D:\\Programs",
				},
				fileExists: (candidate) => candidate === edge,
			}),
		).toBe(edge);
	});

	it("finds a Linux Chromium installation", () => {
		expect(
			resolveDesktopBenchmarkBrowser({
				platform: "linux",
				environment: {},
				fileExists: (candidate) => candidate === "/usr/bin/chromium",
			}),
		).toBe("/usr/bin/chromium");
	});

	it("uses an explicitly configured browser before platform discovery", () => {
		const browser = "/opt/browser/chrome";
		expect(
			resolveDesktopBenchmarkBrowser({
				platform: "linux",
				environment: { CAP_DESKTOP_BENCHMARK_BROWSER: browser },
				fileExists: (candidate) => candidate === browser,
			}),
		).toBe(browser);
	});

	it("rejects a missing explicitly configured browser", () => {
		expect(() =>
			resolveDesktopBenchmarkBrowser({
				platform: "linux",
				environment: { CAP_DESKTOP_BENCHMARK_BROWSER: "/missing/browser" },
				fileExists: () => false,
			}),
		).toThrow("Benchmark browser does not exist: /missing/browser");
	});

	it("explains how to configure unsupported browser installations", () => {
		expect(() =>
			resolveDesktopBenchmarkBrowser({
				platform: "linux",
				environment: {},
				fileExists: () => false,
			}),
		).toThrow("set CAP_DESKTOP_BENCHMARK_BROWSER");
	});
});
