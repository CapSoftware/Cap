import {
	type BrowserAnalyticsContext,
	type ClientProductEventNameForPlatform,
	isCoreEventName,
	isServerOnlyEventName,
	normalizeAnalyticsIdentifier,
	normalizeProductEventInput,
	normalizeProductEventProperties,
	PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE,
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventArguments,
	type ProductEventInput,
	readAnalyticsTouch,
	resolveBrowserAnalyticsContext,
} from "@cap/analytics";
import Cookies from "js-cookie";

const FLUSH_INTERVAL_MS = 5_000;
const RETRY_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 3_000;
const ANONYMOUS_ID_KEY = "cap_analytics_anonymous_id_v1";
const QUEUE_STORAGE_KEY = "cap_analytics_queue_v1";

type TransportResult = "success" | "retry" | "drop";
type TransportMode = "normal" | "unload";
type QueuedEvent = { event: ProductEventInput; attempts: number };
type QueueStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

interface PersistedQueueState {
	version: 1;
	queue: QueuedEvent[];
	inFlight: QueuedEvent[];
	delivery: ProductAnalyticsDeliverySnapshot;
}

interface BrowserTransportDependencies {
	fetchImpl?: typeof fetch;
	sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}

export type ProductAnalyticsTransport = (
	events: readonly ProductEventInput[],
	mode: TransportMode,
	delivery: ProductAnalyticsDeliverySnapshot,
) => Promise<TransportResult>;

export interface ProductAnalyticsDeliverySnapshot {
	attempted: number;
	accepted: number;
	retried: number;
	dropped: number;
	queue_overflow: number;
	oversize: number;
	contract_rejected: number;
	persistence_failed: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeDeliveryCount = (value: unknown, fallback?: number) => {
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error("Persisted analytics delivery count is invalid");
	}
	return value;
};

const normalizeQueuedEvent = (value: unknown): QueuedEvent => {
	if (!isRecord(value) || (value.attempts !== 0 && value.attempts !== 1)) {
		throw new Error("Persisted analytics queue entry is invalid");
	}
	const event = normalizeProductEventInput(value.event);
	if (!event) throw new Error("Persisted analytics event is invalid");
	return { event, attempts: value.attempts };
};

const normalizePersistedQueueState = (value: unknown): PersistedQueueState => {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!Array.isArray(value.queue) ||
		!Array.isArray(value.inFlight) ||
		!isRecord(value.delivery) ||
		value.queue.length > PRODUCT_ANALYTICS_LIMITS.queueSize ||
		value.inFlight.length > PRODUCT_ANALYTICS_LIMITS.batchSize
	) {
		throw new Error("Persisted analytics queue state is invalid");
	}
	const delivery = value.delivery;
	return {
		version: 1,
		queue: value.queue.map(normalizeQueuedEvent),
		inFlight: value.inFlight.map(normalizeQueuedEvent),
		delivery: {
			attempted: normalizeDeliveryCount(delivery.attempted),
			accepted: normalizeDeliveryCount(delivery.accepted),
			retried: normalizeDeliveryCount(delivery.retried),
			dropped: normalizeDeliveryCount(delivery.dropped),
			queue_overflow: normalizeDeliveryCount(delivery.queue_overflow),
			oversize: normalizeDeliveryCount(delivery.oversize),
			contract_rejected: normalizeDeliveryCount(delivery.contract_rejected, 0),
			persistence_failed: normalizeDeliveryCount(
				delivery.persistence_failed,
				0,
			),
		},
	};
};

