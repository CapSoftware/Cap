import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	type HttpApi,
	HttpApiBuilder,
	HttpApiError,
	HttpServer,
	HttpServerRequest,
} from "@effect/platform";
import { type Context, Effect, Layer, Option } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES } from "@/app/api/desktop/upload-health/upload-health";

const mocks = vi.hoisted(() => ({
	authenticate: vi.fn<
		(headers: Readonly<Record<string, string | undefined>>) => boolean
	>(() => true),
	disposers: [] as (() => Promise<void>)[],
}));

vi.mock("@/lib/server", () => ({
	apiToHandler: (api: Layer.Layer<HttpApi.Api, never, HttpAuthMiddleware>) => {
		const auth = Layer.succeed(
			HttpAuthMiddleware,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				if (!mocks.authenticate(request.headers)) {
					return yield* Effect.fail(new HttpApiError.Unauthorized());
				}
				return CurrentUser.of({
					id: "test-user",
					email: "test@example.com",
					activeOrganizationId: "test-organization",
					iconUrlOrKey: Option.none(),
				} as Context.Tag.Service<typeof CurrentUser>);
			}),
		);
		const web = api.pipe(
			Layer.provide(auth),
			Layer.merge(HttpServer.layerContext),
			Layer.provide(
				HttpApiBuilder.middlewareCors({
					allowedOrigins: ["https://cap.test"],
					credentials: true,
					allowedMethods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
					allowedHeaders: [
						"Content-Type",
						"Authorization",
						"sentry-trace",
						"baggage",
					],
				}),
			),
			HttpApiBuilder.toWebHandler,
		);
		mocks.disposers.push(web.dispose);
		return web.handler;
	},
}));

const url = "https://cap.test/api/desktop/upload-health";
const authorization = `Bearer ${"a".repeat(36)}`;

beforeEach(() => {
	mocks.authenticate.mockReset().mockReturnValue(true);
});

afterAll(async () => {
	await Promise.all(mocks.disposers.map((dispose) => dispose()));
});

describe("desktop upload health route", () => {
	it("returns an authenticated, empty HEAD response", async () => {
		const { HEAD } = await import("@/app/api/desktop/upload-health/route");
		const response = await HEAD(
			new Request(url, { method: "HEAD", headers: { authorization } }),
		);

		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(mocks.authenticate).toHaveBeenCalledWith(
			expect.objectContaining({ authorization }),
		);
	});

	it.each(["HEAD", "POST"])(
		"rejects unauthenticated %s before reading any body",
		async (method) => {
			mocks.authenticate.mockReturnValue(false);
			const route = await import("@/app/api/desktop/upload-health/route");
			const request = new Request(url, {
				method,
				...(method === "POST" ? { body: new Uint8Array(16) } : {}),
			});
			const getReader = request.body && vi.spyOn(request.body, "getReader");
			const response = await (method === "HEAD" ? route.HEAD : route.POST)(
				request,
			);

			expect(response.status).toBe(401);
			expect(mocks.authenticate).toHaveBeenCalledOnce();
			if (getReader) expect(getReader).not.toHaveBeenCalled();
		},
	);

	it.each([0, 64 * 1024, MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES])(
		"accepts a %i-byte body with the existing response fields",
		async (size) => {
			const { POST } = await import("@/app/api/desktop/upload-health/route");
			const response = await POST(
				new Request(url, {
					method: "POST",
					headers: { authorization },
					...(size ? { body: new Uint8Array(size) } : {}),
				}),
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				success: true,
				receivedBytes: size,
				maxProbeBytes: MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
			});
		},
	);

	it("rejects a declared oversize without reading the body", async () => {
		const { POST } = await import("@/app/api/desktop/upload-health/route");
		const request = new Request(url, {
			method: "POST",
			headers: {
				authorization,
				"content-length": String(MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES + 1),
			},
			body: new Uint8Array(16),
		});
		const getReader = vi.spyOn(
			request.body as ReadableStream<Uint8Array>,
			"getReader",
		);
		const response = await POST(request);

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "probe_too_large" });
		expect(getReader).not.toHaveBeenCalled();
	});

	it.each([undefined, "1", "invalid"])(
		"rejects actual oversize with Content-Length %s and cancels the stream",
		async (contentLength) => {
			const { POST } = await import("@/app/api/desktop/upload-health/route");
			const cancel = vi.fn();
			let chunks = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						controller.enqueue(
							new Uint8Array(
								chunks++ === 0 ? MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES : 1,
							),
						);
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			const options = {
				method: "POST",
				headers: {
					authorization,
					...(contentLength ? { "content-length": contentLength } : {}),
				},
				body,
				duplex: "half",
			};
			const response = await POST(new Request(url, options));

			expect(response.status).toBe(413);
			expect(await response.json()).toEqual({ error: "probe_too_large" });
			expect(cancel).toHaveBeenCalledOnce();
			expect(chunks).toBe(2);
			expect(body.locked).toBe(false);
		},
	);

	it("returns probe_failed and releases the reader when a stream errors", async () => {
		const { POST } = await import("@/app/api/desktop/upload-health/route");
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("connection interrupted"));
			},
		});
		const options = {
			method: "POST",
			headers: { authorization },
			body,
			duplex: "half",
		};
		const response = await POST(new Request(url, options));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "probe_failed" });
		expect(body.locked).toBe(false);
	});

	it("passes preflight through the Effect CORS middleware without authenticating", async () => {
		const { OPTIONS } = await import("@/app/api/desktop/upload-health/route");
		const response = await OPTIONS(
			new Request(url, {
				method: "OPTIONS",
				headers: {
					origin: "https://cap.test",
					"access-control-request-method": "POST",
					"access-control-request-headers": "Authorization, Content-Type",
				},
			}),
		);

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://cap.test",
		);
		expect(response.headers.get("access-control-allow-credentials")).toBe(
			"true",
		);
		expect(response.headers.get("access-control-allow-methods")).toContain(
			"POST",
		);
		expect(response.headers.get("access-control-allow-methods")).toContain(
			"HEAD",
		);
		expect(response.headers.get("access-control-allow-headers")).toContain(
			"Authorization",
		);
		expect(mocks.authenticate).not.toHaveBeenCalled();
	});
});
