import { afterEach, describe, expect, test } from "bun:test";
import {
	assertMediaUrlAllowed,
	classifyHostLiteral,
	createGuardedMediaFetch,
	fetchCheckedMediaUrl,
	MediaAddressError,
	type MediaAddressPolicy,
	parsePrivateMediaHosts,
} from "../../lib/media-address-guard";
import { getSourceSize } from "../../lib/media-common";
import { MediaInputPolicyError } from "../../lib/media-input-policy";
import { childProcessEnv } from "../../lib/media-spawn";

const NONE: ReadonlySet<string> = new Set();
const ANY: ReadonlySet<string> = new Set(["*"]);

function resolvesTo(...addresses: string[]): MediaAddressPolicy["resolveHost"] {
	return async () => addresses;
}

const servers: { stop(force?: boolean): Promise<void> }[] = [];
const savedHosts = process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS;

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop(true)));
	if (savedHosts === undefined)
		delete process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS;
	else process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS = savedHosts;
});

function serve(handler: (request: Request) => Response) {
	const hits: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			hits.push(new URL(request.url).pathname);
			return handler(request);
		},
	});
	servers.push(server);
	return { hits, url: `http://127.0.0.1:${server.port}` };
}

describe("classifyHostLiteral", () => {
	test.each([
		["8.8.8.8", "public"],
		["172.32.0.1", "public"],
		["[2606:4700::1111]", "public"],
		["[::ffff:8.8.8.8]", "public"],
		["[64:ff9b::808:808]", "public"],
		["[2002:808:808::1]", "public"],
		["127.0.0.1", "private"],
		["10.1.2.3", "private"],
		["172.16.0.1", "private"],
		["192.168.1.1", "private"],
		["100.64.0.1", "private"],
		["100.100.100.200", "private"],
		["198.18.0.1", "private"],
		["[::1]", "private"],
		["[fc00::1]", "private"],
		["[fd12:3456::1]", "private"],
		["[fec0::1]", "private"],
		["[::ffff:10.0.0.1]", "private"],
		["[::127.0.0.1]", "private"],
		["[64:ff9b::7f00:1]", "private"],
		["[64:ff9b:1::1]", "private"],
		["[2002:7f00:1::1]", "private"],
		["[2001:0:4136:e378::1]", "private"],
		["169.254.169.254", "reserved"],
		["192.0.0.192", "reserved"],
		["0.0.0.0", "reserved"],
		["224.0.0.1", "reserved"],
		["255.255.255.255", "reserved"],
		["[::]", "reserved"],
		["[fe80::1]", "reserved"],
		["[ff02::1]", "reserved"],
		["[fd00:ec2::254]", "reserved"],
		["[::ffff:a9fe:a9fe]", "reserved"],
		["[64:ff9b::a9fe:a9fe]", "reserved"],
		["[2002:a9fe:a9fe::1]", "reserved"],
	] as const)("%s is %s", (host, expected) => {
		expect(classifyHostLiteral(host)).toBe(expected);
	});

	test("a name is not an address", () => {
		expect(classifyHostLiteral("169.254.169.254.nip.io")).toBeNull();
		expect(classifyHostLiteral("localtest.me")).toBeNull();
		expect(classifyHostLiteral("localhost")).toBeNull();
		expect(classifyHostLiteral("storage.localhost.")).toBeNull();
	});
});

