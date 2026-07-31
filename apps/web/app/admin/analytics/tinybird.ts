import "server-only";

const ADMIN_ANALYTICS_ENDPOINTS = [
	"product_traffic_overview",
	"product_traffic_pages",
	"product_traffic_sources",
	"product_traffic_countries",
	"product_traffic_technology",
	"product_activation",
	"product_creator_activity",
	"product_creator_retention",
	"product_events_daily",
	"product_events_health",
	"product_analytics_freshness",
] as const;

type AdminAnalyticsEndpoint = (typeof ADMIN_ANALYTICS_ENDPOINTS)[number];
type QueryValue = string | number | undefined;
type QueryParams = Record<string, QueryValue>;
type UnknownRecord = Record<string, unknown>;

export type AdminAnalyticsFilters = {
	startDate: string;
	endDate: string;
	platform?: string;
	appVersion?: string;
	source?: string;
	country?: string;
	plan?: string;
};

export type TrafficOverviewRow = {
	date: string;
	visitors: number;
	visits: number;
	pageviews: number;
	viewsPerVisit: number;
	bounceRate: number;
	visitDurationMs: number;
	engagedMs: number;
};

export type TrafficPageRow = {
	pathname: string;
	visitors: number;
	visits: number;
	pageviews: number;
	landings: number;
	exits: number;
	timeOnPageMs: number;
	averageScrollDepth: number;
};

export type TrafficSourceRow = {
	channel: string;
	source: string;
	medium: string;
	campaign: string;
	visitors: number;
	visits: number;
	pageviews: number;
	bounceRate: number;
};

export type TrafficCountryRow = {
	country: string;
	visitors: number;
	visits: number;
	pageviews: number;
};

export type TrafficTechnologyRow = {
	device: string;
	browser: string;
	os: string;
	visitors: number;
	visits: number;
	pageviews: number;
};

export type ActivationRow = {
	cohortDate: string;
	signups: number;
	activatedCreators: number;
	activationRate: number;
	averageTimeToActivationMs: number;
};

export type CreatorActivityRow = {
	asOfDate: string;
	dau: number;
	wau: number;
	mau: number;
	dailyActiveOrganizations: number;
	newCreators: number;
	returningCreators: number;
	dauWauStickiness: number;
	dauMauStickiness: number;
};

export type CreatorRetentionRow = {
	cohortDate: string;
	activityDate: string;
	cohortDay: number;
	platform: string;
	creators: number;
	organizations: number;
};

export type ProductEventRow = {
	date: string;
	eventName: string;
	source: string;
	platform: string;
	appVersion: string;
	hostname: string;
	country: string;
	device: string;
	browser: string;
	os: string;
	channel: string;
	planId: string;
	paymentStatus: string;
	subscriptionStatus: string;
	currency: string;
	billingInterval: string;
	events: number;
	actors: number;
	users: number;
	organizations: number;
	revenueMinor: number;
};

export type ProductEventsHealthRow = {
	receivedRows: number;
	uniqueEvents: number;
	uniquePayloads: number;
	duplicateRows: number;
	payloadConflicts: number;
	futureEvents: number;
	lateEvents: number;
	missingIdentityEvents: number;
	ingestionLagMs: number[];
};

export type AnalyticsFreshnessRow = {
	latestReceivedHour: string;
	healthFreshnessMs: number;
	productCalculatedAt: string;
	trafficCalculatedAt: string;
	retentionCalculatedAt: string;
};

export type AdminAnalyticsDashboard = {
	trafficOverview: TrafficOverviewRow[];
	trafficPages: TrafficPageRow[];
	trafficSources: TrafficSourceRow[];
	trafficCountries: TrafficCountryRow[];
	trafficTechnology: TrafficTechnologyRow[];
	activation: ActivationRow[];
	creatorActivity: CreatorActivityRow[];
	creatorRetention: CreatorRetentionRow[];
	productEvents: ProductEventRow[];
	health: ProductEventsHealthRow[];
	freshness: AnalyticsFreshnessRow[];
	healthWindowStart: string;
};

export class AdminAnalyticsConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdminAnalyticsConfigurationError";
	}
}

export class AdminAnalyticsRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdminAnalyticsRequestError";
	}
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(row: UnknownRecord, key: string): string {
	const value = row[key];
	if (typeof value !== "string") {
		throw new AdminAnalyticsRequestError(
			`Tinybird returned an invalid ${key} value`,
		);
	}
	return value;
}

