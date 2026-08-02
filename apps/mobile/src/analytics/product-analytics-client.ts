import {
	type ClientProductEventNameForPlatform,
	createProductEventPayloadHash,
	getProductEventDefinition,
	normalizeProductEventInput,
	PRODUCT_ANALYTICS_CLIENT_SCHEMA_VERSION,
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventArguments,
	type ProductEventInput,
} from "@cap/analytics";

export type MobileProductEventName =
	ClientProductEventNameForPlatform<"mobile">;

type PendingEvent = {
	event: ProductEventInput;
	credentialScope: string;
	attempts: number;
	nextAttemptAt: number;
};

type DeadLetter = {
	eventId: string;
	eventName: string;
	credentialScope?: string;
	failedAt: string;
	reason:
		| "contract"
		| "identity_changed"
		| "queue_overflow"
		| "storage_corrupt";
	status?: number;
};

type EventLedgerEntry = {
	eventId: string;
	payloadHash: string;
	credentialScope: string;
	outcome: "accepted" | "dead_letter" | "dropped";
	finalizedAt: string;
};

type DeliveryCounters = {
	attempted: number;
	accepted: number;
	retried: number;
	dropped: number;
	queue_overflow: number;
	oversize: number;
	contract_rejected: number;
	persistence_failed: number;
};

export type MobileProductAnalyticsState = {
	version: 2;
	anonymousIds: Record<string, string>;
	pending: PendingEvent[];
	deadLetters: DeadLetter[];
	deadLetterEvicted: number;
	eventLedger: EventLedgerEntry[];
	delivery: DeliveryCounters;
};

type MobileProductAnalyticsClientOptions = {
	readState: () => Promise<unknown>;
	writeState: (state: MobileProductAnalyticsState) => Promise<void>;
	createId: () => string;
	getAppVersion: () => string | undefined;
	fetchImpl?: typeof fetch;
	now?: () => number;
	setTimer?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	queueCapacity?: number;
	deadLetterCapacity?: number;
	eventLedgerCapacity?: number;
	requestTimeoutMs?: number;
};

