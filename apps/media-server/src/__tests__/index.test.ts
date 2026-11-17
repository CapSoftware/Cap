import { describe, expect, test } from "bun:test";
import app from "../app";

describe("GET /", () => {
	test("returns server metadata and endpoints to a caller with the secret", async () => {
		const saved = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "index-secret";
		const response = await app.fetch(
			new Request("http://localhost/", {
				headers: { "x-media-server-secret": "index-secret" },
			}),
		);
		if (saved === undefined) delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
		else process.env.MEDIA_SERVER_WEBHOOK_SECRET = saved;

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toEqual({
			name: "@cap/media-server",
			version: "1.0.0",
			endpoints: [
				"/health",
				"/audio/status",
				"/audio/check",
				"/audio/extract",
				"/audio/convert",
				"/video/status",
				"/video/probe",
				"/video/thumbnail",
				"/video/convert",
				"/video/process",
				"/video/edit",
				"/video/process/:jobId/status",
				"/video/process/:jobId/cancel",
				"/video/cleanup",
				"/video/force-cleanup",
				"/live-transcribe/status",
				"/live-transcribe/sessions",
			],
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
