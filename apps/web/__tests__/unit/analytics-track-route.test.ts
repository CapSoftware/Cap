import type { Effect as EffectModule } from "effect";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const VIDEO_ID = "video-1";
const ORG_ID = "org-1";
const OWNER_ID = "owner-1";

const mocks = vi.hoisted(() => ({
	video: undefined as Record<string, unknown> | undefined,
	userId: null as string | null,
	appendEvents: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					where: () => ({
						limit: async () => (mocks.video ? [mocks.video] : []),
					}),
				}),
			}),
		}),
	}),
}));

vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));

vi.mock("@cap/web-backend", async () => {
	const { Context, Effect } = await import("effect");
	const { CurrentUser } = await import("@cap/web-domain");
	const Tinybird = Context.GenericTag<{
		appendEvents: (events: unknown[]) => EffectModule.Effect<void>;
	}>("Tinybird");
	return {
		Tinybird,
		provideOptionalAuth: (
			app: EffectModule.Effect<unknown, unknown, never>,
		) => {
			const withTinybird = app.pipe(
				Effect.provideService(Tinybird, {
					appendEvents: (events) =>
						Effect.sync(() => mocks.appendEvents(events)),
				}),
			);
			return mocks.userId
				? withTinybird.pipe(
						Effect.provideService(CurrentUser, {
							id: mocks.userId,
							email: "viewer@example.com",
							activeOrganizationId: ORG_ID,
						} as never),
					)
				: withTinybird;
		},
	};
});

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});

vi.mock("@/lib/Notification", () => ({
	createAnonymousViewNotification: vi.fn(async () => undefined),
	sendFirstViewEmail: vi.fn(async () => undefined),
}));

const { POST } = await import("@/app/api/analytics/track/route");

const track = (body: Record<string, unknown>) =>
	POST(
		new Request("https://cap.so/api/analytics/track", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}) as unknown as NextRequest,
	);

const recordedEvents = () =>
	mocks.appendEvents.mock.calls.flatMap(
		([events]) => events as Array<Record<string, unknown>>,
	);

describe("POST /api/analytics/track", () => {
	beforeEach(() => {
		mocks.appendEvents.mockClear();
		mocks.userId = null;
		mocks.video = {
			orgId: ORG_ID,
			ownerId: OWNER_ID,
			firstViewEmailSentAt: new Date("2025-01-01T00:00:00Z"),
			videoName: "Demo",
			createdAt: new Date("2025-01-01T00:00:00Z"),
			updatedAt: new Date("2025-01-01T00:00:00Z"),
			activeUploadVideoId: null,
		};
	});

	it("records the view under the video's own org and share path", async () => {
		const response = await track({
			videoId: VIDEO_ID,
			orgId: "someone-elses-org",
			ownerId: "someone-else",
			pathname: "/s/a-different-video",
			hostname: "attacker.example",
			sessionId: "session-1",
		});

		expect(response.status).toBe(200);
		expect(recordedEvents()).toEqual([
			expect.objectContaining({
				tenant_id: ORG_ID,
				video_id: VIDEO_ID,
				pathname: `/s/${VIDEO_ID}`,
				session_id: "session-1",
			}),
		]);
	});

	it("does not record views for videos that do not exist", async () => {
		mocks.video = undefined;

		const response = await track({
			videoId: "made-up-video",
			orgId: ORG_ID,
			pathname: `/s/${VIDEO_ID}`,
			sessionId: "session-1",
		});

		expect(response.status).toBe(200);
		expect(recordedEvents()).toEqual([]);
	});

	it("does not record the owner's own views", async () => {
		mocks.userId = OWNER_ID;

		await track({ videoId: VIDEO_ID, sessionId: "session-1" });

		expect(recordedEvents()).toEqual([]);
	});

	it("keeps a client timestamp close to now and replaces one far from it", async () => {
		const recent = new Date(Date.now() - 30_000).toISOString();
		await track({ videoId: VIDEO_ID, occurredAt: recent });

		const before = Date.now();
		await track({ videoId: VIDEO_ID, occurredAt: "2020-01-01T00:00:00Z" });
		await track({ videoId: VIDEO_ID, occurredAt: "not a date" });

		const [kept, backdated, invalid] = recordedEvents();
		expect(kept?.timestamp).toBe(recent);
		for (const event of [backdated, invalid]) {
			expect(Date.parse(event?.timestamp as string)).toBeGreaterThanOrEqual(
				before,
			);
		}
	});
});
