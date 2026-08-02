import {
	createProductEventRows,
	type ProductAnalyticsError,
	sendProductAnalyticsRows,
} from "@cap/analytics";
import { hasAnalyticsSessionCookie } from "@cap/web-backend";
import { describe, expect, it, vi } from "vitest";

const rows = createProductEventRows(
	[
		{
			eventId: "event-1",
			eventName: "page_view",
			occurredAt: "2026-07-12T12:00:00.000Z",
			anonymousId: "anonymous-1",
			schemaVersion: 1,
			platform: "web",
			properties: {
				hostname: "cap.so",
				is_session_entry: true,
				session_started_at: "2026-07-12T12:00:00.000Z",
			},
		},
	],
	{
		receivedAt: "2026-07-12T12:00:01.000Z",
		source: "client",
	},
);

describe("Tinybird product event transport", () => {
	it("skips session resolution for anonymous requests", () => {
		expect(hasAnalyticsSessionCookie()).toBe(false);
		expect(hasAnalyticsSessionCookie("theme=dark; visitor=123")).toBe(false);
		expect(
			hasAnalyticsSessionCookie(
				"theme=dark; next-auth.session-token=token; visitor=123",
			),
		).toBe(true);
		expect(hasAnalyticsSessionCookie("next-auth.session-token.0=chunk")).toBe(
			true,
		);
	});

	it("posts NDJSON with append-only credentials", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 202 }));

		await sendProductAnalyticsRows({
			host: "https://api.tinybird.co",
			token: "append-token",
			rows,
			fetchImpl,
		});

		const [url, request] = fetchImpl.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://api.tinybird.co/v0/events?name=product_events_v1&format=ndjson",
		);
		expect(request).toMatchObject({
			method: "POST",
			headers: {
				Authorization: "Bearer append-token",
				"Content-Type": "application/x-ndjson",
			},
			body: JSON.stringify(rows[0]),
		});
	});

	it("retries a transient response once", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 202 }));

		await sendProductAnalyticsRows({
			host: "https://api.tinybird.co",
			token: "append-token",
			rows,
			fetchImpl,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("does not retry a permanent response", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("invalid", { status: 400 }));

		await expect(
			sendProductAnalyticsRows({
				host: "https://api.tinybird.co",
				token: "append-token",
				rows,
				fetchImpl,
			}),
		).rejects.toMatchObject({
			_tag: "ProductAnalyticsError",
			retryable: false,
			status: 400,
		} satisfies Partial<ProductAnalyticsError>);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("supports a single-attempt collector path", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("offline"));
		await expect(
			sendProductAnalyticsRows({
				host: "https://api.tinybird.co",
				token: "append-token",
				rows,
				maxAttempts: 1,
				fetchImpl,
			}),
		).rejects.toMatchObject({ retryable: true });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("fails after two network attempts", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("offline"));

		await expect(
			sendProductAnalyticsRows({
				host: "https://api.tinybird.co",
				token: "append-token",
				rows,
				fetchImpl,
			}),
		).rejects.toMatchObject({
			_tag: "ProductAnalyticsError",
			retryable: true,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});
