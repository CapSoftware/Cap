import {
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventInput,
} from "@cap/analytics";

export const PRODUCT_ANALYTICS_BATCH_SIZE = PRODUCT_ANALYTICS_LIMITS.batchSize;
export const PRODUCT_ANALYTICS_QUEUE_CAPACITY =
	PRODUCT_ANALYTICS_LIMITS.queueSize;
export const PRODUCT_ANALYTICS_BATCH_DELAY_MS = 250;
export const PRODUCT_ANALYTICS_RETRY_DELAY_MS = 500;

type QueuedEvent = {
	event: ProductEventInput;
	attempts: number;
};

type ProductAnalyticsQueueOptions = {
	sendBatch: (events: ProductEventInput[]) => Promise<void>;
	isEnabled: () => boolean | Promise<boolean>;
	batchSize?: number;
	capacity?: number;
	batchDelayMs?: number;
	retryDelayMs?: number;
	maxBatchBytes?: number;
	onDrop?: (count: number) => void;
};

export class ProductAnalyticsQueue {
	readonly #sendBatch: ProductAnalyticsQueueOptions["sendBatch"];
	readonly #isEnabled: ProductAnalyticsQueueOptions["isEnabled"];
	readonly #batchSize: number;
	readonly #capacity: number;
	readonly #batchDelayMs: number;
	readonly #retryDelayMs: number;
	readonly #maxBatchBytes: number;
	readonly #onDrop: ProductAnalyticsQueueOptions["onDrop"];
	#queue: QueuedEvent[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inFlight = false;
	#dropped = 0;

	constructor(options: ProductAnalyticsQueueOptions) {
		this.#sendBatch = options.sendBatch;
		this.#isEnabled = options.isEnabled;
		this.#batchSize = options.batchSize ?? PRODUCT_ANALYTICS_BATCH_SIZE;
		this.#capacity = options.capacity ?? PRODUCT_ANALYTICS_QUEUE_CAPACITY;
		this.#batchDelayMs =
			options.batchDelayMs ?? PRODUCT_ANALYTICS_BATCH_DELAY_MS;
		this.#retryDelayMs =
			options.retryDelayMs ?? PRODUCT_ANALYTICS_RETRY_DELAY_MS;
		this.#maxBatchBytes =
			options.maxBatchBytes ?? PRODUCT_ANALYTICS_LIMITS.requestBytes;
		this.#onDrop = options.onDrop;
	}

	get size() {
		return this.#queue.length;
	}

	get dropped() {
		return this.#dropped;
	}

	enqueue(event: ProductEventInput) {
		if (this.#queue.length >= this.#capacity) {
			this.#queue.shift();
			this.#recordDrop(1);
		}

		this.#queue.push({ event, attempts: 0 });
		if (this.#queue.length >= this.#batchSize) {
			void this.flush();
		} else {
			this.#schedule(this.#batchDelayMs);
		}
	}

	clear() {
		if (this.#queue.length > 0) {
			this.#recordDrop(this.#queue.length);
			this.#queue = [];
		}
		this.#cancelTimer();
	}

	async flush() {
		if (this.#inFlight || this.#queue.length === 0) return;

		this.#inFlight = true;
		this.#cancelTimer();

		try {
			if (!(await this.#isEnabled())) {
				this.clear();
				return;
			}

			const batch = this.#takeBatch();
			if (batch.length === 0) return;
			try {
				await this.#sendBatch(batch.map(({ event }) => event));
			} catch {
				if (!(await this.#isEnabled())) {
					this.#recordDrop(batch.length);
					return;
				}
				const retryable = batch
					.filter(({ attempts }) => attempts === 0)
					.map(({ event, attempts }) => ({ event, attempts: attempts + 1 }));
				this.#recordDrop(batch.length - retryable.length);
				const queued = [...retryable, ...this.#queue];
				const overflow = Math.max(0, queued.length - this.#capacity);
				this.#recordDrop(overflow);
				this.#queue = queued.slice(overflow);
				if (this.#queue.length > 0) this.#schedule(this.#retryDelayMs);
				return;
			}
		} finally {
			this.#inFlight = false;
		}

		if (this.#queue.length > 0) {
			this.#schedule(this.#batchDelayMs);
		}
	}

	#schedule(delayMs: number) {
		if (this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.flush();
		}, delayMs);
	}

	#cancelTimer() {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#recordDrop(count: number) {
		if (count === 0) return;
		this.#dropped += count;
		this.#onDrop?.(count);
	}

	#takeBatch() {
		const batch: QueuedEvent[] = [];

		while (batch.length < this.#batchSize && this.#queue.length > 0) {
			const next = this.#queue[0];
			if (!next) break;
			const candidate = [...batch, next];
			const bytes = new TextEncoder().encode(
				JSON.stringify({ events: candidate.map(({ event }) => event) }),
			).byteLength;

			if (bytes > this.#maxBatchBytes) {
				if (batch.length > 0) break;
				this.#queue.shift();
				this.#recordDrop(1);
				continue;
			}

			batch.push(next);
			this.#queue.shift();
		}

		return batch;
	}
}