export class ProductAnalyticsQueue {
	private queue: QueuedEvent[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private inFlight: Promise<void> | undefined;
	private delivery: ProductAnalyticsDeliverySnapshot = {
		attempted: 0,
		accepted: 0,
		retried: 0,
		dropped: 0,
		queue_overflow: 0,
		oversize: 0,
		contract_rejected: 0,
		persistence_failed: 0,
	};
	private persistedInFlight: QueuedEvent[] = [];

	constructor(
		private readonly transport: ProductAnalyticsTransport,
		private readonly schedule: typeof setTimeout = setTimeout,
		private readonly cancel: typeof clearTimeout = clearTimeout,
		private readonly storage?: QueueStorage | null,
	) {
		if (this.storage === null) this.delivery.persistence_failed += 1;
		this.restore();
		if (this.queue.length > 0) this.scheduleFlush(RETRY_INTERVAL_MS);
	}

	enqueue(event: ProductEventInput) {
		if (this.queue.length >= PRODUCT_ANALYTICS_LIMITS.queueSize) {
			this.queue.shift();
			this.delivery.dropped += 1;
			this.delivery.queue_overflow += 1;
		}
		this.queue.push({ event, attempts: 0 });
		this.persist();

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
		if (batch.length === 0) {
			this.persist();
			return Promise.resolve();
		}
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

	get deliverySnapshot() {
		return { ...this.delivery };
	}

	recordContractRejection() {
		this.delivery.dropped += 1;
		this.delivery.contract_rejected += 1;
		this.persist();
	}

	private async send(batch: QueuedEvent[], mode: TransportMode) {
		let result: TransportResult;
		this.delivery.attempted += batch.length;
		this.persistedInFlight = batch;
		this.persist();
		try {
			result = await this.transport(
				batch.map(({ event }) => event),
				mode,
				this.deliverySnapshot,
			);
		} catch {
			result = "retry";
		}

		if (result === "success") {
			this.delivery.accepted += batch.length;
			this.persistedInFlight = [];
			this.persist();
			return false;
		}
		if (result === "drop") {
			this.delivery.dropped += batch.length;
			this.persistedInFlight = [];
			this.persist();
			return false;
		}
		this.delivery.retried += batch.length;

		const retryable = batch
			.filter(({ attempts }) => attempts === 0)
			.map(({ event }) => ({ event, attempts: 1 }));
		if (retryable.length === 0) {
			this.delivery.dropped += batch.length;
			this.persistedInFlight = [];
			this.persist();
			return false;
		}

		const nextQueue = [...retryable, ...this.queue];
		const overflow = Math.max(
			0,
			nextQueue.length - PRODUCT_ANALYTICS_LIMITS.queueSize,
		);
		this.queue = nextQueue.slice(0, PRODUCT_ANALYTICS_LIMITS.queueSize);
		this.delivery.dropped += overflow;
		this.delivery.queue_overflow += overflow;
		this.persistedInFlight = [];
		this.persist();
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
				this.delivery.dropped += 1;
				this.delivery.oversize += 1;
				continue;
			}

			batch.push(next);
			this.queue.shift();
		}

		return batch;
	}

	private restore() {
		if (!this.storage) return;
		let state: PersistedQueueState;
		try {
			const serialized = this.storage.getItem(QUEUE_STORAGE_KEY);
			if (!serialized) return;
			const parsed = JSON.parse(serialized) as unknown;
			state = normalizePersistedQueueState(parsed);
		} catch {
			this.delivery.persistence_failed += 1;
			try {
				this.storage.removeItem(QUEUE_STORAGE_KEY);
			} catch {}
			return;
		}
		this.delivery = state.delivery;
		const recovered: QueuedEvent[] = [];
		for (const item of state.inFlight) {
			if (item.attempts === 0) {
				recovered.push({ event: item.event, attempts: 1 });
				this.delivery.retried += 1;
			} else {
				this.delivery.dropped += 1;
			}
		}
		this.queue = [...recovered, ...state.queue].slice(
			0,
			PRODUCT_ANALYTICS_LIMITS.queueSize,
		);
		this.delivery.dropped += Math.max(
			0,
			recovered.length + state.queue.length - this.queue.length,
		);
		this.delivery.queue_overflow += Math.max(
			0,
			recovered.length + state.queue.length - this.queue.length,
		);
		this.persistedInFlight = [];
		this.persist();
	}

	private persist() {
		if (!this.storage) return;
		try {
			this.storage.setItem(
				QUEUE_STORAGE_KEY,
				JSON.stringify({
					version: 1,
					queue: this.queue,
					inFlight: this.persistedInFlight,
					delivery: this.delivery,
				} satisfies PersistedQueueState),
			);
		} catch {
			this.delivery.persistence_failed += 1;
		}
	}
}

let browserQueue: ProductAnalyticsQueue | undefined;
let anonymousId: string | undefined;
let listenersRegistered = false;
let fallbackEventIdCounter = 0;

export function captureProductEvent<
	Name extends ClientProductEventNameForPlatform<"web">,
