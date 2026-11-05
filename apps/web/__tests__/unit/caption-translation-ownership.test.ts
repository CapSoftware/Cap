// @vitest-environment jsdom

import type { Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
describe("translations still running elsewhere", () => {
	const inProgress = {
		success: false,
		inProgress: true,
		message: "Translation in progress",
	};
	afterEach(() => {
		vi.useRealTimers();
	});
	it("asks again for the selected language until the translation is ready", async () => {
		vi.useFakeTimers();
		translate
			.mockResolvedValueOnce(inProgress)
			.mockResolvedValueOnce(inProgress)
			.mockResolvedValueOnce({ success: true, translatedVtt: "Spanish" });
		await act(async () => {
			captions.setSelectedLanguage("es");
		});
		expect(translate).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(translate).toHaveBeenCalledTimes(2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(translate).toHaveBeenCalledTimes(3);
		expect(captions.translatedVttContent.get("es")).toBe("Spanish");
		expect(captions.currentVttContent).toBe("Spanish");
		expect(captions.isTranslating).toBe(false);
	});
	it("keeps asking while a long translation finishes elsewhere", async () => {
		vi.useFakeTimers();
		for (let attempt = 0; attempt < 10; attempt += 1) {
			translate.mockResolvedValueOnce(inProgress);
		}
		translate.mockResolvedValueOnce({
			success: true,
			translatedVtt: "Spanish",
		});
		await act(async () => {
			captions.setSelectedLanguage("es");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(translate).toHaveBeenCalledTimes(11);
		expect(captions.translatedVttContent.get("es")).toBe("Spanish");
		expect(captions.isTranslating).toBe(false);
	});
	it("stops asking once the retry window has passed", async () => {
		vi.useFakeTimers();
		translate.mockResolvedValue(inProgress);
		await act(async () => {
			captions.setSelectedLanguage("es");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		});
		expect(captions.isTranslating).toBe(true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		});
		const calls = translate.mock.calls.length;
		expect(calls).toBeLessThanOrEqual(6 * 12 + 1);
		expect(captions.isTranslating).toBe(false);
		expect(captions.translatedVttContent.has("es")).toBe(false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(translate).toHaveBeenCalledTimes(calls);
	});
	it("stops asking once a different language is selected", async () => {
		vi.useFakeTimers();
		translate.mockResolvedValue(inProgress);
		await act(async () => {
			captions.setSelectedLanguage("es");
		});
		await act(async () => {
			captions.setSelectedLanguage("original");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(translate).toHaveBeenCalledTimes(1);
		expect(captions.isTranslating).toBe(false);
	});
	it("waits longer and asks again after a request limit", async () => {
		vi.useFakeTimers();
		translate
			.mockResolvedValueOnce({
				success: false,
				rateLimited: true,
				message: "Too many requests",
			})
			.mockResolvedValueOnce(inProgress)
			.mockResolvedValueOnce({ success: true, translatedVtt: "Spanish" });
		await act(async () => {
			captions.setSelectedLanguage("es");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(29_000);
		});
		expect(translate).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(translate).toHaveBeenCalledTimes(2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(translate).toHaveBeenCalledTimes(3);
		expect(captions.translatedVttContent.get("es")).toBe("Spanish");
	});
	it("does not ask again after any other failure", async () => {
		vi.useFakeTimers();
		translate.mockResolvedValue({
			success: false,
			message: "Translation failed",
		});
		await act(async () => {
			captions.setSelectedLanguage("es");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(translate).toHaveBeenCalledTimes(1);
		expect(captions.isTranslating).toBe(false);
	});
});
