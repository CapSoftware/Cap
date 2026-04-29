import { describe, expect, test } from "bun:test";
import app from "../../app";

describe("GET /health", () => {
	test("returns status ok with ffmpeg info", async () => {
		const response = await app.fetch(new Request("http://localhost/health"));

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.status).toBe("ok");
		expect(data.ffmpeg).toBeDefined();
		expect(data.ffmpeg.available).toBe(true);
		expect(typeof data.ffmpeg.version).toBe("string");
	});
});