describe("assertMediaUrlAllowed", () => {
	test.each([
		"http://127.0.0.1/video.mp4",
		"http://2130706433/video.mp4",
		"http://0x7f.0.0.1/video.mp4",
		"http://0177.0.0.1/video.mp4",
		"http://127.1/video.mp4",
		"http://LOCALHOST:9000/video.mp4",
		"http://localhost./video.mp4",
		"http://[::1]/video.mp4",
		"http://[::ffff:127.0.0.1]/video.mp4",
		"http://[0:0:0:0:0:ffff:7f00:1]/video.mp4",
		"http://10.0.0.5/video.mp4",
		"https://192.168.1.10/video.mp4",
		"http://[64:ff9b::7f00:1]/video.mp4",
	])("%s is refused unless its host is named", async (url) => {
		const refusal = await assertMediaUrlAllowed(url, {
			privateHosts: NONE,
		}).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(MediaAddressError);
		await assertMediaUrlAllowed(url, { privateHosts: ANY });
	});

	test.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://192.0.0.192/",
		"http://0.0.0.0/",
		"http://[::]/",
		"http://[fe80::1]/",
		"http://[fd00:ec2::254]/",
		"http://[::ffff:169.254.169.254]/",
		"http://[64:ff9b::a9fe:a9fe]/",
		"http://2852039166/",
	])("%s is refused even when every private host is allowed", async (url) => {
		await expect(
			assertMediaUrlAllowed(url, { privateHosts: ANY }),
		).rejects.toBeInstanceOf(MediaAddressError);
	});

	test.each(["file:///etc/hosts", "ftp://example.com/a.mp4", "not a url"])(
		"%s is refused",
		async (url) => {
			await expect(
				assertMediaUrlAllowed(url, { privateHosts: ANY }),
			).rejects.toBeInstanceOf(MediaAddressError);
		},
	);

	test("a name is judged by what it resolves to", async () => {
		const url = "https://media.example/video.mp4";
		await assertMediaUrlAllowed(url, {
			privateHosts: NONE,
			resolveHost: resolvesTo("93.184.216.34", "2606:2800:220:1::1"),
		});
		for (const addresses of [
			["127.0.0.1"],
			["10.0.0.5"],
			["::1"],
			["::ffff:192.168.0.1"],
			["93.184.216.34", "10.0.0.5"],
		]) {
			await expect(
				assertMediaUrlAllowed(url, {
					privateHosts: NONE,
					resolveHost: resolvesTo(...addresses),
				}),
			).rejects.toBeInstanceOf(MediaAddressError);
		}
		for (const addresses of [
			["169.254.169.254"],
			["93.184.216.34", "169.254.169.254"],
			["fe80::1%eth0"],
			["not an address"],
		]) {
			await expect(
				assertMediaUrlAllowed(url, {
					privateHosts: ANY,
					resolveHost: resolvesTo(...addresses),
				}),
			).rejects.toBeInstanceOf(MediaAddressError);
		}
	});

	test("a localhost name is judged by what it resolves to as well", async () => {
		await expect(
			assertMediaUrlAllowed("http://metadata.localhost/", {
				privateHosts: ANY,
				resolveHost: resolvesTo("169.254.169.254"),
			}),
		).rejects.toBeInstanceOf(MediaAddressError);
		await assertMediaUrlAllowed("http://storage.localhost:9000/a.mp4", {
			privateHosts: ANY,
			resolveHost: resolvesTo("127.0.0.1"),
		});
	});

	test("a private host is allowed only by its own name", async () => {
		const policy = {
			privateHosts: parsePrivateMediaHosts(" MinIO , [::1] "),
			resolveHost: resolvesTo("172.18.0.3"),
		};
		await assertMediaUrlAllowed("http://minio:9000/bucket/a.mp4", policy);
		await assertMediaUrlAllowed("http://[::1]:9000/bucket/a.mp4", policy);
		await expect(
			assertMediaUrlAllowed("http://mysql:3306/", policy),
		).rejects.toBeInstanceOf(MediaAddressError);
		await expect(
			assertMediaUrlAllowed("http://127.0.0.1:9000/", policy),
		).rejects.toBeInstanceOf(MediaAddressError);
	});

	test("a failed lookup is an error that can be retried, not a refusal", async () => {
		for (const resolveHost of [
			async () => {
				throw new Error("ENOTFOUND");
			},
			resolvesTo(),
		]) {
			const error = await assertMediaUrlAllowed("https://media.example/a.mp4", {
				privateHosts: NONE,
				resolveHost,
			}).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(MediaAddressError);
			expect((error as Error).message).toBe("Media host could not be resolved");
		}
	});

	test("helper processes inherit the allowed hosts", () => {
		expect(
			childProcessEnv({ MEDIA_SERVER_INTERNAL_MEDIA_HOSTS: "minio" }),
		).toEqual({ MEDIA_SERVER_INTERNAL_MEDIA_HOSTS: "minio" });
	});

	test("reads the allowed hosts from the environment", async () => {
		process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS = "";
		await expect(
			assertMediaUrlAllowed("http://127.0.0.1:9000/a.mp4"),
		).rejects.toThrow("MEDIA_SERVER_INTERNAL_MEDIA_HOSTS");
		process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS = "127.0.0.1";
		await assertMediaUrlAllowed("http://127.0.0.1:9000/a.mp4");
	});
});

