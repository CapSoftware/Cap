import { describe, expect, test } from "bun:test";
import app from "../app";

describe("GET /", () => {
	test("returns server metadata and endpoints", async () => {
		const response = await app.fetch(new Request("http://localhost/"));

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toEqual({
			name: "@cap/media-server",
			version: "1.0.0",
			endpoints: ["/health", "/audio/check", "/audio/extract"],
		});
	});
});

describe("unknown routes", () => {
	test("returns 404 for unknown GET routes", async () => {
		const response = await app.fetch(
			new Request("http://localhost/unknown-route"),
		);

		expect(response.status).toBe(404);
	});
});