function readNumber(row: UnknownRecord, key: string): number {
	const value = row[key];
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		throw new AdminAnalyticsRequestError(
			`Tinybird returned an invalid ${key} value`,
		);
	}
	return parsed;
}

function readNumberArray(row: UnknownRecord, key: string): number[] {
	const value = row[key];
	if (!Array.isArray(value)) {
		throw new AdminAnalyticsRequestError(
			`Tinybird returned an invalid ${key} value`,
		);
	}
	return value.map((item) => {
		const parsed = typeof item === "number" ? item : Number(item);
		if (!Number.isFinite(parsed)) {
			throw new AdminAnalyticsRequestError(
				`Tinybird returned an invalid ${key} value`,
			);
		}
		return parsed;
	});
}

export function decodeTinybirdRows<T>(
	value: unknown,
	decodeRow: (row: UnknownRecord) => T,
): T[] {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		throw new AdminAnalyticsRequestError(
			"Tinybird returned an invalid response envelope",
		);
	}

	return value.data.map((row) => {
		if (!isRecord(row)) {
			throw new AdminAnalyticsRequestError(
				"Tinybird returned an invalid response row",
			);
		}
		return decodeRow(row);
	});
}

export function buildAdminAnalyticsEndpointUrl(
	host: string,
	endpoint: AdminAnalyticsEndpoint,
	params: QueryParams,
): URL {
	const normalizedHost = host.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(`${normalizedHost}/v0/pipes/${endpoint}.json`);
	} catch {
		throw new AdminAnalyticsConfigurationError(
			"PRODUCT_ANALYTICS_TINYBIRD_HOST must be a valid absolute URL",
		);
	}

	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === "") continue;
		url.searchParams.set(key, String(value));
	}
	return url;
}

function decodeTrafficOverviewRow(row: UnknownRecord): TrafficOverviewRow {
	return {
		date: readString(row, "date"),
		visitors: readNumber(row, "visitors"),
		visits: readNumber(row, "visits"),
		pageviews: readNumber(row, "pageviews"),
		viewsPerVisit: readNumber(row, "views_per_visit"),
		bounceRate: readNumber(row, "bounce_rate"),
		visitDurationMs: readNumber(row, "visit_duration_ms"),
		engagedMs: readNumber(row, "engaged_ms"),
	};
}

export function decodeTrafficOverviewResponse(
	value: unknown,
): TrafficOverviewRow[] {
	return decodeTinybirdRows(value, decodeTrafficOverviewRow);
}

function decodeTrafficPageRow(row: UnknownRecord): TrafficPageRow {
	return {
		pathname: readString(row, "pathname"),
		visitors: readNumber(row, "visitors"),
		visits: readNumber(row, "visits"),
		pageviews: readNumber(row, "pageviews"),
		landings: readNumber(row, "landings"),
		exits: readNumber(row, "exits"),
		timeOnPageMs: readNumber(row, "time_on_page_ms"),
		averageScrollDepth: readNumber(row, "average_scroll_depth"),
	};
}

function decodeTrafficSourceRow(row: UnknownRecord): TrafficSourceRow {
	return {
		channel: readString(row, "channel"),
		source: readString(row, "source"),
		medium: readString(row, "medium"),
		campaign: readString(row, "campaign"),
		visitors: readNumber(row, "visitors"),
		visits: readNumber(row, "visits"),
		pageviews: readNumber(row, "pageviews"),
		bounceRate: readNumber(row, "bounce_rate"),
	};
}

function decodeTrafficCountryRow(row: UnknownRecord): TrafficCountryRow {
	return {
		country: readString(row, "country"),
		visitors: readNumber(row, "visitors"),
		visits: readNumber(row, "visits"),
		pageviews: readNumber(row, "pageviews"),
	};
}

function decodeTrafficTechnologyRow(row: UnknownRecord): TrafficTechnologyRow {
	return {
		device: readString(row, "device"),
		browser: readString(row, "browser"),
		os: readString(row, "os"),
		visitors: readNumber(row, "visitors"),
		visits: readNumber(row, "visits"),
		pageviews: readNumber(row, "pageviews"),
	};
}

function decodeActivationRow(row: UnknownRecord): ActivationRow {
	return {
		cohortDate: readString(row, "cohort_date"),
		signups: readNumber(row, "signups"),
		activatedCreators: readNumber(row, "activated_creators"),
		activationRate: readNumber(row, "activation_rate"),
		averageTimeToActivationMs: readNumber(row, "average_time_to_activation_ms"),
	};
}

