import "server-only";

const ADMIN_ANALYTICS_ENDPOINTS = [
	"product_traffic_overview",
	"product_traffic_totals",
	"product_traffic_pages",
	"product_traffic_sources",
	"product_attribution",
	"product_traffic_countries",
	"product_traffic_technology",
	"product_activation",
	"product_creator_activity",
	"product_creator_retention",
	"product_identity_funnel",
	"product_events_daily",
	"product_feature_adoption",
	"product_experiment_outcomes",
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
	organizationCohort?: string;
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

export type TrafficTotalsRow = Omit<TrafficOverviewRow, "date">;

export type AttributionModel = "first" | "session" | "last";

export type TrafficAttributionRow = {
	attributionModel: AttributionModel;
	source: string;
	medium: string;
	campaign: string;
	visitors: number;
	visits: number;
	pageviews: number;
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
	schemaVersion: number;
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
	recordingStatus: string;
	paymentStatus: string;
	subscriptionStatus: string;
	currency: string;
	billingInterval: string;
	changeKind: string;
	previousStatus: string;
	newStatus: string;
	previousPlanId: string;
	quantity: number;
	previousQuantity: number;
	newQuantity: number;
	seatDelta: number;
	firstPurchase: string;
	guestCheckout: string;
	onboarding: string;
	cancelAtPeriodEnd: string;
	fullyRefunded: string;
	endedAt: number;
	trialEndAt: number;
	amountDueMinor: number;
	attemptCount: number;
	experimentId: string;
	experimentVariant: string;
	assignmentVersion: string;
	deliveryLossCount: number;
	events: number;
	actors: number;
	users: number;
	organizations: number;
	revenueMinor: number;
};

export type IdentityFunnelRow = {
	linkedVisitors: number;
	linkedUsers: number;
	signupUsers: number;
	organizations: number;
	guestCheckoutVisitors: number;
	guestPurchasers: number;
	authenticatedCheckoutUsers: number;
	webCheckoutUsers: number;
	desktopCheckoutUsers: number;
	mobileCheckoutUsers: number;
	crossDeviceCheckoutUsers: number;
	trialUsers: number;
	purchasers: number;
	signupRate: number;
	purchaseRate: number;
};

export type FeatureAdoptionRow = {
	eventName: string;
	events: number;
	actorDays: number;
	userDays: number;
	organizationDays: number;
};

export type ExperimentOutcomeRow = {
	experimentId: string;
	assignmentVersion: string;
	variant: string;
	platform: string;
	appVersion: string;
	outcomeName: string;
	exposedActors: number;
	convertedActors: number;
	conversionRate: number;
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
	identityCalculatedAt: string;
	attributionCalculatedAt: string;
	experimentCalculatedAt: string;
};

export type AdminAnalyticsDashboard = {
	trafficOverview: TrafficOverviewRow[];
	trafficTotals: TrafficTotalsRow[];
	trafficTotalsAvailable: boolean;
	trafficPages: TrafficPageRow[];
	trafficSources: TrafficSourceRow[];
	trafficAttribution: TrafficAttributionRow[];
	trafficAttributionAvailable: boolean;
	trafficCountries: TrafficCountryRow[];
	trafficTechnology: TrafficTechnologyRow[];
	activation: ActivationRow[];
	creatorActivity: CreatorActivityRow[];
	creatorRetention: CreatorRetentionRow[];
	identityFunnel: IdentityFunnelRow[];
	identityFunnelAvailable: boolean;
	productEvents: ProductEventRow[];
	featureAdoption: FeatureAdoptionRow[];
	experimentOutcomes: ExperimentOutcomeRow[];
	experimentOutcomesAvailable: boolean;
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
	constructor(
		message: string,
		readonly status?: number,
	) {
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

function readOptionalString(row: UnknownRecord, key: string): string {
	const value = row[key];
	if (value === undefined || value === null) return "";
	return readString(row, key);
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

function readOptionalNumber(row: UnknownRecord, key: string): number {
	const value = row[key];
	if (value === undefined || value === null) return 0;
	return readNumber(row, key);
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

function decodeTrafficTotalsRow(row: UnknownRecord): TrafficTotalsRow {
	return {
		visitors: readNumber(row, "visitors"),
		visits: readNumber(row, "visits"),
		pageviews: readNumber(row, "pageviews"),
		viewsPerVisit: readNumber(row, "views_per_visit"),
		bounceRate: readNumber(row, "bounce_rate"),
		visitDurationMs: readNumber(row, "visit_duration_ms"),
		engagedMs: readNumber(row, "engaged_ms"),
	};
}

export function decodeTrafficTotalsResponse(
	value: unknown,
): TrafficTotalsRow[] {
	return decodeTinybirdRows(value, decodeTrafficTotalsRow);
}

function decodeAttributionModel(
	row: UnknownRecord,
	key: string,
): AttributionModel {
	const value = readString(row, key);
	if (value !== "first" && value !== "session" && value !== "last") {
		throw new AdminAnalyticsRequestError(
			`Tinybird returned an invalid ${key} value`,
		);
	}
	return value;
}

function decodeTrafficAttributionRow(
	row: UnknownRecord,
): TrafficAttributionRow {
	return {
		attributionModel: decodeAttributionModel(row, "attribution_model"),
		source: readString(row, "source"),
		medium: readString(row, "medium"),
		campaign: readString(row, "campaign"),
		visitors: readNumber(row, "visitors"),
		visits: readNumber(row, "visits"),
		pageviews: readNumber(row, "pageviews"),
	};
}

export function decodeTrafficAttributionResponse(
	value: unknown,
): TrafficAttributionRow[] {
	return decodeTinybirdRows(value, decodeTrafficAttributionRow);
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

function decodeIdentityFunnelRow(row: UnknownRecord): IdentityFunnelRow {
	return {
		linkedVisitors: readNumber(row, "linked_visitors"),
		linkedUsers: readNumber(row, "linked_users"),
		signupUsers: readNumber(row, "signup_users"),
		organizations: readNumber(row, "organizations"),
		guestCheckoutVisitors: readNumber(row, "guest_checkout_visitors"),
		guestPurchasers: readNumber(row, "guest_purchasers"),
		authenticatedCheckoutUsers: readNumber(row, "authenticated_checkout_users"),
		webCheckoutUsers: readNumber(row, "web_checkout_users"),
		desktopCheckoutUsers: readNumber(row, "desktop_checkout_users"),
		mobileCheckoutUsers: readNumber(row, "mobile_checkout_users"),
		crossDeviceCheckoutUsers: readNumber(row, "cross_device_checkout_users"),
		trialUsers: readNumber(row, "trial_users"),
		purchasers: readNumber(row, "purchasers"),
		signupRate: readNumber(row, "signup_rate"),
		purchaseRate: readNumber(row, "purchase_rate"),
	};
}

function decodeProductEventRow(row: UnknownRecord): ProductEventRow {
	return {
		date: readString(row, "date"),
		eventName: readString(row, "event_name"),
		schemaVersion: readOptionalNumber(row, "schema_version"),
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
		recordingStatus: readOptionalString(row, "recording_status"),
		paymentStatus: readString(row, "payment_status"),
		subscriptionStatus: readString(row, "subscription_status"),
		currency: readString(row, "currency"),
		billingInterval: readString(row, "billing_interval"),
		changeKind: readOptionalString(row, "change_kind"),
		previousStatus: readOptionalString(row, "previous_status"),
		newStatus: readOptionalString(row, "new_status"),
		previousPlanId: readOptionalString(row, "previous_plan_id"),
		quantity: readOptionalNumber(row, "quantity"),
		previousQuantity: readOptionalNumber(row, "previous_quantity"),
		newQuantity: readOptionalNumber(row, "new_quantity"),
		seatDelta: readOptionalNumber(row, "seat_delta"),
		firstPurchase: readOptionalString(row, "first_purchase"),
		guestCheckout: readOptionalString(row, "guest_checkout"),
		onboarding: readOptionalString(row, "onboarding"),
		cancelAtPeriodEnd: readOptionalString(row, "cancel_at_period_end"),
		fullyRefunded: readOptionalString(row, "fully_refunded"),
		endedAt: readOptionalNumber(row, "ended_at"),
		trialEndAt: readOptionalNumber(row, "trial_end_at"),
		amountDueMinor: readOptionalNumber(row, "amount_due_minor"),
		attemptCount: readOptionalNumber(row, "attempt_count"),
		experimentId: readOptionalString(row, "experiment_id"),
		experimentVariant: readOptionalString(row, "experiment_variant"),
		assignmentVersion: readOptionalString(row, "assignment_version"),
		deliveryLossCount: readOptionalNumber(row, "delivery_loss_count"),
		events: readNumber(row, "events"),
		actors: readNumber(row, "actors"),
		users: readNumber(row, "users"),
		organizations: readNumber(row, "organizations"),
		revenueMinor: readNumber(row, "revenue_minor"),
	};
}

function decodeFeatureAdoptionRow(row: UnknownRecord): FeatureAdoptionRow {
	return {
		eventName: readString(row, "event_name"),
		events: readNumber(row, "events"),
		actorDays: readNumber(row, "actor_days"),
		userDays: readNumber(row, "user_days"),
		organizationDays: readNumber(row, "organization_days"),
	};
}

function decodeExperimentOutcomeRow(row: UnknownRecord): ExperimentOutcomeRow {
	return {
		experimentId: readString(row, "experiment_id"),
		assignmentVersion: readString(row, "assignment_version"),
		variant: readString(row, "variant"),
		platform: readString(row, "platform"),
		appVersion: readString(row, "app_version"),
		outcomeName: readString(row, "outcome_name"),
		exposedActors: readNumber(row, "exposed_actors"),
		convertedActors: readNumber(row, "converted_actors"),
		conversionRate: readNumber(row, "conversion_rate"),
	};
}

export function decodeExperimentOutcomesResponse(
	value: unknown,
): ExperimentOutcomeRow[] {
	return decodeTinybirdRows(value, decodeExperimentOutcomeRow);
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
		identityCalculatedAt: readOptionalString(row, "identity_calculated_at"),
		attributionCalculatedAt: readOptionalString(
			row,
			"attribution_calculated_at",
		),
		experimentCalculatedAt: readOptionalString(row, "experiment_calculated_at"),
	};
}

export function decodeProductEventsResponse(value: unknown): ProductEventRow[] {
	return decodeTinybirdRows(value, decodeProductEventRow);
}

export function decodeAnalyticsFreshnessResponse(
	value: unknown,
): AnalyticsFreshnessRow[] {
	return decodeTinybirdRows(value, decodeAnalyticsFreshnessRow);
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
				response.status,
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

export async function fetchOptionalRollbackEndpoint<T>(
	fetchEndpoint: FetchEndpoint,
	endpoint: AdminAnalyticsEndpoint,
	params: QueryParams,
	decodeRow: (row: UnknownRecord) => T,
): Promise<{ available: boolean; rows: T[] }> {
	try {
		return {
			available: true,
			rows: await fetchEndpoint(endpoint, params, decodeRow),
		};
	} catch (error) {
		if (error instanceof AdminAnalyticsRequestError && error.status === 404) {
			return { available: false, rows: [] };
		}
		throw error;
	}
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

export function assertAdminAnalyticsDateRange(
	startDate: string,
	endDate: string,
) {
	const rangeStart = new Date(`${startDate}T00:00:00.000Z`);
	const rangeEnd = new Date(`${endDate}T00:00:00.000Z`);
	if (
		!Number.isFinite(rangeStart.getTime()) ||
		!Number.isFinite(rangeEnd.getTime()) ||
		rangeEnd < rangeStart ||
		rangeEnd.getTime() - rangeStart.getTime() > 799 * 86_400_000
	) {
		throw new AdminAnalyticsRequestError(
			"The analytics date range must be valid, ordered, and no longer than 800 UTC days.",
		);
	}
}

export async function fetchAdminAnalyticsDashboard(
	filters: AdminAnalyticsFilters,
): Promise<AdminAnalyticsDashboard> {
	assertAdminAnalyticsDateRange(filters.startDate, filters.endDate);

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
		trafficTotalsResult,
		trafficPages,
		trafficSources,
		trafficAttributionResult,
		trafficCountries,
		trafficTechnology,
		activation,
		creatorActivity,
		creatorRetention,
		identityFunnelResult,
		productEvents,
		featureAdoption,
		experimentOutcomesResult,
		health,
		freshness,
	] = await Promise.all([
		fetchEndpoint(
			"product_traffic_overview",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
				country: filters.country,
			},
			decodeTrafficOverviewRow,
		),
		fetchOptionalRollbackEndpoint(
			fetchEndpoint,
			"product_traffic_totals",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
				source: filters.source,
				country: filters.country,
			},
			decodeTrafficTotalsRow,
		),
		fetchEndpoint(
			"product_traffic_pages",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
				country: filters.country,
				limit: 100,
			},
			decodeTrafficPageRow,
		),
		fetchEndpoint(
			"product_traffic_sources",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
				limit: 100,
			},
			decodeTrafficSourceRow,
		),
		fetchOptionalRollbackEndpoint(
			fetchEndpoint,
			"product_attribution",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
				source: filters.source,
				country: filters.country,
				limit: 300,
			},
			decodeTrafficAttributionRow,
		),
		fetchEndpoint(
			"product_traffic_countries",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
			},
			decodeTrafficCountryRow,
		),
		fetchEndpoint(
			"product_traffic_technology",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
				country: filters.country,
			},
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
			{
				start_date: filters.organizationCohort ?? filters.startDate,
				end_date: filters.organizationCohort ?? filters.endDate,
				platform: filters.platform,
			},
			decodeCreatorRetentionRow,
		),
		fetchOptionalRollbackEndpoint(
			fetchEndpoint,
			"product_identity_funnel",
			{
				...dateParams,
				source: filters.source,
				country: filters.country,
			},
			decodeIdentityFunnelRow,
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
			"product_feature_adoption",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
				source: filters.source,
				country: filters.country,
				plan_id: filters.plan,
			},
			decodeFeatureAdoptionRow,
		),
		fetchOptionalRollbackEndpoint(
			fetchEndpoint,
			"product_experiment_outcomes",
			{
				...dateParams,
				platform: filters.platform,
				app_version: filters.appVersion,
				limit: 1000,
			},
			decodeExperimentOutcomeRow,
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
	if (trafficAttributionResult.rows.length >= 300) {
		throw new AdminAnalyticsRequestError(
			"Campaign attribution reached the aggregate endpoint row limit. Narrow the date range or filters before using these metrics for decisions.",
		);
	}
	if (experimentOutcomesResult.rows.length >= 1000) {
		throw new AdminAnalyticsRequestError(
			"Experiment outcomes reached the aggregate endpoint row limit. Narrow the date range or filters before using these metrics for decisions.",
		);
	}
	if (creatorRetention.length >= 5000) {
		throw new AdminAnalyticsRequestError(
			"Creator retention reached the aggregate endpoint row limit. Narrow the date range or platform before using these metrics for decisions.",
		);
	}

	return {
		trafficOverview,
		trafficTotals: trafficTotalsResult.rows,
		trafficTotalsAvailable: trafficTotalsResult.available,
		trafficPages,
		trafficSources,
		trafficAttribution: trafficAttributionResult.rows,
		trafficAttributionAvailable: trafficAttributionResult.available,
		trafficCountries,
		trafficTechnology,
		activation,
		creatorActivity,
		creatorRetention,
		identityFunnel: identityFunnelResult.rows,
		identityFunnelAvailable: identityFunnelResult.available,
		productEvents,
		featureAdoption,
		experimentOutcomes: experimentOutcomesResult.rows,
		experimentOutcomesAvailable: experimentOutcomesResult.available,
		health,
		freshness,
		healthWindowStart,
	};
}
