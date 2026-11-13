import type { Config } from "./config";
import { ApiError, LocalError } from "./errors";
import { ROUTES, type Route, type RouteName } from "./routes";
import { cancelled, sleep, timeLimit } from "./time";

export type CallInput = {
	id?: string;
	query?: Record<string, string | number | undefined>;
	body?: Record<string, unknown>;
	headers?: Record<string, string>;
	token?: string;
	signal?: AbortSignal;
	deadlineAt?: number;
	once?: boolean;
};

export type ClientTuning = {
	requestTimeoutMs: number;
	callTimeoutMs: number;
	rateLimitRetries: number;
	transientRetries: number;
};

export const DEFAULT_CLIENT_TUNING: ClientTuning = {
	requestTimeoutMs: 30_000,
	callTimeoutMs: 90_000,
	rateLimitRetries: 3,
	transientRetries: 2,
};

const RETRY_AFTER_FALLBACK_MS = 5_000;
const RETRY_AFTER_PAD_MS = 250;
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const DETAIL_FIELDS = [
	"standing",
	"pausesAt",
	"balanceMicroCredits",
	"requiredMicroCredits",
	"shortfallMicroCredits",
	"fileRemoved",
] as const;

type Reply = { status: number; retryAfterMs: number | null; body: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) =>
	typeof value === "string" && value.length > 0 ? value : null;