function decodeCreatorActivityRow(row: UnknownRecord): CreatorActivityRow {
	return {
		asOfDate: readString(row, "as_of_date"),
		dau: readNumber(row, "dau"),
		wau: readNumber(row, "wau"),
		mau: readNumber(row, "mau"),
		dailyActiveOrganizations: readNumber(row, "daily_active_organizations"),
		newCreators: readNumber(row, "new_creators"),
		returningCreators: readNumber(row, "returning_creators"),
		dauWauStickiness: readNumber(row, "dau_wau_stickiness"),
		dauMauStickiness: readNumber(row, "dau_mau_stickiness"),
	};
}

function decodeCreatorRetentionRow(row: UnknownRecord): CreatorRetentionRow {
	return {
		cohortDate: readString(row, "cohort_date"),
		activityDate: readString(row, "activity_date"),
		cohortDay: readNumber(row, "cohort_day"),
		platform: readString(row, "platform"),
		creators: readNumber(row, "creators"),
		organizations: readNumber(row, "organizations"),
	};
}

function decodeProductEventRow(row: UnknownRecord): ProductEventRow {
	return {
		date: readString(row, "date"),
		eventName: readString(row, "event_name"),
		source: readString(row, "source"),
		platform: readString(row, "platform"),
		appVersion: readString(row, "app_version"),
		hostname: readString(row, "hostname"),
		country: readString(row, "country"),
		device: readString(row, "device"),
		browser: readString(row, "browser"),
		os: readString(row, "os"),
		channel: readString(row, "channel"),
		planId: readString(row, "plan_id"),
		paymentStatus: readString(row, "payment_status"),
		subscriptionStatus: readString(row, "subscription_status"),
		currency: readString(row, "currency"),
		billingInterval: readString(row, "billing_interval"),
		events: readNumber(row, "events"),
		actors: readNumber(row, "actors"),
		users: readNumber(row, "users"),
		organizations: readNumber(row, "organizations"),
		revenueMinor: readNumber(row, "revenue_minor"),
	};
}

function decodeProductEventsHealthRow(
	row: UnknownRecord,
): ProductEventsHealthRow {
	return {
		receivedRows: readNumber(row, "received_rows"),
		uniqueEvents: readNumber(row, "unique_events"),
		uniquePayloads: readNumber(row, "unique_payloads"),
		duplicateRows: readNumber(row, "duplicate_rows"),
		payloadConflicts: readNumber(row, "payload_conflicts"),
		futureEvents: readNumber(row, "future_events"),
		lateEvents: readNumber(row, "late_events"),
		missingIdentityEvents: readNumber(row, "missing_identity_events"),
		ingestionLagMs: readNumberArray(row, "ingestion_lag_ms"),
	};
}

function decodeAnalyticsFreshnessRow(
	row: UnknownRecord,
): AnalyticsFreshnessRow {
	return {
		latestReceivedHour: readString(row, "latest_received_hour"),
		healthFreshnessMs: readNumber(row, "health_freshness_ms"),
		productCalculatedAt: readString(row, "product_calculated_at"),
		trafficCalculatedAt: readString(row, "traffic_calculated_at"),
		retentionCalculatedAt: readString(row, "retention_calculated_at"),
	};
}

type FetchEndpoint = <T>(
	endpoint: AdminAnalyticsEndpoint,
	params: QueryParams,
	decodeRow: (row: UnknownRecord) => T,
) => Promise<T[]>;