const emptyCounters = (): DeliveryCounters => ({
	attempted: 0,
	accepted: 0,
	retried: 0,
	dropped: 0,
	queue_overflow: 0,
	oversize: 0,
	contract_rejected: 0,
	persistence_failed: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const safeCount = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: 0;

const hydrateState = (
	value: unknown,
	createId: () => string,
	now: number,
): MobileProductAnalyticsState => {
	const state: MobileProductAnalyticsState = {
		version: 2,
		anonymousIds: {},
		pending: [],
		deadLetters: [],
		deadLetterEvicted: 0,
		eventLedger: [],
		delivery: emptyCounters(),
	};
	if (!isRecord(value) || ![1, 2].includes(Number(value.version))) return state;
	if (value.version === 2 && isRecord(value.anonymousIds)) {
		for (const [credentialScope, anonymousId] of Object.entries(
			value.anonymousIds,
		)) {
			if (
				credentialScope &&
				typeof anonymousId === "string" &&
				anonymousId.length > 0
			) {
				state.anonymousIds[credentialScope] = anonymousId;
			}
		}
	}
	if (isRecord(value.delivery)) {
		for (const key of Object.keys(state.delivery) as Array<
			keyof DeliveryCounters
		>) {
			state.delivery[key] = safeCount(value.delivery[key]);
		}
	}
	state.deadLetterEvicted = safeCount(value.deadLetterEvicted);
	if (Array.isArray(value.deadLetters)) {
		state.deadLetters = value.deadLetters.flatMap((entry) => {
			if (
				!isRecord(entry) ||
				typeof entry.eventId !== "string" ||
				typeof entry.eventName !== "string" ||
				typeof entry.failedAt !== "string" ||
				![
					"contract",
					"identity_changed",
					"queue_overflow",
					"storage_corrupt",
				].includes(String(entry.reason))
			) {
				return [];
			}
			return [entry as DeadLetter];
		});
	}
	if (Array.isArray(value.eventLedger)) {
		state.eventLedger = value.eventLedger.flatMap((entry) => {
			if (
				!isRecord(entry) ||
				typeof entry.eventId !== "string" ||
				typeof entry.payloadHash !== "string" ||
				typeof entry.credentialScope !== "string" ||
				typeof entry.finalizedAt !== "string" ||
				!["accepted", "dead_letter", "dropped"].includes(String(entry.outcome))
			) {
				return [];
			}
			return [entry as EventLedgerEntry];
		});
	}
	if (Array.isArray(value.pending)) {
		for (const entry of value.pending) {
			if (!isRecord(entry)) continue;
			if (
				typeof entry.credentialScope !== "string" ||
				entry.credentialScope.length === 0
			) {
				continue;
			}
			const event = normalizeProductEventInput(entry.event, now);
			if (!event || event.platform !== "mobile") {
				const stored = isRecord(entry.event) ? entry.event : {};
				state.deadLetters.push({
					eventId:
						typeof stored.eventId === "string" ? stored.eventId : createId(),
					eventName:
						typeof stored.eventName === "string" ? stored.eventName : "unknown",
					failedAt: new Date(now).toISOString(),
					reason: "storage_corrupt",
				});
				continue;
			}
			state.pending.push({
				event,
				credentialScope: entry.credentialScope,
				attempts: safeCount(entry.attempts),
				nextAttemptAt: safeCount(entry.nextAttemptAt),
			});
		}
	}
	return state;
};

export class MobileProductAnalyticsClient {
	readonly #options: Required<
		Pick<
			MobileProductAnalyticsClientOptions,
			| "fetchImpl"
			| "now"
			| "setTimer"
			| "clearTimer"
			| "queueCapacity"
			| "deadLetterCapacity"
			| "eventLedgerCapacity"
			| "requestTimeoutMs"
		>
	> &
		Omit<
			MobileProductAnalyticsClientOptions,
			| "fetchImpl"
			| "now"
			| "setTimer"
			| "clearTimer"
			| "queueCapacity"
			| "deadLetterCapacity"
			| "eventLedgerCapacity"
			| "requestTimeoutMs"
		>;
	#state: MobileProductAnalyticsState | null = null;
	#initializing: Promise<void> | null = null;
	#flushing: Promise<void> | null = null;
	#mutationQueue: Promise<void> = Promise.resolve();
	#timer: ReturnType<typeof setTimeout> | null = null;
	#apiKey: string | null = null;
	#credentialScope: string | null = null;
	#baseUrl: string | null = null;

	constructor(options: MobileProductAnalyticsClientOptions) {
		this.#options = {
			...options,
			fetchImpl: options.fetchImpl ?? fetch,
			now: options.now ?? Date.now,
			setTimer: options.setTimer ?? setTimeout,
			clearTimer: options.clearTimer ?? clearTimeout,
			queueCapacity: options.queueCapacity ?? 500,
			deadLetterCapacity: options.deadLetterCapacity ?? 100,
			eventLedgerCapacity: options.eventLedgerCapacity ?? 1_000,
			requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
		};
	}

	async configure(input: {
		apiKey: string | null;
		credentialScope: string | null;
		baseUrl: string;
	}) {
		await this.#serialize(async () => {
			this.#apiKey = input.apiKey;
			this.#credentialScope = input.credentialScope;
			this.#baseUrl = input.baseUrl;
			await this.#initialize();
		});
		if (input.apiKey) await this.flush();
	}

	async track<Name extends MobileProductEventName>(
		eventName: Name,
		...args: ProductEventArguments<Name>
	) {
		return this.trackWithId(
			this.#options.createId(),
			new Date(this.#options.now()).toISOString(),
			eventName,
			...args,
		);
	}

	async trackWithId<Name extends MobileProductEventName>(
		eventId: string,
		occurredAt: string,
		eventName: Name,
		...args: ProductEventArguments<Name>
	) {
		const trackedEventId = await this.#serialize(async () => {
			await this.#initialize();
			const state = this.#requireState();
			const credentialScope = this.#credentialScope;
			if (!credentialScope) {
				throw new Error("Mobile analytics requires an authenticated scope");
			}
			const anonymousId =
				state.anonymousIds[credentialScope] ?? this.#options.createId();
			state.anonymousIds[credentialScope] = anonymousId;
			const event = normalizeProductEventInput(
				{
					eventId,
					eventName,
					occurredAt,
					anonymousId,
					schemaVersion: PRODUCT_ANALYTICS_CLIENT_SCHEMA_VERSION,
					platform: "mobile",
					appVersion: this.#options.getAppVersion(),
					...(args[0] ? { properties: args[0] } : {}),
				},
				this.#options.now(),
			);
			if (!event) throw new Error("Invalid mobile product analytics event");
			const payloadHash = createProductEventPayloadHash(event);
			const existing = state.pending.find(
				(entry) => entry.event.eventId === event.eventId,
			);
			const finalized = state.eventLedger.find(
				(entry) => entry.eventId === event.eventId,
			);
			if (
				(existing &&
					(existing.credentialScope !== credentialScope ||
						createProductEventPayloadHash(existing.event) !== payloadHash)) ||
				(finalized &&
					(finalized.credentialScope !== credentialScope ||
						finalized.payloadHash !== payloadHash))
			) {
				throw new Error("Conflicting mobile product analytics event id");
			}
			if (finalized) return event.eventId;
			if (!existing) {
				this.#makeRoom();
				state.pending.push({
					event,
					credentialScope,
					attempts: 0,
					nextAttemptAt: 0,
				});
			}
			const persisted = await this.#persist();
			if (
				!persisted &&
				getProductEventDefinition(event.eventName).delivery === "critical"
			) {
				throw new Error("Critical mobile analytics persistence failed");
			}
			return event.eventId;
		});
		void this.flush();
		return trackedEventId;
	}

	async flush() {
		if (this.#flushing) return this.#flushing;
		this.#flushing = this.#serialize(async () => {
			await this.#initialize();
			if (!this.#apiKey || !this.#baseUrl) return;
			await this.#flushLoop();
		}).finally(() => {
			this.#flushing = null;
		});
		return this.#flushing;
	}

	async snapshot() {
		return this.#serialize(async () => {
			await this.#initialize();
			return structuredClone(this.#requireState());
		});
	}

	async purgeCredentialScope(credentialScope: string) {
		await this.#serialize(async () => {
			await this.#initialize();
			const state = this.#requireState();
			state.pending = state.pending.filter(
				(entry) => entry.credentialScope !== credentialScope,
			);
			state.deadLetters = state.deadLetters.filter(
				(entry) =>
					Boolean(entry.credentialScope) &&
					entry.credentialScope !== credentialScope,
			);
			state.eventLedger = state.eventLedger.filter(
				(entry) => entry.credentialScope !== credentialScope,
			);
			delete state.anonymousIds[credentialScope];
			const persisted = await this.#persist();
			if (!persisted) throw new Error("Mobile analytics purge failed");
		});
	}

	#serialize<T>(operation: () => Promise<T>) {
		const result = this.#mutationQueue.then(operation, operation);
		this.#mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #initialize() {
		if (this.#state) return;
		if (!this.#initializing) {
			this.#initializing = this.#options
				.readState()
				.then((value) => {
					this.#state = hydrateState(
						value,
						this.#options.createId,
						this.#options.now(),
					);
					this.#trimDeadLetters();
				})
				.catch(() => {
					this.#state = hydrateState(
						null,
						this.#options.createId,
						this.#options.now(),
					);
				});
		}
		await this.#initializing;
	}

	#requireState() {
		if (!this.#state) throw new Error("Mobile analytics is not initialized");
		return this.#state;
	}

	#makeRoom() {
		const state = this.#requireState();
		if (state.pending.length < this.#options.queueCapacity) return;
		const bestEffortIndex = state.pending.findIndex(
			(entry) =>
				getProductEventDefinition(entry.event.eventName).delivery ===
				"best_effort",
		);
		const index = bestEffortIndex >= 0 ? bestEffortIndex : 0;
		const [removed] = state.pending.splice(index, 1);
		state.delivery.queue_overflow += 1;
		if (
			removed &&
			getProductEventDefinition(removed.event.eventName).delivery === "critical"
		) {
			this.#deadLetter(
				removed.event,
				"queue_overflow",
				undefined,
				removed.credentialScope,
			);
		} else {
			state.delivery.dropped += 1;
		}
		if (removed) {
			this.#recordFinalizedEvent(
				removed.event,
				removed.credentialScope,
				getProductEventDefinition(removed.event.eventName).delivery ===
					"critical"
					? "dead_letter"
					: "dropped",
			);
		}
	}

	async #flushLoop() {
		while (this.#apiKey && this.#baseUrl && this.#credentialScope) {
			const state = this.#requireState();
			const now = this.#options.now();
			const batch = state.pending
				.filter(
					(entry) =>
						entry.credentialScope === this.#credentialScope &&
						entry.nextAttemptAt <= now,
				)
				.slice(0, PRODUCT_ANALYTICS_LIMITS.batchSize);
			if (batch.length === 0) {
				this.#scheduleNext();
				return;
			}
			state.delivery.attempted += batch.length;
			await this.#persist();
			let response: Response;
			const abortController = new AbortController();
			const requestTimer = this.#options.setTimer(
				() => abortController.abort(),
				this.#options.requestTimeoutMs,
			);
			try {
				response = await this.#options.fetchImpl(
					new URL("/api/events", this.#baseUrl),
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${this.#apiKey}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							events: batch.map((entry) => entry.event),
							delivery: state.delivery,
						}),
						signal: abortController.signal,
					},
				);
			} catch {
				await this.#retry(batch);
				return;
			} finally {
				this.#options.clearTimer(requestTimer);
			}
			if (response.ok) {
				const payload = (await response.json().catch(() => null)) as unknown;
				if (!isRecord(payload)) {
					await this.#retry(batch);
					return;
				}
				const requestedIds = new Set(batch.map((entry) => entry.event.eventId));
				const rawAcceptedEventIds = Array.isArray(payload.acceptedEventIds)
					? payload.acceptedEventIds
					: undefined;
				const rawRejectedEventIds = Array.isArray(payload.rejectedEventIds)
					? payload.rejectedEventIds
					: undefined;
				const hasSelectiveResult = Boolean(
					rawAcceptedEventIds && rawRejectedEventIds,
				);
				const acceptedEventIds = hasSelectiveResult
					? (rawAcceptedEventIds ?? []).filter(
							(eventId: unknown): eventId is string =>
								typeof eventId === "string" && requestedIds.has(eventId),
						)
					: payload.accepted === batch.length
						? [...requestedIds]
						: [];
				const rejectedEventIds = hasSelectiveResult
					? (rawRejectedEventIds ?? []).filter(
							(eventId: unknown): eventId is string =>
								typeof eventId === "string" && requestedIds.has(eventId),
						)
					: [];
				if (
					payload.accepted !== acceptedEventIds.length ||
					acceptedEventIds.length + rejectedEventIds.length !==
						requestedIds.size ||
					new Set([...acceptedEventIds, ...rejectedEventIds]).size !==
						requestedIds.size
				) {
					await this.#retry(batch);
					return;
				}
				const ids = new Set([...acceptedEventIds, ...rejectedEventIds]);
				state.pending = state.pending.filter(
					(entry) => !ids.has(entry.event.eventId),
				);
				state.delivery.accepted += acceptedEventIds.length;
				state.delivery.contract_rejected += rejectedEventIds.length;
				for (const entry of batch) {
					if (acceptedEventIds.includes(entry.event.eventId)) {
						this.#recordFinalizedEvent(
							entry.event,
							entry.credentialScope,
							"accepted",
						);
					} else {
						this.#deadLetter(
							entry.event,
							"contract",
							409,
							entry.credentialScope,
						);
						this.#recordFinalizedEvent(
							entry.event,
							entry.credentialScope,
							"dead_letter",
						);
					}
				}
				await this.#persist();
				continue;
			}
			if (
				response.status === 401 ||
				response.status === 403 ||
				response.status === 404 ||
				response.status === 410 ||
				response.status === 429 ||
				response.status >= 500
			) {
				await this.#retry(batch);
				return;
			}
			const ids = new Set(batch.map((entry) => entry.event.eventId));
			state.pending = state.pending.filter(
				(entry) => !ids.has(entry.event.eventId),
			);
			state.delivery.contract_rejected += batch.length;
			for (const entry of batch) {
				this.#deadLetter(
					entry.event,
					"contract",
					response.status,
					entry.credentialScope,
				);
				this.#recordFinalizedEvent(
					entry.event,
					entry.credentialScope,
					"dead_letter",
				);
			}
			await this.#persist();
		}
	}

	async #retry(batch: PendingEvent[]) {
		const now = this.#options.now();
		for (const entry of batch) {
			entry.attempts += 1;
			entry.nextAttemptAt =
				now + Math.min(5 * 60_000, 1000 * 2 ** Math.min(entry.attempts - 1, 8));
		}
		this.#requireState().delivery.retried += batch.length;
		await this.#persist();
		this.#scheduleNext();
	}

	#scheduleNext() {
		if (this.#timer) this.#options.clearTimer(this.#timer);
		const nextAttemptAt = this.#requireState().pending.reduce(
			(next, entry) => Math.min(next, entry.nextAttemptAt),
			Number.POSITIVE_INFINITY,
		);
		if (!Number.isFinite(nextAttemptAt)) return;
		this.#timer = this.#options.setTimer(
			() => {
				this.#timer = null;
				void this.flush();
			},
			Math.max(0, nextAttemptAt - this.#options.now()),
		);
	}

	#deadLetter(
		event: ProductEventInput,
		reason: DeadLetter["reason"],
		status?: number,
		credentialScope?: string,
	) {
		this.#requireState().deadLetters.push({
			eventId: event.eventId,
			eventName: event.eventName,
			...(credentialScope ? { credentialScope } : {}),
			failedAt: new Date(this.#options.now()).toISOString(),
			reason,
			...(status ? { status } : {}),
		});
		this.#trimDeadLetters();
	}

	#recordFinalizedEvent(
		event: ProductEventInput,
		credentialScope: string,
		outcome: EventLedgerEntry["outcome"],
	) {
		const state = this.#requireState();
		state.eventLedger = state.eventLedger.filter(
			(entry) => entry.eventId !== event.eventId,
		);
		state.eventLedger.push({
			eventId: event.eventId,
			payloadHash: createProductEventPayloadHash(event),
			credentialScope,
			outcome,
			finalizedAt: new Date(this.#options.now()).toISOString(),
		});
		const excess = state.eventLedger.length - this.#options.eventLedgerCapacity;
		if (excess > 0) state.eventLedger.splice(0, excess);
	}

	#trimDeadLetters() {
		const state = this.#requireState();
		const excess = state.deadLetters.length - this.#options.deadLetterCapacity;
		if (excess <= 0) return;
		state.deadLetters.splice(0, excess);
		state.deadLetterEvicted += excess;
	}

	async #persist() {
		try {
			await this.#options.writeState(structuredClone(this.#requireState()));
			return true;
		} catch {
			this.#requireState().delivery.persistence_failed += 1;
			return false;
		}
	}
}
