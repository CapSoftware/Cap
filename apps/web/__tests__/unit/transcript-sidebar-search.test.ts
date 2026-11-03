// @vitest-environment jsdom

import type { Video } from "@cap/web-domain";
import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getEditTranscript: vi.fn(),
	scrollToIndex: vi.fn(),
}));

vi.mock("@/actions/videos/get-edit-transcript", () => ({
	getEditTranscript: mocks.getEditTranscript,
	requestEditTranscript: vi.fn(),
}));

vi.mock("@/app/s/[videoId]/edit/use-active-transcript-word-index", () => ({
	useActiveTranscriptWordIndex: () => -1,
}));

vi.mock("@virtual-grid/react", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getTotalSize: () => count * 100,
		getVirtualItems: () =>
			Array.from({ length: count }, (_, index) => ({
				index,
				key: index,
				start: index * 100,
			})),
		measureElement: vi.fn(),
		scrollToIndex: mocks.scrollToIndex,
	}),
}));

import { TranscriptSidebar } from "@/app/s/[videoId]/edit/TranscriptSidebar";

const videoId = "video-id" as Video.VideoId;
const transcript = {
	version: 3 as const,
	speechModelUsed: "fixture",
	durationMs: 5_000,
	languageCode: "en",
	words: [
		{
			id: "word-0",
			text: "Match",
			startMs: 1_000,
			endMs: 1_400,
			confidence: 1,
			speaker: null,
			channel: null,
		},
		{
			id: "word-1",
			text: "between",
			startMs: 2_000,
			endMs: 2_400,
			confidence: 1,
			speaker: null,
			channel: null,
		},
		{
			id: "word-2",
			text: "matching",
			startMs: 3_000,
			endMs: 3_400,
			confidence: 1,
			speaker: null,
			channel: null,
		},
	],
};

let container: HTMLDivElement;
let root: Root;
let video: HTMLVideoElement;

async function waitFor(assertion: () => void) {
	let error: unknown;
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			assertion();
			return;
		} catch (cause) {
			error = cause;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw error;
}

async function enterSearch(query: string, expectedCounter = "1/2") {
	const input = container.querySelector<HTMLInputElement>(
		'input[placeholder="Search transcript"]',
	);
	if (!input) throw new Error("Search input missing");

	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(input, query);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await waitFor(() => expect(container.textContent).toContain(expectedCounter));
	return input;
}

async function pressEnter(input: HTMLInputElement) {
	await act(async () => {
		input.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
		);
	});
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	HTMLElement.prototype.scrollIntoView = vi.fn();
	mocks.getEditTranscript.mockResolvedValue({ status: "ready", transcript });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	video = document.createElement("video");
	const videoRef: RefObject<HTMLVideoElement | null> = { current: video };

	await act(async () => {
		root.render(
			createElement(TranscriptSidebar, {
				videoId,
				videoRef,
				keepRanges: [{ start: 0, end: 5 }],
				onDeleteRanges: vi.fn(),
			}),
		);
	});
	await waitFor(() =>
		expect(
			container.querySelector('input[placeholder="Search transcript"]'),
		).not.toBeNull(),
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("transcript search navigation", () => {
	it("seeks to the first match before advancing through later matches", async () => {
		const input = await enterSearch("match");

		await pressEnter(input);
		expect(video.currentTime).toBe(1);
		expect(container.textContent).toContain("1/2");

		await pressEnter(input);
		expect(video.currentTime).toBe(3);
		expect(container.textContent).toContain("2/2");

		await pressEnter(input);
		expect(video.currentTime).toBe(1);
		expect(container.textContent).toContain("1/2");
	});

	it("seeks to the last match when Previous is pressed first", async () => {
		await enterSearch("match");
		const previous = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Previous search result"]',
		);
		if (!previous) throw new Error("Previous search button missing");

		await act(async () => previous.click());
		expect(video.currentTime).toBe(3);
		expect(container.textContent).toContain("2/2");
	});

	it("seeks to the new first match after changing the query", async () => {
		const input = await enterSearch("between", "1/1");
		await pressEnter(input);
		expect(video.currentTime).toBe(2);

		await enterSearch("match");
		await pressEnter(input);
		expect(video.currentTime).toBe(1);
		expect(container.textContent).toContain("1/2");
	});
});
