// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "@/app/s/[videoId]/_components/tabs/Transcript";
import type { VideoData } from "@/app/s/[videoId]/types";

const mocks = vi.hoisted(() => ({
	content:
		"WEBVTT\n\n1\n00:00:00.125 --> 00:00:01.000\n<v Speaker A>First,</v>\n\n2\n00:00:02.000 --> 00:00:03.000\n<v Speaker A>then second.</v>\n\n3\n00:00:03.100 --> 00:00:04.000\n<v Speaker B>Yes.</v>\n\n",
	edit: vi.fn(async () => ({ success: true })),
	copy: vi.fn(async () => {}),
	language: "original",
	live: false,
}));

vi.mock("@cap/ui", () => ({ Button: "button" }));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({}),
}));
vi.mock("hooks/use-transcript", () => ({
	useTranscript: () => ({ data: mocks.content, isLoading: false }),
	useInvalidateTranscript: () => vi.fn(),
}));
vi.mock("hooks/use-live-transcript", () => ({
	useLiveTranscript: () => ({
		data: mocks.live
			? { kind: "ready", state: "active", content: mocks.content }
			: undefined,
	}),
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => ({ id: "owner" }),
}));
vi.mock("@/actions/videos/edit-transcript", () => ({
	editTranscriptEntry: mocks.edit,
}));
vi.mock("@/app/s/[videoId]/_components/CaptionContext", () => ({
	useCaptionContext: () => ({
		selectedLanguage: mocks.language,
		currentVttContent: mocks.content,
		translatedVttContent: new Map(),
		isTranslating: false,
	}),
}));

const data = {
	id: "sentence-test",
	owner: { id: "owner" },
	transcriptionStatus: "COMPLETE",
	createdAt: new Date(),
} as unknown as VideoData;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function button(label: string): HTMLButtonElement {
	const match = Array.from(container.querySelectorAll("button")).find(
		(element) =>
			element.textContent?.trim() === label ||
			element.getAttribute("aria-label") === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function click(label: string) {
	await act(async () => button(label).click());
}

describe("sentence transcript reading and editing", () => {
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: mocks.copy },
		});
		mocks.edit.mockClear();
		mocks.copy.mockClear();
		mocks.language = "original";
		mocks.live = false;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("reads sentences, seeks precisely, and copies sentence timestamps", async () => {
		const seek = vi.fn();
		await act(async () =>
			root.render(createElement(Transcript, { data, onSeek: seek })),
		);
		await click("00:00Speaker AFirst, then second.");
		expect(seek).toHaveBeenCalledWith(0.125);
		expect(
			container.querySelectorAll('[aria-label="Edit transcript entry"]'),
		).toHaveLength(0);
		await click("Copy transcript");
		const copyOption = Array.from(container.querySelectorAll("button")).find(
			(element) => element.textContent?.startsWith("With timestamps"),
		);
		expect(copyOption).toBeDefined();
		await act(async () => copyOption?.click());
		expect(mocks.copy).toHaveBeenCalledWith(
			"[00:00] Speaker A: First, then second.\n\n[00:03] Speaker B: Yes.",
		);
	});

	it("edits original cue IDs and text, never a merged sentence under one cue ID", async () => {
		await act(async () => root.render(createElement(Transcript, { data })));
		await click("Edit transcript");
		const editButtons = container.querySelectorAll<HTMLButtonElement>(
			'[aria-label="Edit transcript entry"]',
		);
		expect(editButtons).toHaveLength(3);
		await act(async () => editButtons[1]?.click());
		expect(container.querySelector("textarea")?.value).toBe("then second.");
		expect(button("Done editing").disabled).toBe(true);
		await click("Save");
		expect(mocks.edit).toHaveBeenCalledWith("sentence-test", 2, "then second.");
		await click("Done editing");
		expect(button("00:00Speaker AFirst, then second.")).toBeDefined();
	});

	it("groups translated and provisional live captions", async () => {
		mocks.language = "ru";
		await act(async () => root.render(createElement(Transcript, { data })));
		expect(button("00:00Speaker AFirst, then second.")).toBeDefined();
		expect(container.textContent).not.toContain("Edit transcript");
		mocks.live = true;
		await act(async () =>
			root.render(
				createElement(Transcript, {
					data: { ...data, transcriptionStatus: "PROCESSING" },
				}),
			),
		);
		expect(container.textContent).toContain("Live transcript");
		expect(button("00:00Speaker AFirst, then second.")).toBeDefined();
	});
});
