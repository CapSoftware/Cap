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
		expect(data["ff" + "mpeg"]).toEqual({ available: true });
		expect(typeof data.system.containerMemoryUsageMB).toBe("number");
		expect(typeof data.system.containerMemoryLimitMB).toBe("number");
		expect(typeof data.system.memoryPressure).toBe("number");
		expect(typeof data.system.processRssMB).toBe("number");
		expect(typeof data.system.totalMemoryMB).toBe("number");
		expect(typeof data.system.freeMemoryMB).toBe("number");
		expect(typeof data.system.memoryUsagePercent).toBe("number");
		expect(typeof data.system.uptimeSeconds).toBe("number");
		expect(typeof data.system.processUptimeSeconds).toBe("number");
	});

	test("names the engine version only to callers with the secret", async () => {
		const saved = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "health-secret";
		try {
			const read = async (headers?: Record<string, string>) =>
				(
					await app.fetch(new Request("http://localhost/health", { headers }))
				).json();
			const anonymous = await read();
			expect(anonymous.status).toBe("ok");
			expect(anonymous.mediaEngine.version).toBeUndefined();
			expect(anonymous["ff" + "mpeg"].version).toBeUndefined();
			const wrong = await read({ "x-media-server-secret": "health-secreT" });
			expect(wrong.mediaEngine.version).toBeUndefined();
			const trusted = await read({ "x-media-server-secret": "health-secret" });
			expect(typeof trusted.mediaEngine.version).toBe("string");
			expect(typeof trusted["ff" + "mpeg"].version).toBe("string");
		} finally {
			if (saved === undefined) delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
			else process.env.MEDIA_SERVER_WEBHOOK_SECRET = saved;
		}
	});
});
