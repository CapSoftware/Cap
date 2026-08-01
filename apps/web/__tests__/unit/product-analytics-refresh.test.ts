import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	acquire: vi.fn(),
	release: vi.fn(),
	renew: vi.fn(),
	start: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN: "copy-token",
		PRODUCT_ANALYTICS_TINYBIRD_HOST: "https://staging.tinybird.test",
		PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN: "read-token",
		PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN: "scheduler-token",
	}),
}));

vi.mock("@/lib/analytics/product-analytics-refresh-state", () => ({
	acquireProductAnalyticsRefreshLease: mocks.acquire,
	releaseProductAnalyticsRefreshLease: mocks.release,
	renewProductAnalyticsRefreshLease: mocks.renew,
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));

const markerPayload = {
	activation_markers: 1,
	attribution_markers: 1,
	decision_markers: 1,
	experiment_markers: 1,
	identity_markers: 1,
	retention_markers: 1,
	traffic_markers: 1,
	traffic_page_markers: 1,
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete process.env.CRON_SECRET;
	mocks.acquire.mockReset();
	mocks.release.mockReset();
	mocks.renew.mockReset();
	mocks.start.mockReset();
});

describe("product analytics refresh", () => {
	it("runs every decision copy sequentially at one source cutoff", async () => {
		const requestedUrls: URL[] = [];
		mocks.acquire.mockResolvedValue({
			ownerId: "refresh-owner-1",
			sourceCutoff: "2026-07-31T12:00:00.000Z",
		});
		mocks.renew.mockResolvedValue(true);
		mocks.release.mockResolvedValue(undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				requestedUrls.push(url);
				if (url.pathname.endsWith("/copy")) {
					return Response.json({
						job_id: `job-${requestedUrls.length.toString().padStart(4, "0")}`,
					});
				}
				if (url.pathname.startsWith("/v0/jobs/")) {
					return Response.json({ status: "done" });
				}
				return Response.json({ data: [markerPayload] });
			}),
		);

		const { refreshProductAnalyticsWorkflow } = await import(
			"@/workflows/refresh-product-analytics"
		);
		const result = await refreshProductAnalyticsWorkflow({
			scheduledAt: "2026-07-31T12:00:00.000Z",
		});

		expect(result).toMatchObject({
			refreshed: true,
			sourceCutoff: "2026-07-31T12:00:00.000Z",
		});
		expect(result.jobs).toHaveLength(8);
		expect(mocks.renew).toHaveBeenCalledTimes(8);
		expect(mocks.release).toHaveBeenCalledWith("refresh-owner-1", undefined);
		for (const request of requestedUrls.filter((url) =>
			url.pathname.startsWith("/v0/jobs/"),
		)) {
			expect(request.pathname).toMatch(/^\/v0\/jobs\/[A-Za-z0-9_-]+$/);
		}
		const copyUrls = requestedUrls.filter((url) =>
			url.pathname.endsWith("/copy"),
		);
		expect(copyUrls).toHaveLength(8);
		expect(
			copyUrls.map((url) => url.searchParams.get("source_cutoff")),
		).toEqual(Array.from({ length: 8 }, () => "2026-07-31 12:00:00.000"));
		expect(
			new Set(copyUrls.map((url) => url.searchParams.get("copy_run_id"))).size,
		).toBe(1);
	});

	it("records a failed lease state when a copy assertion is missing", async () => {
		mocks.acquire.mockResolvedValue({
			ownerId: "refresh-owner-2",
			sourceCutoff: "2026-07-31T12:00:00.000Z",
		});
		mocks.renew.mockResolvedValue(true);
		mocks.release.mockResolvedValue(undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.pathname.endsWith("/copy")) {
					return Response.json({ job_id: "job-missing-marker" });
				}
				if (url.pathname.startsWith("/v0/jobs/")) {
					return Response.json({ status: "done" });
				}
				return Response.json({ data: [{}] });
			}),
		);

		const { refreshProductAnalyticsWorkflow } = await import(
			"@/workflows/refresh-product-analytics"
		);
		await expect(
			refreshProductAnalyticsWorkflow({
				scheduledAt: "2026-07-31T12:00:00.000Z",
			}),
		).rejects.toThrow("refresh marker was missing");
		expect(mocks.release).toHaveBeenCalledWith(
			"refresh-owner-2",
			"refresh_failed",
		);
	});

	it("does not touch Tinybird when another refresh owns the lease", async () => {
		mocks.acquire.mockResolvedValue(undefined);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { refreshProductAnalyticsWorkflow } = await import(
			"@/workflows/refresh-product-analytics"
		);

		await expect(
			refreshProductAnalyticsWorkflow({
				scheduledAt: "2026-07-31T12:00:00.000Z",
			}),
		).resolves.toEqual({ refreshed: false, reason: "lease_unavailable" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(mocks.release).not.toHaveBeenCalled();
	});

	it("authenticates the cron before starting a durable workflow", async () => {
		process.env.CRON_SECRET = "refresh-secret";
		mocks.start.mockResolvedValue({ runId: "refresh-run-1" });
		const { GET } = await import(
			"@/app/api/cron/refresh-product-analytics/route"
		);
		const unauthorized = await GET(
			new Request("https://cap.test/api/cron/refresh-product-analytics"),
		);
		expect(unauthorized.status).toBe(401);

		const accepted = await GET(
			new Request("https://cap.test/api/cron/refresh-product-analytics", {
				headers: { authorization: "Bearer refresh-secret" },
			}),
		);
		expect(accepted.status).toBe(200);
		expect(await accepted.json()).toEqual({
			accepted: true,
			runId: "refresh-run-1",
		});
		expect(mocks.start).toHaveBeenCalledOnce();
	});
});