function createFetchEndpoint(): FetchEndpoint {
	const host = process.env.PRODUCT_ANALYTICS_TINYBIRD_HOST?.trim();
	const token = process.env.PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN?.trim();
	if (!host || !token) {
		throw new AdminAnalyticsConfigurationError(
			"Admin analytics is not configured. Set PRODUCT_ANALYTICS_TINYBIRD_HOST and PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN.",
		);
	}

	return async <T>(
		endpoint: AdminAnalyticsEndpoint,
		params: QueryParams,
		decodeRow: (row: UnknownRecord) => T,
	) => {
		const url = buildAdminAnalyticsEndpointUrl(host, endpoint, params);
		let response: Response;
		try {
			response = await fetch(url, {
				headers: { Authorization: `Bearer ${token}` },
				cache: "no-store",
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			throw new AdminAnalyticsRequestError(
				`Tinybird endpoint ${endpoint} could not be reached`,
			);
		}

		if (!response.ok) {
			throw new AdminAnalyticsRequestError(
				`Tinybird endpoint ${endpoint} returned HTTP ${response.status}`,
			);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new AdminAnalyticsRequestError(
				`Tinybird endpoint ${endpoint} returned invalid JSON`,
			);
		}
		return decodeTinybirdRows(body, decodeRow);
	};
}

export function calculateHealthWindowStart(
	startDate: string,
	endDate: string,
): string {
	const requestedStart = new Date(`${startDate}T00:00:00.000Z`);
	const end = new Date(`${endDate}T23:59:59.999Z`);
	const maximumStart = new Date(end);
	maximumStart.setUTCDate(maximumStart.getUTCDate() - 30);
	return new Date(Math.max(requestedStart.getTime(), maximumStart.getTime()))
		.toISOString()
		.slice(0, 10);
}

export async function fetchAdminAnalyticsDashboard(
	filters: AdminAnalyticsFilters,
): Promise<AdminAnalyticsDashboard> {
	const rangeStart = new Date(`${filters.startDate}T00:00:00.000Z`);
	const rangeEnd = new Date(`${filters.endDate}T00:00:00.000Z`);
	if (
		!Number.isFinite(rangeStart.getTime()) ||
		!Number.isFinite(rangeEnd.getTime()) ||
		rangeEnd < rangeStart ||
		rangeEnd.getTime() - rangeStart.getTime() > 399 * 86_400_000
	) {
		throw new AdminAnalyticsRequestError(
			"The analytics date range must be valid, ordered, and no longer than 400 UTC days.",
		);
	}

	const fetchEndpoint = createFetchEndpoint();
	const dateParams = {
		start_date: filters.startDate,
		end_date: filters.endDate,
	};
	const healthWindowStart = calculateHealthWindowStart(
		filters.startDate,
		filters.endDate,
	);

	const [
		trafficOverview,
		trafficPages,
		trafficSources,
		trafficCountries,
		trafficTechnology,
		activation,
		creatorActivity,
		creatorRetention,
		productEvents,
		health,
		freshness,
	] = await Promise.all([
		fetchEndpoint(
			"product_traffic_overview",
			{ ...dateParams, country: filters.country },
			decodeTrafficOverviewRow,
		),
		fetchEndpoint(
			"product_traffic_pages",
			{ ...dateParams, country: filters.country, limit: 100 },
			decodeTrafficPageRow,
		),
		fetchEndpoint(
			"product_traffic_sources",
			{ ...dateParams, limit: 100 },
			decodeTrafficSourceRow,
		),
		fetchEndpoint(
			"product_traffic_countries",
			dateParams,
			decodeTrafficCountryRow,
		),
		fetchEndpoint(
			"product_traffic_technology",
			{ ...dateParams, country: filters.country },
			decodeTrafficTechnologyRow,
		),
		fetchEndpoint("product_activation", dateParams, decodeActivationRow),
		fetchEndpoint(
			"product_creator_activity",
			{ as_of_date: filters.endDate, platform: filters.platform },
			decodeCreatorActivityRow,
		),
		fetchEndpoint(
			"product_creator_retention",
			{ ...dateParams, platform: filters.platform },
			decodeCreatorRetentionRow,
		),
		fetchEndpoint(
			"product_events_daily",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
				source: filters.source,
				country: filters.country,
				plan_id: filters.plan,
				limit: 1000,
			},
			decodeProductEventRow,
		),
		fetchEndpoint(
			"product_events_health",
			{
				start_time: `${healthWindowStart} 00:00:00.000`,
				end_time: `${filters.endDate} 23:59:59.999`,
				platform: filters.platform,
				app_version: filters.appVersion,
			},
			decodeProductEventsHealthRow,
		),
		fetchEndpoint(
			"product_analytics_freshness",
			{},
			decodeAnalyticsFreshnessRow,
		),
	]);

	if (productEvents.length >= 1000) {
		throw new AdminAnalyticsRequestError(
			"Product analytics reached the aggregate endpoint row limit. Narrow the date range or filters before using these metrics for decisions.",
		);
	}
	if (creatorRetention.length >= 5000) {
		throw new AdminAnalyticsRequestError(
			"Creator retention reached the aggregate endpoint row limit. Narrow the date range or platform before using these metrics for decisions.",
		);
	}

	return {
		trafficOverview,
		trafficPages,
		trafficSources,
		trafficCountries,
		trafficTechnology,
		activation,
		creatorActivity,
		creatorRetention,
		productEvents,
		health,
		freshness,
		healthWindowStart,
	};
}
