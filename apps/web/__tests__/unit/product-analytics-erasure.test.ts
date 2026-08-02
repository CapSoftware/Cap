import {
	ProductAnalyticsErasureLeaseRepo,
	type ProductAnalyticsErasureLeaseStore,
	Tinybird,
} from "@cap/web-backend";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const serviceEnvironment = vi.hoisted(
	(): {
		PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN: string | undefined;
		PRODUCT_ANALYTICS_TINYBIRD_ERASURE_LOOKUP_TOKEN: string | undefined;
		PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN: string | undefined;
		PRODUCT_ANALYTICS_TINYBIRD_HOST: string | undefined;
		PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN: string | undefined;
		PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN: string | undefined;
		TINYBIRD_HOST: undefined;
		TINYBIRD_TOKEN: undefined;
	} => ({
		PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN: "copy-token",
		PRODUCT_ANALYTICS_TINYBIRD_ERASURE_LOOKUP_TOKEN: "lookup-token",
		PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN: "erasure-token",
		PRODUCT_ANALYTICS_TINYBIRD_HOST: "https://staging.tinybird.test",
		PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN: "read-token",
		PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN: "scheduler-token",
		TINYBIRD_HOST: undefined,
		TINYBIRD_TOKEN: undefined,
	}),
);

vi.mock("@cap/env", () => ({ serverEnv: () => serviceEnvironment }));

const tinybirdTestLayer = (
	overrides: Partial<ProductAnalyticsErasureLeaseStore> = {},
) => {
	const store = {
		enqueueErasureRequest: () => Effect.succeed("request-1"),
		claimErasureRequest: () =>
			Effect.succeed({
				id: "request-1",
				ownerId: "request-owner-1",
				scope: { organizationId: "organization-1", userId: "user-1" },
			}),
		completeErasureRequest: () => Effect.void,
		deferErasureRequest: () => Effect.void,
		waitForIngestionQuiescence: () => Effect.succeed(undefined),
		discardPendingEvents: (_scope, anonymousIds = []) =>
			Effect.succeed([...anonymousIds]),
		claimNew: (scope) =>
			Effect.succeed({
				ownerId: "owner-1",
				requestId: "request-1",
				fencingToken: 1,
				phase: "claimed" as const,
				pausedPipes: [],
				scope,
			}),
		claimRecovery: () => Effect.succeed(null),
		heartbeat: () => Effect.succeed(true),
		advance: () => Effect.succeed(true),
		complete: () => Effect.succeed(true),
		fail: () => Effect.succeed(true),
		...overrides,
	} satisfies ProductAnalyticsErasureLeaseStore;
	return Tinybird.DefaultWithoutDependencies.pipe(
		Layer.provide(
			Layer.succeed(ProductAnalyticsErasureLeaseRepo, {
				_tag: "ProductAnalyticsErasureLeaseRepo",
				...store,
			}),
		),
	);
};

const copyScheduleResponse = (url: URL, pausedPipes: Set<string>) => {
	const match = url.pathname.match(
		/^\/v0\/pipes\/([A-Za-z0-9_]+)(?:\/copy\/(cancel|resume))?$/,
	);
	if (!match?.[1]) return undefined;
	const pipe = match[1];
	if (match[2] === "cancel") pausedPipes.add(pipe);
	if (match[2] === "resume") pausedPipes.delete(pipe);
	return Response.json({
		schedule: { status: pausedPipes.has(pipe) ? "paused" : "scheduled" },
	});
};

afterEach(() => {
	vi.unstubAllGlobals();
	serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN = "copy-token";
	serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_LOOKUP_TOKEN =
		"lookup-token";
	serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN = "erasure-token";
	serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_HOST =
		"https://staging.tinybird.test";
	serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN = "read-token";
	serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN =
		"scheduler-token";
});

