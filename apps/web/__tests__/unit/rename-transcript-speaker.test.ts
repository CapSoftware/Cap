import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renameTranscriptSpeaker } from "@/actions/videos/rename-transcript-speaker";

const mocks = vi.hoisted(() => ({
	user: { id: "owner" } as { id: string } | null,
	video: {
		id: "recording",
		ownerId: "owner",
		updatedAt: new Date(),
		metadata: {
			transcriptSpeakerNames: {} as Record<string, string>,
			unrelated: "preserved",
		},
	},
	set: vi.fn(),
	revalidate: vi.fn(),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", ownerId: "ownerId", metadata: "metadata" },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@cap/database", () => ({
	db: () => ({
		transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
			callback({
				select: () => ({
					from: () => ({ where: () => ({ for: async () => [mocks.video] }) }),
				}),
				update: () => ({
					set: (payload: { metadata: { queryChunks: unknown[] } }) => {
						mocks.set(payload);
						return {
							where: async () => {
								const chunks = payload.metadata.queryChunks;
								const json = chunks.find(
									(value) => typeof value === "string" && value.startsWith("{"),
								);
								if (typeof json === "string")
									mocks.video.metadata.transcriptSpeakerNames =
										JSON.parse(json);
							},
						};
					},
				}),
			}),
	}),
}));
const id = "recording" as Video.VideoId;
beforeEach(() => {
	mocks.user = { id: "owner" };
	mocks.video.ownerId = "owner";
	mocks.video.metadata.transcriptSpeakerNames = {};
});
describe("recording speaker name mutation", () => {
	it("persists rename and reset without touching VTT, timings or unrelated metadata", async () => {
		expect((await renameTranscriptSpeaker(id, "A", " Alice ")).success).toBe(
			true,
		);
		expect(mocks.set).toHaveBeenCalledOnce();
		const names = (await renameTranscriptSpeaker(id, "B", "Bob")).names;
		expect(names).toEqual({ A: "Alice", B: "Bob" });
		expect((await renameTranscriptSpeaker(id, "A", "")).names).toEqual({
			B: "Bob",
		});
		expect(mocks.video.metadata.unrelated).toBe("preserved");
		expect(mocks.revalidate).toHaveBeenCalledWith("/s/recording");
	});
	it.each(["viewer", null])(
		"rejects unauthorized user %s before writing",
		async (user) => {
			mocks.user = user ? { id: user } : null;
			expect((await renameTranscriptSpeaker(id, "A", "Alice")).success).toBe(
				false,
			);
			expect(mocks.set).not.toHaveBeenCalled();
		},
	);
	it.each(["__proto__", "constructor", "prototype", "<v A>"])(
		"rejects malicious speaker %s",
		async (speaker) => {
			expect(
				(await renameTranscriptSpeaker(id, speaker, "Alice")).success,
			).toBe(false);
			expect(mocks.set).not.toHaveBeenCalled();
		},
	);
	it.each(["x".repeat(81), "<script>", "line\nbreak"])(
		"rejects invalid name",
		async (name) => {
			expect((await renameTranscriptSpeaker(id, "A", name)).success).toBe(
				false,
			);
			expect(mocks.set).not.toHaveBeenCalled();
		},
	);
	it("enforces the recording-local speaker limit", async () => {
		mocks.video.metadata.transcriptSpeakerNames = Object.fromEntries(
			Array.from({ length: 100 }, (_, i) => [`S${i}`, "Name"]),
		);
		expect((await renameTranscriptSpeaker(id, "extra", "Name")).success).toBe(
			false,
		);
		expect(mocks.set).not.toHaveBeenCalled();
	});
});
