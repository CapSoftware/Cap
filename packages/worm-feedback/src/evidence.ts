import { elementLabels } from "../../../vendor/ux-walk/src/labels.mjs";
import { EMAIL, redactBody } from "../../../vendor/ux-walk/src/redact.mjs";
import { Ring } from "./ring";
import { sanitizePath, sanitizeUrl } from "./route";
import type { ElementDescription, EvidenceEvent, RouteRule } from "./types";

export const LIMIT = 50;
export const MASKED = "[data-worm-mask]";
const DEFAULT_REQUEST_ID_HEADERS = [
	"x-request-id",
	"x-correlation-id",
	"request-id",
	"x-amzn-requestid",
	"cf-ray",
];

export interface CollectorOptions {
	host: () => Element | null;
	ignoreOrigin: string;
	routeRules?: RouteRule[];
	requestIdHeaders?: string[];
	genericTestids?: string[];
	now?: () => number;
}

export interface Collector {
	clicks: Ring<EvidenceEvent>;
	logs: Ring<EvidenceEvent>;
	requests: Ring<EvidenceEvent>;
	route(): string;
	events(): EvidenceEvent[];
	stop(): void;
}

const SECRET_JSON =
	/("[^"]*(?:pass|token|secret|otp|key)[^"]*"\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}\]\s]+)/gi;
