import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The two manifests are maintained by hand; these assertions keep the parts
// that must not drift (version, entry points, content scripts, resources) in
// lockstep and pin the deliberate per-browser differences.

type Manifest = {
	manifest_version: number;
	name: string;
	short_name: string;
	version: string;
	homepage_url: string;
	icons: Record<string, string>;
	action: unknown;
	background: {
		service_worker?: string;
		scripts?: string[];
		type?: string;
	};
	permissions: string[];
	host_permissions: string[];
	content_scripts: unknown[];
	web_accessible_resources: Array<{
		resources: string[];
		matches: string[];
		use_dynamic_url?: boolean;
	}>;
	options_page?: string;
	options_ui?: { page: string };
	browser_specific_settings?: {
		gecko?: {
			id?: string;
			strict_min_version?: string;
		};
	};
};

const loadManifest = (target: "chrome" | "firefox"): Manifest =>
	JSON.parse(
		readFileSync(
			resolve(__dirname, `../../manifests/manifest.${target}.json`),
			"utf8",
		),
	);

const chrome = loadManifest("chrome");
const firefox = loadManifest("firefox");

describe("manifest parity", () => {
	it("keeps shared identity fields in sync", () => {
		expect(firefox.manifest_version).toBe(chrome.manifest_version);
		expect(firefox.name).toBe(chrome.name);
		expect(firefox.short_name).toBe(chrome.short_name);
		expect(firefox.version).toBe(chrome.version);
		expect(firefox.homepage_url).toBe(chrome.homepage_url);
		expect(firefox.icons).toEqual(chrome.icons);
		expect(firefox.action).toEqual(chrome.action);
	});

	it("keeps content scripts and host permissions in sync", () => {
		expect(firefox.content_scripts).toEqual(chrome.content_scripts);
		expect(firefox.host_permissions).toEqual(chrome.host_permissions);
	});

	it("exposes the same web accessible resources (modulo use_dynamic_url)", () => {
		const strip = (entries: Manifest["web_accessible_resources"]) =>
			entries.map(({ resources, matches }) => ({ resources, matches }));
		expect(strip(firefox.web_accessible_resources)).toEqual(
			strip(chrome.web_accessible_resources),
		);
		// use_dynamic_url is Chromium-only.
		expect(
			firefox.web_accessible_resources.every(
				(entry) => entry.use_dynamic_url === undefined,
			),
		).toBe(true);
	});

	it("points both backgrounds at the same script", () => {
		expect(chrome.background.service_worker).toBe("assets/service-worker.js");
		expect(firefox.background.scripts).toEqual(["assets/service-worker.js"]);
		expect(firefox.background.service_worker).toBeUndefined();
	});

	it("only differs in the Chrome-only permissions", () => {
		expect(chrome.permissions).toEqual(
			expect.arrayContaining(["offscreen", "tabCapture"]),
		);
		const chromeOnly = ["offscreen", "tabCapture"];
		expect(firefox.permissions.filter((p) => chromeOnly.includes(p))).toEqual(
			[],
		);
		expect([...firefox.permissions].sort()).toEqual(
			chrome.permissions.filter((p) => !chromeOnly.includes(p)).sort(),
		);
	});

	it("declares Firefox-specific settings and options_ui", () => {
		expect(firefox.browser_specific_settings?.gecko?.id).toBeTruthy();
		expect(
			firefox.browser_specific_settings?.gecko?.strict_min_version,
		).toBeTruthy();
		expect(firefox.options_ui?.page).toBe(chrome.options_page);
		expect(firefox.options_page).toBeUndefined();
		expect(chrome.browser_specific_settings).toBeUndefined();
	});
});
