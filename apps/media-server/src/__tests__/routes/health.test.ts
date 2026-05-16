import { describe, expect, test } from "bun:test";
import app from "../../app";

describe("GET /health", () => {
	test("returns status ok with media engine info", async () => {
		const response = await app.fetch(new Request("http://localhost/health"));

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.status).toBe("ok");
		expect(data.mediaEngine).toBeDefined();
		expect(data.mediaEngine.available).toBe(true);
		expect(typeof data.mediaEngine.version).toBe("string");
		expect(data["ff" + "mpeg"]).toBeDefined();
	});
});
