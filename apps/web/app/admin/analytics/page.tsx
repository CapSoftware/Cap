import { buildEnv } from "@cap/env";
import { notFound } from "next/navigation";
import { getViewerContext } from "@/lib/messenger/data";
import {
	AdminAnalyticsConfigurationError,
	type AdminAnalyticsDashboard,
	type AdminAnalyticsFilters,
	AdminAnalyticsRequestError,
	fetchAdminAnalyticsDashboard,
} from "./tinybird";

type SearchParams = Record<string, string | string[] | undefined>;

type MetricCardProps = {
	label: string;
	value: string;
	detail?: string;
};

const integerFormat = new Intl.NumberFormat("en-GB", {
	maximumFractionDigits: 0,
});

const decimalFormat = new Intl.NumberFormat("en-GB", {
	maximumFractionDigits: 2,
});

function MetricCard({ label, value, detail }: MetricCardProps) {
	return (
		<div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
			<p className="text-xs font-medium uppercase tracking-wide text-gray-500">
				{label}
			</p>
			<p className="mt-2 text-2xl font-semibold tabular-nums text-gray-950">
				{value}
			</p>
			{detail ? <p className="mt-1 text-xs text-gray-500">{detail}</p> : null}
		</div>
	);
}

function Section({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-gray-950">{title}</h2>
				{description ? (
					<p className="mt-1 text-sm text-gray-600">{description}</p>
				) : null}
			</div>
			{children}
		</section>
	);
}

function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-600">
			{children}
		</div>
	);
}

function formatInteger(value: number): string {
	return integerFormat.format(value);
}

function formatDecimal(value: number): string {
	return decimalFormat.format(value);
}

function formatPercent(value: number): string {
	return `${formatDecimal(value)}%`;
}

