import { Organisation, User } from "@cap/web-domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_PROBE_BYTES } from "@/lib/upload-health";

const state = vi.hoisted(() => ({
	user: null as {
		id: User.UserId;
		email: string;
		activeOrganizationId: Organisation.OrganisationId;
	} | null,
	recordingOrganizationId: undefined as Organisation.OrganisationId | undefined,
	rateLimited: false,
	putProbeObject:
		vi.fn<(_key: string, _body: Uint8Array) => Effect.Effect<void, unknown>>(),
	deleteObject: vi.fn<(_key: string) => Effect.Effect<void, unknown>>(),
	getWritableAccessForUser: vi.fn(),
	getDesktopRecordingOrganization: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://cap.test",
	}),
}));

vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: {
		DESKTOP_UPLOAD_HEALTH: "rl_desktop_upload_health",
	},
	isRateLimited: vi.fn(async () => state.rateLimited),
}));

vi.mock("@/lib/desktop-recording-organization", () => ({
	getDesktopRecordingOrganization: (...args: unknown[]) =>
		state.getDesktopRecordingOrganization(...args),
}));

vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	class Storage extends Context.Tag("Storage")<
		Storage,
		{
			getWritableAccessForUser: typeof state.getWritableAccessForUser;
		}
	>() {}
	return { Storage };
});

vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpApiError, HttpServer } = await import(
		"@effect/platform"
	);
	const { Effect, Layer, Option } = await import("effect");
	const { HttpAuthMiddleware } = await import("@cap/web-domain");
	const { Storage } = await import("@cap/web-backend");

	return {
		apiToHandler: (apiLive: Layer.Layer<never, never, never>) => {
			const authLive = Layer.succeed(
				HttpAuthMiddleware,
				HttpAuthMiddleware.of(
					Effect.suspend(() =>
						state.user
							? Effect.succeed({
									id: state.user.id,
									email: state.user.email,
									activeOrganizationId: state.user.activeOrganizationId,
									iconUrlOrKey: Option.none(),
								})
							: Effect.fail(new HttpApiError.Unauthorized()),
					),
				),
			);
			const storageLive = Layer.succeed(Storage, {
				getWritableAccessForUser: state.getWritableAccessForUser,
			});
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(
					HttpServer.layerContext,
					apiLive.pipe(Layer.provide(authLive), Layer.provide(storageLive)),
				),
			);
			return (request: Request) => handler(request);
		},
	};
});

