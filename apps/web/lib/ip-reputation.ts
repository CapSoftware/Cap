import { isIP } from "node:net";
import { serverEnv } from "@cap/env";
import { after } from "next/server";
import { clientAddress } from "@/lib/rate-limit";
import {
	normalizeIpAddress,
	upstreamListedAt,
	waitAtMost,
} from "@/lib/tor-exit-gate";

const LIST_BASE_URL =
	"https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output";

export const IP_REPUTATION_LISTS = {
	datacenter: {
		ipv4: `${LIST_BASE_URL}/datacenter/ipv4.txt`,
		ipv6: `${LIST_BASE_URL}/datacenter/ipv6.txt`,
	},
	vpn: {
		ipv4: `${LIST_BASE_URL}/vpn/ipv4.txt`,
		ipv6: `${LIST_BASE_URL}/vpn/ipv6.txt`,
	},
} as const;

export type IpReputationLabel = keyof typeof IP_REPUTATION_LISTS;
export type IpReputationMode = "off" | "log";
export type NewAccountSurface = "web-sign-in" | "mobile-email-session";

const LABELS = Object.keys(IP_REPUTATION_LISTS) as IpReputationLabel[];
const LIST_REVALIDATE_SECONDS = 3600;
const LIST_FETCH_TIMEOUT_MS = 5_000;
const LOOKUP_WAIT_MS = 3_000;
const LIST_FRESH_MS = 10 * 60_000;
const LIST_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MIN_LIST_ENTRIES = 50;
const MAX_IPV6_PREFIX = 64;
const UINT64_MAX = (1n << 64n) - 1n;

export type Ipv4Ranges = { starts: Uint32Array; ends: Uint32Array };
export type Ipv6Ranges = { starts: BigUint64Array; ends: BigUint64Array };
export type RangeList = { ipv4: Ipv4Ranges; ipv6: Ipv6Ranges };

type LoadedList = RangeList & { listedAt: number; loadedAt: number };
type ListState = {
	loaded: LoadedList | null;
	pending: Promise<LoadedList | null> | null;
	pendingStartedAt: number;
	lastFailureAt: number;
};

const states = new Map<IpReputationLabel, ListState>();

function listState(label: IpReputationLabel): ListState {
	let state = states.get(label);
	if (!state) {
		state = {
			loaded: null,
			pending: null,
			pendingStartedAt: 0,
			lastFailureAt: Number.NEGATIVE_INFINITY,
		};
		states.set(label, state);
	}
	return state;
}

