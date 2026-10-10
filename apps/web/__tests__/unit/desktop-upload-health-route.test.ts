import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	type HttpApi,
	HttpApiBuilder,
	HttpApiError,
	HttpServer,
	HttpServerRequest,
} from "@effect/platform";
import { type Context, Effect, Layer, Option } from "effect";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as uploadHealth from "@/app/api/desktop/upload-health/upload-health";
import {
	DESKTOP_UPLOAD_HEALTH_READ_TIMEOUT_MS,
	MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
} from "@/app/api/desktop/upload-health/upload-health";

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
const fixture = new Uint8Array(
	readFileSync(
		new URL(
			"../../../desktop/src-tauri/src/upload_health/fixtures/probe.mp4",
			import.meta.url,
		),
	),
);
const fixtureSha256 =
	"2a53c14ff7bd4380890b938b9d238455661b9aca84c169c8e17215235e46ef5d";

beforeEach(() => {
	mocks.authenticate.mockReset().mockReturnValue(true);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
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
		expect(response.headers.get("cache-control")).toBe("private, no-store");
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

	it.each([1, 64 * 1024, MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES])(
		"accepts a %i-byte body with a digest of the bytes received",
		async (size) => {
			const { POST } = await import("@/app/api/desktop/upload-health/route");
			const body = new Uint8Array(size);
			const response = await POST(
				new Request(url, {
					method: "POST",
					headers: { authorization },
					body,
				}),
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			expect(await response.json()).toEqual({
				success: true,
				receivedBytes: size,
				sha256: createHash("sha256").update(body).digest("hex"),
				maxProbeBytes: MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
			});
		},
	);

	it("receives the exact desktop recording fixture through the Effect router", async () => {
		const { POST } = await import("@/app/api/desktop/upload-health/route");
		const response = await POST(
			new Request(url, {
				method: "POST",
				headers: { authorization, "Content-Type": "video/mp4" },
				body: fixture,
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			receivedBytes: 256 * 1024,
			sha256: fixtureSha256,
			maxProbeBytes: MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
		});
	});

	it.each(["truncated", "corrupted"])(
		"reports the actual digest for a %s recording instead of certifying the expected fixture",
		async (change) => {
			const { POST } = await import("@/app/api/desktop/upload-health/route");
			const body =
				change === "truncated" ? fixture.slice(0, -1) : fixture.slice();
			if (change === "corrupted") body[128] = (body[128] ?? 0) ^ 1;
			const response = await POST(
				new Request(url, {
					method: "POST",
					headers: { authorization, "Content-Type": "video/mp4" },
					body,
				}),
			);

			expect(response.status).toBe(200);
			const result = await response.json();
			expect(result.receivedBytes).toBe(body.byteLength);
			expect(result.sha256).toBe(
				createHash("sha256").update(body).digest("hex"),
			);
			expect(result.sha256).not.toBe(fixtureSha256);
		},
	);

	it.each([undefined, new Uint8Array()])(
		"rejects an empty body",
		async (body) => {
			const { POST } = await import("@/app/api/desktop/upload-health/route");
			const response = await POST(
				new Request(url, { method: "POST", headers: { authorization }, body }),
			);

			expect(response.status).toBe(400);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			expect(await response.json()).toEqual({ error: "probe_empty" });
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
		expect(response.headers.get("cache-control")).toBe("private, no-store");
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
			expect(response.headers.get("cache-control")).toBe("private, no-store");
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
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({ error: "probe_failed" });
		expect(body.locked).toBe(false);
	});

	it("returns 413 without waiting for a stalled cancellation", async () => {
		const { POST } = await import("@/app/api/desktop/upload-health/route");
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new Uint8Array(MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES + 1),
				);
			},
			cancel,
		});
		const options = {
			method: "POST",
			headers: { authorization },
			body,
			duplex: "half",
		};
		const response = await POST(new Request(url, options));

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "probe_too_large" });
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	}, 1_000);

	it("returns 408 for a partially received body that never finishes", async () => {
		const { POST } = await import("@/app/api/desktop/upload-health/route");
		vi.useFakeTimers();
		let waiting!: () => void;
		const stalled = new Promise<void>((resolve) => {
			waiting = resolve;
		});
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		let first = true;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (first) {
						first = false;
						controller.enqueue(new Uint8Array([1, 2, 3]));
					} else {
						waiting();
					}
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		const options = {
			method: "POST",
			headers: { authorization },
			body,
			duplex: "half",
		};
		const result = POST(new Request(url, options));
		await stalled;
		await vi.advanceTimersByTimeAsync(DESKTOP_UPLOAD_HEALTH_READ_TIMEOUT_MS);
		const response = await result;

		expect(response.status).toBe(408);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({ error: "probe_timeout" });
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("forwards Effect cancellation and never succeeds on a partial aborted body", async () => {
		const { POST } = await import("@/app/api/desktop/upload-health/route");
		const read = vi.spyOn(uploadHealth, "readUploadHealthProbe");
		const controller = new AbortController();
		let waiting!: () => void;
		const stalled = new Promise<void>((resolve) => {
			waiting = resolve;
		});
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		let first = true;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(stream) {
					if (first) {
						first = false;
						stream.enqueue(new Uint8Array([1]));
					} else {
						waiting();
					}
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		const options = {
			method: "POST",
			headers: { authorization },
			body,
			duplex: "half",
			signal: controller.signal,
		};
		const request = new Request(url, options);
		const result = POST(request);
		await stalled;
		controller.abort();
		const response = await result;

		expect(response.status).toBe(499);
		expect(read).toHaveBeenCalledWith(request, {
			signal: expect.any(AbortSignal),
		});
		expect(read.mock.calls[0]?.[1]?.signal).not.toBe(request.signal);
		expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(cancel).toHaveBeenCalledOnce();
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
