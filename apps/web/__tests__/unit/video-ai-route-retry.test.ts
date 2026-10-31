import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: { id: "owner-1" } as { id: string } | null,
	video: null as Record<string, unknown> | null,
	startAiGeneration: vi.fn(),
	isAiGenerationEnabled: vi.fn(),
	ownerLookups: 0,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: (fields?: unknown) => ({
			from: () => ({
				where: () => {
					const rows = fields
						? [{ email: "owner@cap.test", stripeSubscriptionStatus: "active" }]
						: mocks.video
							? [mocks.video]
							: [];
					return Object.assign(Promise.resolve(rows), {
						limit: async () => {
							mocks.ownerLookups++;
							return rows;
						},
					});
				},
			}),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	return {
		provideOptionalAuth: <T>(effect: T) => effect,
		VideosPolicy: Context.GenericTag("VideosPolicy"),
	};
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const { VideosPolicy } = (await import("@cap/web-backend")) as unknown as {
		VideosPolicy: import("effect").Context.Tag<
			unknown,
			{ canView: () => import("effect").Effect.Effect<void> }
		>;
	};
	return {
		runPromiseExit: <A, E>(effect: import("effect").Effect.Effect<A, E>) =>
			Effect.runPromiseExit(
				Effect.provideService(effect, VideosPolicy, {
					canView: () => Effect.void,
				}),
			),
	};
});
vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: mocks.startAiGeneration,
}));
vi.mock("@/utils/flags", () => ({
	isAiGenerationEnabled: mocks.isAiGenerationEnabled,
}));

const { GET } = await import("@/app/api/video/ai/route");

const request = () =>
	({
		url: "https://cap.test/api/video/ai?videoId=video-1",
	}) as NextRequest;

const videoWithStatus = (aiGenerationStatus: string) => ({
	id: "video-1",
	ownerId: "owner-1",
	transcriptionStatus: "COMPLETE",
	metadata: { aiGenerationStatus },
});

beforeEach(() => {
	mocks.user = { id: "owner-1" };
	mocks.video = null;
	mocks.ownerLookups = 0;
	mocks.startAiGeneration.mockReset();
	mocks.startAiGeneration.mockResolvedValue({
		success: true,
		message: "AI generation workflow started",
	});
	mocks.isAiGenerationEnabled.mockReset();
	mocks.isAiGenerationEnabled.mockResolvedValue(true);
});

describe("GET /api/video/ai retry", () => {
	it.each(["ERROR", "SKIPPED"])(
		"does not start generation for a viewer who is not the owner (%s)",
		async (status) => {
			mocks.video = videoWithStatus(status);
			mocks.user = { id: "viewer-1" };

			const response = await GET(request());

			expect(response.status).toBe(403);
			await expect(response.json()).resolves.toMatchObject({
				processing: false,
			});
			expect(mocks.startAiGeneration).not.toHaveBeenCalled();
			expect(mocks.isAiGenerationEnabled).not.toHaveBeenCalled();
			expect(mocks.ownerLookups).toBe(0);
		},
	);

	it("starts generation for the owner", async () => {
		mocks.video = videoWithStatus("ERROR");

		const response = await GET(request());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			processing: true,
			aiGenerationStatus: "QUEUED",
		});
		expect(mocks.startAiGeneration).toHaveBeenCalledWith("video-1", "owner-1");
	});

	it.each(["QUEUED", "PROCESSING"])(
		"still reports %s progress to a viewer who is not the owner",
		async (status) => {
			mocks.video = videoWithStatus(status);
			mocks.user = { id: "viewer-1" };

			const response = await GET(request());

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				processing: true,
				aiGenerationStatus: status,
			});
			expect(mocks.startAiGeneration).not.toHaveBeenCalled();
		},
	);

	it("still returns finished AI metadata to a viewer who is not the owner", async () => {
		mocks.video = {
			...videoWithStatus("COMPLETE"),
			metadata: {
				aiGenerationStatus: "COMPLETE",
				summary: "Summary",
				aiTitle: "Title",
			},
		};
		mocks.user = { id: "viewer-1" };

		const response = await GET(request());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			processing: false,
			summary: "Summary",
			title: "Title",
		});
		expect(mocks.startAiGeneration).not.toHaveBeenCalled();
	});
});
