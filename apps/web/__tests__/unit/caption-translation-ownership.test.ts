// @vitest-environment jsdom

import type { Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	CaptionProvider,
	useCaptionContext,
} from "@/app/s/[videoId]/_components/CaptionContext";

const translate = vi.hoisted(() => vi.fn());
vi.mock("@/actions/videos/translate-transcript", () => ({
	translateTranscript: translate,
}));
vi.mock("@/actions/videos/get-available-translations", () => ({
	getAvailableTranslations: vi.fn(async () => ({
		hasOriginal: true,
		translations: [],
	})),
}));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let captions: ReturnType<typeof useCaptionContext>;
function Consumer() {
	captions = useCaptionContext();
	return null;
}
function tree(id: string) {
	return createElement(
		StrictMode,
		null,
		createElement(
			QueryClientProvider,
			{ client },
			createElement(
				CaptionProvider,
				{
					videoId: id as Video.VideoId,
					transcriptionStatus: "COMPLETE",
				} as Parameters<typeof CaptionProvider>[0],
				createElement(Consumer),
			),
		),
	);
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	translate.mockReset();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(tree("video-a")));
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	vi.unstubAllGlobals();
});
it("deduplicates concurrent requests for the same language in Strict Mode", async () => {
	const gate = deferred<{ success: boolean; translatedVtt: string }>();
	translate.mockReturnValue(gate.promise);
	let first!: Promise<string | null>;
	let second!: Promise<string | null>;
	await act(async () => {
		first = captions.requestTranslation("es");
		second = captions.requestTranslation("es");
	});
	expect(translate).toHaveBeenCalledTimes(1);
	expect(captions.isTranslating).toBe(true);
	await act(async () => {
		gate.resolve({ success: true, translatedVtt: "Spanish" });
		expect(await first).toBe("Spanish");
		expect(await second).toBe("Spanish");
	});
	expect(captions.translatedVttContent.get("es")).toBe("Spanish");
	await act(async () => {
		expect(await captions.requestTranslation("es")).toBe("Spanish");
	});
	expect(translate).toHaveBeenCalledTimes(1);
});
it("keeps the loading indicator until all language requests settle", async () => {
	const spanish = deferred<{ success: boolean; translatedVtt: string }>();
	const french = deferred<{ success: boolean; translatedVtt: string }>();
	translate.mockImplementation((_id: string, language: string) =>
		language === "es" ? spanish.promise : french.promise,
	);
	let first!: Promise<string | null>;
	let second!: Promise<string | null>;
	await act(async () => {
		first = captions.requestTranslation("es");
		second = captions.requestTranslation("fr");
	});
	await act(async () => {
		spanish.resolve({ success: true, translatedVtt: "Spanish" });
		await first;
	});
	expect(captions.isTranslating).toBe(true);
	await act(async () => {
		french.resolve({ success: true, translatedVtt: "French" });
		await second;
	});
	expect(captions.isTranslating).toBe(false);
	expect(captions.translatedVttContent.get("fr")).toBe("French");
});
it("does not reuse or apply a previous video's translation after a video switch", async () => {
	const old = deferred<{ success: boolean; translatedVtt: string }>();
	translate.mockImplementation((id: string) =>
		id === "video-a"
			? old.promise
			: Promise.resolve({ success: true, translatedVtt: "New video" }),
	);
	let oldRequest!: Promise<string | null>;
	await act(async () => {
		oldRequest = captions.requestTranslation("es");
	});
	await act(async () => root.render(tree("video-b")));
	await act(async () => {
		old.resolve({ success: true, translatedVtt: "Old video" });
		await oldRequest;
	});
	expect(captions.translatedVttContent.has("es")).toBe(false);
	expect(captions.isTranslating).toBe(false);
	await act(async () => {
		expect(await captions.requestTranslation("es")).toBe("New video");
	});
	expect(translate).toHaveBeenCalledWith("video-b", "es");
});
it("settles a rejected request and allows a retry", async () => {
	translate
		.mockRejectedValueOnce(new Error("connection lost"))
		.mockResolvedValueOnce({ success: true, translatedVtt: "Spanish" });
	await act(async () => {
		expect(await captions.requestTranslation("es")).toBeNull();
	});
	expect(captions.isTranslating).toBe(false);
	await act(async () => {
		expect(await captions.requestTranslation("es")).toBe("Spanish");
	});
	expect(translate).toHaveBeenCalledTimes(2);
});
it("does not cache an unsuccessful response", async () => {
	translate
		.mockResolvedValueOnce({ success: false })
		.mockResolvedValueOnce({ success: true, translatedVtt: "Spanish" });
	await act(async () => {
		expect(await captions.requestTranslation("es")).toBeNull();
	});
	expect(captions.isTranslating).toBe(false);
	await act(async () => {
		expect(await captions.requestTranslation("es")).toBe("Spanish");
	});
	expect(translate).toHaveBeenCalledTimes(2);
});
