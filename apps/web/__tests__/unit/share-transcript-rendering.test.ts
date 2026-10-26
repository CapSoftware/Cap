// @vitest-environment jsdom

import {
	act,
	createElement,
	Profiler,
	type ProfilerOnRenderCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "@/app/s/[videoId]/_components/tabs/Transcript";
import { parseTranscriptVTT } from "@/app/s/[videoId]/_components/utils/parse-transcript-vtt";
import type { VideoData } from "@/app/s/[videoId]/types";

const mocks = vi.hoisted(() => ({
	content: "",
	rowRenders: 0,
	userId: "owner",
	language: "original",
	edit: vi.fn(),
	invalidate: vi.fn(),
}));

vi.mock("@cap/ui", () => ({ Button: () => null }));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ isPending: false, isError: false }),
}));
vi.mock("hooks/use-transcript", () => ({
	useTranscript: () => ({ data: mocks.content, isLoading: false }),
	useInvalidateTranscript: () => mocks.invalidate,
}));
vi.mock("hooks/use-live-transcript", () => ({
	useLiveTranscript: () => ({ data: null }),
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => ({ id: mocks.userId }),
}));
vi.mock("@/app/s/[videoId]/_components/CaptionContext", () => ({
	useCaptionContext: () => ({
		selectedLanguage: mocks.language,
		currentVttContent: mocks.content,
		availableTranslations: [],
	}),
}));
vi.mock("@/actions/videos/edit-transcript", () => ({
	editTranscriptEntry: mocks.edit,
}));
vi.mock("lucide-react", async (importOriginal) => {
	const icons = await importOriginal<typeof import("lucide-react")>();
	return {
		...icons,
		Edit3: (props: Parameters<typeof icons.Edit3>[0]) => {
			mocks.rowRenders++;
			return createElement(icons.Edit3, props);
		},
	};
});

const video: VideoData = {
	id: "share-transcript" as VideoData["id"],
	owner: { id: "owner" as VideoData["owner"]["id"], isPro: true },
	orgId: "organization" as VideoData["orgId"],
	name: "One-hour recording",
	source: { type: "desktopMP4" },
	duration: 3600,
	width: 1920,
	height: 1080,
	fps: 30,
	public: true,
	isScreenshot: false,
	skipProcessing: false,
	createdAt: new Date("2026-01-01"),
	updatedAt: new Date("2026-01-01"),
	effectiveCreatedAt: new Date("2026-01-01"),
	transcriptionStatus: "COMPLETE",
	bucket: null,
	storageIntegrationId: null,
	metadata: null,
	settings: null,
	folderId: null,
	password: null,
	xStreamInfo: null,
	firstViewEmailSentAt: null,
	awsRegion: null,
	awsBucket: null,
	videoStartTime: null,
	audioStartTime: null,
	jobId: null,
	jobStatus: null,
};

function transcript(cues: number) {
	const timestamp = (seconds: number) =>
		`${new Date(seconds * 1000).toISOString().slice(11, 19)}.000`;
	return `WEBVTT\n\n${Array.from(
		{ length: cues },
		(_, i) =>
			`${i + 1}\n${timestamp(i * 3)} --> ${timestamp((i + 1) * 3)}\nCue ${i + 1}: We reviewed the recording and agreed on the next steps.\n`,
	).join("\n")}`;
}

let root: Root;
let container: HTMLDivElement;
let durations: number[];
const onSeek = vi.fn();
const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
	if (phase === "update") durations.push(actualDuration);
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.content = transcript(1200);
	mocks.userId = "owner";
	mocks.language = "original";
	mocks.rowRenders = 0;
	mocks.edit.mockResolvedValue({ success: true });
	durations = [];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function render(seek = onSeek) {
	await act(async () => {
		root.render(
			createElement(
				Profiler,
				{ id: video.id, onRender },
				createElement(Transcript, { data: video, onSeek: seek }),
			),
		);
	});
}

function cue(index: number) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent?.includes(`Cue ${index}:`),
	);
	if (!button) throw new Error(`Missing cue ${index}`);
	return button;
}

async function click(button: HTMLElement) {
	await act(async () => button.click());
}

function button(text: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === text,
	);
	if (!button) throw new Error(`Missing button ${text}`);
	return button;
}

async function editCue(index: number) {
	const edit = cue(index).parentElement?.querySelector<HTMLButtonElement>(
		'button[title="Edit transcript entry"]',
	);
	if (!edit) throw new Error("Missing edit button");
	await click(edit);
}

