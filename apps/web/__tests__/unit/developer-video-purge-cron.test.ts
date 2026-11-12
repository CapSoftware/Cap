import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpApi } from "@effect/platform";
import type { Layer as EffectLayer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ purge: vi.fn() }));

vi.mock("@/lib/developer-video-purge", () => ({
	purgeDeletedDeveloperVideos: mocks.purge,
}));

type ApiLayer = EffectLayer.Layer<HttpApi.Api>;

vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (api: ApiLayer) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(api, HttpServer.layerContext),
			);
			return (request: Request) => handler(request);
		},
	};
});

const runCron = async (authorization?: string) => {
	const { GET } = await import("@/app/api/cron/developer-video-purge/route");
	return GET(
		new Request("https://localhost/api/cron/developer-video-purge", {
			headers: authorization ? { authorization } : {},
		}),
	);
};

describe("developer video purge cron", () => {
	beforeEach(() => {
		vi.stubEnv("CRON_SECRET", "test-cron-secret");
		mocks.purge.mockReset();
		mocks.purge.mockResolvedValue({ purged: 0, failed: 0 });
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([undefined, "Bearer wrong-secret-value", "test-cron-secret"])(
		"rejects the authorization header %j without purging",
		async (authorization) => {
			const response = await runCron(authorization);

			expect(response.status).toBe(401);
			expect(mocks.purge).not.toHaveBeenCalled();
		},
	);

	it("purges deleted videos and reports how many", async () => {
		mocks.purge.mockResolvedValue({ purged: 3, failed: 0 });

		const response = await runCron("Bearer test-cron-secret");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ purged: 3, failed: 0 });
		expect(mocks.purge).toHaveBeenCalledTimes(1);
	});

	it("reports a failure when files could not be removed, so it is seen", async () => {
		mocks.purge.mockResolvedValue({ purged: 1, failed: 2 });

		expect((await runCron("Bearer test-cron-secret")).status).toBe(500);
	});

	it("reports a failure when the purge itself throws", async () => {
		mocks.purge.mockRejectedValue(new Error("database unavailable"));

		expect((await runCron("Bearer test-cron-secret")).status).toBe(500);
	});

	it("is scheduled every five minutes", () => {
		const config = JSON.parse(
			readFileSync(join(process.cwd(), "vercel.json"), "utf8"),
		) as { crons: { path: string; schedule: string }[] };

		expect(
			config.crons.find(
				(cron) => cron.path === "/api/cron/developer-video-purge",
			)?.schedule,
		).toBe("*/5 * * * *");
	});
});