describe("/api/desktop/upload-health", () => {
	let GET: typeof import("@/app/api/desktop/upload-health/route")["GET"];
	let POST: typeof import("@/app/api/desktop/upload-health/route")["POST"];
	const desktopHeaders = {
		Authorization: "Bearer 00000000-0000-4000-8000-000000000000",
	};

	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		state.user = {
			id: User.UserId.make("user-1"),
			email: "person@cap.test",
			activeOrganizationId: Organisation.OrganisationId.make("org-active"),
		};
		state.recordingOrganizationId =
			Organisation.OrganisationId.make("org-default");
		state.rateLimited = false;
		state.putProbeObject.mockImplementation(() => Effect.void);
		state.deleteObject.mockImplementation(() => Effect.void);
		state.getDesktopRecordingOrganization.mockImplementation(
			async (_userId: User.UserId, requested?: Organisation.OrganisationId) =>
				requested ?? state.recordingOrganizationId,
		);
		state.getWritableAccessForUser.mockImplementation(() =>
			Effect.succeed({
				access: {
					putProbeObject: state.putProbeObject,
					deleteObject: state.deleteObject,
				},
			}),
		);
		({ GET, POST } = await import("@/app/api/desktop/upload-health/route"));
	});

	it("rejects unauthenticated requests before touching storage", async () => {
		state.user = null;

		const response = await POST(
			new Request("https://cap.test/api/desktop/upload-health", {
				method: "POST",
				body: new Uint8Array([1, 2, 3]),
			}),
		);

		expect(response.status).toBe(401);
		expect(state.getWritableAccessForUser).not.toHaveBeenCalled();
		expect(state.putProbeObject).not.toHaveBeenCalled();
	});

	it("warms the connection without writing to storage", async () => {
		const response = await GET(
			new Request("https://cap.test/api/desktop/upload-health", {
				headers: desktopHeaders,
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(state.getWritableAccessForUser).not.toHaveBeenCalled();
	});

	it("measures body bytes and checks storage only when requested", async () => {
		const payload = new Uint8Array(2048).fill(7);
		const response = await POST(
			new Request(
				"https://cap.test/api/desktop/upload-health?checkStorage=true&orgId=org-requested",
				{
					method: "POST",
					headers: desktopHeaders,
					body: payload,
				},
			),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			bytes: 2048,
			bodyReadMs: expect.any(Number),
			organizationId: "org-requested",
		});
		expect(state.getDesktopRecordingOrganization).toHaveBeenCalledWith(
			"user-1",
			"org-requested",
		);
		expect(state.getWritableAccessForUser).toHaveBeenCalledWith(
			"user-1",
			"org-requested",
		);
		expect(state.putProbeObject).toHaveBeenCalledOnce();
		const [key, sample] = state.putProbeObject.mock.calls[0] ?? [];
		expect(key).toMatch(/^user-1\/\.cap-upload-health\//);
		expect(sample?.byteLength).toBe(1024);
		expect(state.deleteObject).toHaveBeenCalledWith(key);
	});

	it("skips storage writes on the second speed sample", async () => {
		const response = await POST(
			new Request("https://cap.test/api/desktop/upload-health", {
				method: "POST",
				headers: desktopHeaders,
				body: new Uint8Array([1, 2, 3, 4]),
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			bytes: 4,
			bodyReadMs: expect.any(Number),
			organizationId: "org-default",
		});
		expect(state.getWritableAccessForUser).not.toHaveBeenCalled();
		expect(state.putProbeObject).not.toHaveBeenCalled();
	});

	it("does not fail a successful upload check when probe cleanup fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		state.deleteObject.mockImplementation(() =>
			Effect.fail(new Error("delete denied")),
		);

		const response = await POST(
			new Request(
				"https://cap.test/api/desktop/upload-health?checkStorage=true",
				{
					method: "POST",
					headers: desktopHeaders,
					body: new Uint8Array([1, 2, 3, 4]),
				},
			),
		);

		expect(response.status).toBe(200);
		expect(state.putProbeObject).toHaveBeenCalledOnce();
		expect(state.deleteObject).toHaveBeenCalledOnce();
	});

	it("rejects cookie-authenticated probes without a same-origin browser context", async () => {
		const response = await POST(
			new Request(
				"https://cap.test/api/desktop/upload-health?checkStorage=true",
				{
					method: "POST",
					headers: { "sec-fetch-site": "cross-site" },
					body: new Uint8Array([1, 2, 3, 4]),
				},
			),
		);

		expect(response.status).toBe(403);
		expect(state.getWritableAccessForUser).not.toHaveBeenCalled();
		expect(state.putProbeObject).not.toHaveBeenCalled();
	});

	it("rejects oversized probes and enforces rate limits", async () => {
		const tooLarge = await POST(
			new Request("https://cap.test/api/desktop/upload-health", {
				method: "POST",
				headers: {
					...desktopHeaders,
					"content-length": String(MAX_UPLOAD_PROBE_BYTES + 1),
				},
				body: new Uint8Array([1]),
			}),
		);
		expect(tooLarge.status).toBe(413);

		state.rateLimited = true;
		const limited = await POST(
			new Request("https://cap.test/api/desktop/upload-health", {
				method: "POST",
				headers: desktopHeaders,
				body: new Uint8Array([1]),
			}),
		);
		expect(limited.status).toBe(429);
	});
});
