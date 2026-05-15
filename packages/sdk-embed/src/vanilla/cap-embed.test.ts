import { describe, expect, it } from "vitest";
import { createEmbedUrl } from "./cap-embed";

describe("createEmbedUrl", () => {
	it("builds a default Cap embed URL", () => {
		const url = new URL(
			createEmbedUrl({
				videoId: "video_123",
				publicKey: "pk_test_123",
			}),
		);

		expect(url.origin).toBe("https://cap.so");
		expect(url.pathname).toBe("/embed/video_123");
		expect(url.searchParams.get("sdk")).toBe("1");
		expect(url.searchParams.get("pk")).toBe("pk_test_123");
		expect(url.searchParams.has("autoplay")).toBe(false);
	});

	it("includes optional playback and branding parameters", () => {
		const url = new URL(
			createEmbedUrl({
				apiBase: "https://app.example.com",
				videoId: "video_456",
				publicKey: "pk_live_456",
				autoplay: true,
				branding: {
					logoUrl: "https://cdn.example.com/logo.svg",
					accentColor: "#ff3366",
				},
			}),
		);

		expect(url.origin).toBe("https://app.example.com");
		expect(url.pathname).toBe("/embed/video_456");
		expect(url.searchParams.get("sdk")).toBe("1");
		expect(url.searchParams.get("pk")).toBe("pk_live_456");
		expect(url.searchParams.get("autoplay")).toBe("1");
		expect(url.searchParams.get("logo")).toBe(
			"https://cdn.example.com/logo.svg",
		);
		expect(url.searchParams.get("accent")).toBe("#ff3366");
	});
});
