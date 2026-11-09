import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// No preview GIF exists, so the route takes the `fallback=og` branch.
vi.mock("@/lib/server", () => ({
	runPromise: async () => null,
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: (effect: unknown) => effect,
	Storage: {},
	Videos: {},
}));
vi.mock("@/lib/loom-preview-gif", () => ({
	ensureLoomPreviewGif: () => undefined,
}));

const { GET } = await import("@/app/api/video/preview/route");

describe("video preview route OG fallback", () => {
	it("redirects to the OG image on the public host, not the internal bind address", async () => {
		// Behind a proxy (Railway, Docker), `request.url` is the server's bind
		// address while the client asked for the public host.
		const request = new NextRequest(
			"https://0.0.0.0:8080/api/video/preview?videoId=video123&fallback=og",
			{ headers: { host: "cap.example.com" } },
		);

		const response = await GET(request);

		expect(response.status).toBe(302);
		const location = response.headers.get("location") ?? "";
		expect(location).not.toContain("0.0.0.0");
		expect(location).toBe("/api/video/og?videoId=video123");
	});

	it("still returns 404 without the OG fallback", async () => {
		const request = new NextRequest(
			"https://0.0.0.0:8080/api/video/preview?videoId=video123&fallback=none",
		);

		const response = await GET(request);

		expect(response.status).toBe(404);
	});
});
