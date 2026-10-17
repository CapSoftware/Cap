import { describe, expect, it, vi } from "vitest";
import {
	checkMediaServerUrl,
	parseMediaServerUrl,
} from "@/lib/media-server-startup-check";

describe("media server startup check", () => {
	it("reports an unset URL without fetching", async () => {
		const fetchImpl = vi.fn();
		expect(await checkMediaServerUrl(undefined, { fetchImpl })).toEqual({
			status: "unset",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects malformed URLs and non-http schemes", () => {
		expect(parseMediaServerUrl("media-server:3456").ok).toBe(false);
		expect(parseMediaServerUrl("not a url").ok).toBe(false);
		expect(parseMediaServerUrl("http://media-server:3456").ok).toBe(true);
	});

	it("calls /health on the configured host", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
		const result = await checkMediaServerUrl("http://media-server:3456/", {
			fetchImpl,
		});
		expect(fetchImpl.mock.calls[0]?.[0]).toBe(
			"http://media-server:3456/health",
		);
		expect(result.status).toBe("ok");
	});

	it("reports unreachable hosts instead of throwing", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(
			new TypeError("fetch failed", {
				cause: new Error("ENOTFOUND cap-media"),
			}),
		);
		const result = await checkMediaServerUrl("http://cap-media:3456", {
			fetchImpl,
		});
		expect(result).toMatchObject({ status: "unreachable" });
		expect(result.status === "unreachable" && result.message).toContain(
			"ENOTFOUND",
		);
	});

	it("reports non-2xx health responses", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("down", { status: 503 }));
		const result = await checkMediaServerUrl("http://media:3456", {
			fetchImpl,
		});
		expect(result.status).toBe("unreachable");
	});
});
