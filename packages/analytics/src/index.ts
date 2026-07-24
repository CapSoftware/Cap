export const CORE_EVENT_NAMES = [
	"page_view",
	"download_cta_clicked",
	"pricing_cta_clicked",
	"cli_install_command_copied",
	"auth_started",
	"auth_email_sent",
	"user_signed_up",
	"recording_started",
	"recording_completed",
	"multipart_upload_complete",
	"multipart_upload_failed",
	"export_button_clicked",
	"create_shareable_link_clicked",
	"checkout_started",
	"guest_checkout_started",
	"purchase_completed",
	"organization_invite_sent",
	"organization_member_joined",
	"seat_quantity_changed",
	"loom_import_started",
	"loom_import_completed",
	"loom_import_failed",
	"first_view_received",
	"recording_recovery_failed",
] as const;

export const SERVER_ONLY_EVENT_NAMES = [
	"user_signed_up",
	"checkout_started",
	"guest_checkout_started",
	"purchase_completed",
	"organization_invite_sent",
	"organization_member_joined",
	"seat_quantity_changed",
	"first_view_received",
] as const satisfies readonly CoreEventName[];

export type CoreEventName = (typeof CORE_EVENT_NAMES)[number];
export type ProductEventPlatform = "web" | "desktop" | "mobile" | "server";
export type ProductEventProperty = string | number | boolean | null;
export type ProductEventProperties = Record<string, ProductEventProperty>;

export const PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE =
	"cap_analytics_anonymous_id";

export interface ProductEventInput {
	eventId: string;
	eventName: CoreEventName;
	occurredAt: string;
	anonymousId: string;
	sessionId?: string;
	platform: ProductEventPlatform;
	appVersion?: string;
	pathname?: string;
	referrer?: string;
	properties?: ProductEventProperties;
}

export interface ProductEventContext {
	receivedAt: string;
	source: "client" | "server";
	userId?: string;
	organizationId?: string;
	country?: string;
	region?: string;
	city?: string;
}

export interface ProductEventRow {
	event_id: string;
	occurred_at: string;
	received_at: string;
	event_name: CoreEventName;
	schema_version: 1;
	source: "client" | "server";
	platform: ProductEventPlatform;
	anonymous_id: string;
	session_id: string;
	user_id: string;
	organization_id: string;
	app_version: string;
	pathname: string;
	referrer: string;
	country: string;
	region: string;
	city: string;
	properties: string;
}

export const PRODUCT_ANALYTICS_LIMITS = {
	batchSize: 20,
	queueSize: 100,
	requestBytes: 64 * 1024,
	propertyCount: 32,
	propertyKeyLength: 64,
	propertyStringLength: 512,
	propertiesBytes: 16 * 1024,
	identifierLength: 128,
	appVersionLength: 64,
	pathnameLength: 2048,
	referrerLength: 2048,
	maxPastAgeMs: 7 * 24 * 60 * 60 * 1000,
	maxFutureAgeMs: 5 * 60 * 1000,
} as const;

export class ProductAnalyticsError extends Error {
	readonly _tag = "ProductAnalyticsError";
	readonly retryable: boolean;
	readonly status?: number;

	constructor(options: {
		cause: unknown;
		retryable: boolean;
		status?: number;
	}) {
		super("Product analytics request failed", { cause: options.cause });
		this.name = "ProductAnalyticsError";
		this.retryable = options.retryable;
		this.status = options.status;
	}
}

interface ProductAnalyticsTransportOptions {
	host: string;
	token: string;
	rows: readonly ProductEventRow[];
	wait?: boolean;
	maxAttempts?: number;
	fetchImpl?: typeof fetch;
}

