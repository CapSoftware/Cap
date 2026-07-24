import {
	isCoreEventName,
	isServerOnlyEventName,
	normalizeProductEventProperties,
	PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE,
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventInput,
	type ProductEventProperties,
} from "@cap/analytics";
import Cookies from "js-cookie";

const FLUSH_INTERVAL_MS = 5_000;
const RETRY_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 3_000;
const ANONYMOUS_ID_KEY = "cap_analytics_anonymous_id_v1";
const SESSION_ID_KEY = "cap_analytics_session_id_v1";
const ATTRIBUTION_KEY = "cap_analytics_attribution_v1";
const ATTRIBUTION_FIELDS = [
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_content",
	"utm_term",
	"gclid",
	"fbclid",
] as const;

type TransportResult = "success" | "retry" | "drop";
type TransportMode = "normal" | "unload";
type QueuedEvent = { event: ProductEventInput; attempts: number };

interface BrowserTransportDependencies {
	fetchImpl?: typeof fetch;
	sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}

export type ProductAnalyticsTransport = (
	events: readonly ProductEventInput[],
	mode: TransportMode,
) => Promise<TransportResult>;

export class ProductAnalyticsQueue {
	private queue: QueuedEvent[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private inFlight: Promise<void> | undefined;

	constructor(
		private readonly transport: ProductAnalyticsTransport,
		private readonly schedule: typeof setTimeout = setTimeout,
		private readonly cancel: typeof clearTimeout = clearTimeout,
	) {}

	enqueue(event: ProductEventInput) {
		if (this.queue.length >= PRODUCT_ANALYTICS_LIMITS.queueSize) {
			this.queue.shift();
		}
		this.queue.push({ event, attempts: 0 });

		if (this.queue.length >= PRODUCT_ANALYTICS_LIMITS.batchSize) {
			void this.flush();
		} else {
			this.scheduleFlush(FLUSH_INTERVAL_MS);
		}
	}

	flush(mode: TransportMode = "normal") {
		if (this.inFlight) return this.inFlight;
		if (this.queue.length === 0) return Promise.resolve();

		this.clearTimer();
		const batch = this.takeBatch();
		if (batch.length === 0) return Promise.resolve();
		let retryScheduled = false;
		this.inFlight = this.send(batch, mode)
			.then((scheduled) => {
				retryScheduled = scheduled;
			})
			.finally(() => {
				this.inFlight = undefined;
				if (retryScheduled) return;
				if (this.queue.length >= PRODUCT_ANALYTICS_LIMITS.batchSize) {
					void this.flush();
				} else if (this.queue.length > 0) {
					this.scheduleFlush(FLUSH_INTERVAL_MS);
				}
			});

		return this.inFlight;
	}

	get size() {
		return this.queue.length;
	}

	private async send(batch: QueuedEvent[], mode: TransportMode) {
		let result: TransportResult;
		try {
			result = await this.transport(
				batch.map(({ event }) => event),
				mode,
			);
		} catch {
			result = "retry";
		}

		if (result !== "retry") return false;

		const retryable = batch
			.filter(({ attempts }) => attempts === 0)
			.map(({ event }) => ({ event, attempts: 1 }));
		if (retryable.length === 0) return false;

		this.queue = [...retryable, ...this.queue].slice(
			0,
			PRODUCT_ANALYTICS_LIMITS.queueSize,
		);
		this.scheduleFlush(RETRY_INTERVAL_MS);
		return true;
	}

	private scheduleFlush(delay: number) {
		if (this.timer !== undefined) return;
		this.timer = this.schedule(() => {
			this.timer = undefined;
			void this.flush();
		}, delay);
	}

	private clearTimer() {
		if (this.timer === undefined) return;
		this.cancel(this.timer);
		this.timer = undefined;
	}

	private takeBatch() {
		const batch: QueuedEvent[] = [];

		while (
			batch.length < PRODUCT_ANALYTICS_LIMITS.batchSize &&
			this.queue.length > 0
		) {
			const next = this.queue[0];
			if (!next) break;
			const candidate = [...batch, next];
			const bytes = new TextEncoder().encode(
				JSON.stringify({ events: candidate.map(({ event }) => event) }),
			).byteLength;

			if (bytes > PRODUCT_ANALYTICS_LIMITS.requestBytes) {
				if (batch.length > 0) break;
				this.queue.shift();
				continue;
			}

			batch.push(next);
			this.queue.shift();
		}

		return batch;
	}
}

let browserQueue: ProductAnalyticsQueue | undefined;
let anonymousId: string | undefined;
let sessionId: string | undefined;
let listenersRegistered = false;
let fallbackEventIdCounter = 0;

export function captureProductEvent(
	eventName: string,
	properties?: Record<string, unknown>,
) {
	try {
		if (typeof window === "undefined" || !isCoreEventName(eventName))
			return false;
		if (isServerOnlyEventName(eventName)) return false;

		const normalizedProperties = normalizeProductEventProperties(properties);
		getBrowserQueue().enqueue({
			eventId: createProductEventId(),
			eventName,
			occurredAt: new Date().toISOString(),
			anonymousId: getProductAnalyticsAnonymousId(),
			sessionId: getSessionId(),
			platform: "web",
			pathname: window.location.pathname,
			...(document.referrer ? { referrer: document.referrer } : {}),
			...(normalizedProperties ? { properties: normalizedProperties } : {}),
		});
		return true;
	} catch {
		return false;
	}
}

export function captureProductPageView() {
	return captureProductEvent("page_view", getFirstTouchAttribution());
}

export function shouldCaptureProductPageView(pathname: string) {
	return !["/s", "/c", "/embed"].some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

export function getOrCreateStorageId(
	storage: Pick<Storage, "getItem" | "setItem"> | undefined,
	key: string,
	createId: () => string,
) {
	try {
		const existing = storage?.getItem(key);
		if (existing) return existing;
	} catch {
		return createId();
	}

	const created = createId();
	try {
		storage?.setItem(key, created);
	} catch {}
	return created;
}

export function getOrCreateBrowserAnonymousId(
	storage: Pick<Storage, "getItem" | "setItem"> | undefined,
	cookieId: string | undefined,
	createId: () => string,
) {
	if (!cookieId)
		return getOrCreateStorageId(storage, ANONYMOUS_ID_KEY, createId);
	try {
		storage?.setItem(ANONYMOUS_ID_KEY, cookieId);
	} catch {}
	return cookieId;
}

export function createProductEventId(
	randomUUID: (() => string) | null = getRandomUUID() ?? null,
	now = Date.now(),
	randomValues:
		| ((values: Uint32Array) => Uint32Array)
		| null = getRandomValues() ?? null,
) {
	try {
		const id = randomUUID?.();
		if (id) return id;
	} catch {}

	try {
		if (randomValues) {
			const values = randomValues(new Uint32Array(2));
			return `fallback-${now.toString(36)}-${values[0]?.toString(36)}-${values[1]?.toString(36)}`;
		}
	} catch {}

	fallbackEventIdCounter += 1;
	return `fallback-${now.toString(36)}-counter-${fallbackEventIdCounter.toString(36)}`;
}

export function readFirstTouchAttribution(
	search: string,
	storage?: Pick<Storage, "getItem" | "setItem">,
): ProductEventProperties | undefined {
	try {
		const existing = storage?.getItem(ATTRIBUTION_KEY);
		if (existing) {
			return normalizeProductEventProperties(JSON.parse(existing));
		}

		const params = new URLSearchParams(search);
		const properties: Record<string, string> = {};
		for (const key of ATTRIBUTION_FIELDS) {
			const value = params.get(key)?.trim();
			if (value) properties[key] = value;
		}
		const normalized = normalizeProductEventProperties(properties);
		if (normalized)
			storage?.setItem(ATTRIBUTION_KEY, JSON.stringify(normalized));
		return normalized;
	} catch {
		return undefined;
	}
}

function getBrowserQueue() {
	if (!browserQueue) browserQueue = new ProductAnalyticsQueue(browserTransport);
	registerLifecycleListeners();
	return browserQueue;
}

export function getProductAnalyticsAnonymousId() {
	if (!anonymousId) {
		const storage = getBrowserStorage("localStorage");
		const cookieId = Cookies.get(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE);
		anonymousId = getOrCreateBrowserAnonymousId(
			storage,
			cookieId,
			createProductEventId,
		);
		persistAnonymousIdCookie(anonymousId);
	}
	return anonymousId;
}

function persistAnonymousIdCookie(value: string) {
	try {
		Cookies.set(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE, value, {
			expires: 365,
			path: "/",
			sameSite: "Lax",
			secure: window.location.protocol === "https:",
		});
	} catch {}
}

function getSessionId() {
	if (!sessionId) {
		sessionId = getOrCreateStorageId(
			getBrowserStorage("sessionStorage"),
			SESSION_ID_KEY,
			() => createProductEventId(),
		);
	}
	return sessionId;
}

function getFirstTouchAttribution() {
	return readFirstTouchAttribution(
		window.location.search,
		getBrowserStorage("localStorage"),
	);
}

function getBrowserStorage(name: "localStorage" | "sessionStorage") {
	try {
		return window[name];
	} catch {
		return undefined;
	}
}

function getRandomUUID() {
	try {
		return globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
	} catch {
		return undefined;
	}
}

function getRandomValues() {
	try {
		if (!globalThis.crypto?.getRandomValues) return undefined;
		return (values: Uint32Array) => globalThis.crypto.getRandomValues(values);
	} catch {
		return undefined;
	}
}

function registerLifecycleListeners() {
	if (listenersRegistered) return;
	listenersRegistered = true;
	const flush = () => void browserQueue?.flush("unload");
	window.addEventListener("pagehide", flush, { passive: true });
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flush();
	});
}

export const sendBrowserProductAnalytics = async (
	events: readonly ProductEventInput[],
	mode: TransportMode,
	dependencies: BrowserTransportDependencies = {},
): Promise<TransportResult> => {
	const body = JSON.stringify({ events });
	const sendBeacon =
		dependencies.sendBeacon ??
		(typeof navigator !== "undefined" &&
		typeof navigator.sendBeacon === "function"
			? navigator.sendBeacon.bind(navigator)
			: undefined);
	if (mode === "unload" && sendBeacon) {
		try {
			if (
				sendBeacon(
					"/api/events",
					new Blob([body], { type: "application/json" }),
				)
			) {
				return "success";
			}
		} catch {}
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const response = await (dependencies.fetchImpl ?? fetch)("/api/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			credentials: "include",
			keepalive: mode === "unload",
			signal: controller.signal,
		}).finally(() => clearTimeout(timeout));
		if (response.ok) return "success";
		return response.status === 429 || response.status >= 500 ? "retry" : "drop";
	} catch {
		return "retry";
	}
};

const browserTransport: ProductAnalyticsTransport = (events, mode) =>
	sendBrowserProductAnalytics(events, mode);
