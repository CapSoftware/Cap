import { describe, expect, it } from "vitest";
import { createEmbedUrl } from "./cap-embed";

describe("createEmbedUrl", () => {
	it("builds the default Cap embed URL", () => {
		const url = createEmbedUrl({
			videoId: "video_123",
			publicKey: "pk_test",
		});

		expect(url).toBe("https://cap.so/embed/video_123?sdk=1&pk=pk_test");
	});

	it("includes optional base, playback, and branding parameters", () => {
		const url = createEmbedUrl({
			videoId: "video_123",
			publicKey: "pk_test",
			apiBase: "https://app.example",
			autoplay: true,
			branding: {
				logoUrl: "https://cdn.example/logo.png",
				accentColor: "#abcdef",
			},
		});

		expect(url).toBe(
			"https://app.example/embed/video_123?sdk=1&pk=pk_test&autoplay=1&logo=https%3A%2F%2Fcdn.example%2Flogo.png&accent=%23abcdef",
		);
	});
});