export async function sendProductAnalyticsRows({
	host,
	token,
	rows,
	wait = false,
	maxAttempts = 2,
	fetchImpl = fetch,
}: ProductAnalyticsTransportOptions) {
	if (rows.length === 0) return;

	const url = new URL("/v0/events", host);
	url.searchParams.set("name", "product_events_v1");
	url.searchParams.set("format", "ndjson");
	if (wait) url.searchParams.set("wait", "true");

	const body = rows.map((row) => JSON.stringify(row)).join("\n");
	let lastError: ProductAnalyticsError | undefined;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			const response = await fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/x-ndjson",
				},
				body,
				signal: AbortSignal.timeout(wait ? 10_000 : 2_000),
			});

			if (response.ok) return;

			const retryable = response.status === 429 || response.status >= 500;
			lastError = new ProductAnalyticsError({
				cause: await response.text(),
				retryable,
				status: response.status,
			});
			if (!retryable) throw lastError;
		} catch (cause) {
			if (cause instanceof ProductAnalyticsError) throw cause;
			lastError = new ProductAnalyticsError({ cause, retryable: true });
		}

		if (attempt + 1 < maxAttempts) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	throw (
		lastError ??
		new ProductAnalyticsError({
			cause: "Product analytics request failed",
			retryable: false,
		})
	);
}

const CORE_EVENT_NAME_SET = new Set<string>(CORE_EVENT_NAMES);
const SERVER_ONLY_EVENT_NAME_SET = new Set<string>(SERVER_ONLY_EVENT_NAMES);
const PROPERTY_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const FORBIDDEN_PROPERTY_KEYS = new Set([
	"comment",
	"content",
	"email",
	"error",
	"error_message",
	"file_name",
	"file_path",
	"raw_error",
	"reason",
	"recording_name",
	"organization_id",
	"session_id",
	"subscription_id",
	"title",
	"transcript",
	"user_email",
	"user_id",
	"video_id",
]);
const CLIENT_PRODUCT_EVENT_PLATFORMS = new Set<ProductEventPlatform>([
	"web",
	"desktop",
]);
const DYNAMIC_ID_PARENT_SEGMENTS = new Set([
	"apps",
	"c",
	"dev",
	"embed",
	"folder",
	"invite",
	"messenger",
	"s",
	"spaces",
	"videos",
]);
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CAP_NANOID_PATTERN = /^(?:[0-9abcdefghjkmnpqrstvwxyz]{15}){1,2}$/;

export function isCoreEventName(value: string): value is CoreEventName {
	return CORE_EVENT_NAME_SET.has(value);
}

export function isServerOnlyEventName(value: CoreEventName) {
	return SERVER_ONLY_EVENT_NAME_SET.has(value);
}

export function normalizeProductEventProperties(
	properties?: Record<string, unknown>,
): ProductEventProperties | undefined {
	if (!properties) return undefined;

	const normalized: ProductEventProperties = {};
	let count = 0;

	for (const [key, value] of Object.entries(properties)) {
		if (count >= PRODUCT_ANALYTICS_LIMITS.propertyCount) break;
		if (
			key.length > PRODUCT_ANALYTICS_LIMITS.propertyKeyLength ||
			!PROPERTY_KEY_PATTERN.test(key) ||
			FORBIDDEN_PROPERTY_KEYS.has(key)
		) {
			continue;
		}

		let normalizedValue: ProductEventProperty;
		if (typeof value === "string") {
			normalizedValue = value.slice(
				0,
				PRODUCT_ANALYTICS_LIMITS.propertyStringLength,
			);
		} else if (typeof value === "number" && Number.isFinite(value)) {
			normalizedValue = value;
		} else if (typeof value === "boolean" || value === null) {
			normalizedValue = value;
		} else {
			continue;
		}

		normalized[key] = normalizedValue;
		if (
			new TextEncoder().encode(JSON.stringify(normalized)).byteLength >
			PRODUCT_ANALYTICS_LIMITS.propertiesBytes
		) {
			delete normalized[key];
			continue;
		}

		count += 1;
	}

	return count > 0 ? normalized : undefined;
}

