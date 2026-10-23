import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChartArea from "@/app/(org)/dashboard/analytics/components/ChartArea";

vi.mock("recharts", () => ({
	AreaChart: ({ data }: { data: Array<{ label: string; views: number }> }) =>
		createElement(
			"div",
			null,
			data.map((point) =>
				createElement(
					"span",
					{ key: point.label },
					`${point.label}: ${point.views}`,
				),
			),
		),
	Area: () => null,
	CartesianGrid: () => null,
	XAxis: () => null,
	YAxis: () => null,
}));

vi.mock("@/components/ui/chart", () => ({
	ChartContainer: ({ children }: { children: ReactNode }) => children,
	ChartTooltip: () => null,
	ChartTooltipContent: () => null,
}));

const renderChart = (buckets: string[]) =>
	renderToStaticMarkup(
		createElement(ChartArea, {
			selectedMetrics: ["views"],
			data: buckets.map((bucket, index) => ({
				bucket,
				views: index + 1,
				caps: 0,
				comments: 0,
				reactions: 0,
			})),
		}),
	);

describe.each(["America/Los_Angeles", "Asia/Kolkata", "UTC"])(
	"analytics chart dates in %s",
	(timeZone) => {
		beforeEach(() => vi.stubEnv("TZ", timeZone));
		afterEach(() => vi.unstubAllEnvs());
		it.each([
			["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
			["2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z"],
			["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"],
		])("labels UTC daily buckets on their actual date: %s", (...buckets) => {
			const chart = renderChart(buckets);
			for (const [index, bucket] of buckets.entries()) {
				const label = new Date(bucket).toLocaleDateString([], {
					month: "short",
					day: "numeric",
					timeZone: "UTC",
				});
				expect(chart).toContain(`${label}: ${index + 1}`);
			}
		});

		it("keeps hourly labels in the viewer's local time", () => {
			const buckets = ["2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"];
			const chart = renderChart(buckets);
			for (const [index, bucket] of buckets.entries()) {
				const label = new Date(bucket).toLocaleTimeString([], {
					hour: "numeric",
				});
				expect(chart).toContain(`${label}: ${index + 1}`);
			}
		});

		it("shows the empty state when there are no buckets", () => {
			expect(renderChart([])).toContain("No analytics data yet.");
		});
	},
);
