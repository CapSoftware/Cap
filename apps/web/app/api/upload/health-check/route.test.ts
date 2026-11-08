import { Storage } from "@cap/web-backend";
import { HttpAuthMiddleware, Organisation, User } from "@cap/web-domain";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rateLimited: false,
	storageHealthy: true,
	deleteHealthy: true,
	putObject: vi.fn(),
	deleteObject: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: vi.fn(async () => mocks.rateLimited),
}));
vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const authLayer = Layer.succeed(
		HttpAuthMiddleware,
		Effect.succeed({
			id: User.UserId.make("user_test"),
			email: "user@cap.so",
			activeOrganizationId: Organisation.OrganisationId.make("org_test"),
			iconUrlOrKey: Option.none(),
		}),
	);
	const storageLayer = Layer.succeed(Storage, {
		getWritableAccessForUser: () =>
			mocks.storageHealthy
				? Effect.succeed({
						access: {
							putObject: (...args: unknown[]) => {
								mocks.putObject(...args);
								return Effect.void;
							},
							deleteObject: (...args: unknown[]) => {
								mocks.deleteObject(...args);
								return mocks.deleteHealthy
									? Effect.void
									: Effect.fail(new Error("Delete failed"));
							},
						},
						bucketId: Option.none(),
						storageIntegrationId: Option.none(),
					})
				: Effect.fail(new Error("Storage offline")),
	} as never);
	return {
		apiToHandler: (api: Parameters<typeof Layer.mergeAll>[0]) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(
					Layer.provide(api as never, Layer.mergeAll(authLayer, storageLayer)),
					HttpServer.layerContext,
				) as never,
			);
			return (request: Request) => handler(request);
		},
	};
});

const { GET, POST } = await import("@/app/api/upload/health-check/route");

describe("Cap desktop upload health-check API route", () => {
	beforeEach(() => {
		mocks.rateLimited = false;
		mocks.storageHealthy = true;
		mocks.deleteHealthy = true;
		mocks.putObject.mockClear();
		mocks.deleteObject.mockClear();
	});

	it("verifies POST storage write/delete and rejects invalid or cross-site probes", async () => {
		const validPayload = new Uint8Array(1024).fill(42);
		const okRes = await POST(
			new Request("http://localhost/api/upload/health-check", {
				method: "POST",
				body: validPayload,
			}),
		);
		expect(okRes.status).toBe(200);
		const okJson = await okRes.json();
		expect(okJson.ok).toBe(true);
		expect(okJson.bytesReceived).toBe(1024);
		expect(mocks.putObject).toHaveBeenCalledTimes(1);
		expect(mocks.deleteObject).toHaveBeenCalledTimes(1);

		const crossSiteRes = await POST(
			new Request("http://localhost/api/upload/health-check", {
				method: "POST",
				headers: { "sec-fetch-site": "cross-site" },
				body: validPayload,
			}),
		);
		expect(crossSiteRes.status).toBe(403);

		const smallRes = await POST(
			new Request("http://localhost/api/upload/health-check", {
				method: "POST",
				body: new Uint8Array(4),
			}),
		);
		expect(smallRes.status).toBe(400);

		const oversizedRes = await POST(
			new Request("http://localhost/api/upload/health-check", {
				method: "POST",
				headers: { "content-length": "1048576" },
				body: new Uint8Array(32),
			}),
		);
		expect(oversizedRes.status).toBe(413);

		mocks.deleteHealthy = false;
		const deleteFailedRes = await POST(
			new Request("http://localhost/api/upload/health-check", {
				method: "POST",
				body: validPayload,
			}),
		);
		expect(deleteFailedRes.status).toBe(503);
	});

	it("keeps GET strictly read-only without bucket mutations", async () => {
		const getRes = await GET(
			new Request("http://localhost/api/upload/health-check", {
				method: "GET",
			}),
		);
		expect(getRes.status).toBe(200);
		expect(mocks.putObject).not.toHaveBeenCalled();
		expect(mocks.deleteObject).not.toHaveBeenCalled();

		const crossSiteGetRes = await GET(
			new Request("http://localhost/api/upload/health-check", {
				method: "GET",
				headers: { "sec-fetch-site": "cross-site" },
			}),
		);
		expect(crossSiteGetRes.status).toBe(403);

		mocks.rateLimited = true;
		const limitedGetRes = await GET(
			new Request("http://localhost/api/upload/health-check", {
				method: "GET",
			}),
		);
		expect(limitedGetRes.status).toBe(429);
		expect(mocks.putObject).not.toHaveBeenCalled();
	});
});
