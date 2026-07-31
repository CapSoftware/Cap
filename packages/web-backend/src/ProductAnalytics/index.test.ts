import {
	ProductAnalyticsError,
	type ProductEventRow,
	type sendProductAnalyticsRows,
} from "@cap/analytics";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	createProductAnalyticsService,
	isOfficialProductAnalyticsDeployment,
} from "./index";

const row: ProductEventRow = {
	event_id: "event-1",
	payload_hash: "payload-hash-1",
	occurred_at: "2026-07-31T12:00:00.000Z",
	received_at: "2026-07-31T12:00:01.000Z",
	event_name: "page_view",
	schema_version: 1,
	source: "client",
	platform: "web",
	anonymous_id: "anonymous-1",
	session_id: "session-1",
	user_id: "",
	organization_id: "",
	app_version: "",
	pathname: "/",
	referrer: "",
	country: "",
	region: "",
	city: "",
	hostname: "cap.so",
	browser: "Chrome",
	device: "desktop",
	os: "macOS",
	channel: "direct",
	traffic_class: "external",
	synthetic_run_id: "",
	properties: "{}",
};

describe("ProductAnalytics", () => {
	for (const vercelEnvironment of ["production", "preview"] as const) {
		it(`requires Tinybird configuration for official ${vercelEnvironment} deployments`, () => {
			expect(
				isOfficialProductAnalyticsDeployment({
					isCap: "true",
					vercelEnvironment,
				}),
			).toBe(true);
		});
	}

	for (const deployment of [
		{ isCap: "true", vercelEnvironment: "development" as const },
		{ isCap: "false", vercelEnvironment: "production" as const },
		{ isCap: undefined, vercelEnvironment: "preview" as const },
	]) {
		it("keeps explicitly non-official deployments optional", () => {
			expect(isOfficialProductAnalyticsDeployment(deployment)).toBe(false);
		});
	}

	it("fails official delivery when Tinybird configuration is missing", async () => {
		const analytics = createProductAnalyticsService({ required: true });
		const error = await Effect.runPromise(Effect.flip(analytics.append([row])));

		expect(error._tag).toBe("ProductAnalyticsError");
		expect(error.retryable).toBe(true);
		expect(error.status).toBe(503);
	});

	it("treats whitespace-only credentials as missing", async () => {
		const analytics = createProductAnalyticsService({
			host: " ",
			token: "\t",
			required: true,
		});
		const error = await Effect.runPromise(Effect.flip(analytics.append([row])));

		expect(error).toBeInstanceOf(ProductAnalyticsError);
	});

	it("preserves the optional no-op for non-official deployments", async () => {
		let calls = 0;
		const sendRows = async () => {
			calls += 1;
		};
		const analytics = createProductAnalyticsService({
			required: false,
			sendRows,
		});

		await Effect.runPromise(analytics.append([row]));

		expect(analytics.enabled).toBe(false);
		expect(calls).toBe(0);
	});

	it("sends configured events with the collector retry boundary", async () => {
		let request: Parameters<typeof sendProductAnalyticsRows>[0] | undefined;
		const sendRows = async (
			options: Parameters<typeof sendProductAnalyticsRows>[0],
		) => {
			request = options;
		};
		const analytics = createProductAnalyticsService({
			host: " https://api.tinybird.co ",
			token: " append-token ",
			required: true,
			sendRows,
		});

		await Effect.runPromise(analytics.append([row], true));

		expect(analytics.enabled).toBe(true);
		expect(request).toEqual({
			host: "https://api.tinybird.co",
			token: "append-token",
			rows: [row],
			wait: true,
			maxAttempts: 1,
		});
	});
});