>(eventName: Name, ...args: ProductEventArguments<Name>) {
	return enqueueBrowserProductEvent(
		eventName,
		args,
		resolveBrowserAnalyticsContext({
			storage: getBrowserStorage("localStorage"),
			createId: createProductEventId,
		}),
	);
}

function enqueueBrowserProductEvent<
	Name extends ClientProductEventNameForPlatform<"web">,
>(
	eventName: Name,
	args: ProductEventArguments<Name>,
	context: ReturnType<typeof resolveBrowserAnalyticsContext>,
	pathname = window.location.pathname,
) {
	try {
		if (typeof window === "undefined") {
			return undefined;
		}
		if (!isCoreEventName(eventName) || isServerOnlyEventName(eventName)) {
			getBrowserQueue().recordContractRejection();
			return undefined;
		}

		const normalizedProperties = normalizeProductEventProperties(
			eventName,
			args[0] as Record<string, unknown> | undefined,
		);
		if (normalizedProperties === null) {
			getBrowserQueue().recordContractRejection();
			return undefined;
		}
		const eventId = createProductEventId();
		getBrowserQueue().enqueue({
			eventId,
			eventName,
			occurredAt: new Date().toISOString(),
			anonymousId: getProductAnalyticsAnonymousId(),
			sessionId: context.sessionId,
			platform: "web",
			pathname,
			...(document.referrer ? { referrer: document.referrer } : {}),
			...(normalizedProperties ? { properties: normalizedProperties } : {}),
		});
		return eventId;
	} catch {
		return undefined;
	}
}

export function captureProductPageEngagement(
	pageViewId: string,
	sessionId: string,
	sessionStartedAt: string,
	pathname: string,
	engagedMs: number,
	maxScrollDepth: number,
) {
	return enqueueBrowserProductEvent(
		"page_engagement",
		[
			{
				page_view_id: pageViewId,
				session_started_at: sessionStartedAt,
				engaged_ms: Math.max(0, Math.round(engagedMs)),
				max_scroll_depth: Math.max(0, Math.min(100, maxScrollDepth)),
			},
		],
		{
			sessionId,
			sessionStartedAt,
			isSessionEntry: false,
			attribution: {},
		},
		pathname,
	);
}

export function captureProductPageView(
	context: BrowserAnalyticsContext = touchProductAnalyticsSession(),
) {
	const eventId = enqueueBrowserProductEvent(
		"page_view",
		[
			{
				...context.attribution,
				hostname: window.location.hostname,
				is_session_entry: context.isSessionEntry,
				session_started_at: context.sessionStartedAt,
			},
		],
		context,
	);
	return eventId
		? {
				eventId,
				sessionId: context.sessionId,
				sessionStartedAt: context.sessionStartedAt,
			}
		: undefined;
}

export function touchProductAnalyticsSession() {
	return resolveBrowserAnalyticsContext({
		storage: getBrowserStorage("localStorage"),
		createId: createProductEventId,
		touch: readAnalyticsTouch(window.location.search),
	});
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
		const existing = normalizeAnalyticsIdentifier(storage?.getItem(key));
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
	const normalizedCookieId = normalizeAnalyticsIdentifier(cookieId);
	if (!normalizedCookieId)
		return getOrCreateStorageId(storage, ANONYMOUS_ID_KEY, createId);
	try {
		storage?.setItem(ANONYMOUS_ID_KEY, normalizedCookieId);
	} catch {}
	return normalizedCookieId;
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

function getBrowserQueue() {
	if (!browserQueue) {
		browserQueue = new ProductAnalyticsQueue(
			browserTransport,
			setTimeout,
			clearTimeout,
			getBrowserStorage("localStorage") ?? null,
		);
	}
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

function getBrowserStorage(name: "localStorage") {
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
	delivery?: ProductAnalyticsDeliverySnapshot,
): Promise<TransportResult> => {
	const body = JSON.stringify({ events, ...(delivery ? { delivery } : {}) });
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
				return "retry";
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

const browserTransport: ProductAnalyticsTransport = (events, mode, delivery) =>
	sendBrowserProductAnalytics(events, mode, {}, delivery);

export function getProductAnalyticsDeliverySnapshot() {
	return getBrowserQueue().deliverySnapshot;
}

export function flushBrowserProductAnalytics(mode: TransportMode = "normal") {
	return browserQueue?.flush(mode) ?? Promise.resolve();
}
