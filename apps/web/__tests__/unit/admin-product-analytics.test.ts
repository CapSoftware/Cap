import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	AdminAnalyticsConfigurationError,
	AdminAnalyticsRequestError,
	assertAdminAnalyticsDateRange,
	buildAdminAnalyticsEndpointUrl,
	calculateHealthWindowStart,
	decodeAnalyticsFreshnessResponse,
	decodeProductEventsResponse,
	decodeTrafficOverviewResponse,
	fetchOptionalRollbackEndpoint,
} from "@/app/admin/analytics/tinybird";

describe("admin analytics Tinybird client", () => {
	it("builds an allowlisted endpoint query and omits unset filters", () => {
		const url = buildAdminAnalyticsEndpointUrl(
			"https://api.tinybird.co/",
			"product_events_daily",
			{
				start_date: "2026-07-01",
				end_date: "2026-07-31",
				platform: "desktop",
				app_version: undefined,
				source: "",
				limit: 1000,
			},
		);

		expect(url.origin).toBe("https://api.tinybird.co");
		expect(url.pathname).toBe("/v0/pipes/product_events_daily.json");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			start_date: "2026-07-01",
			end_date: "2026-07-31",
			platform: "desktop",
			limit: "1000",
		});
	});

	it("rejects a malformed Tinybird host without including credentials", () => {
		expect(() =>
			buildAdminAnalyticsEndpointUrl(
				"not a URL",
				"product_traffic_overview",
				{},
			),
		).toThrow(AdminAnalyticsConfigurationError);
	});

	it("caps the inclusive health query to less than 31 days", () => {
		expect(calculateHealthWindowStart("2026-01-01", "2026-07-31")).toBe(
			"2026-07-01",
		);
		expect(calculateHealthWindowStart("2026-07-20", "2026-07-31")).toBe(
			"2026-07-20",
		);
	});

	it("allows two year-over-year windows but rejects dates beyond retention", () => {
		expect(() =>
			assertAdminAnalyticsDateRange("2024-06-01", "2026-07-31"),
		).not.toThrow();
		expect(() =>
			assertAdminAnalyticsDateRange("2024-05-01", "2026-07-31"),
		).toThrow("no longer than 800 UTC days");
	});

	it("degrades only a missing rollback-era optional endpoint", async () => {
		const missing = async () => {
			throw new AdminAnalyticsRequestError("missing", 404);
		};
		await expect(
			fetchOptionalRollbackEndpoint(
				missing,
				"product_identity_funnel",
				{},
				() => ({ linkedUsers: 1 }),
			),
		).resolves.toEqual({ available: false, rows: [] });

		const unavailable = async () => {
			throw new AdminAnalyticsRequestError("unavailable", 503);
		};
		await expect(
			fetchOptionalRollbackEndpoint(
				unavailable,
				"product_identity_funnel",
				{},
				() => ({ linkedUsers: 1 }),
			),
		).rejects.toMatchObject({ status: 503 });
	});

	it("decodes the retained aggregate schema during rollback", () => {
		expect(
			decodeProductEventsResponse({
				data: [
					{
						date: "2026-07-31",
						event_name: "purchase_completed",
						source: "server",
						platform: "web",
						app_version: "web",
						hostname: "cap.so",
						country: "GB",
						device: "desktop",
						browser: "Chrome",
						os: "macOS",
						channel: "direct",
						plan_id: "price_pro",
						payment_status: "paid",
						subscription_status: "active",
						currency: "GBP",
						billing_interval: "month",
						events: 1,
						actors: 1,
						users: 1,
						organizations: 1,
						revenue_minor: 2_500,
					},
				],
			}),
		).toMatchObject([{ changeKind: "", revenueMinor: 2_500 }]);
		expect(
			decodeAnalyticsFreshnessResponse({
				data: [
					{
						latest_received_hour: "2026-07-31 10:00:00",
						health_freshness_ms: 1_000,
						product_calculated_at: "2026-07-31 10:01:00",
						traffic_calculated_at: "2026-07-31 10:01:00",
						retention_calculated_at: "2026-07-31 10:01:00",
					},
				],
			}),
		).toMatchObject([{ identityCalculatedAt: "" }]);
	});

	it("decodes numeric Tinybird values without accepting malformed rows", () => {
		expect(
			decodeTrafficOverviewResponse({
				data: [
					{
						date: "2026-07-31",
						visitors: "12",
						visits: 14,
						pageviews: "28",
						views_per_visit: 2,
						bounce_rate: "25.5",
						visit_duration_ms: 60_000,
						engaged_ms: "120000",
					},
				],
			}),
		).toEqual([
			{
				date: "2026-07-31",
				visitors: 12,
				visits: 14,
				pageviews: 28,
				viewsPerVisit: 2,
				bounceRate: 25.5,
				visitDurationMs: 60_000,
				engagedMs: 120_000,
			},
		]);

		expect(() =>
			decodeTrafficOverviewResponse({ data: [{ date: 42 }] }),
		).toThrow(AdminAnalyticsRequestError);
		expect(() => decodeTrafficOverviewResponse({ rows: [] })).toThrow(
			AdminAnalyticsRequestError,
		);
	});
});
