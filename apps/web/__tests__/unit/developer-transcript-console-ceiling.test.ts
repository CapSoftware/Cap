import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	create: vi.fn(),
}));

vi.mock("@cap/database", () => {
	const chain = Object.assign(Promise.resolve([{ id: "app-1" }]), {
		from: () => chain,
		where: () => chain,
		limit: () => chain,
	});
	return { db: () => ({ select: () => chain }) };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user-1", email: "owner@example.com" }),
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));
vi.mock("@/lib/developer-transcript-store", () => ({
	startTranscriptUpload: mocks.start,
	createTranscriptUpload: mocks.create,
	deleteTranscript: vi.fn(),
	getTranscript: vi.fn(),
	listConsoleTranscripts: vi.fn(),
}));

import { startAudioTranscript } from "@/actions/developers/transcripts";

beforeEach(() => {
	mocks.start.mockReset();
});

describe("the transcript ceiling in the console", () => {
	it("passes the refusal and its wording to the page when a start is refused", async () => {
		mocks.start.mockResolvedValue({
			ok: false,
			status: 429,
			code: "too_many_transcripts",
			message: "This app already has 20 transcripts queued or processing",
			hint: "Wait for one to finish, then send the request again.",
		});

		expect(await startAudioTranscript("app-1", "tr-1")).toEqual({
			ok: false,
			code: "too_many_transcripts",
			message: "This app already has 20 transcripts queued or processing",
		});
		expect(mocks.start).toHaveBeenCalledWith("app-1", "tr-1");
	});
});
