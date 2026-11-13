import { afterEach, describe, expect, it, vi } from "vitest";

const dnsState = vi.hoisted(() => ({
	answers: new Map<string, string[]>(),
	calls: [] as string[],
}));

vi.mock("node:dns", async () => {
	const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
	const lookup = (
		hostname: string,
		options: unknown,
		callback: (
			error: NodeJS.ErrnoException | null,
			address: unknown,
			family?: number,
		) => void,
	) => {
		dnsState.calls.push(hostname);
		const answers = dnsState.answers.get(hostname);
		if (!answers) {
			const error: NodeJS.ErrnoException = new Error(`ENOTFOUND ${hostname}`);
			error.code = "ENOTFOUND";
			callback(error, undefined);
			return;
		}
		const entries = answers.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		}));
		const all =
			typeof options === "object" &&
			options !== null &&
			(options as { all?: boolean }).all;
		if (all) callback(null, entries);
		else callback(null, entries[0]?.address, entries[0]?.family);
	};
	return { ...actual, default: { ...actual, lookup }, lookup };
});

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "production",
	serverEnv: () => ({}),
}));
vi.mock("@cap/database", () => ({
	db: () => {
		throw new Error("No database in unit tests");
	},
}));
vi.mock("@/lib/infra-video-upload", () => ({}));
vi.mock("@/lib/developer-webhook-dispatch", () => ({}));
vi.mock("@/lib/infra-auto-top-up", () => ({}));
vi.mock("@/lib/infra-standing", () => ({}));
vi.mock("@/lib/developer-video-charge", () => ({}));

const {
	checkImportUrl,
	headStop,
	ImportStop,
	importStopFor,
	isMissingImportTable,
	openImportSource,
	preflightImport,
	streamSourceToParts,
} = await import("@/lib/infra-video-import");
const { isBlockedS3Endpoint } = await import("@/lib/s3-endpoint-policy");
const { requestPublicOnly } = await import("@/lib/storage-fetch");

const resolvesTo =
	(table: Record<string, string[]>) =>
	(url: string): Promise<boolean> =>
		isBlockedS3Endpoint(url, async (hostname) => table[hostname] ?? []);

const publicNames = resolvesTo({
	"media.example.com": ["93.184.216.34"],
	"cdn.example.com": ["93.184.216.35"],
	"mixed.example.com": ["93.184.216.34", "10.0.0.5"],
	"private.example.com": ["10.1.2.3"],
	"metadata.example.com": ["169.254.169.254"],
	"loopback6.example.com": ["::1"],
	"mapped.example.com": ["::ffff:127.0.0.1"],
});

const MP4_HEAD = new Uint8Array([
	0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
	0x00, 0x02, 0x00,
]);

const streamOf = (chunks: Uint8Array[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});

const okResponse = (
	chunks: Uint8Array[],
	headers: Record<string, string> = { "content-type": "video/mp4" },
) => new Response(streamOf(chunks), { status: 200, headers });

const redirect = (location: string, status = 302) =>
	new Response(null, { status, headers: { location } });

const codeOf = async (work: Promise<unknown>) => {
	try {
		await work;
		return "ok";
	} catch (error) {
		return error instanceof ImportStop ? error.code : `raw:${String(error)}`;
	}
};

afterEach(() => {
	dnsState.answers.clear();
	dnsState.calls.length = 0;
	vi.useRealTimers();
});

