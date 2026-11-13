import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import app from "../../app";

const SECRET = "health-secret";
let saved: string | undefined;

beforeEach(() => {
	saved = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
	if (saved === undefined) delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = saved;
});

function get(path: string, headers?: Record<string, string>) {
	return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

describe("GET /health", () => {
	test("returns status ok with media engine info to a caller with the secret", async () => {
		const response = await get("/health", { "x-media-server-secret": SECRET });

		expect(response.status).toBe(200);
		const data = await response.json();
		// "degraded" on a test machine short of memory.
		expect(["ok", "degraded"]).toContain(data.status);
		expect(data.mediaEngine).toBeDefined();
		expect(data.mediaEngine.available).toBe(true);
		expect(typeof data.mediaEngine.version).toBe("string");
		expect(data["ff" + "mpeg"].available).toBe(true);
		expect(typeof data["ff" + "mpeg"].version).toBe("string");
		expect(data.videoEncoder).toBeDefined();
		expect(data.runtime).toBeDefined();
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

	test("tells a caller without the secret only whether the server is up", async () => {
		for (const headers of [
			undefined,
			{ "x-media-server-secret": "health-secreT" },
		]) {
			const response = await get("/health", headers);
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(Object.keys(body)).toEqual(["status"]);
			expect(["ok", "degraded"]).toContain(body.status);
		}
	});

	test("answers only the status when no secret is configured", async () => {
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
		const response = await get("/health");
		expect(response.status).toBe(200);
		expect(Object.keys(await response.json())).toEqual(["status"]);
	});
});

describe("GET /", () => {
	test("lists endpoints only to a caller with the secret", async () => {
		expect(await (await get("/")).json()).toEqual({ status: "ok" });
		const trusted = await (
			await get("/", { "x-media-server-secret": SECRET })
		).json();
		expect(trusted.name).toBe("@cap/media-server");
		expect(trusted.endpoints).toContain("/health");
	});
});
