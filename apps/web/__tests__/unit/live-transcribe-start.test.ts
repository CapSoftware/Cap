import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: {
		ASSEMBLY_API_KEY: "test-key" as string | undefined,
		CAP_LIVE_TRANSCRIPTION: false,
	},
	select: vi.fn(),
	update: vi.fn(),
	start: vi.fn(),
}));

vi.mock("@cap/env", () => ({ serverEnv: () => mocks.env }));

vi.mock("@cap/database", () => ({
	db: () => ({ select: mocks.select, update: mocks.update }),
}));

vi.mock("@cap/database/schema", () => ({
	organizations: { id: "id", settings: "settings" },
	videos: { id: "id", ownerId: "ownerId", metadata: "metadata" },
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn(),
	eq: vi.fn(),
	sql: vi.fn(),
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));

vi.mock("@/workflows/live-transcribe", () => ({
	liveTranscribeWorkflow: vi.fn(),
}));

import type { Organisation, User, Video } from "@cap/web-domain";
import { maybeStartLiveTranscription } from "@/lib/live-transcribe";

const input = {
	videoId: "video-1" as Video.VideoId,
	ownerId: "user-1" as User.UserId,
	orgId: "org-1" as Organisation.OrganisationId,
};

describe("maybeStartLiveTranscription", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.env.ASSEMBLY_API_KEY = "test-key";
		mocks.env.CAP_LIVE_TRANSCRIPTION = false;
		mocks.select.mockReturnValue({
			from: () => ({ where: async () => [{ settings: null }] }),
		});
		mocks.update.mockReturnValue({
			set: () => ({ where: async () => [{ affectedRows: 1 }] }),
		});
	});

	it("skips live transcription unless it is enabled", async () => {
		await expect(maybeStartLiveTranscription(input)).resolves.toBe("skipped");
		expect(mocks.select).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("skips live transcription without an AssemblyAI key", async () => {
		mocks.env.CAP_LIVE_TRANSCRIPTION = true;
		mocks.env.ASSEMBLY_API_KEY = undefined;

		await expect(maybeStartLiveTranscription(input)).resolves.toBe("skipped");
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("starts the live workflow when enabled", async () => {
		mocks.env.CAP_LIVE_TRANSCRIPTION = true;

		await expect(maybeStartLiveTranscription(input)).resolves.toBe("started");
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});
});