const scrub = (text: string) =>
	(redactBody(text) ?? "")
		.replace(SECRET_JSON, '$1"[redacted]"')
		.replace(/(https?:\/\/[^\s?#"')]+)[?#][^\s"')]*/g, "$1");

export function consoleText(args: unknown[]): string {
	const parts = args.map((value) => {
		if (value instanceof Error)
			return value.stack || `${value.name}: ${value.message}`;
		if (typeof value === "string") return value;
		try {
			const json = JSON.stringify(value);
			return json === undefined
				? String(value)
				: (redactBody(json) ?? "").slice(0, 1000);
		} catch {
			return Object.prototype.toString.call(value);
		}
	});
	return scrub(parts.join(" ").slice(0, 4000));
}

export function describeClick(
	target: Element | null,
	host: Element | null,
	genericTestids: string[] = [],
): ElementDescription | null {
	const labels = elementLabels({ genericTestids });
	const description = labels.desc(target, host) as ElementDescription | null;
	if (!description) return null;
	if (target?.closest?.(MASKED)) {
		return {
			tag: description.tag,
			role: description.role,
			control: description.control,
			testid: description.testid,
			region: description.region,
			masked: true,
		};
	}
	const clean = (value?: string | null) =>
		value == null ? value : value.replace(EMAIL, "[email]");
	return {
		...description,
		text: clean(description.text) ?? undefined,
		label: clean(description.label) ?? undefined,
		aria: clean(description.aria),
		title: clean(description.title),
		ctx: clean(description.ctx) ?? undefined,
		row: clean(description.row) ?? undefined,
	};
}

export function createCollector(options: CollectorOptions): Collector {
	const now = options.now ?? Date.now;
	const rules = options.routeRules ?? [];
	const idHeaders = (
		options.requestIdHeaders ?? DEFAULT_REQUEST_ID_HEADERS
	).map((name) => name.toLowerCase());
	const clicks = new Ring<EvidenceEvent>(LIMIT);
	const logs = new Ring<EvidenceEvent>(LIMIT);
	const requests = new Ring<EvidenceEvent>(LIMIT);
	const route = () => sanitizePath(location.pathname, rules);
	const ours = (url: string) => {
		try {
			return new URL(url, location.href).origin === options.ignoreOrigin;
		} catch {
			return false;
		}
	};
	const insideWidget = (event: Event) => {
		const host = options.host();
		return !!host && event.composedPath().includes(host);
	};
	const cleanups: Array<() => void> = [];
	const listen = <K extends keyof WindowEventMap>(
		type: K,
		handler: (event: WindowEventMap[K]) => void,
	) => {
		window.addEventListener(type, handler, true);
		cleanups.push(() => window.removeEventListener(type, handler, true));
	};

	listen("click", (event) => {
		if (insideWidget(event)) return;
		clicks.push({
			t: now(),
			ev: "click",
			url: route(),
			el: describeClick(
				event.target instanceof Element ? event.target : null,
				options.host(),
				options.genericTestids,
			),
		});
	});
	listen("error", (event) => {
		if (!(event instanceof ErrorEvent)) return;
		const where = event.filename
			? ` (${sanitizeUrl(event.filename, location.href, rules)}:${event.lineno})`
			: "";
		logs.push({
			t: now(),
			ev: "pageerror",
			url: route(),
			text: consoleText([event.error ?? event.message]) + where,
		});
	});
	listen("unhandledrejection", (event) => {
		logs.push({
			t: now(),
			ev: "pageerror",
			url: route(),
			text: `Unhandled rejection: ${consoleText([event.reason])}`,
		});
	});

	const original = { warn: console.warn, error: console.error };
	for (const [method, level] of [
		["warn", "warning"],
		["error", "error"],
	] as const) {
		const call = original[method];
		console[method] = function (this: Console, ...args: unknown[]) {
			try {
				logs.push({
					t: now(),
					ev: "console",
					url: route(),
					level,
					text: consoleText(args),
				});
			} catch {}
			return call.apply(this, args);
		};
	}
	cleanups.push(() => {
		console.warn = original.warn;
		console.error = original.error;
	});

	const record = (
		method: string,
		url: string,
		started: number,
		status: number,
		requestId?: string | null,
		failure?: string,
	) => {
		const upper = method.toUpperCase();
		requests.push({
			t: now(),
			ev: ["GET", "HEAD", "OPTIONS"].includes(upper) ? "http" : "write",
			url: route(),
			method: upper.slice(0, 12),
			request: sanitizeUrl(url, location.href, rules),
			status,
			durationMs: Math.max(0, now() - started),
			...(requestId ? { requestId: requestId.slice(0, 200) } : {}),
			...(failure ? { failure: failure.slice(0, 200) } : {}),
		});
	};
	const requestIdOf = (get: (name: string) => string | null) => {
		for (const name of idHeaders) {
			const value = get(name);
			if (value) return value;
		}
		return null;
	};

	const fetchBefore = window.fetch;
	if (typeof fetchBefore === "function") {
		window.fetch = async function (
			this: unknown,
			input: RequestInfo | URL,
			init?: RequestInit,
		) {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			const method =
				init?.method ?? (input instanceof Request ? input.method : "GET");
			const started = now();
			try {
				const response = await fetchBefore.call(this, input, init);
				if (response.status >= 400 && !ours(url))
					record(
						method,
						url,
						started,
						response.status,
						requestIdOf((name) => response.headers.get(name)),
					);
				return response;
			} catch (error) {
				if (!ours(url))
					record(
						method,
						url,
						started,
						0,
						null,
						error instanceof Error ? error.name : "Request failed",
					);
				throw error;
			}
		} as typeof window.fetch;
		cleanups.push(() => {
			window.fetch = fetchBefore;
		});
	}

	const xhr = window.XMLHttpRequest?.prototype;
	if (xhr) {
		const open = xhr.open;
		const send = xhr.send;
		const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
		xhr.open = function (
			this: XMLHttpRequest,
			method: string,
			url: string | URL,
			...rest: unknown[]
		) {
			meta.set(this, { method, url: String(url) });
			return (open as (...args: unknown[]) => void).call(
				this,
				method,
				url,
				...rest,
			);
		} as typeof xhr.open;
		xhr.send = function (
			this: XMLHttpRequest,
			body?: Document | XMLHttpRequestBodyInit | null,
		) {
			const info = meta.get(this);
			const started = now();
			if (info && !ours(info.url)) {
				this.addEventListener("loadend", () => {
					if (this.status >= 400 || this.status === 0)
						record(
							info.method,
							info.url,
							started,
							this.status,
							this.status
								? requestIdOf((name) => {
										try {
											return this.getResponseHeader(name);
										} catch {
											return null;
										}
									})
								: null,
							this.status ? undefined : "Network error",
						);
				});
			}
			return send.call(this, body);
		};
		cleanups.push(() => {
			xhr.open = open;
			xhr.send = send;
		});
	}

	return {
		clicks,
		logs,
		requests,
		route,
		events: () =>
			[...clicks.values(), ...logs.values(), ...requests.values()].sort(
				(a, b) => a.t - b.t,
			),
		stop: () => {
			for (const cleanup of cleanups.splice(0)) cleanup();
		},
	};
}
