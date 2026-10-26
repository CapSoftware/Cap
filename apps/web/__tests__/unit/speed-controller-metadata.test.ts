// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpeedController } from "@/components/tools/SpeedController";

vi.mock("@cap/ui", () => ({
	Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) =>
		createElement("button", { ...props, type: "button" }),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let probes: HTMLVideoElement[];
let revoked: string[];

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
	probes = [];
	revoked = [];
	let nextUrl = 0;
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL() {
				return `blob:metadata-${++nextUrl}`;
			}
			static revokeObjectURL(url: string) {
				revoked.push(url);
			}
		},
	);
	const create = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
		const element = create(tag, options);
		if (element instanceof HTMLVideoElement) probes.push(element);
		return element;
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(SpeedController)));
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function select(name: string) {
	const input = container.querySelector("input[type=file]");
	if (!(input instanceof HTMLInputElement)) throw new Error("Missing input");
	Object.defineProperty(input, "files", {
		configurable: true,
		value: [new File(["video"], name, { type: "video/mp4" })],
	});
	const count = probes.length;
	await act(async () =>
		input.dispatchEvent(new Event("change", { bubbles: true })),
	);
	const probe = probes
		.slice(count)
		.find((video) => video.preload === "metadata");
	if (!probe) throw new Error("Missing metadata probe");
	return probe;
}

async function load(probe: HTMLVideoElement, duration = 12, width = 640) {
	Object.defineProperties(probe, {
		duration: { configurable: true, value: duration },
		videoWidth: { configurable: true, value: width },
		videoHeight: { configurable: true, value: 360 },
	});
	await act(async () => probe.dispatchEvent(new Event("loadedmetadata")));
}

it("keeps the current file's metadata when an older probe finishes last", async () => {
	const first = await select("first.mp4");
	const firstUrl = first.src;
	const second = await select("second.mp4");
	await load(second, 30, 1920);
	expect(container.textContent).toContain("Duration: 0:30");
	await load(first, 90, 320);
	expect(container.textContent).toContain("second.mp4");
	expect(container.textContent).toContain("Duration: 0:30");
	expect(container.textContent).toContain("Resolution: 1920x360");
	expect(revoked.filter((url) => url === firstUrl)).toHaveLength(1);
});

it("releases a pending probe as soon as another file replaces it", async () => {
	const first = await select("first.mp4");
	const url = first.src;
	await select("second.mp4");
	expect(revoked).toContain(url);
	expect(first.onloadedmetadata).toBeNull();
	expect(first.onerror).toBeNull();
});

it("disposes metadata failures without losing the selected file", async () => {
	const probe = await select("broken.mp4");
	const url = probe.src;
	await act(async () => probe.dispatchEvent(new Event("error")));
	expect(revoked.filter((entry) => entry === url)).toHaveLength(1);
	expect(container.textContent).toContain("broken.mp4");
	expect(container.textContent).not.toContain("Resolution:");
	await load(probe);
	expect(container.textContent).not.toContain("Resolution:");
});

it("releases a pending metadata URL on unmount", async () => {
	const probe = await select("first.mp4");
	const url = probe.src;
	await act(async () => root.unmount());
	expect(revoked.filter((entry) => entry === url)).toHaveLength(1);
	expect(probe.onloadedmetadata).toBeNull();
});

it("prevents a reset probe from restoring the discarded file's metadata", async () => {
	const probe = await select("first.mp4");
	const url = probe.src;
	const reset = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Reset",
	);
	if (!reset) throw new Error("Missing reset button");
	await act(async () => reset.click());
	expect(revoked.filter((entry) => entry === url)).toHaveLength(1);
	await load(probe, 90, 320);
	await select("second.mp4");
	expect(container.textContent).not.toContain("Resolution:");
	await load(probe, 90, 320);
	expect(container.textContent).not.toContain("Resolution:");
});

it("shows successful metadata and releases its URL exactly once", async () => {
	const probe = await select("first.mp4");
	const url = probe.src;
	await load(probe);
	expect(container.textContent).toContain("Duration: 0:12");
	expect(container.textContent).toContain("Resolution: 640x360");
	await select("second.mp4");
	expect(container.textContent).not.toContain("Resolution:");
	expect(revoked.filter((entry) => entry === url)).toHaveLength(1);
});
