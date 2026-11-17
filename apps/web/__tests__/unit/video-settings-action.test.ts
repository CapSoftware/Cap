import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	updates: [] as unknown[],
	stripeSubscriptionStatus: "active" as string | null,
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({
		id: "owner",
		stripeSubscriptionStatus: mocks.stripeSubscriptionStatus,
		thirdPartyStripeSubscriptionId: null,
	}),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => [{ ownerId: "owner" }],
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: async () => {
					mocks.updates.push(values);
				},
			}),
		}),
	}),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));

import type { Video } from "@cap/web-domain";
import { editTitle } from "@/actions/videos/edit-title";
import { updateVideoSettings } from "@/actions/videos/settings";

const patchOf = (value: unknown): Record<string, unknown> => {
	const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
	const json = chunks.find(
		(chunk): chunk is string =>
			typeof chunk === "string" && chunk.startsWith("{"),
	);
	return JSON.parse(json ?? "{}");
};

describe("updateVideoSettings", () => {
	beforeEach(() => {
		mocks.updates = [];
		mocks.stripeSubscriptionStatus = "active";
	});

	it("merges only known viewer settings", async () => {
		await updateVideoSettings(
			"video" as Video.VideoId,
			{
				disableComments: true,
				defaultPlaybackSpeed: 1.49,
				callToAction: { label: "x", url: "javascript:alert(1)" },
			} as Parameters<typeof updateVideoSettings>[1],
		);

		const settings = (mocks.updates[0] as { settings: unknown }).settings;
		expect(patchOf(settings)).toEqual({
			disableComments: true,
			defaultPlaybackSpeed: 1.5,
		});
	});

	it("keeps Pro-only settings unchanged for free owners", async () => {
		mocks.stripeSubscriptionStatus = null;

		await updateVideoSettings("video" as Video.VideoId, {
			disableComments: true,
			disableSummary: true,
			disableChapters: true,
			disableTranscript: true,
		});

		const settings = (mocks.updates[0] as { settings: unknown }).settings;
		expect(patchOf(settings)).toEqual({ disableComments: true });
	});

	it.each([true, false])(
		"saves the download choice %s for any owner",
		async (disableDownloads) => {
			mocks.stripeSubscriptionStatus = null;

			await updateVideoSettings("video" as Video.VideoId, {
				disableDownloads,
			});

			const settings = (mocks.updates[0] as { settings: unknown }).settings;
			expect(patchOf(settings)).toEqual({ disableDownloads });
		},
	);

	it("ignores a download value that is not a boolean", async () => {
		await updateVideoSettings(
			"video" as Video.VideoId,
			{ disableDownloads: "yes" } as unknown as Parameters<
				typeof updateVideoSettings
			>[1],
		);

		const settings = (mocks.updates[0] as { settings: unknown }).settings;
		expect(patchOf(settings)).toEqual({});
	});

	it("saves Pro-only settings for Pro owners", async () => {
		await updateVideoSettings("video" as Video.VideoId, {
			disableSummary: true,
			disableChapters: false,
			disableTranscript: true,
		});

		const settings = (mocks.updates[0] as { settings: unknown }).settings;
		expect(patchOf(settings)).toEqual({
			disableSummary: true,
			disableChapters: false,
			disableTranscript: true,
		});
	});
});

describe("editTitle", () => {
	beforeEach(() => {
		mocks.updates = [];
	});

	it.each(["", "   ", "\t\n"])(
		"refuses a blank title %j without writing",
		async (title) => {
			await expect(editTitle("video" as Video.VideoId, title)).rejects.toThrow(
				"Missing required data",
			);
			expect(mocks.updates).toEqual([]);
		},
	);

	it("saves the trimmed title", async () => {
		await editTitle("video" as Video.VideoId, "  Launch demo  ");

		expect((mocks.updates[0] as { name: unknown }).name).toBe("Launch demo");
	});
});
