type ProductEventProperties = Record<string, string | number | boolean | null>;

export const PRODUCT_ANALYTICS_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const PRODUCT_ANALYTICS_ENGAGEMENT_IDLE_MS = 30 * 1000;
export const PRODUCT_ANALYTICS_SESSION_STORAGE_KEY = "cap_analytics_session_v2";
export const PRODUCT_ANALYTICS_FIRST_TOUCH_STORAGE_KEY =
	"cap_analytics_first_touch_v2";
export const PRODUCT_ANALYTICS_LAST_TOUCH_STORAGE_KEY =
	"cap_analytics_last_touch_v2";

const ATTRIBUTION_FIELDS = [
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_content",
	"utm_term",
	"gclid",
	"fbclid",
] as const;

type AttributionField = (typeof ATTRIBUTION_FIELDS)[number];
type AnalyticsStorage = Pick<Storage, "getItem" | "setItem">;

export interface AnalyticsTouch {
	capturedAt: number;
	values: Partial<Record<AttributionField, string>>;
}

export interface BrowserAnalyticsSession {
	id: string;
	startedAt: number;
	lastActivityAt: number;
	sessionTouch?: AnalyticsTouch;
}

export interface BrowserAnalyticsContext {
	sessionId: string;
	isSessionEntry: boolean;
	attribution: ProductEventProperties;
}

export function boundedForegroundEngagementMs(options: {
	activeSince: number;
	lastInteractionAt: number;
	now: number;
}) {
	const engagementEnd = Math.min(
		options.now,
		options.lastInteractionAt + PRODUCT_ANALYTICS_ENGAGEMENT_IDLE_MS,
	);
	return Math.max(0, engagementEnd - options.activeSince);
}

export function readAnalyticsTouch(
	search: string,
	now = Date.now(),
): AnalyticsTouch | undefined {
	const params = new URLSearchParams(search);
	const values: Partial<Record<AttributionField, string>> = {};
	for (const field of ATTRIBUTION_FIELDS) {
		const value = params.get(field)?.trim();
		if (value) values[field] = value.slice(0, 512);
	}
	return Object.keys(values).length > 0
		? { capturedAt: now, values }
		: undefined;
}

export function resolveBrowserAnalyticsContext(options: {
	storage: AnalyticsStorage | undefined;
	createId: () => string;
	now?: number;
	touch?: AnalyticsTouch;
}): BrowserAnalyticsContext {
	const now = options.now ?? Date.now();
	const existing = readStoredSession(options.storage);
	const isSessionEntry =
		!existing ||
		now < existing.lastActivityAt ||
		now - existing.lastActivityAt > PRODUCT_ANALYTICS_SESSION_TIMEOUT_MS;
	const session: BrowserAnalyticsSession = isSessionEntry
		? {
				id: options.createId(),
				startedAt: now,
				lastActivityAt: now,
				...(options.touch ? { sessionTouch: options.touch } : {}),
			}
		: {
				...existing,
				lastActivityAt: now,
			};

	const firstTouch =
		readStoredTouch(
			options.storage,
			PRODUCT_ANALYTICS_FIRST_TOUCH_STORAGE_KEY,
		) ?? options.touch;
	const lastTouch =
		options.touch ??
		readStoredTouch(options.storage, PRODUCT_ANALYTICS_LAST_TOUCH_STORAGE_KEY);

	writeStorage(options.storage, PRODUCT_ANALYTICS_SESSION_STORAGE_KEY, session);
	if (firstTouch) {
		writeStorage(
			options.storage,
			PRODUCT_ANALYTICS_FIRST_TOUCH_STORAGE_KEY,
			firstTouch,
		);
	}
	if (lastTouch) {
		writeStorage(
			options.storage,
			PRODUCT_ANALYTICS_LAST_TOUCH_STORAGE_KEY,
			lastTouch,
		);
	}

	return {
		sessionId: session.id,
		isSessionEntry,
		attribution: {
			...touchProperties("first_touch", firstTouch),
			...touchProperties("session_touch", session.sessionTouch),
			...touchProperties("last_touch", lastTouch),
		},
	};
}

function readStoredSession(storage: AnalyticsStorage | undefined) {
	const value = readStorage(storage, PRODUCT_ANALYTICS_SESSION_STORAGE_KEY);
	if (!isRecord(value)) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.startedAt !== "number" ||
		typeof value.lastActivityAt !== "number"
	) {
		return undefined;
	}
	const sessionTouch = parseTouch(value.sessionTouch);
	return {
		id: value.id,
		startedAt: value.startedAt,
		lastActivityAt: value.lastActivityAt,
		...(sessionTouch ? { sessionTouch } : {}),
	} satisfies BrowserAnalyticsSession;
}

function readStoredTouch(storage: AnalyticsStorage | undefined, key: string) {
	return parseTouch(readStorage(storage, key));
}

function parseTouch(value: unknown): AnalyticsTouch | undefined {
	if (!isRecord(value) || typeof value.capturedAt !== "number")
		return undefined;
	if (!isRecord(value.values)) return undefined;
	const values: Partial<Record<AttributionField, string>> = {};
	for (const field of ATTRIBUTION_FIELDS) {
		const fieldValue = value.values[field];
		if (typeof fieldValue === "string" && fieldValue) {
			values[field] = fieldValue.slice(0, 512);
		}
	}
	return Object.keys(values).length > 0
		? { capturedAt: value.capturedAt, values }
		: undefined;
}

function touchProperties(
	prefix: "first_touch" | "session_touch" | "last_touch",
	touch: AnalyticsTouch | undefined,
) {
	if (!touch) return {};
	const properties: ProductEventProperties = {};
	for (const [field, value] of Object.entries(touch.values)) {
		properties[`${prefix}_${field.replace(/^utm_/, "")}`] = value;
	}
	return properties;
}

function readStorage(storage: AnalyticsStorage | undefined, key: string) {
	try {
		const value = storage?.getItem(key);
		return value ? (JSON.parse(value) as unknown) : undefined;
	} catch {
		return undefined;
	}
}

function writeStorage(
	storage: AnalyticsStorage | undefined,
	key: string,
	value: unknown,
) {
	try {
		storage?.setItem(key, JSON.stringify(value));
	} catch {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
