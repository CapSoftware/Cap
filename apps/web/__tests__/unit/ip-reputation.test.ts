import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkNewAccountAddress,
	getRangeList,
	IP_REPUTATION_LISTS,
	ipReputationMode,
	ipv4ToInt,
	ipv6HighBits,
	logNewAccountAddress,
	parseIpv4RangeList,
	parseIpv6RangeList,
	pendingRangeListLoads,
	type RangeList,
	rangeListHas,
	resetRangeListCache,
} from "@/lib/ip-reputation";
import {
	DATACENTER_ADDRESS,
	DATACENTER_IPV6_ADDRESS,
	listBodies,
	listFetch,
	UNLISTED_ADDRESS,
	VPN_ADDRESS,
} from "../fixtures/ip-reputation-lists";

const env = vi.hoisted(() => ({
	CAP_IP_REPUTATION_LOG: "log" as string | undefined,
}));
const scheduled = vi.hoisted(() => ({
	tasks: [] as (() => Promise<unknown>)[],
	outsideRequest: false,
}));

vi.mock("@cap/env", () => ({ serverEnv: () => env }));
vi.mock("next/server", () => ({
	after: (task: () => Promise<unknown>) => {
		if (scheduled.outsideRequest) throw new Error("outside a request scope");
		scheduled.tasks.push(task);
	},
}));

const fetchMock = vi.fn<typeof fetch>();
const filler = (make: (index: number) => string) =>
	Array.from({ length: 60 }, (_, index) => make(index));

function ipv4List(...entries: string[]) {
	return parseIpv4RangeList(
		[...filler((index) => `10.${index * 2}.0.0/16`), ...entries].join("\n"),
	);
}

function rangeList(ipv4: string[], ipv6: string[] = []): RangeList {
	const v4 = ipv4List(...ipv4);
	const v6 = parseIpv6RangeList(
		[
			...filler((index) => `fd00:${(index * 2).toString(16)}::/32`),
			...ipv6,
		].join("\n"),
	);
	if (!v4 || !v6) throw new Error("fixture did not parse");
	return { ipv4: v4, ipv6: v6 };
}

function clientHeaders(address: string) {
	return new Headers({ "x-real-ip": address, "x-forwarded-for": address });
}

async function runScheduled() {
	const tasks = scheduled.tasks.splice(0);
	await Promise.all(tasks.map((task) => task()));
}

