import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getTorExitList,
	normalizeIpAddress,
	parseTorExitList,
	pendingTorExitListLoad,
	resetTorExitListCache,
	shouldRefuseTorExit,
	TOR_EXIT_LIST_URL,
	torExitGateMode,
} from "@/lib/tor-exit-gate";

const env = vi.hoisted(() => ({
	CAP_TOR_EXIT_GATE: undefined as string | undefined,
}));
const requestHeaders = vi.hoisted(() => ({ value: new Headers() }));

vi.mock("@cap/env", () => ({ serverEnv: () => env }));
vi.mock("next/headers", () => ({
	headers: async () => requestHeaders.value,
}));

const LISTED = "198.51.100.7";
const UNLISTED = "203.0.113.20";

function exitList(...extra: string[]) {
	const filler = Array.from({ length: 60 }, (_, i) => `192.0.2.${i + 1}`);
	return [...filler, LISTED, ...extra].join("\n");
}

function listResponse(body = exitList(), init?: ResponseInit) {
	return new Response(body, { status: 200, ...init });
}

const fetchMock = vi.fn<typeof fetch>();

function clientHeaders(address: string) {
	return new Headers({ "x-real-ip": address, "x-forwarded-for": address });
}

beforeEach(() => {
	resetTorExitListCache();
	env.CAP_TOR_EXIT_GATE = "deny";
	requestHeaders.value = new Headers();
	fetchMock.mockReset().mockImplementation(async () => listResponse());
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("VERCEL", "1");
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("parseTorExitList", () => {
	it("reads one address per line and skips blanks and comments", () => {
		const list = parseTorExitList(
			`# header\n\n${exitList(" 2001:DB8:0:0::1 ")}\r\n`,
		);
		expect(list?.has(LISTED)).toBe(true);
		expect(list?.has("2001:db8::1")).toBe(true);
		expect(list?.has("# header")).toBe(false);
		expect(list?.size).toBe(62);
	});

	it("ignores lines that are not addresses", () => {
		const list = parseTorExitList(exitList("not-an-ip", "999.1.1.1"));
		expect(list?.has("not-an-ip")).toBe(false);
		expect(list?.size).toBe(61);
	});

	it("rejects bodies that do not look like the list", () => {
		expect(parseTorExitList("<html><body>Error</body></html>")).toBeNull();
		expect(parseTorExitList("")).toBeNull();
		expect(parseTorExitList("198.51.100.7\n198.51.100.8")).toBeNull();
	});
});

describe("normalizeIpAddress", () => {
	it("keeps IPv4 and canonicalises IPv6", () => {
		expect(normalizeIpAddress(" 198.51.100.7 ")).toBe("198.51.100.7");
		expect(normalizeIpAddress("2001:DB8:0000:0::1")).toBe("2001:db8::1");
		expect(normalizeIpAddress("[2001:db8::1]")).toBe("2001:db8::1");
	});

	it("unwraps IPv4-mapped IPv6", () => {
		expect(normalizeIpAddress("::ffff:198.51.100.7")).toBe("198.51.100.7");
		expect(normalizeIpAddress("::FFFF:c633:6407")).toBe("198.51.100.7");
	});

	it("rejects anything else", () => {
		expect(normalizeIpAddress("")).toBeNull();
		expect(normalizeIpAddress("unknown")).toBeNull();
		expect(normalizeIpAddress("198.51.100.7:443")).toBeNull();
		expect(normalizeIpAddress("256.1.1.1")).toBeNull();
	});
});

describe("torExitGateMode", () => {
	it("accepts off, log and deny in any case", () => {
		env.CAP_TOR_EXIT_GATE = " DENY ";
		expect(torExitGateMode()).toBe("deny");
		env.CAP_TOR_EXIT_GATE = "log";
		expect(torExitGateMode()).toBe("log");
		env.CAP_TOR_EXIT_GATE = "off";
		expect(torExitGateMode()).toBe("off");
	});

	it("defaults to log on Cap and off for self-hosted installs", () => {
		env.CAP_TOR_EXIT_GATE = undefined;
		vi.stubEnv("NEXT_PUBLIC_IS_CAP", "true");
		expect(torExitGateMode()).toBe("log");
		vi.stubEnv("NEXT_PUBLIC_IS_CAP", "");
		expect(torExitGateMode()).toBe("off");
		env.CAP_TOR_EXIT_GATE = "block";
		expect(torExitGateMode()).toBe("off");
	});
});

describe("getTorExitList cache", () => {
	it("fetches once with the shared hourly cache and reuses the parsed set", async () => {
		const first = await getTorExitList();
		const second = await getTorExitList();

		expect(first?.has(LISTED)).toBe(true);
		expect(second).toBe(first);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(TOR_EXIT_LIST_URL);
		expect((init as { next?: { revalidate?: number } }).next?.revalidate).toBe(
			3600,
		);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("shares one load between concurrent lookups", async () => {
		const lists = await Promise.all([
			getTorExitList(),
			getTorExitList(),
			getTorExitList(),
		]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(new Set(lists).size).toBe(1);
	});

	it("serves a stale list while refreshing it in the background", async () => {
		const now = Date.now();
		const first = await getTorExitList(now);
		let release: (response: Response) => void = () => {};
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);

		const stale = await getTorExitList(now + 11 * 60_000);
		expect(stale).toBe(first);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		release(listResponse(exitList(UNLISTED)));
		await pendingTorExitListLoad();
		expect((await getTorExitList())?.has(UNLISTED)).toBe(true);
	});

	it("stops using a list that could not be refreshed for a day", async () => {
		const now = Date.now();
		await getTorExitList(now);
		fetchMock.mockRejectedValue(new Error("offline"));

		await getTorExitList(now + 11 * 60_000);
		await pendingTorExitListLoad();
		expect(console.warn).toHaveBeenCalledWith(
			"[tor-exit] List unavailable, allowing requests",
			{ error: "offline" },
		);
		expect(await getTorExitList(now + 25 * 60 * 60_000)).toBeNull();
	});

	it("refuses a list whose upstream copy is more than a day old", async () => {
		const lastModified = new Date(Date.now() - 25 * 60 * 60_000).toUTCString();
		fetchMock.mockResolvedValue(
			listResponse(exitList(), { headers: { "last-modified": lastModified } }),
		);

		expect(await getTorExitList()).toBeNull();
		expect(console.warn).toHaveBeenCalledWith(
			"[tor-exit] List unavailable, allowing requests",
			{ error: "List is out of date" },
		);
	});

	it("does not extend a list's age when the cache keeps returning the same copy", async () => {
		vi.useFakeTimers();
		const start = Date.now();
		const lastModified = new Date(start - 23 * 60 * 60_000).toUTCString();
		fetchMock.mockImplementation(async () =>
			listResponse(exitList(), { headers: { "last-modified": lastModified } }),
		);

		expect((await getTorExitList())?.has(LISTED)).toBe(true);

		vi.setSystemTime(start + 30 * 60_000);
		expect((await getTorExitList())?.has(LISTED)).toBe(true);
		await pendingTorExitListLoad();

		vi.setSystemTime(start + 61 * 60_000);
		expect(await getTorExitList()).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("fails open when the list cannot be fetched", async () => {
		fetchMock.mockRejectedValue(new Error("offline"));

		expect(await getTorExitList()).toBeNull();
		expect(console.warn).toHaveBeenCalledWith(
			"[tor-exit] List unavailable, allowing requests",
			{ error: "offline" },
		);
	});

	it("fails open on an error status or an unexpected body", async () => {
		fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }));
		expect(await getTorExitList()).toBeNull();

		resetTorExitListCache();
		fetchMock.mockResolvedValueOnce(listResponse("<html></html>"));
		expect(await getTorExitList()).toBeNull();

		resetTorExitListCache();
		fetchMock.mockResolvedValueOnce(
			listResponse(exitList(), {
				headers: { "content-length": String(3 * 1024 * 1024) },
			}),
		);
		expect(await getTorExitList()).toBeNull();
	});

	it("waits briefly for a cold list and then allows the request", async () => {
		vi.useFakeTimers();
		let release: (response: Response) => void = () => {};
		fetchMock.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);

		const lookup = getTorExitList();
		await vi.advanceTimersByTimeAsync(750);
		expect(await lookup).toBeNull();

		release(listResponse());
		await pendingTorExitListLoad();
		expect((await getTorExitList())?.has(LISTED)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stops waiting for a slow load once the first wait has run out", async () => {
		vi.useFakeTimers();
		fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

		const first = getTorExitList();
		await vi.advanceTimersByTimeAsync(750);
		expect(await first).toBeNull();

		const start = Date.now();
		expect(await getTorExitList()).toBeNull();
		expect(Date.now() - start).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not retry a failed load on every request", async () => {
		fetchMock.mockRejectedValue(new Error("offline"));

		await getTorExitList();
		await getTorExitList();
		await getTorExitList();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("shouldRefuseTorExit", () => {
	it("refuses a listed address in deny mode", async () => {
		expect(
			await shouldRefuseTorExit("web-sign-in", clientHeaders(LISTED)),
		).toBe(true);
		expect(console.warn).toHaveBeenCalledWith(
			"[tor-exit] Request from a listed address",
			{ surface: "web-sign-in", mode: "deny", address: LISTED },
		);
	});

	it("allows an address that is not listed", async () => {
		expect(
			await shouldRefuseTorExit("web-sign-in", clientHeaders(UNLISTED)),
		).toBe(false);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("only logs in log mode", async () => {
		env.CAP_TOR_EXIT_GATE = "log";

		expect(
			await shouldRefuseTorExit("web-sign-in", clientHeaders(LISTED)),
		).toBe(false);
		expect(console.warn).toHaveBeenCalledWith(
			"[tor-exit] Request from a listed address",
			{ surface: "web-sign-in", mode: "log", address: LISTED },
		);
	});

	it("does nothing and fetches nothing when off", async () => {
		env.CAP_TOR_EXIT_GATE = "off";

		expect(
			await shouldRefuseTorExit("web-sign-in", clientHeaders(LISTED)),
		).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows the request when the list is unavailable", async () => {
		fetchMock.mockRejectedValue(new Error("offline"));

		expect(
			await shouldRefuseTorExit("web-sign-in", clientHeaders(LISTED)),
		).toBe(false);
	});

	it("allows the request when there is no client address", async () => {
		expect(await shouldRefuseTorExit("web-sign-in", new Headers())).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses the address Vercel sets, not a client-supplied forwarded chain", async () => {
		const headers = new Headers({
			"x-real-ip": UNLISTED,
			"x-forwarded-for": `${LISTED}, ${UNLISTED}`,
		});
		expect(await shouldRefuseTorExit("web-sign-in", headers)).toBe(false);

		headers.set("x-real-ip", LISTED);
		headers.set("x-forwarded-for", `${UNLISTED}, ${LISTED}`);
		expect(await shouldRefuseTorExit("web-sign-in", headers)).toBe(true);
	});

	it("uses the last forwarded entry behind a self-hosted proxy", async () => {
		vi.stubEnv("VERCEL", "");
		const spoofed = new Headers({
			"x-forwarded-for": `${LISTED}, ${UNLISTED}`,
		});
		expect(await shouldRefuseTorExit("web-sign-in", spoofed)).toBe(false);

		const proxied = new Headers({
			"x-forwarded-for": `${UNLISTED}, ${LISTED}`,
		});
		expect(await shouldRefuseTorExit("web-sign-in", proxied)).toBe(true);
	});

	it("matches an IPv4-mapped client address", async () => {
		expect(
			await shouldRefuseTorExit(
				"web-sign-in",
				clientHeaders(`::ffff:${LISTED}`),
			),
		).toBe(true);
	});

	it("reads the request headers when none are passed", async () => {
		requestHeaders.value = clientHeaders(LISTED);
		expect(await shouldRefuseTorExit("developer-app")).toBe(true);

		requestHeaders.value = clientHeaders(UNLISTED);
		expect(await shouldRefuseTorExit("developer-app")).toBe(false);
	});
});
