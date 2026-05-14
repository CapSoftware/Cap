import { describe, expect, it } from "vitest";
import { createEmbedUrl } from "./cap-embed";

describe("createEmbedUrl", () => {
	it("builds a default Cap embed URL with SDK and public-key markers", () => {
		const url = new URL(
			createEmbedUrl({ videoId: "video-123", publicKey: "pk_test" }),
		);

		expect(url.origin).toBe("https://cap.so");
		expect(url.pathname).toBe("/embed/video-123");
		expect(url.searchParams.get("sdk")).toBe("1");
		expect(url.searchParams.get("pk")).toBe("pk_test");
	});

	it("includes autoplay and branding options when provided", () => {
		const url = new URL(
			createEmbedUrl({
				videoId: "video-123",
				publicKey: "pk_live",
				apiBase: "https://app.example.com",
				autoplay: true,
				branding: {
					logoUrl: "https://cdn.example.com/logo.png",
					accentColor: "#ff00aa",
				},
			}),
		);

		expect(url.origin).toBe("https://app.example.com");
		expect(url.searchParams.get("autoplay")).toBe("1");
		expect(url.searchParams.get("logo")).toBe(
			"https://cdn.example.com/logo.png",
		);
		expect(url.searchParams.get("accent")).toBe("#ff00aa");
	});
});
