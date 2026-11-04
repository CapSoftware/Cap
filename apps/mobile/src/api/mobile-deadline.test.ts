import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMobileApiClient, MobileApiError } from "./mobile";

vi.mock("expo-file-system/legacy", () => ({}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const client = () =>
	createMobileApiClient({ baseUrl: "https://cap.test", getToken: () => "key" });

describe.each(["bootstrap", "getAuthConfig"] as const)(
	"mobile %s request deadline",
	(method) => {
		it("aborts stalled response headers after 30 seconds", async () => {
			let signal: AbortSignal | null | undefined;
			vi.stubGlobal("fetch", (_url: RequestInfo | URL, init?: RequestInit) => {
				signal = init?.signal;
				return new Promise<Response>((_resolve, reject) =>
					signal?.addEventListener(
						"abort",
						() => reject(new Error("Aborted")),
						{ once: true },
					),
				);
			});
			const rejected = vi.fn();
			void client()[method]().catch(rejected);
			await vi.advanceTimersByTimeAsync(29_999);
			expect(rejected).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(signal?.aborted).toBe(true);
			expect(rejected).toHaveBeenCalledOnce();
			const error: unknown = rejected.mock.calls[0]?.[0];
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(MobileApiError);
			expect((error as Error).message).toBe("Mobile API request timed out");
			expect(vi.getTimerCount()).toBe(0);
		});

		it("keeps the deadline active while reading a stalled body", async () => {
			vi.stubGlobal(
				"fetch",
				async (_url: RequestInfo | URL, init?: RequestInit) =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								init?.signal?.addEventListener(
									"abort",
									() => controller.error(new Error("Body aborted")),
									{ once: true },
								);
							},
						}),
					),
			);
			const rejected = vi.fn();
			void client()[method]().catch(rejected);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(rejected).toHaveBeenCalledOnce();
			expect(rejected.mock.calls[0]?.[0]).toMatchObject({
				message: "Mobile API request timed out",
			});
			expect(vi.getTimerCount()).toBe(0);
		});

		it("clears the deadline after success without aborting the completed request", async () => {
			let signal: AbortSignal | null | undefined;
			vi.stubGlobal(
				"fetch",
				async (_url: RequestInfo | URL, init?: RequestInit) => {
					signal = init?.signal;
					return Response.json({ success: true });
				},
			);
			await expect(client()[method]()).resolves.toEqual({ success: true });
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(signal?.aborted ?? false).toBe(false);
		});

		it("preserves HTTP errors and releases their deadline", async () => {
			vi.stubGlobal("fetch", async () =>
				Response.json({ error: "No session" }, { status: 401 }),
			);
			const result = client()[method]();
			await expect(result).rejects.toBeInstanceOf(MobileApiError);
			await expect(result).rejects.toMatchObject({
				status: 401,
				payload: { error: "No session" },
			});
			expect(vi.getTimerCount()).toBe(0);
		});

		it("preserves immediate network errors and releases their deadline", async () => {
			const error = new TypeError("Network unavailable");
			vi.stubGlobal("fetch", async () => {
				throw error;
			});
			await expect(client()[method]()).rejects.toBe(error);
			expect(vi.getTimerCount()).toBe(0);
		});
	},
);