describe("checkImportUrl", () => {
	it("accepts a public https URL", async () => {
		expect(
			await checkImportUrl("https://media.example.com/a.mp4", {
				isBlocked: publicNames,
			}),
		).toBeNull();
	});

	it.each([
		["plain http", "http://media.example.com/a.mp4"],
		["credentials", "https://user:pass@media.example.com/a.mp4"],
		["a username alone", "https://user@media.example.com/a.mp4"],
		["an explicit port", "https://media.example.com:8443/a.mp4"],
		["the default port written out", "https://media.example.com:443x/a.mp4"],
		["localhost", "https://localhost/a.mp4"],
		["a localhost subdomain", "https://x.localhost/a.mp4"],
		[".local", "https://nas.local/a.mp4"],
		[".internal", "https://metadata.google.internal/computeMetadata/v1/"],
		["a file URL", "file:///etc/passwd"],
		["a gopher URL", "gopher://media.example.com/"],
		["a data URL", "data:video/mp4;base64,AAAA"],
		["no host", "https:///a.mp4"],
		[
			"a URL over 2,048 characters",
			`https://media.example.com/${"a".repeat(2_100)}`,
		],
		["IPv4 loopback", "https://127.0.0.1/a.mp4"],
		["IPv4 loopback, short form", "https://127.1/a.mp4"],
		["IPv4 loopback, decimal form", "https://2130706433/a.mp4"],
		["IPv4 loopback, hex form", "https://0x7f000001/a.mp4"],
		["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
		["RFC 1918 10/8", "https://10.0.0.1/a.mp4"],
		["RFC 1918 172.16/12", "https://172.16.5.4/a.mp4"],
		["RFC 1918 192.168/16", "https://192.168.1.1/a.mp4"],
		["carrier NAT", "https://100.64.0.1/a.mp4"],
		["this network", "https://0.0.0.0/a.mp4"],
		["multicast", "https://224.0.0.1/a.mp4"],
		["IPv6 loopback", "https://[::1]/a.mp4"],
		["IPv6 unspecified", "https://[::]/a.mp4"],
		["IPv6 unique local", "https://[fd00::1]/a.mp4"],
		["IPv6 link local", "https://[fe80::1]/a.mp4"],
		["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/a.mp4"],
		["IPv4-mapped metadata in hex", "https://[::ffff:a9fe:a9fe]/a.mp4"],
		["IPv4-compatible loopback", "https://[::7f00:1]/a.mp4"],
		["NAT64 metadata", "https://[64:ff9b::a9fe:a9fe]/a.mp4"],
		["6to4 wrapping a private address", "https://[2002:a00:1::1]/a.mp4"],
		["Teredo", "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/a.mp4"],
		["a name that resolves to 10/8", "https://private.example.com/a.mp4"],
		["a name that resolves to metadata", "https://metadata.example.com/a.mp4"],
		["a name with one private answer", "https://mixed.example.com/a.mp4"],
		["a name that resolves to ::1", "https://loopback6.example.com/a.mp4"],
		[
			"a name that resolves to a mapped address",
			"https://mapped.example.com/a.mp4",
		],
		["a name that does not resolve", "https://nowhere.example.com/a.mp4"],
	])("refuses %s", async (_label, url) => {
		const refused = await checkImportUrl(url, { isBlocked: publicNames });
		expect(refused?.code).toBe("url_not_allowed");
	});

	it("explains each refusal in words", async () => {
		const messages = await Promise.all(
			[
				"http://media.example.com/a.mp4",
				"https://user:pass@media.example.com/a.mp4",
				"https://media.example.com:8443/a.mp4",
				"https://169.254.169.254/",
			].map(
				async (url) =>
					(await checkImportUrl(url, { isBlocked: publicNames }))?.message,
			),
		);
		expect(messages).toEqual([
			"The URL must start with https://",
			"The URL must not contain a username or password",
			"The URL must use the default https port",
			"The URL must point to a public address",
		]);
	});
});

describe("redirects", () => {
	it("follows up to three redirects, checking every hop", async () => {
		const isBlocked = vi.fn(publicNames);
		const request = vi
			.fn()
			.mockResolvedValueOnce(redirect("https://cdn.example.com/1"))
			.mockResolvedValueOnce(redirect("/2", 301))
			.mockResolvedValueOnce(redirect("https://media.example.com/3", 307))
			.mockResolvedValueOnce(okResponse([MP4_HEAD]));
		const found = await preflightImport("https://media.example.com/0", {
			isBlocked,
			request,
		});
		expect(found.contentType).toBe("video/mp4");
		expect(isBlocked.mock.calls.map(([url]) => url)).toEqual([
			"https://media.example.com/0",
			"https://cdn.example.com/1",
			"https://cdn.example.com/2",
			"https://media.example.com/3",
		]);
		expect(request).toHaveBeenCalledTimes(4);
	});

	it("stops at the fourth redirect", async () => {
		const request = vi
			.fn()
			.mockImplementation(async () => redirect("https://cdn.example.com/x"));
		const stop = await preflightImport("https://media.example.com/0", {
			isBlocked: publicNames,
			request,
		}).catch((error) => error);
		expect(stop).toBeInstanceOf(ImportStop);
		expect(stop.code).toBe("url_unreachable");
		expect(request).toHaveBeenCalledTimes(4);
	});

	it.each([
		["a private literal", "https://10.0.0.1/a.mp4"],
		["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
		["metadata over https", "https://169.254.169.254/latest/meta-data/"],
		["a name that resolves privately", "https://private.example.com/a.mp4"],
		["plain http", "http://cdn.example.com/a.mp4"],
		["localhost", "https://localhost/a.mp4"],
		["a credentialed URL", "https://a:b@cdn.example.com/a.mp4"],
		["an odd port", "https://cdn.example.com:2375/a.mp4"],
	])(
		"refuses a redirect to %s without requesting it",
		async (_label, target) => {
			const request = vi.fn().mockResolvedValueOnce(redirect(target));
			expect(
				await codeOf(
					preflightImport("https://media.example.com/0", {
						isBlocked: publicNames,
						request,
					}),
				),
			).toBe("url_not_allowed");
			expect(request).toHaveBeenCalledTimes(1);
		},
	);
});

describe("DNS rebinding", () => {
	it("refuses at connect when the name answers privately after the check", async () => {
		const checked: string[] = [];
		const isBlocked = (url: string) =>
			isBlockedS3Endpoint(url, async (hostname) => {
				checked.push(hostname);
				return ["93.184.216.34"];
			});
		dnsState.answers.set("rebind.example.com", ["127.0.0.1"]);

		expect(
			await codeOf(
				preflightImport("https://rebind.example.com/a.mp4", {
					isBlocked,
					request: requestPublicOnly,
				}),
			),
		).toBe("url_not_allowed");
		expect(checked).toEqual(["rebind.example.com"]);
		expect(dnsState.calls).toEqual(["rebind.example.com"]);
	});

	it.each([
		["metadata", ["169.254.169.254"]],
		["IPv6 loopback", ["::1"]],
		["an IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
		["NAT64 metadata", ["64:ff9b::a9fe:a9fe"]],
		["one private answer among public ones", ["93.184.216.34", "10.0.0.7"]],
	])("refuses a connect-time answer of %s", async (_label, answers) => {
		dnsState.answers.set("rebind.example.com", answers);
		expect(
			await codeOf(
				preflightImport("https://rebind.example.com/a.mp4", {
					isBlocked: async () => false,
					request: requestPublicOnly,
				}),
			),
		).toBe("url_not_allowed");
	});
});

describe("what the URL serves", () => {
	const serve = (response: Response) => ({
		isBlocked: publicNames,
		request: vi.fn().mockResolvedValueOnce(response),
	});
	const html = new TextEncoder().encode("<!DOCTYPE html><html><body>hi");
	const playlist = new TextEncoder().encode("#EXTM3U\n#EXT-X-VERSION:3\n");
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const pdf = new TextEncoder().encode("%PDF-1.7\n");

	it.each([
		["a web page", okResponse([html], {})],
		[
			"a page served as text/html",
			okResponse([MP4_HEAD], { "content-type": "text/html; charset=utf-8" }),
		],
		["a playlist", okResponse([playlist], {})],
		["a PNG", okResponse([png], {})],
		[
			"a PDF",
			okResponse([pdf], { "content-type": "application/octet-stream" }),
		],
		["an image type", okResponse([MP4_HEAD], { "content-type": "image/jpeg" })],
		[
			"an AVI type",
			okResponse([MP4_HEAD], { "content-type": "video/x-msvideo" }),
		],
		["JSON", okResponse([MP4_HEAD], { "content-type": "application/json" })],
	])("refuses %s as unsupported_format", async (_label, response) => {
		expect(
			await codeOf(
				preflightImport("https://media.example.com/a", serve(response)),
			),
		).toBe("unsupported_format");
	});

	it.each([
		["a 404", new Response("nope", { status: 404 })],
		["a 500", new Response("nope", { status: 500 })],
		["an empty body", okResponse([])],
		["a redirect with no location", new Response(null, { status: 302 })],
	])("reports %s as url_unreachable", async (_label, response) => {
		expect(
			await codeOf(
				preflightImport("https://media.example.com/a", serve(response)),
			),
		).toBe("url_unreachable");
	});

	it("reports a declared length over the limit as too_large before reading", async () => {
		const body = new ReadableStream<Uint8Array>({ pull() {} });
		const response = new Response(body, {
			status: 200,
			headers: { "content-length": "999", "content-type": "video/mp4" },
		});
		expect(
			await codeOf(
				preflightImport("https://media.example.com/a", {
					...serve(response),
					maxBytes: 998,
				}),
			),
		).toBe("too_large");
	});

	it("accepts octet-stream and no type when the bytes look like a video", async () => {
		const variants: Record<string, string>[] = [
			{ "content-type": "application/octet-stream" },
			{},
		];
		for (const headers of variants) {
			expect(
				await codeOf(
					preflightImport(
						"https://media.example.com/a",
						serve(okResponse([MP4_HEAD], headers)),
					),
				),
			).toBe("ok");
		}
	});
});

describe("timeouts", () => {
	it("gives up when the source stops sending", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(MP4_HEAD);
			},
		});
		const source = await openImportSource("https://media.example.com/a", {
			isBlocked: publicNames,
			request: async () => new Response(body, { status: 200 }),
			stallTimeoutMs: 50,
		});
		const started = Date.now();
		expect((await source.read()).done).toBe(false);
		const error = await source.read().catch((caught) => caught);
		const stop = importStopFor(error, source.stopped());
		source.close();
		expect(stop.code).toBe("timeout");
		expect(stop.message).toMatch(/stopped sending data/);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("gives up when the headers never arrive", async () => {
		expect(
			await codeOf(
				openImportSource("https://media.example.com/a", {
					isBlocked: publicNames,
					request: () => new Promise<Response>(() => {}),
					stallTimeoutMs: 50,
				}),
			),
		).toBe("timeout");
	});

	it("gives up at the total deadline even while bytes keep coming", async () => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				timer = setInterval(() => controller.enqueue(MP4_HEAD), 10);
			},
			cancel() {
				clearInterval(timer);
			},
		});
		const source = await openImportSource("https://media.example.com/a", {
			isBlocked: publicNames,
			request: async () => new Response(body, { status: 200 }),
			stallTimeoutMs: 1_000,
			totalTimeoutMs: 150,
		});
		let error: unknown;
		try {
			for (;;) await source.read();
		} catch (caught) {
			error = caught;
		}
		const stop = importStopFor(error, source.stopped());
		source.close();
		clearInterval(timer);
		expect(stop.code).toBe("timeout");
		expect(stop.message).toMatch(/did not finish downloading/);
	});
});

