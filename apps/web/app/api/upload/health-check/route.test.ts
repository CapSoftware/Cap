import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

describe("Cap desktop upload health-check API route", () => {
	it("accepts valid upload probe buffers and rejects undersized or oversized payloads", async () => {
		const validPayload = new Uint8Array(1024).fill(42);
		const okRes = await POST(
			new Request("https://cap.so/api/upload/health-check", {
				method: "POST",
				body: validPayload,
			}),
		);
		expect(okRes.status).toBe(200);
		const okJson = await okRes.json();
		expect(okJson.ok).toBe(true);
		expect(okJson.bytesReceived).toBe(1024);

		const smallRes = await POST(
			new Request("https://cap.so/api/upload/health-check", {
				method: "POST",
				body: new Uint8Array(4),
			}),
		);
		expect(smallRes.status).toBe(400);

		const oversizedRes = await POST(
			new Request("https://cap.so/api/upload/health-check", {
				method: "POST",
				headers: { "content-length": "1048576" },
				body: new Uint8Array(32),
			}),
		);
		expect(oversizedRes.status).toBe(413);

		const getRes = await GET();
		expect(getRes.status).toBe(200);
	});
});
