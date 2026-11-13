import type { ViewableVideo, ViewDecisionDeps } from "@cap/web-backend";
import type { Effect as EffectModule, Option as OptionModule } from "effect";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const VIDEO_ID = "video-1";
const ORG_ID = "org-1";
const OWNER_ID = "owner-1";

const mocks = vi.hoisted(() => ({
	video: undefined as Record<string, unknown> | undefined,
	userId: null as string | null,
	orgMember: false,
	verifiedPasswords: [] as string[],
	appendEvents: vi.fn(),
	videoLookups: 0,
	requestsPerIp: new Map<string, number>(),
	rateLimitCalls: [] as string[],
}));

const REQUESTS_PER_IP_LIMIT = 60;

vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: { ANALYTICS_TRACK: "rl_analytics_track" },
	isRateLimited: vi.fn(
		async (ruleId: string, opts?: { key?: string; headers?: Headers }) => {
			mocks.rateLimitCalls.push(ruleId);
			const bucket = opts?.key ?? opts?.headers?.get("x-real-ip") ?? "none";
			const count = (mocks.requestsPerIp.get(bucket) ?? 0) + 1;
			mocks.requestsPerIp.set(bucket, count);
			return count > REQUESTS_PER_IP_LIMIT;
		},
	),
}));

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					where: () => ({
						limit: async () => {
							mocks.videoLookups++;
							return mocks.video ? [mocks.video] : [];
						},
					}),
				}),
			}),
		}),
	}),
}));

vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));

