import { describe, expect, it } from "vitest";
import { editorRequestOrigin } from "@/lib/editor-request-origin";

describe("editorRequestOrigin", () => {
	it("uses the request origin when the browser sends none", () => {
		expect(
			editorRequestOrigin("https://cap.so/api/x", undefined, "https://cap.so"),
		).toBe("https://cap.so");
	});

	it("accepts the request's own origin", () => {
		expect(
			editorRequestOrigin(
				"https://preview.vercel.app/api/x",
				"https://preview.vercel.app",
				"https://cap.so",
			),
		).toBe("https://preview.vercel.app");
	});

	it("accepts the public web URL behind a proxy on another port", () => {
		expect(
			editorRequestOrigin(
				"https://localhost:3430/api/x",
				"https://localhost:3443",
				"https://localhost:3443",
			),
		).toBe("https://localhost:3443");
	});

	it("refuses any other origin", () => {
		expect(
			editorRequestOrigin(
				"https://cap.so/api/x",
				"https://evil.example",
				"https://cap.so",
			),
		).toBeNull();
		expect(
			editorRequestOrigin("https://cap.so/api/x", "null", "not a url"),
		).toBeNull();
	});
});
