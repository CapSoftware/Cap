import { describe, expect, it } from "vitest";
import { createEmbedUrl } from "./cap-embed";

describe("createEmbedUrl", () => {
	it("builds the default embed URL with required SDK parameters", () => {
		const url = createEmbedUrl({
			videoId: "video-123",
			publicKey: "pk_live_123",
		});

		expect(url).toBe("https://cap.so/embed/video-123?sdk=1&pk=pk_live_123");
	});

	it("includes optional playback and branding parameters", () => {
		const url = new URL(
			createEmbedUrl({
				apiBase: "https://app.example.com",
				videoId: "video-123",
				publicKey: "pk_live_123",
				autoplay: true,
				branding: {
					logoUrl: "https://cdn.example.com/logo.svg",
					accentColor: "#ff00aa",
				},
			}),
		);

		expect(url.origin).toBe("https://app.example.com");
		expect(url.pathname).toBe("/embed/video-123");
		expect(url.searchParams.get("sdk")).toBe("1");
		expect(url.searchParams.get("pk")).toBe("pk_live_123");
		expect(url.searchParams.get("autoplay")).toBe("1");
		expect(url.searchParams.get("logo")).toBe(
			"https://cdn.example.com/logo.svg",
		);
		expect(url.searchParams.get("accent")).toBe("#ff00aa");
	});
});