async function type(text: string) {
	const textarea = container.querySelector("textarea");
	if (!textarea) throw new Error("Missing transcript editor");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(textarea, text);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("share transcript rendering", () => {
	it("only renders the changed rows when selecting a cue in a one-hour transcript", async () => {
		await render();
		expect(mocks.rowRenders).toBe(1200);
		const rows = () =>
			Array.from(
				container.querySelectorAll('button[title="Edit transcript entry"]'),
				(button) => button.parentElement?.textContent,
			);
		const expectedRows = parseTranscriptVTT(mocks.content).map(
			(entry) => `${entry.timestamp}${entry.text}`,
		);
		expect(rows()).toEqual(expectedRows);
		mocks.rowRenders = 0;
		await click(cue(300));
		expect(onSeek).toHaveBeenLastCalledWith(897);
		expect(cue(300).parentElement?.className).toContain("bg-gray-3");
		expect(mocks.rowRenders).toBe(1);
		mocks.rowRenders = 0;
		await click(cue(600));
		expect(cue(300).parentElement?.className).not.toContain("bg-gray-3");
		expect(cue(600).parentElement?.className).toContain("bg-gray-3");
		expect(mocks.rowRenders).toBe(2);
		expect(rows()).toEqual(expectedRows);
	});

	it("does not render other rows while typing and preserves save and cancel", async () => {
		await render();
		await editCue(300);
		mocks.rowRenders = 0;
		await type("Updated cue");
		expect(container.querySelector("textarea")?.value).toBe("Updated cue");
		expect(mocks.rowRenders).toBe(0);
		await click(button("Save"));
		expect(mocks.edit).toHaveBeenCalledWith(video.id, 300, "Updated cue");
		expect(mocks.invalidate).toHaveBeenCalledWith(video.id);
		expect(container.textContent).toContain("Updated cue");
		expect(container.querySelector("textarea")).toBeNull();
		await editCue(600);
		await type("Discarded edit");
		await click(button("Cancel"));
		expect(cue(600).textContent).toContain("We reviewed the recording");
		expect(container.textContent).not.toContain("Discarded edit");
		expect(mocks.edit).toHaveBeenCalledTimes(1);
	});

	it("keeps an unsuccessful edit open without changing the other cues", async () => {
		mocks.content = transcript(3);
		mocks.edit.mockResolvedValue({ success: false, message: "Save failed" });
		vi.spyOn(console, "error").mockImplementation(() => {});
		await render();
		await editCue(2);
		await type("Unsaved edit");
		await click(button("Save"));
		expect(container.querySelector("textarea")?.value).toBe("Unsaved edit");
		expect(button("Save").disabled).toBe(false);
		expect(cue(1).textContent).toContain("We reviewed the recording");
		expect(cue(3).textContent).toContain("We reviewed the recording");
		expect(mocks.invalidate).not.toHaveBeenCalled();
	});

	it("refreshes cue content, language, permissions and seek callbacks", async () => {
		mocks.content = transcript(3);
		await render();
		mocks.content = mocks.content.replace("Cue 2:", "Translated Cue 2:");
		mocks.language = "fr";
		await render();
		expect(container.textContent).toContain("Translated Cue 2:");
		expect(
			container.querySelector('button[title="Edit transcript entry"]'),
		).toBeNull();
		await click(cue(1));
		expect(onSeek).toHaveBeenLastCalledWith(0);
		mocks.language = "original";
		mocks.userId = "viewer";
		await render();
		expect(
			container.querySelector('button[title="Edit transcript entry"]'),
		).toBeNull();
		mocks.userId = "owner";
		await render();
		expect(
			container.querySelectorAll('button[title="Edit transcript entry"]'),
		).toHaveLength(3);
		const updatedSeek = vi.fn();
		await render(updatedSeek);
		await click(cue(2));
		expect(updatedSeek).toHaveBeenCalledWith(3);
	});

	it("starts with the new cue's text when switching editors", async () => {
		mocks.content = transcript(3);
		await render();
		await editCue(1);
		await type("Draft for cue one");
		await editCue(2);
		expect(container.querySelector("textarea")?.value).toMatch(/^Cue 2:/);
		await click(button("Cancel"));
		expect(cue(1).textContent).toContain("We reviewed the recording");
		expect(mocks.edit).not.toHaveBeenCalled();
	});

	it("keeps save and cancel disabled until a pending save completes", async () => {
		mocks.content = transcript(3);
		let finish!: (result: { success: boolean }) => void;
		mocks.edit.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await render();
		await editCue(2);
		await type("Saved after waiting");
		await click(button("Save"));
		expect(button("Save").disabled).toBe(true);
		expect(button("Cancel").disabled).toBe(true);
		await editCue(3);
		expect(container.querySelector("textarea")?.value).toMatch(/^Cue 3:/);
		expect(button("Save").disabled).toBe(true);
		expect(button("Cancel").disabled).toBe(true);
		await act(async () => finish({ success: true }));
		expect(container.querySelector("textarea")).toBeNull();
		expect(container.textContent).toContain("Saved after waiting");
	});

	it("keeps an empty transcript empty", async () => {
		mocks.content = "WEBVTT\n\n";
		await render();
		expect(
			container.querySelector('button[title="Edit transcript entry"]'),
		).toBeNull();
		expect(container.querySelector("textarea")).toBeNull();
		expect(mocks.rowRenders).toBe(0);
	});

	it.skipIf(!process.env.CAP_TRANSCRIPT_BENCH)(
		"profiles selection and typing with 1200 three-second cues",
		async () => {
			await render();
			const median = (values: number[]) =>
				[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
			const selection: number[] = [];
			const typing: number[] = [];
			const selectionElapsed: number[] = [];
			const typingElapsed: number[] = [];
			for (let i = 0; i < 40; i++) {
				durations = [];
				const target = cue(i % 2 ? 300 : 600);
				const start = performance.now();
				await click(target);
				if (i >= 10) {
					selectionElapsed.push(performance.now() - start);
					selection.push(...durations);
				}
			}
			await editCue(300);
			mocks.rowRenders = 0;
			for (let i = 0; i < 40; i++) {
				durations = [];
				const start = performance.now();
				await type(`Updated cue ${i}`);
				if (i >= 10) {
					typingElapsed.push(performance.now() - start);
					typing.push(...durations);
				}
			}
			expect(selection).toHaveLength(30);
			expect(typing).toHaveLength(30);
			console.log(
				JSON.stringify({
					cues: 1200,
					samples: 30,
					selectionMedianMs: median(selection),
					typingMedianMs: median(typing),
					selectionElapsedMedianMs: median(selectionElapsed),
					typingElapsedMedianMs: median(typingElapsed),
					typingRowRenders: mocks.rowRenders,
				}),
			);
		},
		60000,
	);
});