export function retryAfterMs(header: string | null, now: number = Date.now()) {
	if (header === null) return null;
	const trimmed = header.trim();
	if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function issueLines(issues: unknown) {
	if (!Array.isArray(issues)) return null;
	return issues.slice(0, 10).map((issue) => {
		const fields = isRecord(issue) ? issue : {};
		const path = Array.isArray(fields.path) ? fields.path.join(".") : "";
		const message = text(fields.message) ?? "invalid";
		return path ? `${path}: ${message}` : message;
	});
}

function apiError(reply: Reply) {
	const body = isRecord(reply.body) ? reply.body : {};
	const details: Record<string, unknown> = {};
	for (const field of DETAIL_FIELDS) {
		if (body[field] !== undefined) details[field] = body[field];
	}
	const issues = issueLines(body.issues);
	if (issues) details.issues = issues;
	return new ApiError(
		reply.status,
		text(body.code) ?? `http_${reply.status}`,
		text(body.message) ??
			text(body.error) ??
			`Cap answered with status ${reply.status}`,
		text(body.hint),
		details,
		reply.retryAfterMs === null ? null : Math.ceil(reply.retryAfterMs / 1000),
	);
}

function unreachable(error: unknown, what: string) {
	const cause = isRecord(error) && isRecord(error.cause) ? error.cause : {};
	const code = text(cause.code);
	return new LocalError(
		"network_error",
		code ? `Could not reach ${what} (${code})` : `Could not reach ${what}`,
		"Check the network connection, then run the tool again.",
	);
}

const timedOut = (what: string, ms: number) =>
	new LocalError(
		"timeout",
		ms < 1000
			? `${what} did not answer within ${Math.round(ms)} ms`
			: `${what} did not answer within ${Math.round(ms / 1000)} seconds`,
		"Run the tool again.",
	);

const outOfTime = () =>
	new LocalError(
		"timeout",
		"The time allowed for this call ran out before Cap could be asked",
		"Run the tool again.",
	);

export class InfraClient {
	private pausedUntil = 0;

	constructor(
		private readonly config: Pick<Config, "apiUrl" | "secretKey">,
		private readonly tuning: ClientTuning = DEFAULT_CLIENT_TUNING,
	) {}

	async call(name: RouteName, input: CallInput = {}): Promise<unknown> {
		const route: Route = ROUTES[name];
		const url = this.url(route, input);
		const deadlineAt =
			input.deadlineAt ?? Date.now() + this.tuning.callTimeoutMs;
		const shared = route.auth === "secret";
		let rateLimited = 0;
		let transient = 0;

		for (;;) {
			if (shared) await this.waitForRateLimit(deadlineAt, input.signal);

			let reply: Reply;
			try {
				reply = await this.send(route, url, input, deadlineAt);
			} catch (error) {
				const retry =
					!input.once &&
					route.method === "GET" &&
					error instanceof LocalError &&
					error.code === "network_error" &&
					transient < this.tuning.transientRetries;
				if (!retry) throw error;
				transient++;
				await this.backOff(transient, deadlineAt, input.signal, error);
				continue;
			}

			if (reply.status === 429) {
				const wait =
					Math.max(1_000, reply.retryAfterMs ?? RETRY_AFTER_FALLBACK_MS) +
					RETRY_AFTER_PAD_MS;
				const resumeAt = Date.now() + wait;
				if (shared) this.pausedUntil = Math.max(this.pausedUntil, resumeAt);
				if (
					input.once ||
					rateLimited >= this.tuning.rateLimitRetries ||
					resumeAt > deadlineAt
				) {
					throw apiError({ ...reply, retryAfterMs: wait });
				}
				rateLimited++;
				await sleep(wait, input.signal);
				continue;
			}

			if (
				!input.once &&
				route.method === "GET" &&
				TRANSIENT_STATUSES.has(reply.status) &&
				transient < this.tuning.transientRetries
			) {
				transient++;
				await this.backOff(
					transient,
					deadlineAt,
					input.signal,
					apiError(reply),
				);
				continue;
			}

			if (reply.status >= 200 && reply.status < 300) return reply.body;
			throw apiError(reply);
		}
	}

	private url(route: Route, input: CallInput) {
		if (route.path.includes("{id}") !== (input.id !== undefined)) {
			throw new LocalError("internal_error", "Route and id do not match");
		}
		const stray =
			Object.keys(input.query ?? {}).find(
				(name) => !route.query.includes(name),
			) ??
			Object.keys(input.body ?? {}).find(
				(name) => !route.body.includes(name),
			) ??
			Object.keys(input.headers ?? {}).find(
				(name) => !route.headers.includes(name),
			);
		if (stray !== undefined) {
			throw new LocalError(
				"internal_error",
				`Field ${stray} is not part of ${route.method} ${route.path}`,
			);
		}
		const path = route.path.replace("{id}", encodeURIComponent(input.id ?? ""));
		const query = new URLSearchParams();
		for (const [name, value] of Object.entries(input.query ?? {})) {
			if (value !== undefined) query.set(name, String(value));
		}
		const search = query.toString();
		return `${this.config.apiUrl}${path}${search ? `?${search}` : ""}`;
	}

	private async waitForRateLimit(deadlineAt: number, signal?: AbortSignal) {
		for (;;) {
			const wait = this.pausedUntil - Date.now();
			if (wait <= 0) return;
			if (this.pausedUntil > deadlineAt) {
				throw new ApiError(
					429,
					"rate_limited",
					"Rate limit exceeded",
					"Wait for retryAfterSeconds, then run the tool again. Each key allows 60 requests per minute.",
					{},
					Math.ceil(wait / 1000),
				);
			}
			await sleep(wait, signal);
		}
	}

	private async backOff(
		attempt: number,
		deadlineAt: number,
		signal: AbortSignal | undefined,
		error: unknown,
	) {
		const wait = 500 * 3 ** (attempt - 1);
		if (Date.now() + wait >= deadlineAt) throw error;
		await sleep(wait, signal);
	}

	private async send(
		route: Route,
		url: string,
		input: CallInput,
		deadlineAt: number,
	): Promise<Reply> {
		if (input.signal?.aborted) throw cancelled();
		const budget = Math.min(
			this.tuning.requestTimeoutMs,
			deadlineAt - Date.now(),
		);
		if (budget <= 0) throw outOfTime();
		if (route.auth === "upload" && !input.token) {
			throw new LocalError("internal_error", "Upload token is missing");
		}

		const limit = timeLimit(budget, input.signal);
		try {
			const response = await fetch(url, {
				method: route.method,
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${route.auth === "upload" ? input.token : this.config.secretKey}`,
					...(input.body ? { "Content-Type": "application/json" } : {}),
					...input.headers,
				},
				body: input.body ? JSON.stringify(input.body) : undefined,
				redirect: "manual",
				signal: limit.signal,
			});
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel().catch(() => {});
				throw new LocalError(
					"redirected",
					"Cap answered with a redirect instead of the API",
					"Set CAP_API_URL to the address the API is served from, or leave it unset.",
				);
			}
			const raw = await response.text();
			let body: unknown = null;
			try {
				body = raw === "" ? null : JSON.parse(raw);
			} catch {
				body = null;
			}
			return {
				status: response.status,
				retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
				body,
			};
		} catch (error) {
			if (error instanceof LocalError) throw error;
			if (input.signal?.aborted) throw cancelled();
			if (limit.timedOut()) throw timedOut("Cap", budget);
			throw unreachable(error, "Cap");
		} finally {
			limit.dispose();
		}
	}
}

export type StoredPart = { status: number; etag: string | null };

export async function storagePut(
	url: string,
	body: Uint8Array | ReadableStream<Uint8Array>,
	options: {
		headers?: Record<string, string>;
		signal?: AbortSignal;
		timeoutMs: number;
	},
): Promise<StoredPart> {
	if (options.signal?.aborted) throw cancelled();
	const limit = timeLimit(options.timeoutMs, options.signal);
	try {
		const response = await fetch(url, {
			method: "PUT",
			headers: options.headers,
			body,
			signal: limit.signal,
			...(body instanceof Uint8Array ? {} : { duplex: "half" }),
		} as RequestInit);
		await response.body?.cancel().catch(() => {});
		return { status: response.status, etag: response.headers.get("etag") };
	} catch (error) {
		if (options.signal?.aborted) throw cancelled();
		if (limit.timedOut()) throw timedOut("Storage", options.timeoutMs);
		throw unreachable(error, "storage");
	} finally {
		limit.dispose();
	}
}

export function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function dataOf(reply: unknown): Record<string, unknown> {
	const data = asRecord(reply).data;
	if (!isRecord(data)) {
		throw new LocalError(
			"unexpected_response",
			"Cap answered in a shape this server does not understand",
			"Check that CAP_API_URL points at a Cap server, then run the tool again.",
		);
	}
	return data;
}

export function confirmed(reply: unknown) {
	if (asRecord(reply).success !== true) {
		throw new LocalError(
			"unexpected_response",
			"Cap answered in a shape this server does not understand",
			"Check that CAP_API_URL points at a Cap server, then run the tool again.",
		);
	}
}

export function listOf(reply: unknown): Record<string, unknown>[] {
	const data = asRecord(reply).data;
	if (!Array.isArray(data)) {
		throw new LocalError(
			"unexpected_response",
			"Cap answered in a shape this server does not understand",
			"Check that CAP_API_URL points at a Cap server, then run the tool again.",
		);
	}
	return data.map(asRecord);
}
