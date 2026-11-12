// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioTranscriptRow } from "@/actions/developers/transcripts";
import {
	button,
	chooseFiles,
	click,
	type Deferred,
	deferred,
	flush,
	openStage,
	type Stage,
	stubStorageUploads,
	text,
	until,
} from "./infra-console-harness";

const mocks = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn() },
	list: vi.fn(),
	create: vi.fn(),
	start: vi.fn(),
	read: vi.fn(),
	remove: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
	default: ({ href, children }: { href: string; children: ReactNode }) =>
		createElement("a", { href }, children),
}));
vi.mock("next/font/google", () => ({
	Geist: () => ({ variable: "sans" }),
	Geist_Mono: () => ({ variable: "mono" }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/actions/developers/delete-video", () => ({
	deleteDeveloperVideo: vi.fn(),
}));
vi.mock("@/actions/developers/transcripts", () => ({
	listAudioTranscripts: mocks.list,
	createAudioTranscriptUpload: mocks.create,
	startAudioTranscript: mocks.start,
	readAudioTranscript: mocks.read,
	deleteAudioTranscript: mocks.remove,
}));
vi.mock("@/lib/developer-transcripts", () => ({
	TRANSCRIPT_MAX_UPLOAD_BYTES: 2 * 1024 * 1024 * 1024,
}));

const { AudioClient } = await import(
	"@/app/(infra)/dashboard/infra/[appId]/audio/audio-client"
);

const transcript = (
	id: string,
	status: AudioTranscriptRow["status"],
	overrides: Partial<AudioTranscriptRow> = {},
): AudioTranscriptRow => ({
	id,
	name: id,
	status,
	durationSeconds: status === "complete" ? 12 : null,
	costMicroCredits: status === "complete" ? 330 : 0,
	errorMessage: null,
	createdAt: "2026-11-12T10:00:00.000Z",
	...overrides,
});

const audio = (name: string, bytes = 4096) =>
	new File([new Uint8Array(bytes)], name, { type: "audio/mpeg" });

let stage: Stage;

const show = (rows: AudioTranscriptRow[]) =>
	stage.render(
		createElement(AudioClient, {
			appId: "a1",
			initialTranscripts: rows,
			initialHasMore: false,
			available: true,
			canTranscribe: true,
			pricePerHour: "$0.10",
		}),
	);

const rowFor = (name: string) => {
	const row = [...document.querySelectorAll("tbody tr")].find((candidate) =>
		candidate.textContent?.includes(name),
	);
	if (!row) throw new Error(`Row not found: ${name}`);
	return row.textContent ?? "";
};

const leaving = () => {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
};

beforeEach(() => {
	stage = openStage();
	mocks.list.mockResolvedValue({ ok: true, transcripts: [], hasMore: false });
	mocks.create.mockResolvedValue({
		ok: true,
		transcript: { id: "t-new" },
		upload: { url: "https://storage.example/t-new" },
	});
	mocks.start.mockResolvedValue({ ok: true });
	mocks.remove.mockResolvedValue({ ok: true });
});

afterEach(async () => {
	await stage.close();
});

describe("an Audio upload that never finished", () => {
	const stuck = transcript("maya-talk-720p", "uploading");

	it("says so, explains it and never claims to be waiting", async () => {
		await show([stuck, transcript("done", "complete")]);

		expect(rowFor("maya-talk-720p")).toContain("Upload not finished");
		expect(rowFor("maya-talk-720p")).toContain(
			"The file has not arrived. If the upload was interrupted, remove this and upload it again.",
		);
		expect(text()).not.toContain("Waiting for file");
		expect(rowFor("maya-talk-720p")).not.toContain("pending");
		expect(rowFor("done")).not.toContain("Upload not finished");
	});

	it("can be removed straight away", async () => {
		await show([stuck]);

		await click(button("Remove maya-talk-720p"));
		expect(text()).toContain("Remove upload");
		expect(text()).toContain("Its file has not arrived.");
		await click(button("Remove"));
		await until(() => mocks.toast.success.mock.calls.length === 1, "removal");

		expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(
			"a1",
			"maya-talk-720p",
		);
		expect(mocks.toast.success).toHaveBeenCalledWith("Upload removed");
		expect(text()).toContain("No transcripts yet.");
	});

	it("keeps the usual wording for a finished transcript", async () => {
		await show([transcript("done", "complete")]);

		await click(button("Delete done"));

		expect(text()).toContain("Delete transcript");
		expect(text()).toContain("The text is removed");
	});
});

describe("leaving the Audio page during an upload", () => {
	it("asks first, and only while the file is uploading", async () => {
		const sent = stubStorageUploads({ finish: false });
		await show([]);
		expect(leaving()).toBe(false);

		await chooseFiles([audio("interview.mp3")]);
		await until(() => sent.length === 1, "the upload to start");

		expect(text()).toContain("interview.mp3");
		expect(leaving()).toBe(true);

		await click(button("Cancel"));
		await until(
			() => text().includes("Drop an audio or video file here"),
			"the upload to stop",
		);

		expect(leaving()).toBe(false);
		expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("a1", "t-new");
	});
});

describe("an Audio upload that finished", () => {
	let listed: Deferred<{
		ok: true;
		transcripts: AudioTranscriptRow[];
		hasMore: boolean;
	}>;

	beforeEach(() => {
		stubStorageUploads();
		listed = deferred();
		mocks.list.mockReturnValue(listed.promise);
	});

	it("reads as queued, never as unfinished, while the list catches up", async () => {
		await show([transcript("t-new", "uploading", { name: "interview" })]);
		expect(rowFor("interview")).toContain("Upload not finished");

		await chooseFiles([audio("interview.mp3")]);
		await until(() => mocks.start.mock.calls.length === 1, "the start call");
		await flush();

		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Transcribing interview.mp3",
		);
		expect(rowFor("interview")).toContain("Queued");
		expect(rowFor("interview")).not.toContain("Upload not finished");
		expect(leaving()).toBe(false);

		listed.resolve({
			ok: true,
			transcripts: [transcript("t-new", "queued", { name: "interview" })],
			hasMore: false,
		});
		await flush();

		expect(rowFor("interview")).toContain("Queued");
	});
});

describe("a file Audio cannot transcribe", () => {
	it("says an empty file is empty, without asking the server", async () => {
		await show([]);

		await chooseFiles([audio("empty.mp3", 0)]);

		expect(document.querySelector("[role=alert]")?.textContent).toContain(
			"That file is empty.",
		);
		expect(mocks.create).not.toHaveBeenCalled();
	});
});

describe("the Audio table on a phone", () => {
	it("keeps name, status and cost in view and drops the rest first", async () => {
		await show([transcript("done", "complete")]);

		const cells = [...document.querySelectorAll("thead th")].map((cell) => ({
			label: cell.textContent?.trim(),
			hidden: /(^|\s)hidden(\s|$)/.test(cell.className),
		}));
		const always = cells.filter((cell) => !cell.hidden).map((c) => c.label);

		expect(always).toEqual(["Name", "Cost", "Actions"]);
		const stacked = document.querySelector("tbody td span.sm\\:hidden");
		expect(stacked?.textContent).toBe("Complete");
		expect(document.querySelector("tbody td")?.className).toContain("max-w-0");
	});
});