describe("streamSourceToParts", () => {
	const chunks = (sizes: number[]) =>
		sizes.map((size, index) => new Uint8Array(size).fill(index + 1));

	const sourceOf = (list: Uint8Array[]) => {
		const reader = streamOf(list).getReader();
		return { read: () => reader.read() };
	};

	it("cuts the stream into fixed parts with one upload in flight at a time", async () => {
		let inFlight = 0;
		let most = 0;
		const sizes: number[] = [];
		const writer = {
			put: async (partNumber: number, bytes: Uint8Array) => {
				inFlight++;
				most = Math.max(most, inFlight);
				sizes[partNumber - 1] = bytes.length;
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight--;
				return `etag-${partNumber}`;
			},
		};
		const result = await streamSourceToParts(
			sourceOf(chunks([7, 3, 12, 1, 9])),
			{ chunks: [], length: 0, done: false },
			writer,
			{ maxBytes: 1_000, partBytes: 10 },
		);
		expect(result.totalBytes).toBe(32);
		expect(sizes).toEqual([10, 10, 10, 2]);
		expect(result.parts.map((part) => part.etag)).toEqual([
			"etag-1",
			"etag-2",
			"etag-3",
			"etag-4",
		]);
		expect(most).toBe(1);
	});

	it("stops mid-stream once the size cap is passed, with no Content-Length", async () => {
		const put = vi.fn(async (partNumber: number) => `etag-${partNumber}`);
		let delivered = 0;
		const endless = {
			read: async () => {
				delivered += 8;
				return { done: false as const, value: new Uint8Array(8) };
			},
		};
		const error = await streamSourceToParts(
			endless,
			{ chunks: [], length: 0, done: false },
			{ put },
			{ maxBytes: 50, partBytes: 16 },
		).catch((caught) => caught);
		expect(error).toBeInstanceOf(ImportStop);
		expect(error.code).toBe("too_large");
		expect(delivered).toBe(56);
		expect(put).toHaveBeenCalledTimes(3);
	});

	it("keeps the bytes it already read for the sniff", async () => {
		const put = vi.fn(async (partNumber: number, bytes: Uint8Array) => {
			expect(Array.from(bytes)).toEqual([1, 1, 2, 2, 2]);
			return `etag-${partNumber}`;
		});
		const result = await streamSourceToParts(
			sourceOf([new Uint8Array([2, 2, 2])]),
			{ chunks: [new Uint8Array([1, 1])], length: 2, done: false },
			{ put },
			{ maxBytes: 100, partBytes: 64 },
		);
		expect(result.totalBytes).toBe(5);
		expect(put).toHaveBeenCalledTimes(1);
	});
});

describe("headStop", () => {
	it("lets a real MP4 head through", () => {
		expect(headStop(MP4_HEAD)).toBeNull();
	});
});

describe("isMissingImportTable", () => {
	it("knows the MySQL missing-table error, wrapped or not", () => {
		const mysql = Object.assign(
			new Error("Table 'cap.developer_video_imports' doesn't exist"),
			{ errno: 1146, code: "ER_NO_SUCH_TABLE" },
		);
		expect(isMissingImportTable(mysql)).toBe(true);
		expect(
			isMissingImportTable(new Error("Failed query", { cause: mysql })),
		).toBe(true);
		expect(isMissingImportTable(new Error("Connection lost"))).toBe(false);
	});
});
