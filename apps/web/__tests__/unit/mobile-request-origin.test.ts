import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMobileRequestOrigin } from "@/lib/mobile-request-origin";

describe("mobile request origin", () => {
	it("uses the private request origin when local WEB_URL is loopback", () => {
		expect(
			resolveMobileRequestOrigin(
				"http://localhost:3000",
				"http://192.168.4.42:3000/api/mobile/caps/cap_123/playback",
			),
		).toBe("http://192.168.4.42:3000");
	});

	it("supports private IPv6 and local hostnames", () => {
		expect(
			resolveMobileRequestOrigin(
				"http://127.0.0.1:3000",
				"http://[fd12:3456::1]:3000/api/mobile/caps",
			),
		).toBe("http://[fd12:3456::1]:3000");
		expect(
			resolveMobileRequestOrigin(
				"http://[::1]:3000",
				"http://richies-mac.local:3000/api/mobile/caps",
			),
		).toBe("http://richies-mac.local:3000");
	});

	it("preserves configured production and preview origins", () => {
		expect(
			resolveMobileRequestOrigin(
				"https://cap.so",
				"http://192.168.4.42:3000/api/mobile/caps",
			),
		).toBe("https://cap.so");
		expect(
			resolveMobileRequestOrigin(
				"https://cap-git-feature.vercel.app/",
				"http://10.0.0.4:3000/api/mobile/caps",
			),
		).toBe("https://cap-git-feature.vercel.app");
	});

	it("does not trust a public request host when WEB_URL is local", () => {
		expect(
			resolveMobileRequestOrigin(
				"http://localhost:3000",
				"https://example.com/api/mobile/caps",
			),
		).toBe("http://localhost:3000");
	});

	it("falls back to the configured origin for malformed requests", () => {
		expect(
			resolveMobileRequestOrigin("http://localhost:3000/", "not a request URL"),
		).toBe("http://localhost:3000");
	});

	it("uses Effect's unmodified request URL for mobile response origins", () => {
		const route = readFileSync(
			join(process.cwd(), "app/api/mobile/[...route]/route.ts"),
			"utf8",
		);

		expect(route).toContain(
			"getPlayback(path.id, getMobilePublicOrigin(request.originalUrl))",
		);
		expect(route).not.toContain("getMobilePublicOrigin(request.url)");
	});
});
