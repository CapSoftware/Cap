// @vitest-environment jsdom

import { useDetectPlatform } from "hooks/useDetectPlatform";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getPlatformIcon,
	getVersionText,
} from "@/utils/platform";

const USER_AGENTS = {
	androidPhone:
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36",
	androidTablet:
		"Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
	linux:
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
	windows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
	mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
	iphone:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

let detected: string | null = null;
let detectedIOS = false;

function Probe() {
	const info = useDetectPlatform();
	detected = info.platform;
	detectedIOS = info.isIOS;
	return null;
}

describe("useDetectPlatform", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		detected = null;
		detectedIOS = false;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	const detect = async (userAgent: string, maxTouchPoints = 0) => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
		vi.stubGlobal(
			"navigator",
			new Proxy(navigator, {
				get: (target, key) =>
					key === "maxTouchPoints"
						? maxTouchPoints
						: Reflect.get(target, key, target),
			}),
		);
		await act(async () => root.render(createElement(Probe)));
		return detected;
	};

	it.each([
		["an Android phone", USER_AGENTS.androidPhone],
		["an Android tablet", USER_AGENTS.androidTablet],
	])("doesn't take %s for desktop Linux", async (_, userAgent) => {
		expect(await detect(userAgent)).toBe("android");
	});

	it.each([
		["linux", USER_AGENTS.linux],
		["windows", USER_AGENTS.windows],
		["macos", USER_AGENTS.mac],
	])("still detects %s", async (platform, userAgent) => {
		expect(await detect(userAgent)).toBe(platform);
		expect(detectedIOS).toBe(false);
	});

	it.each([
		["an iPhone", USER_AGENTS.iphone, 5],
		["an iPad sending a desktop Mac user agent", USER_AGENTS.mac, 5],
	])("flags %s as iOS", async (_, userAgent, maxTouchPoints) => {
		await detect(userAgent, maxTouchPoints);
		expect(detectedIOS).toBe(true);
	});

	it("doesn't flag a Mac with a trackpad as iOS", async () => {
		await detect(USER_AGENTS.mac, 0);
		expect(detectedIOS).toBe(false);
	});

	it("doesn't flag Android as iOS", async () => {
		await detect(USER_AGENTS.androidPhone, 5);
		expect(detectedIOS).toBe(false);
	});
});

describe("download helpers on Android", () => {
	it("offer the generic download rather than the Linux .deb", () => {
		expect(getDownloadUrl("android", false)).not.toBe("/download/linux-deb");
		expect(getDownloadButtonText("android", false)).toBe("Download Cap");
		expect(getPlatformIcon("android")).toBeNull();
		expect(getVersionText("android")).not.toContain("Linux");
	});
});
