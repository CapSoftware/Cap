import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import {
	CORE_EVENT_NAMES,
	type CoreEventName,
	EVENT_REGISTRY,
	getProductEventDefinition,
	isCoreEventName,
	isServerOnlyEventName,
	type ProductEventPlatform,
	type ProductEventPropertiesFor,
	SERVER_ONLY_EVENT_NAMES,
} from "./event-registry";

export type {
	AnalyticsTouch,
	BrowserAnalyticsContext,
	BrowserAnalyticsSession,
} from "./browser-session";
export {
	boundedForegroundEngagementMs,
	PRODUCT_ANALYTICS_ENGAGEMENT_IDLE_MS,
	PRODUCT_ANALYTICS_FIRST_TOUCH_STORAGE_KEY,
	PRODUCT_ANALYTICS_LAST_TOUCH_STORAGE_KEY,
	PRODUCT_ANALYTICS_SESSION_STORAGE_KEY,
	PRODUCT_ANALYTICS_SESSION_TIMEOUT_MS,
	readAnalyticsTouch,
	resolveBrowserAnalyticsContext,
} from "./browser-session";

export {
	CORE_EVENT_NAMES,
	EVENT_REGISTRY,
	getProductEventDefinition,
	isCoreEventName,
	isServerOnlyEventName,
	SERVER_ONLY_EVENT_NAMES,
};
export type {
	ClientProductEventName,
	CoreEventName,
	ProductEventArguments,
	ProductEventAuthority,
	ProductEventDelivery,
	ProductEventPlatform,
	ProductEventPropertiesFor,
	ProductEventPropertyField,
	ServerProductEventName,
} from "./event-registry";

export type ProductEventProperty = string | number | boolean | null;
export type ProductEventProperties = Record<string, ProductEventProperty>;

export const PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE =
	"cap_analytics_anonymous_id";

export interface ProductEventInput<Name extends CoreEventName = CoreEventName> {
	eventId: string;
	eventName: Name;
	occurredAt: string;
	anonymousId: string;
	sessionId?: string;
	platform: ProductEventPlatform;
	appVersion?: string;
	pathname?: string;
	referrer?: string;
	properties?: ProductEventPropertiesFor<Name>;
}

export interface ProductEventContext {
	receivedAt: string;
	source: "client" | "server";
	userId?: string;
	organizationId?: string;
	country?: string;
	region?: string;
	city?: string;
	hostname?: string;
	browser?: string;
	device?: string;
	os?: string;
	trafficClass?: "external" | "bot" | "internal" | "preview" | "synthetic";
	syntheticRunId?: string;
}

