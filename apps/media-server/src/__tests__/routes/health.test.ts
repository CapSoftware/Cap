import { describe, expect, test } from "bun:test";
import app from "../../app";
import { beginDraining, endDraining } from "../../lib/job-manager";

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

	test("stays HTTP 200 while draining so the healthcheck can finish the drain", async () => {
		beginDraining();
		try {
			const response = await app.fetch(new Request("http://localhost/health"));
			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.status).toBe("draining");
		} finally {
			endDraining();
		}
	});
});
