// @vitest-environment jsdom

import { Video } from "@cap/web-domain";
import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getEditTranscript: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
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
		scrollToIndex: vi.fn(),
	}),
}));

import { TranscriptSidebar } from "@/app/s/[videoId]/edit/TranscriptSidebar";
import { formatClock, formatClockWithHundredths } from "@/lib/player-time";
import { buildSlackVideoBlock } from "@/lib/slack/unfurl";

describe("formatClock", () => {
	it("keeps M:SS under an hour", () => {
		expect(formatClock(0)).toBe("0:00");
		expect(formatClock(44.9)).toBe("0:44");
		expect(formatClock(95)).toBe("1:35");
		expect(formatClock(3599.9)).toBe("59:59");
	});

	it("rolls over into hours instead of counting past 59 minutes", () => {
		expect(formatClock(3600)).toBe("1:00:00");
		expect(formatClock(3905)).toBe("1:05:05");
		expect(formatClock(36000)).toBe("10:00:00");
	});

	it("falls back to zero for negative or non-finite input", () => {
		expect(formatClock(-3)).toBe("0:00");
		expect(formatClock(Number.NaN)).toBe("0:00");
		expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
	});
});

describe("formatClockWithHundredths", () => {
	it("keeps MM:SS.ss under an hour and adds hours after", () => {
		expect(formatClockWithHundredths(0)).toBe("00:00.00");
		expect(formatClockWithHundredths(75.25)).toBe("01:15.25");
		expect(formatClockWithHundredths(3599.5)).toBe("59:59.50");
		expect(formatClockWithHundredths(3600)).toBe("1:00:00.00");
		expect(formatClockWithHundredths(3905.5)).toBe("1:05:05.50");
	});
});

describe("Slack previews", () => {
	const preview = (duration: number) =>
		buildSlackVideoBlock({
			video: {
				id: Video.VideoId.make("abc123"),
				name: "Cap walkthrough",
				ownerId: "owner123",
				ownerName: "Richie",
				sourceType: "desktopMP4",
				width: 1920,
				height: 1080,
				duration,
			},
			shareUrl: "https://cap.so/s/abc123",
			webUrl: "https://cap.so",
		}).description.text;

	it("shows hours for recordings an hour or longer", () => {
		expect(preview(64)).toBe("Watch this 1:04 recording on Cap");
		expect(preview(3905)).toBe("Watch this 1:05:05 recording on Cap");
		expect(preview(3904.6)).toBe("Watch this 1:05:05 recording on Cap");
	});
});

describe("web editor transcript", () => {
	let container: HTMLDivElement;
	let root: Root;

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("shows hours on lines past the hour mark", async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		HTMLElement.prototype.scrollIntoView = vi.fn();
		const word = (id: string, text: string, startMs: number) => ({
			id,
			text,
			startMs,
			endMs: startMs + 400,
			confidence: 1,
			speaker: null,
			channel: null,
		});
		mocks.getEditTranscript.mockResolvedValue({
			status: "ready",
			transcript: {
				version: 3 as const,
				speechModelUsed: "fixture",
				durationMs: 3_910_000,
				languageCode: "en",
				words: [
					word("word-0", "Early.", 95_000),
					word("word-1", "Late.", 3_905_000),
				],
			},
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		const videoRef: RefObject<HTMLVideoElement | null> = {
			current: document.createElement("video"),
		};

		await act(async () => {
			root.render(
				createElement(TranscriptSidebar, {
					videoId: "video-id" as Video.VideoId,
					videoRef,
					keepRanges: [{ start: 0, end: 3910 }],
					onDeleteRanges: vi.fn(),
				}),
			);
		});
		for (let attempt = 0; attempt < 50; attempt++) {
			if (container.textContent?.includes("Late.")) break;
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
		}

		expect(container.textContent).toContain("1:35");
		expect(container.textContent).toContain("1:05:05");
		expect(container.textContent).not.toContain("65:05");
	});
});
