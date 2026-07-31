import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	AdminAnalyticsConfigurationError,
	AdminAnalyticsRequestError,
	buildAdminAnalyticsEndpointUrl,
	calculateHealthWindowStart,
	decodeTrafficOverviewResponse,
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
