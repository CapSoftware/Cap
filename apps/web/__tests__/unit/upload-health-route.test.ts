import {
	HttpApiBuilder,
	HttpServer,
	HttpServerRequest,
} from "@effect/platform";
import { Context, Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	writes: [] as string[],
	deletes: [] as string[],
	storageAvailable: true,
	cleanupAvailable: true,
	organizationAllowed: true,
	rateLimited: false,
}));

vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	return { Storage: Context.GenericTag("UploadHealthTestStorage") };
});

vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: async () => state.rateLimited,
	RATE_LIMIT_IDS: { DESKTOP_UPLOAD_HEALTH: "rl_desktop_upload_health" },
}));

vi.mock("@/app/api/desktop/[...route]/organizationStorage", () => ({
	getAccessibleOrganization: async () =>
		state.organizationAllowed ? { id: "org" } : null,
}));

vi.mock("@/lib/server", async () => {
	const { CurrentUser, HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiError } = await import("@effect/platform");
	const storage = Context.GenericTag("UploadHealthTestStorage");
	const authentication = Layer.succeed(
		HttpAuthMiddleware,
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			if (request.headers.authorization !== "Bearer test") {
				return yield* new HttpApiError.Unauthorized();
			}
			return CurrentUser.of({
				id: User.UserId.make("test-user"),
				email: "dev@example.test",
				activeOrganizationId: Organisation.OrganisationId.make("org"),
				iconUrlOrKey: Option.none(),
			});
		}),
	);
	const access = {
		putObject: (key: string) =>
			Effect.suspend(() => {
				state.writes.push(key);
				return state.storageAvailable
					? Effect.void
					: Effect.fail("write failed");
			}),
		deleteObject: (key: string) =>
			Effect.suspend(() => {
				state.deletes.push(key);
				return state.cleanupAvailable
					? Effect.void
					: Effect.fail("delete failed");
			}),
	};
	return {
		apiToHandler: (live: Parameters<typeof HttpApiBuilder.toWebHandler>[0]) =>
			HttpApiBuilder.toWebHandler(
				live.pipe(
					Layer.provide(authentication),
					Layer.provide(
						Layer.succeed(storage, {
							getWritableAccessForUser: () => Effect.succeed({ access }),
						}),
					),
					Layer.provide(HttpServer.layerContext),
				),
			).handler,
	};
});

import { GET, POST } from "@/app/api/desktop/upload-health/route";

function request(
	checkStorage = true,
	body = new Uint8Array(1024),
	token = "test",
) {
	return new Request(
		`http://localhost/api/desktop/upload-health${checkStorage ? "?checkStorage=true" : ""}`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body,
		},
	);
}

let clock = 0;
beforeEach(() => {
	clock += 60_000;
	vi.spyOn(Date, "now").mockReturnValue(clock);
	state.writes = [];
	state.deletes = [];
	state.storageAvailable = true;
	state.cleanupAvailable = true;
	state.organizationAllowed = true;
	state.rateLimited = false;
});

describe("authenticated upload-health API", () => {
	it("rejects unauthenticated probes without touching storage", async () => {
		const response = await POST(request(true, new Uint8Array(1), "wrong"));
		expect(response.status).toBe(401);
		expect(state.writes).toEqual([]);
	});

	it("warms the connection without writing or deleting an object", async () => {
		const response = await GET(
			new Request("http://localhost/api/desktop/upload-health", {
				headers: { authorization: "Bearer test" },
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(state.writes).toEqual([]);
	});

	it("checks the selected storage under the user's prefix and returns body timing", async () => {
		const response = await POST(request());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ bytes: 1024, bodyReadMs: 0 });
		expect(state.writes[0]).toMatch(/^test-user\/\.cap-upload-health\//);
		expect(state.deletes).toEqual(state.writes);
	});

	it("measures subsequent samples without another storage write", async () => {
		const response = await POST(request(false));
		expect(response.status).toBe(200);
		expect(state.writes).toEqual([]);
	});

	it("rejects a stale organization membership before touching storage", async () => {
		state.organizationAllowed = false;
		const response = await POST(request());
		expect(response.status).toBe(403);
		expect(state.writes).toEqual([]);
	});

	it("returns unavailable when the chosen storage cannot accept a write", async () => {
		state.storageAvailable = false;
		const response = await POST(request());
		expect(response.status).toBe(503);
	});

	it("rejects empty and oversized streamed bodies without a storage write", async () => {
		expect((await POST(request(true, new Uint8Array()))).status).toBe(400);
		expect(
			(await POST(request(true, new Uint8Array(8 * 1024 * 1024 + 1)))).status,
		).toBe(413);
		expect(state.writes).toEqual([]);
	});

	it("rejects an oversized Content-Length before reading or writing", async () => {
		const probe = request();
		probe.headers.set("content-length", String(8 * 1024 * 1024 + 1));
		expect((await POST(probe)).status).toBe(413);
		expect(state.writes).toEqual([]);
	});

	it("keeps upload availability successful when object cleanup fails", async () => {
		state.cleanupAvailable = false;
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect((await POST(request())).status).toBe(200);
		expect(console.warn).toHaveBeenCalledOnce();
	});

	it("rate-limits repeated authenticated probes", async () => {
		for (let index = 0; index < 4; index++) {
			expect((await POST(request(false))).status).toBe(200);
		}
		expect((await POST(request())).status).toBe(429);
		expect(state.writes).toEqual([]);
	});

	it("rejects a distributed rate-limit decision before writing", async () => {
		state.rateLimited = true;
		expect((await POST(request())).status).toBe(429);
		expect(state.writes).toEqual([]);
	});
});