describe("createGuardedMediaFetch", () => {
	test("does not request a private address it was given", async () => {
		const origin = serve(() => new Response("internal"));
		const url = `${origin.url}/video.mp4`;
		await expect(
			createGuardedMediaFetch(url, { privateHosts: NONE })(url),
		).rejects.toBeInstanceOf(MediaAddressError);
		expect(origin.hits).toEqual([]);
	});

	test("does not request a name that resolves to a private address", async () => {
		const origin = serve(() => new Response("internal"));
		const url = `http://storage.example:${new URL(origin.url).port}/video.mp4`;
		await expect(
			createGuardedMediaFetch(url, {
				privateHosts: NONE,
				resolveHost: resolvesTo("127.0.0.1"),
			})(url),
		).rejects.toBeInstanceOf(MediaAddressError);
		expect(origin.hits).toEqual([]);
	});

	test("connects to the address that was checked, under the name it was given", async () => {
		const seen: (string | null)[] = [];
		const origin = serve((request) => {
			seen.push(request.headers.get("host"));
			return new Response("media");
		});
		const port = new URL(origin.url).port;
		const lookups: string[] = [];
		const url = `http://storage.internal:${port}/video.mp4`;
		const response = await createGuardedMediaFetch(url, {
			privateHosts: new Set(["storage.internal"]),
			resolveHost: async (hostname) => {
				lookups.push(hostname);
				return lookups.length === 1 ? ["127.0.0.1"] : ["169.254.169.254"];
			},
		})(url, { headers: { Range: "bytes=0-4" } });
		expect(await response.text()).toBe("media");
		expect(seen).toEqual([`storage.internal:${port}`]);
		expect(lookups).toEqual(["storage.internal"]);
	});

	test("pins the request to a checked address and falls back to the next one", async () => {
		const calls: { target: string; host: string; serverName?: string }[] = [];
		const fetchImpl = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const pinned = init as RequestInit & { tls?: { serverName: string } };
			calls.push({
				target: String(input),
				host: new Headers(init?.headers).get("host") ?? "",
				serverName: pinned.tls?.serverName,
			});
			if (calls.length === 1) throw new Error("ECONNREFUSED");
			return new Response("ok");
		}) as typeof fetch;
		const url = "https://media.example:8443/a/video.mp4?sig=1";
		const response = await createGuardedMediaFetch(url, {
			privateHosts: NONE,
			resolveHost: resolvesTo(
				"2606:2800:220:1::1",
				"93.184.216.34",
				"93.184.216.35",
			),
			fetchImpl,
		})(url);
		expect(await response.text()).toBe("ok");
		expect(calls).toEqual([
			{
				target: "https://93.184.216.34:8443/a/video.mp4?sig=1",
				host: "media.example:8443",
				serverName: "media.example",
			},
			{
				target: "https://93.184.216.35:8443/a/video.mp4?sig=1",
				host: "media.example:8443",
				serverName: "media.example",
			},
		]);
	});

	test("does not try another address once the request was cancelled", async () => {
		const controller = new AbortController();
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts++;
			controller.abort();
			throw new Error("aborted");
		}) as unknown as typeof fetch;
		const url = "http://media.example/video.mp4";
		await expect(
			createGuardedMediaFetch(url, {
				privateHosts: NONE,
				resolveHost: resolvesTo("93.184.216.34", "93.184.216.35"),
				fetchImpl,
			})(url, { signal: controller.signal }),
		).rejects.toThrow("aborted");
		expect(attempts).toBe(1);
	});

	test("checks every hop of a redirect before following it", async () => {
		const internal = serve(() => new Response("internal"));
		const origin = serve((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/first")
				return new Response(null, {
					status: 302,
					headers: { Location: "/second" },
				});
			if (path === "/second")
				return new Response(null, {
					status: 307,
					headers: { Location: `${internal.url}/latest/meta-data/` },
				});
			return new Response("ok");
		});
		const url = `${origin.url}/first`;

		for (const privateHosts of [ANY, new Set(["127.0.0.1"])]) {
			origin.hits.length = 0;
			await expect(
				createGuardedMediaFetch(url, { privateHosts })(url),
			).rejects.toBeInstanceOf(MediaInputPolicyError);
			expect(origin.hits).toEqual(["/first", "/second"]);
		}
		expect(internal.hits).toEqual([]);

		const sameOrigin = await createGuardedMediaFetch(`${origin.url}/direct`, {
			privateHosts: ANY,
		})(`${origin.url}/direct`);
		expect(await sameOrigin.text()).toBe("ok");
	});

	test.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://[::ffff:169.254.169.254]/",
		"http://10.0.0.5/",
		"file:///etc/hosts",
	])("refuses a redirect to %s", async (location) => {
		const origin = serve(
			() =>
				new Response(null, { status: 302, headers: { Location: location } }),
		);
		const url = `${origin.url}/video.mp4`;
		await expect(
			createGuardedMediaFetch(url, { privateHosts: ANY })(url),
		).rejects.toThrow("redirected to an address that is not allowed");
	});

	test("refuses a redirect to a name that resolves to a private address", async () => {
		const origin = serve(
			() =>
				new Response(null, {
					status: 302,
					headers: { Location: "http://rebound.example/a" },
				}),
		);
		const url = `${origin.url}/video.mp4`;
		await expect(
			createGuardedMediaFetch(url, {
				privateHosts: new Set(["127.0.0.1"]),
				resolveHost: resolvesTo("10.0.0.5"),
			})(url),
		).rejects.toBeInstanceOf(MediaInputPolicyError);
	});
});