describe.sequential("product analytics erasure", () => {
	it("deletes linked identities and rebuilds every derived snapshot", async () => {
		const requests: Array<{ url: URL; init: RequestInit }> = [];
		const pausedPipes = new Set<string>();
		let deleted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
				const url = new URL(String(input));
				requests.push({ url, init });
				if (/\/copy\/(cancel|resume)$/.test(url.pathname)) {
					return Response.json(
						{ error: "The copy Pipe is not scheduled" },
						{ status: 422 },
					);
				}
				const scheduleResponse = copyScheduleResponse(url, pausedPipes);
				if (scheduleResponse) return scheduleResponse;
				if (url.pathname === "/v0/sql") {
					const query = url.searchParams.get("q") ?? "";
					if (query.startsWith("SELECT anonymous_id")) {
						return Response.json({ data: [{ anonymous_id: "anonymous-1" }] });
					}
					return Response.json({
						data: [{ matching_rows: deleted ? 0 : 1 }],
					});
				}
				if (url.pathname.includes("/delete")) {
					deleted = true;
					return Response.json({ mutation: { is_done: true } });
				}
				if (url.pathname.endsWith("product_analytics_copy_assertions.json")) {
					return Response.json({
						data: [
							{
								activation_markers: 1,
								attribution_markers: 1,
								decision_markers: 1,
								experiment_markers: 1,
								health_markers: 1,
								identity_markers: 1,
								retention_markers: 1,
								traffic_markers: 1,
								traffic_page_markers: 1,
							},
						],
					});
				}
				if (url.pathname === "/v0/jobs") {
					return Response.json({ jobs: [] });
				}
				if (url.pathname.startsWith("/v0/jobs/")) {
					return Response.json({ status: "done" });
				}
				if (url.pathname.includes("/copy")) {
					const pipe = url.pathname.split("/").at(-2);
					return Response.json({ job_id: `${pipe}-job` });
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
			}).pipe(Effect.provide(tinybirdTestLayer())),
		);

		const identityLookup = requests.find(({ url }) =>
			(url.searchParams.get("q") ?? "").startsWith("SELECT anonymous_id"),
		);
		expect(identityLookup?.url.pathname).toBe("/v0/sql");
		expect(identityLookup?.url.searchParams.get("q")).toContain(
			"countIf(user_id != '' AND user_id != 'user-1') = 0",
		);
		const deletion = requests.find(({ url }) =>
			url.pathname.includes("/delete"),
		);
		expect(deletion?.url.pathname).toBe(
			"/v1/datasources/product_events_v1/delete",
		);
		const deleteBody = new URLSearchParams(String(deletion?.init.body)).get(
			"delete_condition",
		);
		expect(deleteBody).toContain("organization_id");
		expect(deleteBody).toContain("user_id");
		expect(deleteBody).toContain("anonymous_id");
		expect(deleteBody).toContain("AND (user_id = '' OR user_id = 'user-1')");
		expect(
			requests
				.filter(({ url }) => url.pathname.endsWith("/copy"))
				.map(({ url }) => url.pathname),
		).toEqual(
			[
				"snapshot_product_event_id_states_v2",
				"snapshot_product_event_day_states_v2",
				"snapshot_product_events_canonical_v1",
				"snapshot_product_events_daily_exact",
				"snapshot_product_traffic_daily_exact",
				"snapshot_product_traffic_pages_daily_exact",
				"snapshot_product_activation_daily_exact",
				"snapshot_product_creator_retention_exact",
				"snapshot_product_identity_funnel_exact",
				"snapshot_product_attribution_daily_exact",
				"snapshot_product_experiment_outcomes_exact",
				"snapshot_product_events_health_hourly",
			].map((pipe) => `/v0/pipes/${pipe}/copy`),
		);
		for (const request of requests.filter(({ url }) =>
			url.pathname.endsWith("/copy"),
		)) {
			expect(request.url.searchParams.get("_mode")).toBe("replace");
		}
		const jobListRequests = requests.filter(
			({ url }) => url.pathname === "/v0/jobs",
		);
		expect(jobListRequests).toHaveLength(12);
		expect(
			new Set(
				jobListRequests.map(({ url }) => url.searchParams.get("pipe_name")),
			).size,
		).toBe(12);
		expect(
			jobListRequests.every(
				({ init }) =>
					new Headers(init.headers).get("Authorization") ===
					"Bearer scheduler-token",
			),
		).toBe(true);
		expect(
			requests.filter(({ url }) =>
				/^\/v0\/pipes\/[A-Za-z0-9_]+$/.test(url.pathname),
			),
		).toHaveLength(0);
		expect(
			requests.filter(({ url }) => url.pathname.startsWith("/v0/jobs/")),
		).toHaveLength(12);
		expect(
			requests
				.filter(({ url }) => url.pathname.startsWith("/v0/jobs/"))
				.every(
					({ init }) =>
						new Headers(init.headers).get("Authorization") ===
						"Bearer scheduler-token",
				),
		).toBe(true);
		expect(
			requests
				.filter(({ url }) => url.pathname === "/v0/sql")
				.every(
					({ init }) =>
						new Headers(init.headers).get("Authorization") ===
						"Bearer lookup-token",
				),
		).toBe(true);
		expect(
			requests
				.filter(({ url }) => url.pathname === "/v0/sql")
				.every(({ url }) =>
					(url.searchParams.get("q") ?? "").endsWith(" FORMAT JSON"),
				),
		).toBe(true);
		expect(new Headers(deletion?.init.headers).get("Authorization")).toBe(
			"Bearer erasure-token",
		);
	});

	it("fails closed when the erasure credential is missing", async () => {
		serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN = undefined;

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(tinybirdTestLayer()), Effect.flip),
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe(
			"Product analytics Copy schedule control is not configured",
		);
		expect(error.cause).toEqual({
			errorCode: "pause_schedules_configuration",
		});
	});

	it("fails closed when the erasure host is missing", async () => {
		serviceEnvironment.PRODUCT_ANALYTICS_TINYBIRD_HOST = undefined;

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(tinybirdTestLayer()), Effect.flip),
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe(
			"Product analytics erasure host is not configured",
		);
	});

	it("fails closed before deletion when Copy job state is malformed", async () => {
		const requests: URL[] = [];
		const pausedPipes = new Set<string>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				requests.push(url);
				const scheduleResponse = copyScheduleResponse(url, pausedPipes);
				if (scheduleResponse) return scheduleResponse;
				if (url.pathname === "/v0/sql") {
					return Response.json({ data: [{ matching_rows: 1 }] });
				}
				if (url.pathname === "/v0/jobs") return Response.json({});
				return Response.json({});
			}),
		);

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(tinybirdTestLayer()), Effect.flip),
		);

		expect(error.message).toBe(
			"Product analytics Jobs API response was invalid",
		);
		expect(requests.some((url) => url.pathname.includes("/delete"))).toBe(
			false,
		);
	});

	it("fails closed when Tinybird does not confirm deletion", async () => {
		const pausedPipes = new Set<string>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				const scheduleResponse = copyScheduleResponse(url, pausedPipes);
				if (scheduleResponse) return scheduleResponse;
				if (url.pathname === "/v0/sql") {
					return Response.json({ data: [{ matching_rows: 1 }] });
				}
				if (url.pathname === "/v0/jobs") {
					return Response.json({ jobs: [] });
				}
				return Response.json({});
			}),
		);

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(tinybirdTestLayer()), Effect.flip),
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Product analytics deletion did not finish");
	});

	it("rebuilds every snapshot when a retry finds no remaining identity rows", async () => {
		const requests: URL[] = [];
		const pausedPipes = new Set<string>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				requests.push(url);
				const scheduleResponse = copyScheduleResponse(url, pausedPipes);
				if (scheduleResponse) return scheduleResponse;
				if (url.pathname === "/v0/sql") {
					return Response.json({ data: [{ matching_rows: 0 }] });
				}
				if (url.pathname.endsWith("product_analytics_copy_assertions.json")) {
					return Response.json({
						data: [
							{
								activation_markers: 1,
								attribution_markers: 1,
								decision_markers: 1,
								experiment_markers: 1,
								health_markers: 1,
								identity_markers: 1,
								retention_markers: 1,
								traffic_markers: 1,
								traffic_page_markers: 1,
							},
						],
					});
				}
				if (url.pathname === "/v0/jobs") {
					return Response.json({ jobs: [] });
				}
				if (url.pathname.startsWith("/v0/jobs/")) {
					return Response.json({ status: "done" });
				}
				if (url.pathname.endsWith("/copy")) {
					return Response.json({ job_id: "copy-job" });
				}
				return Response.json({});
			}),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(tinybirdTestLayer())),
		);

		expect(requests.some((url) => url.pathname.includes("/delete"))).toBe(
			false,
		);
		expect(
			requests
				.filter((url) => url.pathname.endsWith("/copy"))
				.map((url) => url.pathname),
		).toHaveLength(12);
	});

	it("does not start canonical rebuilding until the event-state copy completes", async () => {
		const requests: URL[] = [];
		const pausedPipes = new Set<string>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				requests.push(url);
				const scheduleResponse = copyScheduleResponse(url, pausedPipes);
				if (scheduleResponse) return scheduleResponse;
				if (url.pathname === "/v0/sql") {
					return Response.json({ data: [{ matching_rows: 0 }] });
				}
				if (url.pathname === "/v0/jobs") {
					return Response.json({ jobs: [] });
				}
				if (
					url.pathname === "/v0/pipes/snapshot_product_event_id_states_v2/copy"
				) {
					return Response.json({ job_id: "state-copy-job" });
				}
				if (url.pathname === "/v0/jobs/state-copy-job") {
					return Response.json({ status: "failed" });
				}
				return Response.json({});
			}),
		);

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(tinybirdTestLayer()), Effect.flip),
		);

		expect(error.message).toContain("ended in failed");
		expect(
			requests.some(
				(url) =>
					url.pathname ===
					"/v0/pipes/snapshot_product_events_canonical_v1/copy",
			),
		).toBe(false);
	});

	it("resumes schedules already paused when a later pause fails", async () => {
		const requests: URL[] = [];
		const pausedPipes = new Set<string>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				requests.push(url);
				if (
					url.pathname ===
					"/v0/pipes/snapshot_product_traffic_daily_exact/copy/cancel"
				) {
					return new Response("pause failed", { status: 500 });
				}
				const scheduleResponse = copyScheduleResponse(url, pausedPipes);
				if (scheduleResponse) return scheduleResponse;
				return Response.json({});
			}),
		);

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				yield* tinybird.eraseProductAnalytics({ organizationId: "org-1" });
			}).pipe(Effect.provide(tinybirdTestLayer()), Effect.flip),
		);

		expect(error).toBeInstanceOf(Error);
		expect(
			requests
				.map((url) => url.pathname)
				.filter((pathname) => /\/copy\/(cancel|resume)$/.test(pathname)),
		).toEqual([
			"/v0/pipes/snapshot_product_event_id_states_v2/copy/cancel",
			"/v0/pipes/snapshot_product_event_day_states_v2/copy/cancel",
			"/v0/pipes/snapshot_product_events_canonical_v1/copy/cancel",
			"/v0/pipes/snapshot_product_events_daily_exact/copy/cancel",
			"/v0/pipes/snapshot_product_traffic_daily_exact/copy/cancel",
			"/v0/pipes/snapshot_product_traffic_daily_exact/copy/cancel",
			"/v0/pipes/snapshot_product_traffic_daily_exact/copy/cancel",
			"/v0/pipes/snapshot_product_traffic_daily_exact/copy/cancel",
			"/v0/pipes/snapshot_product_event_id_states_v2/copy/resume",
			"/v0/pipes/snapshot_product_event_day_states_v2/copy/resume",
			"/v0/pipes/snapshot_product_events_canonical_v1/copy/resume",
			"/v0/pipes/snapshot_product_events_daily_exact/copy/resume",
		]);
	});

	it("durably queues without touching Tinybird when another owner holds the lease", async () => {
		const fetch = vi.fn();
		const deferErasureRequest = vi.fn(() => Effect.void);
		vi.stubGlobal("fetch", fetch);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				return yield* tinybird.eraseProductAnalytics({
					organizationId: "org-1",
				});
			}).pipe(
				Effect.provide(
					tinybirdTestLayer({
						claimNew: () => Effect.succeed(null),
						deferErasureRequest,
					}),
				),
			),
		);

		expect(result).toEqual({ queued: true, requestId: "request-1" });
		expect(deferErasureRequest).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("recovers only the requested durable erasure", async () => {
		const claimRecovery = vi.fn(() => Effect.succeed(null));
		const claimErasureRequest = vi.fn(() => Effect.succeed(null));

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				return yield* tinybird.recoverProductAnalyticsErasureRequest(
					"request-scoped",
				);
			}).pipe(
				Effect.provide(
					tinybirdTestLayer({ claimErasureRequest, claimRecovery }),
				),
			),
		);

		expect(result).toEqual({
			recovered: false,
			requestId: "request-scoped",
		});
		expect(claimRecovery).toHaveBeenCalledWith("request-scoped");
		expect(claimErasureRequest).toHaveBeenCalledWith("request-scoped");
	});

	it("recovers a fenced scope and resumes persisted schedules before rebuilding", async () => {
		const requests: URL[] = [];
		const pausedPipes = new Set(["snapshot_product_events_canonical_v1"]);
		const complete = vi.fn(() => Effect.succeed(true));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				requests.push(url);
				const scheduleResponse = copyScheduleResponse(url, pausedPipes);
				if (scheduleResponse) return scheduleResponse;
				if (url.pathname === "/v0/sql") {
					return Response.json({ data: [{ matching_rows: 0 }] });
				}
				if (url.pathname.endsWith("product_analytics_copy_assertions.json")) {
					return Response.json({
						data: [
							{
								activation_markers: 1,
								attribution_markers: 1,
								decision_markers: 1,
								experiment_markers: 1,
								health_markers: 1,
								identity_markers: 1,
								retention_markers: 1,
								traffic_markers: 1,
								traffic_page_markers: 1,
							},
						],
					});
				}
				if (url.pathname === "/v0/jobs") {
					return Response.json({ jobs: [] });
				}
				if (url.pathname.startsWith("/v0/jobs/")) {
					return Response.json({ status: "done" });
				}
				if (url.pathname.endsWith("/copy")) {
					return Response.json({ job_id: "copy-job" });
				}
				return Response.json({});
			}),
		);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				return yield* tinybird.recoverProductAnalyticsErasure;
			}).pipe(
				Effect.provide(
					tinybirdTestLayer({
						claimRecovery: () =>
							Effect.succeed({
								ownerId: "recovery-owner",
								requestId: "persisted-request",
								fencingToken: 2,
								phase: "failed",
								pausedPipes: ["snapshot_product_events_canonical_v1"],
								scope: { organizationId: "persisted-org" },
							}),
						complete,
					}),
				),
			),
		);

		expect(result).toEqual({
			recovered: true,
			requestId: "persisted-request",
		});
		expect(requests[0]?.pathname).toBe(
			"/v0/pipes/snapshot_product_events_canonical_v1/copy/resume",
		);
		expect(
			requests.some((url) =>
				(url.searchParams.get("q") ?? "").includes(
					"organization_id = 'persisted-org'",
				),
			),
		).toBe(true);
		expect(complete).toHaveBeenCalledOnce();
		expect(pausedPipes.size).toBe(0);
	});
});
