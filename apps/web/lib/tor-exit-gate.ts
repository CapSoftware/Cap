import { isIP } from "node:net";
import { serverEnv } from "@cap/env";
import { headers as nextHeaders } from "next/headers";
import { clientAddress } from "@/lib/rate-limit";

export const TOR_EXIT_LIST_URL = "https://check.torproject.org/torbulkexitlist";

const LIST_REVALIDATE_SECONDS = 3600;
const LIST_FETCH_TIMEOUT_MS = 5_000;
const LOOKUP_WAIT_MS = 750;
const LIST_FRESH_MS = 10 * 60_000;
const LIST_MAX_AGE_MS = 24 * 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MIN_LIST_ENTRIES = 50;

export const TOR_EXIT_REFUSAL_MESSAGE =
	"This request can't be completed. Contact support if this keeps happening.";

export type TorExitGateMode = "off" | "log" | "deny";

export type TorExitSurface =
	| "web-sign-in"
	| "desktop-session"
	| "mobile-session"
	| "mobile-email-session"
	| "developer-app"
	| "agent-key"
	| "cli-authorize"
	| "mcp-authorize";

type FetchedList = { addresses: ReadonlySet<string>; listedAt: number };
type LoadedList = FetchedList & { loadedAt: number };

let loadedList: LoadedList | null = null;
let pendingLoad: Promise<LoadedList | null> | null = null;
let pendingLoadStartedAt = 0;
let lastFailureAt = Number.NEGATIVE_INFINITY;

export function torExitGateMode(): TorExitGateMode {
	const configured = serverEnv().CAP_TOR_EXIT_GATE?.trim().toLowerCase();
	if (configured === "off" || configured === "log" || configured === "deny")
		return configured;
	return process.env.NEXT_PUBLIC_IS_CAP === "true" ? "log" : "off";
}

const IPV4_MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

export function normalizeIpAddress(value: string): string | null {
	const trimmed = value.trim().replace(/^\[(.*)\]$/, "$1");
	const version = isIP(trimmed);
	if (version === 4) return trimmed;
	if (version !== 6) return null;
	let canonical: string;
	try {
		canonical = new URL(`http://[${trimmed}]`).hostname.slice(1, -1);
	} catch {
		return null;
	}
	const mapped = canonical.match(IPV4_MAPPED_HEX);
	if (!mapped?.[1] || !mapped[2]) return canonical;
	const high = Number.parseInt(mapped[1], 16);
	const low = Number.parseInt(mapped[2], 16);
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function parseTorExitList(text: string): ReadonlySet<string> | null {
	const addresses = new Set<string>();
	for (const line of text.split("\n")) {
		const entry = line.trim();
		if (!entry || entry.startsWith("#")) continue;
		const address = normalizeIpAddress(entry);
		if (address) addresses.add(address);
	}
	return addresses.size >= MIN_LIST_ENTRIES ? addresses : null;
}

// The framework cache keeps serving its last good response when revalidation
// fails, so the list's age comes from the upstream headers, not the fetch time.
export function upstreamListedAt(headers: Headers, now: number): number {
	const stamp = Date.parse(
		headers.get("last-modified") ?? headers.get("date") ?? "",
	);
	return Number.isFinite(stamp) ? Math.min(stamp, now) : now;
}

async function fetchTorExitList(): Promise<FetchedList> {
	const response = await fetch(TOR_EXIT_LIST_URL, {
		next: { revalidate: LIST_REVALIDATE_SECONDS },
		signal: AbortSignal.timeout(LIST_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	if (Number(response.headers.get("content-length")) > MAX_LIST_BYTES)
		throw new Error("List too large");
	const text = await response.text();
	if (text.length > MAX_LIST_BYTES) throw new Error("List too large");
	const addresses = parseTorExitList(text);
	if (!addresses) throw new Error("Unexpected list format");
	const now = Date.now();
	const listedAt = upstreamListedAt(response.headers, now);
	if (now - listedAt >= LIST_MAX_AGE_MS) throw new Error("List is out of date");
	return { addresses, listedAt };
}

function startListLoad(): Promise<LoadedList | null> {
	if (pendingLoad) return pendingLoad;
	pendingLoadStartedAt = Date.now();
	const load = fetchTorExitList().then(
		(fetched) => {
			loadedList = { ...fetched, loadedAt: Date.now() };
			return loadedList;
		},
		(error: unknown) => {
			lastFailureAt = Date.now();
			console.warn("[tor-exit] List unavailable, allowing requests", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		},
	);
	pendingLoad = load.finally(() => {
		pendingLoad = null;
	});
	return pendingLoad;
}

export function waitAtMost<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}

export async function getTorExitList(
	now = Date.now(),
): Promise<ReadonlySet<string> | null> {
	const usable =
		loadedList && now - loadedList.listedAt < LIST_MAX_AGE_MS
			? loadedList
			: null;
	if (usable && now - usable.loadedAt < LIST_FRESH_MS) return usable.addresses;
	if (now - lastFailureAt < RETRY_AFTER_FAILURE_MS)
		return usable?.addresses ?? null;
	const loading = startListLoad();
	if (usable) return usable.addresses;
	const waitMs = LOOKUP_WAIT_MS - (Date.now() - pendingLoadStartedAt);
	if (waitMs <= 0) return null;
	return (await waitAtMost(loading, waitMs))?.addresses ?? null;
}

export function pendingTorExitListLoad(): Promise<unknown> {
	return pendingLoad ?? Promise.resolve();
}

export function resetTorExitListCache() {
	loadedList = null;
	pendingLoad = null;
	lastFailureAt = Number.NEGATIVE_INFINITY;
}

async function requestHeaders(source?: Headers): Promise<Headers | null> {
	if (source) return source;
	try {
		return new Headers(await nextHeaders());
	} catch {
		return null;
	}
}

/**
 * Whether a request from a Tor exit should be refused. In "log" mode a match
 * is only logged. Any failure to load the list or read the address allows the
 * request.
 */
export async function shouldRefuseTorExit(
	surface: TorExitSurface,
	source?: Headers,
): Promise<boolean> {
	try {
		const mode = torExitGateMode();
		if (mode === "off") return false;
		const headers = await requestHeaders(source);
		const raw = headers ? clientAddress(headers) : undefined;
		const address = raw ? normalizeIpAddress(raw) : null;
		if (!address) return false;
		const list = await getTorExitList();
		if (!list?.has(address)) return false;
		console.warn("[tor-exit] Request from a listed address", {
			surface,
			mode,
			address,
		});
		return mode === "deny";
	} catch (error) {
		console.warn("[tor-exit] Check failed, allowing request", {
			surface,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