describe("fetchCheckedMediaUrl", () => {
	test("makes one checked, pinned request and leaves redirects to the caller", async () => {
		const origin = serve((request) =>
			new URL(request.url).pathname === "/moved"
				? new Response(null, { status: 302, headers: { Location: "/here" } })
				: new Response(request.headers.get("host")),
		);
		const port = new URL(origin.url).port;
		const policy = {
			privateHosts: new Set(["storage.internal"]),
			resolveHost: resolvesTo("127.0.0.1"),
		};
		const response = await fetchCheckedMediaUrl(
			`http://storage.internal:${port}/here`,
			{ redirect: "error" },
			policy,
		);
		expect(await response.text()).toBe(`storage.internal:${port}`);
		await expect(
			fetchCheckedMediaUrl(
				`http://storage.internal:${port}/moved`,
				{ redirect: "error" },
				policy,
			),
		).rejects.toThrow();
		await expect(
			fetchCheckedMediaUrl(`${origin.url}/here`, undefined, {
				privateHosts: NONE,
			}),
		).rejects.toBeInstanceOf(MediaAddressError);
		expect(origin.hits).toEqual(["/here", "/moved"]);
	});

	test("stops waiting on a slow lookup when the caller cancels", async () => {
		const cancelled = new AbortController();
		const pending = fetchCheckedMediaUrl(
			"http://storage.internal/here",
			{ signal: cancelled.signal },
			{ privateHosts: ANY, resolveHost: () => new Promise(() => {}) },
		);
		cancelled.abort(new Error("deadline passed"));
		await expect(pending).rejects.toThrow("deadline passed");
	});
});

describe("getSourceSize", () => {
	test("does not follow a redirect of the size request to another private service", async () => {
		const internal = serve(
			() =>
				new Response("x", {
					status: 206,
					headers: { "Content-Range": "bytes 0-0/12345" },
				}),
		);
		const origin = serve(
			() =>
				new Response(null, {
					status: 302,
					headers: { Location: `${internal.url}/latest/meta-data/` },
				}),
		);
		for (const hosts of ["*", "127.0.0.1"]) {
			process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS = hosts;
			await expect(getSourceSize(`${origin.url}/video.mp4`)).rejects.toThrow(
				"redirected to an address that is not allowed",
			);
		}
		expect(internal.hits).toEqual([]);
	});

	test("does not request a private address unless its host is named", async () => {
		const origin = serve(
			() =>
				new Response("x", {
					status: 206,
					headers: { "Content-Range": "bytes 0-0/777" },
				}),
		);
		process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS = "";
		await expect(
			getSourceSize(`${origin.url}/video.mp4`),
		).rejects.toBeInstanceOf(MediaAddressError);
		expect(origin.hits).toEqual([]);
		process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS = "127.0.0.1";
		expect(await getSourceSize(`${origin.url}/video.mp4`)).toBe(777);
	});
});
