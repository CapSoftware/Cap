import { Tinybird } from "@cap/web-backend";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const serviceEnvironment = vi.hoisted(
	(): {
		PRODUCT_ANALYTICS_TINYBIRD_HOST: string | undefined;
		TINYBIRD_HOST: undefined;
		TINYBIRD_TOKEN: undefined;
	} => ({
		PRODUCT_ANALYTICS_TINYBIRD_HOST: "https://staging.tinybird.test",
		TINYBIRD_HOST: undefined,
		TINYBIRD_TOKEN: undefined,
	}),
);

vi.mock("@cap/env", () => ({ serverEnv: () => serviceEnvironment }));

const originalEnvironment = {
	erasureToken: process.env.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN,
};

afterEach(() => {
	vi.unstubAllGlobals();
	serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_HOST =
		"https://staging.tinybird.test";
	if (originalEnvironment.erasureToken === undefined) {
		delete process.env.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN;
	} else {
		process.env.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN =
			originalEnvironment.erasureToken;
	}
});

describe.sequential("product analytics erasure", () => {
	it("deletes linked identities and rebuilds every derived snapshot", async () => {
		process.env.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN = "erasure-token";
		const requests: Array<{ url: URL; init: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
				const url = new URL(String(input));
				requests.push({ url, init });
				if (url.pathname === "/v0/sql") {
					return Response.json({ data: [{ anonymous_id: "anonymous-1" }] });
				}
				if (url.pathname.includes("/delete")) {
					return Response.json({ mutation: { is_done: true } });
				}
				if (url.pathname.includes("/copy")) {
					const pipe = url.pathname.split("/").at(-2);
					return Response.json({ job_id: `${pipe}-job` });
				}
				if (url.pathname.includes("/jobs/")) {
					return Response.json({ status: "done" });
				}
				return Response.json({});
			}),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({
					userId: "user-1",
					organizationId: "organization-1",
				});
			}).pipe(Effect.provide(Tinybird.Default)),
		);

		expect(requests).toHaveLength(16);
		expect(requests[0]?.url.pathname).toBe("/v0/sql");
		expect(requests[0]?.url.searchParams.get("q")).toContain(
			"countIf(user_id != '' AND user_id != 'user-1') = 0",
		);
		expect(requests[1]?.url.pathname).toBe(
			"/v1/datasources/product_events_v1/delete",
		);
		const deleteBody = new URLSearchParams(String(requests[1]?.init.body)).get(
			"delete_condition",
		);
		expect(deleteBody).toContain("organization_id");
		expect(deleteBody).toContain("user_id");
		expect(deleteBody).toContain("anonymous_id");
		expect(deleteBody).toContain("AND (user_id = '' OR user_id = 'user-1')");
		expect(requests.slice(2).map(({ url }) => url.pathname)).toEqual(
			[
				"snapshot_product_events_canonical_v1",
				"snapshot_product_events_daily_exact",
				"snapshot_product_traffic_daily_exact",
				"snapshot_product_traffic_pages_daily_exact",
				"snapshot_product_activation_daily_exact",
				"snapshot_product_creator_retention_exact",
				"snapshot_product_events_health_hourly",
			].flatMap((pipe) => [`/v0/pipes/${pipe}/copy`, `/v0/jobs/${pipe}-job`]),
		);
		for (const request of requests.filter(({ url }) =>
			url.pathname.endsWith("/copy"),
		)) {
			expect(request.url.searchParams.get("_mode")).toBe("replace");
		}
		for (const request of requests) {
			expect(new Headers(request.init.headers).get("Authorization")).toBe(
				"Bearer erasure-token",
			);
		}
	});

	it("fails closed when the erasure credential is missing", async () => {
		delete process.env.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN;

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(Tinybird.Default), Effect.flip),
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Product analytics erasure is not configured");
	});

	it("fails closed when the erasure host is missing", async () => {
		process.env.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN = "erasure-token";
		serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_HOST = undefined;

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(Tinybird.Default), Effect.flip),
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe(
			"Product analytics erasure host is not configured",
		);
	});

	it("fails closed when Tinybird does not confirm deletion", async () => {
		process.env.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN = "erasure-token";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.pathname === "/v0/sql") {
					return Response.json({ data: [] });
				}
				return Response.json({});
			}),
		);

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(Tinybird.Default), Effect.flip),
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Product analytics deletion did not finish");
	});
});
