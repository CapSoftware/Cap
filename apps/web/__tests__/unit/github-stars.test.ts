import { afterEach, describe, expect, it, vi } from "vitest";
import { getGitHubStars } from "@/utils/github";

async function settle(): Promise<number | string> {
	try {
		return await getGitHubStars();
	} catch (error) {
		return `threw: ${String(error)}`;
	}
}

describe("getGitHubStars", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns the star count when the request succeeds", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ stargazers_count: 1234 }), {
					status: 200,
				}),
			),
		);
		expect(await settle()).toBe(1234);
	});

	it("returns 0 when fetch rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("fetch failed")),
		);
		expect(await settle()).toBe(0);
	});

	it("returns 0 when the response is not ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
		);
		expect(await settle()).toBe(0);
	});

	it("returns 0 when the body is not valid JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("<html></html>", { status: 200 })),
		);
		expect(await settle()).toBe(0);
	});
});
