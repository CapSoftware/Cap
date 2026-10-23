import { describe, expect, test } from "bun:test";
import { createEmbedUrl } from "../src/vanilla/cap-embed";

describe("embed autoplay", () => {
	test("requests autoplay using the embed route's true value", () => {
		const url = new URL(
			createEmbedUrl({
				videoId: "video123",
				publicKey: "pk_test_123",
				autoplay: true,
			}),
		);

		expect(url.searchParams.get("autoplay")).toBe("true");
	});

	test.each([false, undefined])("omits autoplay when %s", (autoplay) => {
		const url = new URL(
			createEmbedUrl({
				videoId: "video123",
				publicKey: "pk_test_123",
				autoplay,
			}),
		);

		expect(url.searchParams.has("autoplay")).toBe(false);
	});
});