vi.mock("@cap/web-backend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/web-backend")>();
	const { Context, Effect } = await import("effect");
	const { CurrentUser, Video } = await import("@cap/web-domain");
	const Tinybird = Context.GenericTag<{
		appendEvents: (events: unknown[]) => EffectModule.Effect<void>;
	}>("Tinybird");
	const deps: ViewDecisionDeps = {
		repo: {
			getById: () => Effect.succeedNone,
			hasViewerGrant: () => Effect.succeed(false),
			isLinkOpenToAnyone: () => Effect.succeed(false),
		},
		orgsRepo: {
			membershipForVideo: () =>
				Effect.sync(() => (mocks.orgMember ? [{ membershipId: "m" }] : [])),
			allowedEmailDomain: () => Effect.succeedNone,
		},
		spacesRepo: {
			membershipForVideo: () => Effect.succeedNone,
			passwordsForVideo: () => Effect.succeed([]),
		},
	};
	class VideosPolicy extends Effect.Service<VideosPolicy>()("VideosPolicy", {
		sync: () => ({
			canViewLoaded: (
				video: ViewableVideo,
				password: OptionModule.Option<string>,
			) => actual.buildCanViewLoaded(deps, video, password),
		}),
	}) {}
	return {
		Tinybird,
		VideosPolicy,
		provideOptionalAuth: (
			app: EffectModule.Effect<unknown, unknown, never>,
		) => {
			const withServices = app.pipe(
				Effect.provideService(Tinybird, {
					appendEvents: (events) =>
						Effect.sync(() => mocks.appendEvents(events)),
				}),
				Effect.provide(VideosPolicy.Default),
				Effect.provideService(Video.VideoPasswordAttachment, {
					passwords: mocks.verifiedPasswords,
				}),
			);
			return mocks.userId
				? withServices.pipe(
						Effect.provideService(CurrentUser, {
							id: mocks.userId,
							email: "viewer@example.com",
							activeOrganizationId: ORG_ID,
						} as never),
					)
				: withServices;
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
const { createAnonymousViewNotification } = await import("@/lib/Notification");

const track = (body: Record<string, unknown>, ip = "203.0.113.1") =>
	POST(
		new Request("https://cap.so/api/analytics/track", {
			method: "POST",
			headers: { "content-type": "application/json", "x-real-ip": ip },
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
		mocks.videoLookups = 0;
		mocks.requestsPerIp.clear();
		mocks.rateLimitCalls = [];
		vi.mocked(createAnonymousViewNotification).mockClear();
		mocks.userId = null;
		mocks.orgMember = false;
		mocks.verifiedPasswords = [];
		mocks.video = {
			id: VIDEO_ID,
			orgId: ORG_ID,
			ownerId: OWNER_ID,
			public: true,
			password: null,
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

	it("does not record views of private videos the viewer cannot watch", async () => {
		mocks.video = {
			...mocks.video,
			public: false,
			createdAt: new Date(),
			firstViewEmailSentAt: null,
		};

		await track({ videoId: VIDEO_ID, sessionId: "session-1" });
		mocks.userId = "stranger";
		await track({ videoId: VIDEO_ID, sessionId: "session-2" });

		expect(recordedEvents()).toEqual([]);
		expect(createAnonymousViewNotification).not.toHaveBeenCalled();
	});

	it("records views of private videos by org members", async () => {
		mocks.video = { ...mocks.video, public: false };
		mocks.userId = "member";
		mocks.orgMember = true;

		await track({ videoId: VIDEO_ID, sessionId: "session-1" });

		expect(recordedEvents()).toEqual([
			expect.objectContaining({ video_id: VIDEO_ID, user_id: "member" }),
		]);
	});

	it("records password-protected views only after the password is verified", async () => {
		mocks.video = { ...mocks.video, password: "password-hash" };

		await track({ videoId: VIDEO_ID, sessionId: "locked" });
		mocks.verifiedPasswords = ["password-hash"];
		await track({ videoId: VIDEO_ID, sessionId: "unlocked" });

		expect(recordedEvents()).toEqual([
			expect.objectContaining({ session_id: "unlocked" }),
		]);
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

	it("stops recording views from one address past the per-address limit", async () => {
		for (let index = 0; index < REQUESTS_PER_IP_LIMIT; index++) {
			const response = await track({
				videoId: VIDEO_ID,
				sessionId: `session-${index}`,
			});
			expect(response.status).toBe(200);
		}

		const limited = await track({
			videoId: VIDEO_ID,
			sessionId: "session-over-limit",
		});

		expect(limited.status).toBe(429);
		expect(mocks.appendEvents).toHaveBeenCalledTimes(REQUESTS_PER_IP_LIMIT);
		expect(mocks.videoLookups).toBe(REQUESTS_PER_IP_LIMIT);
		expect(mocks.rateLimitCalls).toEqual(
			Array(REQUESTS_PER_IP_LIMIT + 1).fill("rl_analytics_track"),
		);

		const otherAddress = await track(
			{ videoId: VIDEO_ID, sessionId: "session-other-address" },
			"198.51.100.7",
		);

		expect(otherAddress.status).toBe(200);
		expect(recordedEvents().at(-1)).toEqual(
			expect.objectContaining({ session_id: "session-other-address" }),
		);
	});

	it("checks the limit before reading the body", async () => {
		mocks.requestsPerIp.set("203.0.113.1", REQUESTS_PER_IP_LIMIT);

		const response = await POST(
			new Request("https://cap.so/api/analytics/track", {
				method: "POST",
				headers: { "x-real-ip": "203.0.113.1" },
				body: "not json",
			}) as unknown as NextRequest,
		);

		expect(response.status).toBe(429);
		expect(mocks.videoLookups).toBe(0);
	});

	it("accepts the full payload the share page sends", async () => {
		const response = await track({
			videoId: VIDEO_ID,
			orgId: null,
			ownerId: OWNER_ID,
			sessionId: "6f1c1a4e-5d0b-4a8e-9f57-2b8c1d1e7a90",
			pathname: `/s/${VIDEO_ID}`,
			href: `https://cap.so/s/${VIDEO_ID}`,
			referrer: "",
			hostname: "cap.so",
			timezone: "Europe/London",
			language: "en-GB",
			locale: "en-GB",
			screen: { width: 1512, height: 982, colorDepth: 30 },
			userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
			occurredAt: new Date().toISOString(),
		});

		expect(response.status).toBe(200);
		expect(recordedEvents()).toEqual([
			expect.objectContaining({
				session_id: "6f1c1a4e-5d0b-4a8e-9f57-2b8c1d1e7a90",
			}),
		]);
	});

	it("rejects malformed fields without looking up the video", async () => {
		const malformed = [
			{ videoId: 42 },
			{ videoId: "" },
			{ videoId: "v".repeat(65) },
			{ videoId: VIDEO_ID, sessionId: { nested: true } },
			{ videoId: VIDEO_ID, sessionId: "s".repeat(129) },
			{ videoId: VIDEO_ID, occurredAt: 1234 },
			{ videoId: VIDEO_ID, userAgent: "u".repeat(4097) },
		];

		for (const body of malformed) {
			const response = await track(body);
			expect(response.status).toBe(400);
		}

		expect(mocks.videoLookups).toBe(0);
		expect(recordedEvents()).toEqual([]);
	});

	it("still records a view when local storage could not hold a session id", async () => {
		await track({ videoId: VIDEO_ID, sessionId: "anonymous" });

		expect(recordedEvents()).toEqual([
			expect.objectContaining({ session_id: "anon" }),
		]);
	});

	it("notifies the owner about a new anonymous session", async () => {
		mocks.video = {
			...mocks.video,
			createdAt: new Date(),
			firstViewEmailSentAt: null,
		};

		await track({ videoId: VIDEO_ID, sessionId: "fresh-session" });

		await vi.waitFor(() =>
			expect(createAnonymousViewNotification).toHaveBeenCalledWith(
				expect.objectContaining({
					videoId: VIDEO_ID,
					sessionId: "fresh-session",
				}),
			),
		);
	});
});
