// @vitest-environment jsdom

import { act, type ComponentProps, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoomDownloader } from "@/components/tools/LoomDownloader";
import { saveLoomStreamAsMp4 } from "@/lib/loom-browser-conversion";
import { resolveLoomBrowserDownload } from "@/lib/loom-browser-download";

vi.mock("@cap/ui", () => ({
	Button: ({
		spinner: _spinner,
		...props
	}: ComponentProps<"button"> & { spinner?: boolean }) =>
		createElement("button", { ...props, type: "button" }),
}));
vi.mock("@/lib/loom-browser-download", () => ({
	resolveLoomBrowserDownload: vi.fn(),
}));
vi.mock("@/lib/loom-browser-conversion", () => ({
	saveLoomStreamAsMp4: vi.fn(),
	getLoomBrowserConversionSupport: () => ({ supported: true }),
	getLoomBrowserConversionErrorMessage: (error: Error) => error.message,
	isLoomBrowserConversionAbort: (error: Error) => error.name === "AbortError",
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const downloadInfo = (direct = false) => ({
	success: true,
	videoId: "fixture-video",
	videoName: "Fixture video",
	downloadUrl: `https://cdn.example/video.${direct ? "mp4" : "mpd"}`,
	downloadMode: direct
		? ("direct-download" as const)
		: ("browser-conversion" as const),
});
let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
let converter: ReturnType<typeof deferred<Blob | undefined>>;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = vi.fn(() => "blob:download");
			static revokeObjectURL = vi.fn();
		},
	);
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
	vi.mocked(resolveLoomBrowserDownload)
		.mockReset()
		.mockResolvedValue(downloadInfo());
	converter = deferred<Blob | undefined>();
	vi.mocked(saveLoomStreamAsMp4).mockReset().mockReturnValue(converter.promise);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	mounted = true;
	await act(async () => root.render(createElement(LoomDownloader)));
	const input = container.querySelector("input");
	if (!input) throw new Error("Missing Loom URL input");
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	setValue?.call(input, "https://www.loom.com/share/fixture-video");
	await act(async () =>
		input.dispatchEvent(new Event("input", { bubbles: true })),
	);
});
afterEach(async () => {
	if (mounted) await unmount();
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function unmount() {
	await act(async () => root.unmount());
	mounted = false;
}
async function start() {
	const button = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "Download Video",
	);
	if (!button) throw new Error("Missing download action");
	await act(async () => button.click());
}

it("aborts the active conversion when the downloader unmounts", async () => {
	await start();
	const signal = vi.mocked(saveLoomStreamAsMp4).mock.calls[0]?.[0].signal;
	expect(signal?.aborted).toBe(false);
	await unmount();
	expect(signal?.aborted).toBe(true);
	await act(async () => converter.resolve(undefined));
});

it("does not create a download or retain a Blob from late conversion completion", async () => {
	await start();
	await unmount();
	await act(async () =>
		converter.resolve(new Blob(["MP4"], { type: "video/mp4" })),
	);
	expect(URL.createObjectURL).not.toHaveBeenCalled();
	expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
});

it.each([false, true])(
	"ignores late URL resolution after unmount (direct: %s)",
	async (direct) => {
		const resolver =
			deferred<Awaited<ReturnType<typeof resolveLoomBrowserDownload>>>();
		vi.mocked(resolveLoomBrowserDownload).mockReturnValueOnce(resolver.promise);
		await start();
		await unmount();
		await act(async () => resolver.resolve(downloadInfo(direct)));
		expect(saveLoomStreamAsMp4).not.toHaveBeenCalled();
		expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
		await act(async () => converter.resolve(undefined));
	},
);

it("keeps a completed MP4 available until the downloader unmounts", async () => {
	await start();
	await act(async () =>
		converter.resolve(new Blob(["MP4"], { type: "video/mp4" })),
	);
	expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
	expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
	expect(URL.revokeObjectURL).not.toHaveBeenCalled();
	await unmount();
	expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
});

it("still starts a direct MP4 download while mounted", async () => {
	vi.mocked(resolveLoomBrowserDownload).mockResolvedValueOnce(
		downloadInfo(true),
	);
	await start();
	expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
	expect(saveLoomStreamAsMp4).not.toHaveBeenCalled();
});

it("allows another attempt after conversion fails", async () => {
	vi.mocked(saveLoomStreamAsMp4).mockRejectedValueOnce(
		new Error("Decoder failed"),
	);
	await start();
	expect(container.textContent).toContain("Decoder failed");
	await start();
	expect(saveLoomStreamAsMp4).toHaveBeenCalledTimes(2);
	await act(async () => converter.resolve(undefined));
});
