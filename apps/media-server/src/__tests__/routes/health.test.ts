import { describe, expect, test } from "bun:test";
import app from "../../app";

describe("GET /health", () => {
	test("returns status ok", async () => {
		const response = await app.fetch(new Request("http://localhost/health"));

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toEqual({ status: "ok" });
	});
});
