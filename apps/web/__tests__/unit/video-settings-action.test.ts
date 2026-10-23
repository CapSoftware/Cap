import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	updates: [] as unknown[],
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner" }),
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

import type { Video } from "@cap/web-domain";
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
});
