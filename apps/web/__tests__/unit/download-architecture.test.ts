// @vitest-environment jsdom

import { useDetectPlatform } from "hooks/useDetectPlatform";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDownloadUrl } from "@/utils/platform";

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
let platform: ReturnType<typeof useDetectPlatform>;
function Harness() {
	platform = useDetectPlatform();
	return createElement(
		"a",
		{ href: getDownloadUrl(platform.platform, platform.isIntel) },
		"Download",
	);
}
function navigatorInfo(
	userAgent: string,
	getHighEntropyValues?: () => Promise<{ architecture?: string }>,
) {
	vi.stubGlobal("navigator", {
		userAgent,
		...(getHighEntropyValues
			? { userAgentData: { getHighEntropyValues } }
			: {}),
	});
}
function renderer(name: string | null) {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() =>
		name === null
			? null
			: {
					getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37446 }),
					getParameter: () => name,
				}) as typeof HTMLCanvasElement.prototype.getContext);
}
const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
async function render() {
	await act(async () => {
		root.render(createElement(Harness));
		await Promise.resolve();
	});
}
function href() {
	return container.querySelector("a")?.getAttribute("href");
}
describe("Mac download architecture", () => {
	it.each(["", "unknown", "mips"])(
		"uses the Apple GPU fallback for an unrecognized %j hint",
		async (architecture) => {
			navigatorInfo(mac, async () => ({ architecture }));
			renderer("Apple M2");
			await render();
			expect(href()).toBe("/download/apple-silicon");
		},
	);
	it("keeps the safe default when the hint is empty and WebGL is unavailable", async () => {
		navigatorInfo(mac, async () => ({ architecture: "" }));
		renderer(null);
		await render();
		expect(href()).toBe("/download/apple-silicon");
	});
	it("uses WebGL to identify Intel when the hint is unknown", async () => {
		navigatorInfo(mac, async () => ({ architecture: "" }));
		renderer("Intel Iris");
		await render();
		expect(href()).toBe("/download/apple-intel");
	});
	it.each([
		["x86", "/download/apple-intel"],
		["arm", "/download/apple-silicon"],
		["arm64", "/download/apple-silicon"],
		["aarch64", "/download/apple-silicon"],
		["amd64", "/download/apple-intel"],
	])("uses the known %s hint", async (architecture, expected) => {
		navigatorInfo(mac, async () => ({ architecture }));
		renderer(null);
		await render();
		expect(href()).toBe(expected);
	});
	it("falls back to the renderer when high entropy access rejects", async () => {
		navigatorInfo(mac, async () => {
			throw new Error("unavailable");
		});
		renderer("Intel Iris");
		await render();
		expect(href()).toBe("/download/apple-intel");
	});
	it.each([
		["Windows", "/download/windows"],
		["Linux", "/download/linux-deb"],
	])("keeps %s downloads", async (agent, expected) => {
		const hints = vi.fn();
		navigatorInfo(agent, hints);
		await render();
		expect(href()).toBe(expected);
		expect(hints).not.toHaveBeenCalled();
	});
});