beforeEach(() => {
	resetRangeListCache();
	env.CAP_IP_REPUTATION_LOG = "log";
	scheduled.tasks = [];
	scheduled.outsideRequest = false;
	fetchMock.mockReset().mockImplementation(listFetch);
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("VERCEL", "1");
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("ipv4ToInt and ipv6HighBits", () => {
	it("converts addresses to integers", () => {
		expect(ipv4ToInt("0.0.0.0")).toBe(0);
		expect(ipv4ToInt("255.255.255.255")).toBe(4294967295);
		expect(ipv4ToInt("1.2.3.4")).toBe(0x01020304);
		expect(ipv6HighBits("2001:db8::1")).toBe(0x20010db800000000n);
		expect(ipv6HighBits("::")).toBe(0n);
		expect(ipv6HighBits("ffff:ffff:ffff:ffff::")).toBe(0xffffffffffffffffn);
		expect(ipv6HighBits("1:2:3:4:5:6:7:8")).toBe(0x0001000200030004n);
		expect(ipv6HighBits("1:2:3::6.7.8.9")).toBe(0x0001000200030000n);
	});

	it("rejects malformed values", () => {
		for (const value of ["256.0.0.1", "1.2.3", "1.2.3.4.5", "a.b.c.d", ""]) {
			expect(ipv4ToInt(value)).toBeNull();
		}
		for (const value of ["1::2::3", "2001:db8::g", "1.2.3.4", "fe80::1%en0"]) {
			expect(ipv6HighBits(value)).toBeNull();
		}
	});
});

describe("parseIpv4RangeList", () => {
	it("skips blanks, comments and malformed lines", () => {
		const list = ipv4List(
			"",
			"# comment",
			" 198.51.100.0/24 \r",
			"198.51.100.0/33",
			"198.51.100.0/-1",
			"198.51.100.0/2x",
			"999.0.0.0/8",
			"198.51.100.0/24/1",
			"not-a-range",
		);
		expect(list?.starts.length).toBe(61);
	});

	it("rejects bodies that do not look like the list", () => {
		expect(parseIpv4RangeList("<html>error</html>")).toBeNull();
		expect(parseIpv4RangeList("")).toBeNull();
		expect(parseIpv4RangeList("198.51.100.0/24\n203.0.113.0/24")).toBeNull();
	});

	it("merges overlapping, nested and adjacent ranges", () => {
		const list = parseIpv4RangeList(
			[
				...filler((index) => `10.${index * 2}.0.0/16`),
				"10.1.0.0/16",
				"10.0.5.0/24",
				"10.0.0.0/15",
			].join("\n"),
		);
		expect(list?.starts[0]).toBe(ipv4ToInt("10.0.0.0"));
		expect(list?.ends[0]).toBe(ipv4ToInt("10.2.255.255"));
		expect(list?.starts[1]).toBe(ipv4ToInt("10.4.0.0"));
		expect(list?.starts.length).toBe(59);
		for (let index = 1; index < (list?.starts.length ?? 0); index++) {
			expect(list?.starts[index]).toBeGreaterThan(list?.ends[index - 1] ?? 0);
		}
	});

	it("keeps host bits out of a range's start", () => {
		const list = rangeList(["198.51.100.77/24"]);
		expect(rangeListHas(list, "198.51.100.0")).toBe(true);
		expect(rangeListHas(list, "198.51.100.255")).toBe(true);
	});
});

describe("parseIpv6RangeList", () => {
	it("matches prefixes up to /64 and leaves longer ones out", () => {
		const list = rangeList(
			[],
			[
				"2001:db8:aa00::/40",
				"2001:db8:bb::/48",
				"2001:db8:cc:dd::/64",
				"2001:db8:ee:ff::/96",
				"2001:db8::/129",
				"2001:db8::",
			],
		);
		expect(list.ipv6.starts.length).toBe(63);
		expect(rangeListHas(list, "2001:db8:aaff:ffff::1")).toBe(true);
		expect(rangeListHas(list, "2001:db8:ab00::")).toBe(false);
		expect(rangeListHas(list, "2001:db8:bb:ffff::1")).toBe(true);
		expect(rangeListHas(list, "2001:db8:cc:dd:ffff::1")).toBe(true);
		expect(rangeListHas(list, "2001:db8:cc:de::")).toBe(false);
		expect(rangeListHas(list, "2001:db8:ee:ff::1")).toBe(false);
	});

	it("handles a /0 prefix", () => {
		const list = rangeList([], ["::/0"]);
		expect(rangeListHas(list, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(
			true,
		);
	});
});

describe("rangeListHas", () => {
	const list = rangeList(
		["0.0.0.0/32", "198.51.100.0/24", "203.0.113.128/25", "255.255.255.255/32"],
		["2001:db8:ff00::/40"],
	);

	it("matches the first and last address of a range and nothing outside it", () => {
		expect(rangeListHas(list, "198.51.100.0")).toBe(true);
		expect(rangeListHas(list, "198.51.100.255")).toBe(true);
		expect(rangeListHas(list, "198.51.99.255")).toBe(false);
		expect(rangeListHas(list, "198.51.101.0")).toBe(false);
		expect(rangeListHas(list, "203.0.113.127")).toBe(false);
		expect(rangeListHas(list, "203.0.113.128")).toBe(true);
	});

	it("matches the ends of the address space", () => {
		expect(rangeListHas(list, "0.0.0.0")).toBe(true);
		expect(rangeListHas(list, "0.0.0.1")).toBe(false);
		expect(rangeListHas(list, "255.255.255.255")).toBe(true);
		expect(rangeListHas(list, "255.255.255.254")).toBe(false);
	});

	it("matches IPv6 by its network half", () => {
		expect(rangeListHas(list, "2001:db8:ff00::")).toBe(true);
		expect(rangeListHas(list, "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(
			true,
		);
		expect(rangeListHas(list, "2001:db8:feff:ffff::")).toBe(false);
		expect(rangeListHas(list, "2001:db9::")).toBe(false);
	});

	it("does not match values that are not addresses", () => {
		expect(rangeListHas(list, "")).toBe(false);
		expect(rangeListHas(list, "198.51.100")).toBe(false);
		expect(rangeListHas(list, "unknown")).toBe(false);
	});
});

describe("ipReputationMode", () => {
	it("accepts off and log in any case", () => {
		env.CAP_IP_REPUTATION_LOG = " LOG ";
		expect(ipReputationMode()).toBe("log");
		env.CAP_IP_REPUTATION_LOG = "off";
		expect(ipReputationMode()).toBe("off");
	});

	it("defaults to log on Cap and off for self-hosted installs", () => {
		env.CAP_IP_REPUTATION_LOG = undefined;
		vi.stubEnv("NEXT_PUBLIC_IS_CAP", "true");
		expect(ipReputationMode()).toBe("log");
		vi.stubEnv("NEXT_PUBLIC_IS_CAP", "");
		expect(ipReputationMode()).toBe("off");
	});

	it("treats any other value as off", () => {
		vi.stubEnv("NEXT_PUBLIC_IS_CAP", "true");
		env.CAP_IP_REPUTATION_LOG = "deny";
		expect(ipReputationMode()).toBe("off");
	});
});

describe("getRangeList cache", () => {
	it("fetches both files once with the shared hourly cache", async () => {
		const first = await getRangeList("datacenter");
		const second = await getRangeList("datacenter");

		expect(second).toBe(first);
		expect(first && rangeListHas(first, DATACENTER_ADDRESS)).toBe(true);
		expect(first && rangeListHas(first, DATACENTER_IPV6_ADDRESS)).toBe(true);
		expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(
			[
				IP_REPUTATION_LISTS.datacenter.ipv4,
				IP_REPUTATION_LISTS.datacenter.ipv6,
			].sort(),
		);
		for (const [, init] of fetchMock.mock.calls) {
			expect(
				(init as { next?: { revalidate?: number } }).next?.revalidate,
			).toBe(3600);
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		}
	});

	it("shares one load between concurrent lookups", async () => {
		const lists = await Promise.all([
			getRangeList("vpn"),
			getRangeList("vpn"),
			getRangeList("vpn"),
		]);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(new Set(lists).size).toBe(1);
	});

	it("serves a stale list while refreshing it in the background", async () => {
		const now = Date.now();
		const first = await getRangeList("datacenter", now);
		const release = Promise.withResolvers<void>();
		fetchMock.mockImplementation(async (input) => {
			await release.promise;
			return listFetch(input);
		});

		expect(await getRangeList("datacenter", now + 11 * 60_000)).toBe(first);
		expect(fetchMock).toHaveBeenCalledTimes(4);

		release.resolve();
		await pendingRangeListLoads();
		expect(await getRangeList("datacenter")).not.toBe(first);
	});

	it("stops using a list that could not be refreshed for a week", async () => {
		const now = Date.now();
		await getRangeList("datacenter", now);
		fetchMock.mockRejectedValue(new Error("offline"));

		await getRangeList("datacenter", now + 11 * 60_000);
		await pendingRangeListLoads();
		expect(console.warn).toHaveBeenCalledWith(
			"[ip-reputation] List unavailable",
			{ label: "datacenter", error: "offline" },
		);
		expect(await getRangeList("datacenter", now + 8 * 24 * 60 * 60_000)).toBe(
			null,
		);
	});

	it("refuses a list whose upstream copy is more than a week old", async () => {
		const date = new Date(Date.now() - 8 * 24 * 60 * 60_000).toUTCString();
		fetchMock.mockImplementation(
			async (input) =>
				new Response(listBodies[String(input)], { headers: { date } }),
		);

		expect(await getRangeList("datacenter")).toBeNull();
		expect(console.warn).toHaveBeenCalledWith(
			"[ip-reputation] List unavailable",
			{ label: "datacenter", error: "List is out of date" },
		);
	});

	it("fails open on an error status, an unexpected body or an oversized file", async () => {
		fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }));
		expect(await getRangeList("datacenter")).toBeNull();

		resetRangeListCache();
		fetchMock.mockImplementation(
			async () => new Response("<html>error</html>"),
		);
		expect(await getRangeList("datacenter")).toBeNull();

		resetRangeListCache();
		fetchMock.mockImplementation(
			async (input) =>
				new Response(listBodies[String(input)], {
					headers: { "content-length": String(3 * 1024 * 1024) },
				}),
		);
		expect(await getRangeList("datacenter")).toBeNull();
	});

	it("keeps each list independent when one cannot be loaded", async () => {
		fetchMock.mockImplementation(async (input) =>
			String(input).includes("/vpn/")
				? new Response("busy", { status: 503 })
				: listFetch(input),
		);

		expect(await getRangeList("vpn")).toBeNull();
		expect(await getRangeList("datacenter")).not.toBeNull();
	});

	it("waits a bounded time for a cold list", async () => {
		vi.useFakeTimers();
		const release = Promise.withResolvers<void>();
		fetchMock.mockImplementation(async (input) => {
			await release.promise;
			return listFetch(input);
		});

		const lookup = getRangeList("datacenter");
		await vi.advanceTimersByTimeAsync(3_000);
		expect(await lookup).toBeNull();

		release.resolve();
		await pendingRangeListLoads();
		expect(await getRangeList("datacenter")).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry a failed load on every lookup", async () => {
		fetchMock.mockRejectedValue(new Error("offline"));

		await getRangeList("datacenter");
		await getRangeList("datacenter");
		await getRangeList("datacenter");

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("checkNewAccountAddress", () => {
	it("logs each list an address is in", async () => {
		expect(
			await checkNewAccountAddress("web-sign-in", DATACENTER_ADDRESS, {
				provider: "google",
				flow: "desktop",
			}),
		).toEqual(["datacenter"]);
		expect(console.warn).toHaveBeenCalledWith(
			"[ip-reputation] New account from a listed range",
			{
				surface: "web-sign-in",
				label: "datacenter",
				address: DATACENTER_ADDRESS,
				provider: "google",
				flow: "desktop",
			},
		);

		expect(
			await checkNewAccountAddress("mobile-email-session", VPN_ADDRESS),
		).toEqual(["vpn"]);
		expect(console.warn).toHaveBeenLastCalledWith(
			"[ip-reputation] New account from a listed range",
			{ surface: "mobile-email-session", label: "vpn", address: VPN_ADDRESS },
		);
	});

	it("logs nothing for an address in neither list", async () => {
		expect(
			await checkNewAccountAddress("web-sign-in", UNLISTED_ADDRESS),
		).toEqual([]);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("logs nothing when the lists are unavailable", async () => {
		fetchMock.mockRejectedValue(new Error("offline"));

		expect(
			await checkNewAccountAddress("web-sign-in", DATACENTER_ADDRESS),
		).toEqual([]);
		expect(console.warn).not.toHaveBeenCalledWith(
			"[ip-reputation] New account from a listed range",
			expect.anything(),
		);
	});
});

describe("logNewAccountAddress", () => {
	it("runs the lookup only after the response", async () => {
		const result = logNewAccountAddress(
			"web-sign-in",
			clientHeaders(DATACENTER_ADDRESS),
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(scheduled.tasks).toHaveLength(1);
		await runScheduled();
		expect(await result).toEqual(["datacenter"]);
	});

	it("does nothing and fetches nothing when off", async () => {
		env.CAP_IP_REPUTATION_LOG = "off";

		expect(
			logNewAccountAddress("web-sign-in", clientHeaders(DATACENTER_ADDRESS)),
		).toBeNull();
		expect(scheduled.tasks).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does nothing without a client address", () => {
		expect(logNewAccountAddress("web-sign-in", new Headers())).toBeNull();
		expect(scheduled.tasks).toHaveLength(0);
	});

	it("uses the address Vercel sets and unwraps IPv4-mapped addresses", async () => {
		const headers = new Headers({
			"x-real-ip": `::ffff:${DATACENTER_ADDRESS}`,
			"x-forwarded-for": UNLISTED_ADDRESS,
		});

		const result = logNewAccountAddress("web-sign-in", headers);
		await runScheduled();
		expect(await result).toEqual(["datacenter"]);
	});

	it("runs straight away outside a request", async () => {
		scheduled.outsideRequest = true;

		expect(
			await logNewAccountAddress(
				"web-sign-in",
				clientHeaders(DATACENTER_IPV6_ADDRESS),
			),
		).toEqual(["datacenter"]);
	});
});