export interface ProductEventRow {
	event_id: string;
	payload_hash: string;
	occurred_at: string;
	received_at: string;
	event_name: CoreEventName;
	schema_version: number;
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
	hostname: string;
	browser: string;
	device: string;
	os: string;
	channel: string;
	traffic_class: string;
	synthetic_run_id: string;
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

const PROPERTY_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const CLIENT_PRODUCT_EVENT_PLATFORMS = new Set<ProductEventPlatform>([
	"web",
	"desktop",
	"mobile",
	"cli",
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

export function normalizeProductEventProperties<Name extends CoreEventName>(
	eventName: Name,
	properties?: Record<string, unknown>,
): ProductEventPropertiesFor<Name> | undefined | null {
	const schema = EVENT_REGISTRY[eventName].properties as Record<
		string,
		{
			type: "string" | "number" | "boolean";
			required?: true;
			nullable?: true;
			values?: readonly string[];
		}
	>;
	const entries = Object.entries(properties ?? {});
	if (
		entries.length > PRODUCT_ANALYTICS_LIMITS.propertyCount ||
		entries.some(
			([key]) =>
				key.length > PRODUCT_ANALYTICS_LIMITS.propertyKeyLength ||
				!PROPERTY_KEY_PATTERN.test(key) ||
				!Object.hasOwn(schema, key),
		)
	) {
		return null;
	}
	const normalized: ProductEventProperties = {};
	for (const [key, rule] of Object.entries(schema)) {
		if (!Object.hasOwn(properties ?? {}, key)) {
			if (rule.required) return null;
			continue;
		}

		const value = properties?.[key];
		if (value === null) {
			if (!rule.nullable) return null;
			normalized[key] = null;
			continue;
		}

		if (typeof value !== rule.type) return null;
		if (typeof value === "number" && !Number.isFinite(value)) return null;
		if (
			typeof value === "string" &&
			(value.length > PRODUCT_ANALYTICS_LIMITS.propertyStringLength ||
				(rule.values && !rule.values.includes(value)))
		) {
			return null;
		}
		normalized[key] = value as ProductEventProperty;
	}

	if (
		new TextEncoder().encode(JSON.stringify(normalized)).byteLength >
		PRODUCT_ANALYTICS_LIMITS.propertiesBytes
	) {
		return null;
	}

	return Object.keys(normalized).length > 0
		? (normalized as ProductEventPropertiesFor<Name>)
		: undefined;
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
	const definition = getProductEventDefinition(eventName);
	if (
		definition.authority === "server" ||
		!(definition.platforms as readonly ProductEventPlatform[]).includes(
			platform as ProductEventPlatform,
		)
	) {
		return null;
	}

	const hasProperties = "properties" in value;
	if (hasProperties && !isRecord(value.properties)) return null;
	const rawProperties =
		hasProperties && isRecord(value.properties) ? value.properties : undefined;
	const properties = normalizeProductEventProperties(eventName, rawProperties);
	if (properties === null) return null;

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
	return events.map((event) => {
		const payload = {
			event_name: event.eventName,
			schema_version: getProductEventDefinition(event.eventName).version,
			source: context.source,
			platform: event.platform,
			occurred_at: event.occurredAt,
			anonymous_id: event.anonymousId,
			session_id: event.sessionId ?? "",
			user_id: context.userId ?? "",
			organization_id: context.organizationId ?? "",
			app_version: event.appVersion ?? "",
			pathname: event.pathname ?? "",
			referrer: event.referrer ?? "",
			properties: event.properties ? JSON.stringify(event.properties) : "{}",
		};
		return {
			event_id: event.eventId,
			payload_hash: createProductEventPayloadHash(payload),
			received_at: context.receivedAt,
			...payload,
			country: context.country ?? "",
			region: context.region ?? "",
			city: context.city ?? "",
			hostname: context.hostname ?? "",
			browser: context.browser ?? "",
			device: context.device ?? "",
			os: context.os ?? "",
			channel: normalizeAcquisitionChannel(
				event.properties as ProductEventProperties | undefined,
				event.referrer,
			),
			traffic_class: context.trafficClass ?? "external",
			synthetic_run_id: context.syntheticRunId ?? "",
		};
	});
}

export function normalizeAcquisitionChannel(
	properties: ProductEventProperties | undefined,
	referrer?: string,
) {
	if (properties?.first_touch_gclid || properties?.session_touch_gclid) {
		return "paid_search";
	}
	if (properties?.first_touch_fbclid || properties?.session_touch_fbclid) {
		return "paid_social";
	}
	const medium = String(
		properties?.session_touch_medium ?? properties?.first_touch_medium ?? "",
	).toLowerCase();
	if (medium.includes("email")) return "email";
	if (medium.includes("affiliate")) return "affiliate";
	if (
		medium.includes("cpc") ||
		medium.includes("ppc") ||
		medium.includes("paid")
	) {
		return "paid_other";
	}
	const source = String(
		properties?.session_touch_source ?? properties?.first_touch_source ?? "",
	).toLowerCase();
	const hostname = referrer?.toLowerCase() ?? "";
	if (!source && !hostname) return "direct";
	if (
		/(google|bing|duckduckgo|yahoo|baidu|yandex)/.test(source) ||
		/(google\.|bing\.|duckduckgo\.|search\.yahoo\.|baidu\.|yandex\.)/.test(
			hostname,
		)
	) {
		return "organic_search";
	}
	if (
		/(facebook|instagram|linkedin|reddit|twitter|youtube|tiktok|x\.com)/.test(
			source || hostname,
		)
	) {
		return "organic_social";
	}
	return "referral";
}

export function createProductEventPayloadHash(value: unknown) {
	return bytesToHex(sha256(new TextEncoder().encode(stableJson(value)))).slice(
		0,
		32,
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
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