export function ipReputationMode(): IpReputationMode {
	const configured = serverEnv().CAP_IP_REPUTATION_LOG?.trim().toLowerCase();
	if (configured === "off" || configured === "log") return configured;
	if (configured) return "off";
	return process.env.NEXT_PUBLIC_IS_CAP === "true" ? "log" : "off";
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function ipv4ToInt(address: string): number | null {
	const match = address.match(IPV4_PATTERN);
	if (!match) return null;
	let value = 0;
	for (let index = 1; index <= 4; index++) {
		const octet = Number(match[index]);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	return value;
}

export function ipv6HighBits(address: string): bigint | null {
	if (isIP(address) !== 6 || address.includes("%")) return null;
	let text = address.toLowerCase();
	const embedded = text.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
	if (embedded) {
		const value = ipv4ToInt(embedded);
		if (value === null) return null;
		text = `${text.slice(0, -embedded.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
	let high = 0n;
	for (let index = 0; index < 4; index++) {
		high = (high << 16n) | BigInt(Number.parseInt(groups[index] ?? "", 16));
	}
	return high;
}

function parseIpv4Cidr(entry: string): [number, number] | null {
	const [address = "", prefixText, extra] = entry.split("/");
	if (extra !== undefined) return null;
	const prefix = prefixText === undefined ? 32 : Number(prefixText);
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
	if (prefixText !== undefined && !/^\d{1,2}$/.test(prefixText)) return null;
	const value = ipv4ToInt(address);
	if (value === null) return null;
	const size = 2 ** (32 - prefix);
	const start = value - (value % size);
	return [start, start + size - 1];
}

function parseIpv6Cidr(entry: string): [bigint, bigint] | null | "too-long" {
	const [address = "", prefixText, extra] = entry.split("/");
	if (extra !== undefined || prefixText === undefined) return null;
	if (!/^\d{1,3}$/.test(prefixText)) return null;
	const prefix = Number(prefixText);
	if (prefix > 128) return null;
	const high = ipv6HighBits(address);
	if (high === null) return null;
	if (prefix > MAX_IPV6_PREFIX) return "too-long";
	const hostMask = prefix === 0 ? UINT64_MAX : (1n << BigInt(64 - prefix)) - 1n;
	const start = high & ~hostMask & UINT64_MAX;
	return [start, start | hostMask];
}

function mergeRanges<T extends number | bigint>(
	ranges: [T, T][],
	adjoins: (end: T, start: T) => boolean,
): { starts: T[]; ends: T[] } {
	ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const starts: T[] = [];
	const ends: T[] = [];
	for (const [start, end] of ranges) {
		const last = ends.length - 1;
		const lastEnd = ends[last];
		if (lastEnd !== undefined && adjoins(lastEnd, start)) {
			if (end > lastEnd) ends[last] = end;
			continue;
		}
		starts.push(start);
		ends.push(end);
	}
	return { starts, ends };
}

export function parseIpv4RangeList(text: string): Ipv4Ranges | null {
	const ranges: [number, number][] = [];
	for (const line of text.split("\n")) {
		const entry = line.trim();
		if (!entry || entry.startsWith("#")) continue;
		const range = parseIpv4Cidr(entry);
		if (range) ranges.push(range);
	}
	if (ranges.length < MIN_LIST_ENTRIES) return null;
	const merged = mergeRanges(ranges, (end, start) => start <= end + 1);
	return {
		starts: Uint32Array.from(merged.starts),
		ends: Uint32Array.from(merged.ends),
	};
}

// Lookups compare the top 64 bits of an address, which is exact for any
// prefix up to /64. Longer prefixes are left out rather than widened.
export function parseIpv6RangeList(text: string): Ipv6Ranges | null {
	const ranges: [bigint, bigint][] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		const entry = line.trim();
		if (!entry || entry.startsWith("#")) continue;
		const range = parseIpv6Cidr(entry);
		if (range === "too-long") skipped++;
		else if (range) ranges.push(range);
	}
	if (ranges.length + skipped < MIN_LIST_ENTRIES) return null;
	const merged = mergeRanges(ranges, (end, start) => start <= end + 1n);
	return {
		starts: BigUint64Array.from(merged.starts),
		ends: BigUint64Array.from(merged.ends),
	};
}

function inRanges<T extends number | bigint>(
	starts: ArrayLike<T>,
	ends: ArrayLike<T>,
	value: T,
): boolean {
	let low = 0;
	let high = starts.length - 1;
	while (low <= high) {
		const mid = (low + high) >>> 1;
		if ((starts[mid] as T) <= value) low = mid + 1;
		else high = mid - 1;
	}
	return high >= 0 && value <= (ends[high] as T);
}

export function rangeListHas(list: RangeList, address: string): boolean {
	const ipv4 = ipv4ToInt(address);
	if (ipv4 !== null) return inRanges(list.ipv4.starts, list.ipv4.ends, ipv4);
	const ipv6 = ipv6HighBits(address);
	return ipv6 !== null && inRanges(list.ipv6.starts, list.ipv6.ends, ipv6);
}

async function fetchListFile(url: string) {
	const response = await fetch(url, {
		next: { revalidate: LIST_REVALIDATE_SECONDS },
		signal: AbortSignal.timeout(LIST_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	if (Number(response.headers.get("content-length")) > MAX_LIST_BYTES)
		throw new Error("List too large");
	const text = await response.text();
	if (text.length > MAX_LIST_BYTES) throw new Error("List too large");
	const now = Date.now();
	const listedAt = upstreamListedAt(response.headers, now);
	if (now - listedAt >= LIST_MAX_AGE_MS) throw new Error("List is out of date");
	return { text, listedAt };
}

async function fetchRangeList(label: IpReputationLabel): Promise<LoadedList> {
	const urls = IP_REPUTATION_LISTS[label];
	const [v4, v6] = await Promise.all([
		fetchListFile(urls.ipv4),
		fetchListFile(urls.ipv6),
	]);
	const ipv4 = parseIpv4RangeList(v4.text);
	const ipv6 = parseIpv6RangeList(v6.text);
	if (!ipv4 || !ipv6) throw new Error("Unexpected list format");
	return {
		ipv4,
		ipv6,
		listedAt: Math.min(v4.listedAt, v6.listedAt),
		loadedAt: Date.now(),
	};
}

function startListLoad(label: IpReputationLabel, state: ListState) {
	if (state.pending) return state.pending;
	state.pendingStartedAt = Date.now();
	const load = fetchRangeList(label).then(
		(loaded) => {
			state.loaded = loaded;
			return loaded;
		},
		(error: unknown) => {
			state.lastFailureAt = Date.now();
			console.warn("[ip-reputation] List unavailable", {
				label,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		},
	);
	state.pending = load.finally(() => {
		state.pending = null;
	});
	return state.pending;
}

export async function getRangeList(
	label: IpReputationLabel,
	now = Date.now(),
): Promise<RangeList | null> {
	const state = listState(label);
	const usable =
		state.loaded && now - state.loaded.listedAt < LIST_MAX_AGE_MS
			? state.loaded
			: null;
	if (usable && now - usable.loadedAt < LIST_FRESH_MS) return usable;
	if (now - state.lastFailureAt < RETRY_AFTER_FAILURE_MS) return usable;
	const loading = startListLoad(label, state);
	if (usable) return usable;
	const waitMs = LOOKUP_WAIT_MS - (Date.now() - state.pendingStartedAt);
	if (waitMs <= 0) return null;
	return waitAtMost(loading, waitMs);
}

export function pendingRangeListLoads(): Promise<unknown> {
	return Promise.all(LABELS.map((label) => states.get(label)?.pending));
}

export function resetRangeListCache() {
	states.clear();
}

export type NewAccountDetails = { provider?: string; flow?: string };

export async function checkNewAccountAddress(
	surface: NewAccountSurface,
	address: string,
	details: NewAccountDetails = {},
): Promise<IpReputationLabel[]> {
	try {
		const lists = await Promise.all(LABELS.map((label) => getRangeList(label)));
		const labels = LABELS.filter((_, index) => {
			const list = lists[index];
			return list ? rangeListHas(list, address) : false;
		});
		for (const label of labels) {
			console.warn("[ip-reputation] New account from a listed range", {
				surface,
				label,
				address,
				...details,
			});
		}
		return labels;
	} catch (error) {
		console.warn("[ip-reputation] Check failed", {
			surface,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

export function logNewAccountAddress(
	surface: NewAccountSurface,
	headers: Headers,
	details: NewAccountDetails = {},
): Promise<IpReputationLabel[]> | null {
	try {
		if (ipReputationMode() === "off") return null;
		const raw = clientAddress(headers);
		const address = raw ? normalizeIpAddress(raw) : null;
		if (!address) return null;
		const check = () => checkNewAccountAddress(surface, address, details);
		try {
			const result = Promise.withResolvers<IpReputationLabel[]>();
			after(() => check().then(result.resolve));
			return result.promise;
		} catch {
			return check();
		}
	} catch {
		return null;
	}
}