export function normalizeProductEventInput(
	value: unknown,
	now = Date.now(),
): ProductEventInput | null {
	if (!isRecord(value)) return null;

	const eventId = normalizeIdentifier(value.eventId);
	const anonymousId = normalizeIdentifier(value.anonymousId);
	const sessionId = normalizeOptionalIdentifier(value.sessionId);
	const eventName = value.eventName;
	const platform = value.platform;
	const occurredAt = normalizeOccurredAt(value.occurredAt, now);

	if (
		!eventId ||
		!anonymousId ||
		!occurredAt ||
		typeof eventName !== "string" ||
		!isCoreEventName(eventName) ||
		typeof platform !== "string" ||
		!CLIENT_PRODUCT_EVENT_PLATFORMS.has(platform as ProductEventPlatform)
	) {
		return null;
	}

	const properties =
		"properties" in value && isRecord(value.properties)
			? normalizeProductEventProperties(value.properties)
			: undefined;

	return {
		eventId,
		eventName,
		occurredAt,
		anonymousId,
		...(sessionId ? { sessionId } : {}),
		platform: platform as ProductEventPlatform,
		...normalizeOptionalStringField(
			"appVersion",
			value.appVersion,
			PRODUCT_ANALYTICS_LIMITS.appVersionLength,
		),
		...normalizeOptionalPathname(value.pathname),
		...normalizeOptionalReferrer(value.referrer),
		...(properties ? { properties } : {}),
	};
}

export function createProductEventRows(
	events: readonly ProductEventInput[],
	context: ProductEventContext,
): ProductEventRow[] {
	return events.map((event) => ({
		event_id: event.eventId,
		occurred_at: event.occurredAt,
		received_at: context.receivedAt,
		event_name: event.eventName,
		schema_version: 1,
		source: context.source,
		platform: event.platform,
		anonymous_id: event.anonymousId,
		session_id: event.sessionId ?? "",
		user_id: context.userId ?? "",
		organization_id: context.organizationId ?? "",
		app_version: event.appVersion ?? "",
		pathname: event.pathname ?? "",
		referrer: event.referrer ?? "",
		country: context.country ?? "",
		region: context.region ?? "",
		city: context.city ?? "",
		properties: event.properties ? JSON.stringify(event.properties) : "{}",
	}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentifier(value: unknown) {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > PRODUCT_ANALYTICS_LIMITS.identifierLength
	) {
		return null;
	}
	return normalized;
}

function normalizeOptionalIdentifier(value: unknown) {
	if (value === undefined || value === null || value === "") return undefined;
	return normalizeIdentifier(value) ?? undefined;
}

function normalizeOccurredAt(value: unknown, now: number) {
	if (typeof value !== "string") return null;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return null;
	if (timestamp < now - PRODUCT_ANALYTICS_LIMITS.maxPastAgeMs) return null;
	if (timestamp > now + PRODUCT_ANALYTICS_LIMITS.maxFutureAgeMs) return null;
	return new Date(timestamp).toISOString();
}

function normalizeOptionalStringField<Key extends "appVersion">(
	key: Key,
	value: unknown,
	maxLength: number,
): Partial<Record<Key, string>> {
	if (typeof value !== "string") return {};
	const normalized = value.trim().slice(0, maxLength);
	return normalized ? ({ [key]: normalized } as Record<Key, string>) : {};
}

function normalizeOptionalPathname(value: unknown) {
	if (typeof value !== "string") return {};

	let pathname = value.trim();
	try {
		pathname = new URL(pathname).pathname;
	} catch {
		pathname = pathname.split(/[?#]/, 1)[0] ?? "";
	}

	const segments = pathname.split("/");
	const normalized = segments
		.map((segment, index) =>
			isHighCardinalityPathSegment(segment, segments[index - 1])
				? ":id"
				: segment,
		)
		.join("/")
		.slice(0, PRODUCT_ANALYTICS_LIMITS.pathnameLength);

	return normalized ? { pathname: normalized } : {};
}

function normalizeOptionalReferrer(value: unknown) {
	if (typeof value !== "string" || !value.trim()) return {};
	try {
		return {
			referrer: new URL(value).hostname.slice(
				0,
				PRODUCT_ANALYTICS_LIMITS.referrerLength,
			),
		};
	} catch {
		return {};
	}
}

function isHighCardinalityPathSegment(segment: string, parentSegment?: string) {
	if (UUID_PATTERN.test(segment) || ULID_PATTERN.test(segment)) return true;
	return Boolean(
		parentSegment &&
			DYNAMIC_ID_PARENT_SEGMENTS.has(parentSegment) &&
			CAP_NANOID_PATTERN.test(segment),
	);
}