function formatDuration(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0s";
	const seconds = Math.round(milliseconds / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatTimestamp(value: string): string {
	const timestamp = new Date(value);
	if (Number.isNaN(timestamp.getTime())) return "Unavailable";
	return timestamp.toLocaleString("en-GB", {
		timeZone: "UTC",
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function sumBy<T>(items: T[], readValue: (item: T) => number): number {
	return items.reduce((sum, item) => sum + readValue(item), 0);
}

function firstParam(params: SearchParams, key: string): string | undefined {
	const value = params[key];
	return Array.isArray(value) ? value[0] : value;
}

function isDate(value: string | undefined): value is string {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}

function defaultDateRange(): Pick<
	AdminAnalyticsFilters,
	"startDate" | "endDate"
> {
	const today = new Date();
	const endDate = today.toISOString().slice(0, 10);
	today.setUTCDate(today.getUTCDate() - 29);
	return { startDate: today.toISOString().slice(0, 10), endDate };
}

function optionalFilter(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized.slice(0, 100) : undefined;
}

function parseFilters(params: SearchParams): AdminAnalyticsFilters {
	const defaults = defaultDateRange();
	let startDate = firstParam(params, "start");
	let endDate = firstParam(params, "end");
	startDate = isDate(startDate) ? startDate : defaults.startDate;
	endDate = isDate(endDate) ? endDate : defaults.endDate;
	if (startDate > endDate) [startDate, endDate] = [endDate, startDate];

	return {
		startDate,
		endDate,
		platform: optionalFilter(firstParam(params, "platform")),
		appVersion: optionalFilter(firstParam(params, "appVersion")),
		source: optionalFilter(firstParam(params, "source")),
		country: optionalFilter(firstParam(params, "country"))?.toUpperCase(),
		plan: optionalFilter(firstParam(params, "plan")),
		organizationCohort: isDate(firstParam(params, "organizationCohort"))
			? firstParam(params, "organizationCohort")
			: undefined,
	};
}

function trafficTotals(data: AdminAnalyticsDashboard) {
	const visitorDays = sumBy(data.trafficOverview, (row) => row.visitors);
	const visits = sumBy(data.trafficOverview, (row) => row.visits);
	const pageviews = sumBy(data.trafficOverview, (row) => row.pageviews);
	const weightedBounces = sumBy(
		data.trafficOverview,
		(row) => row.bounceRate * row.visits,
	);
	const weightedDuration = sumBy(
		data.trafficOverview,
		(row) => row.visitDurationMs * row.visits,
	);
	const latestDay = data.trafficOverview.at(-1);
	return {
		visitorDays,
		visits,
		pageviews,
		viewsPerVisit: visits === 0 ? 0 : pageviews / visits,
		bounceRate: visits === 0 ? 0 : weightedBounces / visits,
		visitDurationMs: visits === 0 ? 0 : weightedDuration / visits,
		latestDay,
	};
}

function activationTotals(data: AdminAnalyticsDashboard) {
	const signups = sumBy(data.activation, (row) => row.signups);
	const activatedCreators = sumBy(
		data.activation,
		(row) => row.activatedCreators,
	);
	const weightedTime = sumBy(
		data.activation,
		(row) => row.averageTimeToActivationMs * row.activatedCreators,
	);
	return {
		signups,
		activatedCreators,
		activationRate: signups === 0 ? 0 : (100 * activatedCreators) / signups,
		averageTimeToActivationMs:
			activatedCreators === 0 ? 0 : weightedTime / activatedCreators,
	};
}

function eventCount(data: AdminAnalyticsDashboard, eventName: string): number {
	return sumBy(
		data.productEvents.filter((row) => row.eventName === eventName),
		(row) => row.events,
	);
}

function eventValue(
	data: AdminAnalyticsDashboard,
	eventName: string,
	field: "attemptCount" | "seatDelta",
): number {
	return sumBy(
		data.productEvents.filter((row) => row.eventName === eventName),
		(row) => row[field] * row.events,
	);
}

function eventMaxValue(
	data: AdminAnalyticsDashboard,
	eventName: string,
	field: "attemptCount",
): number {
	return Math.max(
		0,
		...data.productEvents
			.filter((row) => row.eventName === eventName)
			.map((row) => row[field]),
	);
}

function eventCountWhere(
	data: AdminAnalyticsDashboard,
	eventName: string,
	predicate: (row: AdminAnalyticsDashboard["productEvents"][number]) => boolean,
): number {
	return sumBy(
		data.productEvents.filter(
			(row) => row.eventName === eventName && predicate(row),
		),
		(row) => row.events,
	);
}

function retentionRate(
	data: AdminAnalyticsDashboard,
	cohortDay: number,
	endDate: string,
	metric: "creators" | "organizations" = "creators",
): number | undefined {
	const end = new Date(`${endDate}T00:00:00.000Z`);
	const eligibleCohorts = new Set(
		data.creatorRetention
			.filter((row) => {
				const cohort = new Date(`${row.cohortDate}T00:00:00.000Z`);
				return end.getTime() - cohort.getTime() >= cohortDay * 86_400_000;
			})
			.map((row) => `${row.cohortDate}:${row.platform}`),
	);
	const dayZero = sumBy(
		data.creatorRetention.filter(
			(row) =>
				row.cohortDay === 0 &&
				eligibleCohorts.has(`${row.cohortDate}:${row.platform}`),
		),
		(row) => row[metric],
	);
	if (dayZero === 0) return undefined;
	const retained = sumBy(
		data.creatorRetention.filter(
			(row) =>
				row.cohortDay === cohortDay &&
				eligibleCohorts.has(`${row.cohortDate}:${row.platform}`),
		),
		(row) => row[metric],
	);
	return (100 * retained) / dayZero;
}

function revenueTotals(data: AdminAnalyticsDashboard): Array<[string, number]> {
	const totals = new Map<string, number>();
	for (const row of data.productEvents) {
		if (!row.currency || row.revenueMinor === 0) continue;
		totals.set(
			row.currency,
			(totals.get(row.currency) ?? 0) + row.revenueMinor,
		);
	}
	return [...totals.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	);
}

function featureAdoptionRows(data: AdminAnalyticsDashboard) {
	return data.featureAdoption;
}

function qualityStatus(data: AdminAnalyticsDashboard) {
	const freshness = data.freshness[0];
	const health = data.health[0];
	if (!freshness || !health) {
		return {
			label: "Unavailable",
			className: "bg-amber-100 text-amber-800",
		};
	}
	if (
		freshness.healthFreshnessMs > 7_200_000 ||
		health.payloadConflicts > 0 ||
		health.missingIdentityEvents > 0
	) {
		return {
			label: "Attention required",
			className: "bg-red-100 text-red-800",
		};
	}
	return { label: "Healthy", className: "bg-emerald-100 text-emerald-800" };
}

function AnalyticsFilters({ filters }: { filters: AdminAnalyticsFilters }) {
	const fieldClassName =
		"mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
	return (
		<form
			className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7"
			method="get"
		>
			<label className="text-xs font-medium text-gray-600">
				Start date
				<input
					className={fieldClassName}
					defaultValue={filters.startDate}
					name="start"
					type="date"
				/>
			</label>
			<label className="text-xs font-medium text-gray-600">
				End date
				<input
					className={fieldClassName}
					defaultValue={filters.endDate}
					name="end"
					type="date"
				/>
			</label>
			<label className="text-xs font-medium text-gray-600">
				Platform
				<select
					className={fieldClassName}
					defaultValue={filters.platform ?? ""}
					name="platform"
				>
					<option value="">All platforms</option>
					<option value="web">Web</option>
					<option value="desktop">Desktop</option>
					<option value="mobile">Mobile</option>
					<option value="cli">CLI</option>
					<option value="server">Server</option>
				</select>
			</label>
			<label className="text-xs font-medium text-gray-600">
				App version
				<input
					className={fieldClassName}
					defaultValue={filters.appVersion ?? ""}
					name="appVersion"
					placeholder="All versions"
				/>
			</label>
			<label className="text-xs font-medium text-gray-600">
				Source
				<input
					className={fieldClassName}
					defaultValue={filters.source ?? ""}
					name="source"
					placeholder="All sources"
				/>
			</label>
			<label className="text-xs font-medium text-gray-600">
				Country
				<input
					className={fieldClassName}
					defaultValue={filters.country ?? ""}
					maxLength={2}
					name="country"
					placeholder="All countries"
				/>
			</label>
			<label className="text-xs font-medium text-gray-600">
				Plan
				<input
					className={fieldClassName}
					defaultValue={filters.plan ?? ""}
					name="plan"
					placeholder="All plans"
				/>
			</label>
			<label className="text-xs font-medium text-gray-600">
				Organization cohort
				<input
					className={fieldClassName}
					defaultValue={filters.organizationCohort ?? ""}
					name="organizationCohort"
					type="date"
				/>
			</label>
			<div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4 xl:col-span-6">
				<button
					className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
					type="submit"
				>
					Apply filters
				</button>
				<a
					className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
					href="/admin/analytics"
				>
					Reset
				</a>
			</div>
			<p className="self-end text-xs text-gray-500">
				Platform and app version affect product, retention, and health. Source,
				plan, and country affect endpoints that expose those dimensions.
				Organization cohort selects one first-value UTC date for the retention
				view.
			</p>
		</form>
	);
}

function AnalyticsError({ error }: { error: unknown }) {
	const message =
		error instanceof AdminAnalyticsConfigurationError ||
		error instanceof AdminAnalyticsRequestError
			? error.message
			: "Admin analytics could not be loaded.";
	return (
		<div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-900">
			<p className="font-semibold">Analytics unavailable</p>
			<p className="mt-1">{message}</p>
		</div>
	);
}

function TrafficSection({ data }: { data: AdminAnalyticsDashboard }) {
	const totals = trafficTotals(data);
	return (
		<Section
			description="Privacy-safe, deduplicated traffic aggregates. Visitor-days are daily uniques summed across the selected range."
			title="Website traffic"
		>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
				<MetricCard
					label="Visitor-days"
					value={formatInteger(totals.visitorDays)}
				/>
				<MetricCard label="Visits" value={formatInteger(totals.visits)} />
				<MetricCard label="Pageviews" value={formatInteger(totals.pageviews)} />
				<MetricCard
					label="Views per visit"
					value={formatDecimal(totals.viewsPerVisit)}
				/>
				<MetricCard
					label="Bounce rate"
					value={formatPercent(totals.bounceRate)}
				/>
				<MetricCard
					label="Average visit"
					value={formatDuration(totals.visitDurationMs)}
				/>
				<MetricCard
					detail={totals.latestDay?.date ?? "No recent day"}
					label="Latest-day visitors"
					value={formatInteger(totals.latestDay?.visitors ?? 0)}
				/>
			</div>
			<p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
				A current-online visitor count is intentionally not shown: the aggregate
				API does not yet provide a reliable live-presence metric.
			</p>
		</Section>
	);
}

function PagesSection({ data }: { data: AdminAnalyticsDashboard }) {
	if (data.trafficPages.length === 0) {
		return (
			<Section title="Pages, landings, and exits">
				<EmptyState>No page aggregates in this range.</EmptyState>
			</Section>
		);
	}
	return (
		<Section title="Pages, landings, and exits">
			<div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
				<table className="min-w-full divide-y divide-gray-200 text-sm">
					<thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
						<tr>
							<th className="px-4 py-3 font-medium">Path</th>
							<th className="px-4 py-3 text-right font-medium">Visitors</th>
							<th className="px-4 py-3 text-right font-medium">Views</th>
							<th className="px-4 py-3 text-right font-medium">Landings</th>
							<th className="px-4 py-3 text-right font-medium">Exits</th>
							<th className="px-4 py-3 text-right font-medium">Time</th>
							<th className="px-4 py-3 text-right font-medium">Scroll</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-gray-100">
						{data.trafficPages.slice(0, 25).map((row) => (
							<tr key={row.pathname}>
								<td className="max-w-sm truncate px-4 py-3 font-medium text-gray-900">
									{row.pathname}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatInteger(row.visitors)}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatInteger(row.pageviews)}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatInteger(row.landings)}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatInteger(row.exits)}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatDuration(row.timeOnPageMs)}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatPercent(row.averageScrollDepth)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Section>
	);
}

function AcquisitionSection({ data }: { data: AdminAnalyticsDashboard }) {
	return (
		<Section
			description="Server-normalized acquisition, geography, and technology dimensions without raw IP addresses or user agents."
			title="Acquisition and audience"
		>
			<div className="grid gap-4 xl:grid-cols-3">
				<div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
					<h3 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold">
						Sources and campaigns
					</h3>
					<table className="min-w-full text-sm">
						<tbody className="divide-y divide-gray-100">
							{data.trafficSources.slice(0, 15).map((row, index) => (
								<tr
									key={`${row.channel}:${row.source}:${row.campaign}:${index}`}
								>
									<td className="px-4 py-3">
										<p className="font-medium text-gray-900">
											{row.source || "Direct"}
										</p>
										<p className="text-xs text-gray-500">
											{[row.channel, row.medium, row.campaign]
												.filter(Boolean)
												.join(" · ") || "Unattributed"}
										</p>
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{formatInteger(row.visits)} visits
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
					<h3 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold">
						Countries
					</h3>
					<table className="min-w-full text-sm">
						<tbody className="divide-y divide-gray-100">
							{data.trafficCountries.slice(0, 15).map((row) => (
								<tr key={row.country}>
									<td className="px-4 py-3 font-medium text-gray-900">
										{row.country || "Unknown"}
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{formatInteger(row.visits)} visits
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
					<h3 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold">
						Technology
					</h3>
					<table className="min-w-full text-sm">
						<tbody className="divide-y divide-gray-100">
							{data.trafficTechnology.slice(0, 15).map((row, index) => (
								<tr key={`${row.device}:${row.browser}:${row.os}:${index}`}>
									<td className="px-4 py-3">
										<p className="font-medium text-gray-900">
											{row.device || "Unknown device"}
										</p>
										<p className="text-xs text-gray-500">
											{[row.browser, row.os].filter(Boolean).join(" · ") ||
												"Unknown"}
										</p>
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{formatInteger(row.visits)} visits
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</Section>
	);
}

function ProductSection({
	data,
	filters,
}: {
	data: AdminAnalyticsDashboard;
	filters: AdminAnalyticsFilters;
}) {
	const activation = activationTotals(data);
	const activity = data.creatorActivity[0];
	const d1 = retentionRate(data, 1, filters.endDate);
	const d7 = retentionRate(data, 7, filters.endDate);
	const d30 = retentionRate(data, 30, filters.endDate);
	const organizationD1 = retentionRate(
		data,
		1,
		filters.endDate,
		"organizations",
	);
	const organizationD7 = retentionRate(
		data,
		7,
		filters.endDate,
		"organizations",
	);
	const organizationD30 = retentionRate(
		data,
		30,
		filters.endDate,
		"organizations",
	);
	const features = featureAdoptionRows(data);
	return (
		<Section
			description="Activation is the first successful share link within seven UTC days of signup. Active creators performed a creator-value event in the measured period."
			title="Activation, engagement, and retention"
		>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<MetricCard label="Signups" value={formatInteger(activation.signups)} />
				<MetricCard
					label="Activated creators"
					value={formatInteger(activation.activatedCreators)}
				/>
				<MetricCard
					label="Activation rate"
					value={formatPercent(activation.activationRate)}
				/>
				<MetricCard
					label="Time to activation"
					value={formatDuration(activation.averageTimeToActivationMs)}
				/>
				<MetricCard label="DAU" value={formatInteger(activity?.dau ?? 0)} />
				<MetricCard label="WAU" value={formatInteger(activity?.wau ?? 0)} />
				<MetricCard label="MAU" value={formatInteger(activity?.mau ?? 0)} />
				<MetricCard
					label="Active organizations"
					value={formatInteger(activity?.dailyActiveOrganizations ?? 0)}
				/>
				<MetricCard
					label="New creators"
					value={formatInteger(activity?.newCreators ?? 0)}
				/>
				<MetricCard
					label="Returning creators"
					value={formatInteger(activity?.returningCreators ?? 0)}
				/>
				<MetricCard
					label="DAU / WAU"
					value={formatPercent(activity?.dauWauStickiness ?? 0)}
				/>
				<MetricCard
					label="DAU / MAU"
					value={formatPercent(activity?.dauMauStickiness ?? 0)}
				/>
				<MetricCard
					label="D1 retention"
					value={d1 === undefined ? "Unavailable" : formatPercent(d1)}
				/>
				<MetricCard
					label="D7 retention"
					value={d7 === undefined ? "Unavailable" : formatPercent(d7)}
				/>
				<MetricCard
					label="D30 retention"
					value={d30 === undefined ? "Unavailable" : formatPercent(d30)}
				/>
				<MetricCard
					label="Organization D1 retention"
					value={
						organizationD1 === undefined
							? "Unavailable"
							: formatPercent(organizationD1)
					}
				/>
				<MetricCard
					label="Organization D7 retention"
					value={
						organizationD7 === undefined
							? "Unavailable"
							: formatPercent(organizationD7)
					}
				/>
				<MetricCard
					label="Organization D30 retention"
					value={
						organizationD30 === undefined
							? "Unavailable"
							: formatPercent(organizationD30)
					}
				/>
			</div>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<MetricCard
					label="Recordings completed"
					value={formatInteger(eventCount(data, "recording_completed"))}
				/>
				<MetricCard
					label="Uploads completed"
					value={formatInteger(eventCount(data, "multipart_upload_complete"))}
				/>
				<MetricCard
					label="Share links created"
					value={formatInteger(eventCount(data, "share_link_created"))}
				/>
				<MetricCard
					label="First external views"
					value={formatInteger(eventCount(data, "first_view_received"))}
				/>
			</div>
			<div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
				<div className="border-b border-gray-200 px-4 py-3">
					<h3 className="text-sm font-semibold text-gray-950">
						Feature adoption
					</h3>
					<p className="mt-1 text-xs text-gray-500">
						Adopter counts are daily uniques summed across the range, so they
						are actor-days rather than period-unique people.
					</p>
				</div>
				<table className="min-w-full divide-y divide-gray-200 text-sm">
					<thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
						<tr>
							<th className="px-4 py-3 font-medium">Event</th>
							<th className="px-4 py-3 text-right font-medium">Events</th>
							<th className="px-4 py-3 text-right font-medium">Actor-days</th>
							<th className="px-4 py-3 text-right font-medium">User-days</th>
							<th className="px-4 py-3 text-right font-medium">
								Organization-days
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-gray-100">
						{features.slice(0, 40).map((row) => (
							<tr key={row.eventName}>
								<td className="px-4 py-3 font-medium text-gray-900">
									{row.eventName}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatInteger(row.events)}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatInteger(row.actorDays)}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatInteger(row.userDays)}
								</td>
								<td className="px-4 py-3 text-right tabular-nums">
									{formatInteger(row.organizationDays)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Section>
	);
}

function RevenueSection({ data }: { data: AdminAnalyticsDashboard }) {
	const revenue = revenueTotals(data);
	return (
		<Section
			description="Business outcomes are server-authoritative. Revenue remains in currency-specific minor units to avoid unsafe currency conversion."
			title="Checkout and revenue"
		>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<MetricCard
					label="Checkout started"
					value={formatInteger(
						eventCount(data, "checkout_started") +
							eventCount(data, "guest_checkout_started"),
					)}
				/>
				<MetricCard
					label="Trials started"
					value={formatInteger(eventCount(data, "trial_started"))}
				/>
				<MetricCard
					label="Purchases"
					value={formatInteger(eventCount(data, "purchase_completed"))}
				/>
				<MetricCard
					label="First purchases"
					value={formatInteger(
						eventCountWhere(
							data,
							"purchase_completed",
							(row) => row.firstPurchase === "true",
						),
					)}
				/>
				<MetricCard
					label="Renewals"
					value={formatInteger(eventCount(data, "subscription_renewed"))}
				/>
				<MetricCard
					label="Trial conversions"
					value={formatInteger(eventCount(data, "trial_converted"))}
				/>
				<MetricCard
					label="Plan or seat changes"
					value={formatInteger(
						eventCountWhere(
							data,
							"subscription_changed",
							(row) => row.changeKind === "plan" || row.changeKind === "seats",
						),
					)}
				/>
				<MetricCard
					label="Net seat change"
					value={formatInteger(
						eventValue(data, "subscription_changed", "seatDelta"),
					)}
				/>
				<MetricCard
					label="Scheduled cancellations"
					value={formatInteger(
						eventCountWhere(
							data,
							"subscription_changed",
							(row) => row.changeKind === "cancellation_scheduled",
						),
					)}
				/>
				<MetricCard
					label="Cancellations"
					value={formatInteger(eventCount(data, "subscription_cancelled"))}
				/>
				<MetricCard
					label="Refunds"
					value={formatInteger(eventCount(data, "subscription_refunded"))}
				/>
				<MetricCard
					label="Full refunds"
					value={formatInteger(
						eventCountWhere(
							data,
							"subscription_refunded",
							(row) => row.fullyRefunded === "true",
						),
					)}
				/>
				<MetricCard
					label="Payment failures"
					value={formatInteger(eventCount(data, "subscription_payment_failed"))}
				/>
				<MetricCard
					label="Highest collection attempt"
					value={formatInteger(
						eventMaxValue(data, "subscription_payment_failed", "attemptCount"),
					)}
				/>
				{revenue.map(([currency, minorUnits]) => (
					<MetricCard
						detail="Exact tracked minor units; no FX conversion"
						key={currency}
						label={`${currency} revenue`}
						value={formatInteger(minorUnits)}
					/>
				))}
			</div>
		</Section>
	);
}

function ExperimentationSection({ data }: { data: AdminAnalyticsDashboard }) {
	const exposures = new Map<
		string,
		{
			experimentId: string;
			variant: string;
			assignmentVersion: string;
			exposures: number;
			actorDays: number;
			userDays: number;
		}
	>();
	for (const row of data.productEvents) {
		if (row.eventName !== "experiment_exposed" || !row.experimentId) continue;
		const key = [
			row.experimentId,
			row.experimentVariant,
			row.assignmentVersion,
		].join("\u0000");
		const current = exposures.get(key) ?? {
			experimentId: row.experimentId,
			variant: row.experimentVariant,
			assignmentVersion: row.assignmentVersion,
			exposures: 0,
			actorDays: 0,
			userDays: 0,
		};
		current.exposures += row.events;
		current.actorDays += row.actors;
		current.userDays += row.users;
		exposures.set(key, current);
	}
	const rows = [...exposures.values()].sort(
		(left, right) =>
			left.experimentId.localeCompare(right.experimentId) ||
			left.assignmentVersion.localeCompare(right.assignmentVersion) ||
			left.variant.localeCompare(right.variant),
	);

	return (
		<Section
			description="Exposure is recorded when a stable assignment is rendered. Counts never infer assignment from a later conversion; actor-day and user-day totals are additive daily uniques, not selected-range unique people."
			title="Experiments"
		>
			{rows.length === 0 ? (
				<EmptyState>No experiment exposures in this period.</EmptyState>
			) : (
				<div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
					<table className="min-w-full divide-y divide-gray-200 text-sm">
						<thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
							<tr>
								<th className="px-4 py-3 font-medium">Experiment</th>
								<th className="px-4 py-3 font-medium">Version</th>
								<th className="px-4 py-3 font-medium">Variant</th>
								<th className="px-4 py-3 text-right font-medium">Exposures</th>
								<th className="px-4 py-3 text-right font-medium">Actor-days</th>
								<th className="px-4 py-3 text-right font-medium">User-days</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-100">
							{rows.map((row) => (
								<tr
									key={`${row.experimentId}:${row.assignmentVersion}:${row.variant}`}
								>
									<td className="px-4 py-3 font-medium text-gray-950">
										{row.experimentId}
									</td>
									<td className="px-4 py-3 text-gray-600">
										{row.assignmentVersion}
									</td>
									<td className="px-4 py-3 text-gray-600">{row.variant}</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{formatInteger(row.exposures)}
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{formatInteger(row.actorDays)}
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{formatInteger(row.userDays)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Section>
	);
}

function IdentityFunnelSection({ data }: { data: AdminAnalyticsDashboard }) {
	if (!data.identityFunnelAvailable) {
		return (
			<Section
				description="The current Tinybird rollback target predates privacy-safe identity cohorts. Traffic and product metrics remain available."
				title="Acquisition to paid conversion"
			>
				<EmptyState>
					Identity funnel metrics are unavailable on this deployment.
				</EmptyState>
			</Section>
		);
	}
	if (data.identityFunnel.length === 0) {
		return (
			<Section
				description="No privacy-safe identity cohorts match the selected filters."
				title="Acquisition to paid conversion"
			>
				<EmptyState>No identity funnel activity in this period.</EmptyState>
			</Section>
		);
	}
	const total = (field: keyof (typeof data.identityFunnel)[number]) =>
		data.identityFunnel.reduce((sum, row) => {
			const value = row[field];
			return sum + (typeof value === "number" ? value : 0);
		}, 0);
	return (
		<Section
			description="Privacy-safe cohorts join the pre-auth anonymous acquisition touch to authoritative user outcomes. No identity mapping is returned to this page."
			title="Acquisition to paid conversion"
		>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<MetricCard
					label="Linked visitors"
					value={formatInteger(total("linkedVisitors"))}
				/>
				<MetricCard
					label="Linked users"
					value={formatInteger(total("linkedUsers"))}
				/>
				<MetricCard
					label="Signed-up users"
					value={formatInteger(total("signupUsers"))}
				/>
				<MetricCard
					label="Authenticated checkout users"
					value={formatInteger(total("authenticatedCheckoutUsers"))}
				/>
				<MetricCard
					label="Guest checkout visitors"
					value={formatInteger(total("guestCheckoutVisitors"))}
				/>
				<MetricCard
					label="Guest purchasers"
					value={formatInteger(total("guestPurchasers"))}
				/>
				<MetricCard
					label="Cross-device checkout users"
					value={formatInteger(total("crossDeviceCheckoutUsers"))}
				/>
				<MetricCard
					label="Purchasers"
					value={formatInteger(total("purchasers"))}
				/>
			</div>
		</Section>
	);
}

function QualitySection({ data }: { data: AdminAnalyticsDashboard }) {
	const freshness = data.freshness[0];
	const health = data.health[0];
	const status = qualityStatus(data);
	const lag = health?.ingestionLagMs ?? [];
	const reportedDeliveryLosses = sumBy(
		data.productEvents,
		(row) => row.deliveryLossCount,
	);
	return (
		<Section
			description={`Delivery quality covers ${data.healthWindowStart} through the selected end date and is capped at 31 days.`}
			title="Freshness and data quality"
		>
			<div className="flex items-center gap-3">
				<span
					className={`rounded-full px-3 py-1 text-xs font-semibold ${status.className}`}
				>
					{status.label}
				</span>
				<p className="text-xs text-gray-500">
					Fresh means health aggregates are no more than two hours old.
				</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<MetricCard
					label="Received rows"
					value={formatInteger(health?.receivedRows ?? 0)}
				/>
				<MetricCard
					label="Unique events"
					value={formatInteger(health?.uniqueEvents ?? 0)}
				/>
				<MetricCard
					label="Duplicate rows"
					value={formatInteger(health?.duplicateRows ?? 0)}
				/>
				<MetricCard
					label="Payload conflicts"
					value={formatInteger(health?.payloadConflicts ?? 0)}
				/>
				<MetricCard
					label="Missing identity"
					value={formatInteger(health?.missingIdentityEvents ?? 0)}
				/>
				<MetricCard
					label="Late events"
					value={formatInteger(health?.lateEvents ?? 0)}
				/>
				<MetricCard
					label="Future-clock events"
					value={formatInteger(health?.futureEvents ?? 0)}
				/>
				<MetricCard
					detail="Deduplicated durable client loss summaries"
					label="Reported delivery losses"
					value={formatInteger(reportedDeliveryLosses)}
				/>
				<MetricCard label="Ingestion p50" value={formatDuration(lag[0] ?? 0)} />
				<MetricCard label="Ingestion p95" value={formatDuration(lag[1] ?? 0)} />
				<MetricCard label="Ingestion p99" value={formatDuration(lag[2] ?? 0)} />
				<MetricCard
					detail={formatTimestamp(freshness?.latestReceivedHour ?? "")}
					label="Latest received hour"
					value={
						freshness
							? `${formatDuration(freshness.healthFreshnessMs)} ago`
							: "Unavailable"
					}
				/>
				<MetricCard
					detail="UTC"
					label="Traffic calculated"
					value={formatTimestamp(freshness?.trafficCalculatedAt ?? "")}
				/>
				<MetricCard
					detail="UTC"
					label="Product calculated"
					value={formatTimestamp(freshness?.productCalculatedAt ?? "")}
				/>
				<MetricCard
					detail="UTC"
					label="Retention calculated"
					value={formatTimestamp(freshness?.retentionCalculatedAt ?? "")}
				/>
				<MetricCard
					detail="UTC"
					label="Identity funnel calculated"
					value={formatTimestamp(freshness?.identityCalculatedAt ?? "")}
				/>
			</div>
		</Section>
	);
}

function Definitions() {
	const definitions = [
		["Metric timezone", "All cohorts, sessions, and reporting dates use UTC."],
		[
			"Visitor",
			"An anonymous, privacy-safe visitor key. The overview exposes daily uniques, so the selected-range card is visitor-days, not period-unique people.",
		],
		[
			"Visit",
			"A browser session separated by 30 minutes of inactivity across reloads, SPA navigation, and participating tabs.",
		],
		[
			"Bounce",
			"A visit with one pageview and no qualifying engagement before the session closes.",
		],
		[
			"Activation",
			"A signed-up creator whose first successful share link is created within seven UTC days.",
		],
		[
			"Active creator",
			"An authenticated creator with a creator-value event in the DAU, WAU, or MAU window.",
		],
		[
			"Retention",
			"Creator or organization activity on a cohort-relative day divided by its eligible day-zero cohort; immature cohorts are excluded.",
		],
		[
			"Revenue",
			"Server-authoritative tracked revenue in original-currency minor units. No FX or decimal conversion is applied here.",
		],
		[
			"Identity stitching",
			"A server-authoritative link or settled guest purchase connects one anonymous acquisition identity to an authenticated user. The endpoint returns cohort counts only, never the mapping.",
		],
		[
			"Deduplication",
			"Decision-facing endpoints are built from stable event IDs. Duplicate deliveries remain visible in health but count once in metrics.",
		],
		[
			"Experiment exposure",
			"A typed, stable assignment rendered to an actor. Variants are read only from exposure events and are never inferred from conversion behavior.",
		],
		[
			"Privacy",
			"This page queries aggregate endpoints only and never renders actor, user, organization, network, or raw user-agent identifiers.",
		],
		[
			"Filter coverage",
			"Date applies throughout. Platform applies to product, creator, retention, and health aggregates. App version, source, and plan apply to product aggregates; app version also applies to health. Country applies to product and supported traffic aggregates. Organization cohort selects a first-value UTC date for creator and organization retention.",
		],
	];
	return (
		<Section title="Metric definitions">
			<dl className="grid gap-3 sm:grid-cols-2">
				{definitions.map(([term, definition]) => (
					<div
						className="rounded-xl border border-gray-200 bg-white p-4"
						key={term}
					>
						<dt className="text-sm font-semibold text-gray-950">{term}</dt>
						<dd className="mt-1 text-sm leading-6 text-gray-600">
							{definition}
						</dd>
					</div>
				))}
			</dl>
		</Section>
	);
}

export default async function AdminAnalyticsPage({
	searchParams,
}: {
	searchParams: Promise<SearchParams>;
}) {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") notFound();

	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) notFound();

	const filters = parseFilters(await searchParams);
	let data: AdminAnalyticsDashboard;
	try {
		data = await fetchAdminAnalyticsDashboard(filters);
	} catch (error) {
		return (
			<main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6 lg:px-8">
				<div className="mx-auto max-w-7xl space-y-6">
					<div>
						<p className="text-sm font-medium text-blue-600">
							Cap administration
						</p>
						<h1 className="mt-1 text-3xl font-semibold tracking-tight text-gray-950">
							Analytics
						</h1>
					</div>
					<AnalyticsFilters filters={filters} />
					<AnalyticsError error={error} />
				</div>
			</main>
		);
	}

	return (
		<main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6 lg:px-8">
			<div className="mx-auto max-w-7xl space-y-10">
				<div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
					<div>
						<p className="text-sm font-medium text-blue-600">
							Cap administration
						</p>
						<h1 className="mt-1 text-3xl font-semibold tracking-tight text-gray-950">
							First-party analytics
						</h1>
						<p className="mt-2 max-w-3xl text-sm text-gray-600">
							Private, aggregate-only product and website decision metrics. No
							raw personal identifiers are queried or displayed.
						</p>
					</div>
					<p className="text-xs text-gray-500">
						{filters.startDate} – {filters.endDate} UTC
					</p>
				</div>
				<AnalyticsFilters filters={filters} />
				<QualitySection data={data} />
				<TrafficSection data={data} />
				<PagesSection data={data} />
				<AcquisitionSection data={data} />
				<IdentityFunnelSection data={data} />
				<ProductSection data={data} filters={filters} />
				<RevenueSection data={data} />
				<ExperimentationSection data={data} />
				<Definitions />
			</div>
		</main>
	);
}
