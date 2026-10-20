import { describe, expect, test } from "bun:test";
import { probe, validateHealth } from "../lib/probe";
import { SERVICES, serviceUrl } from "../lib/services";

const website = SERVICES[0];
const auth = SERVICES[1];
const media = SERVICES[4];
const render = SERVICES[5];

describe("lightweight probes", () => {
	test("uses bounded HEAD requests without redirects or a response download", async () => {
		let calls = 0;
		const fetcher = (async (_url, options) => {
			calls++;
			expect(options?.method).toBe("HEAD");
			expect(options?.redirect).toBe("manual");
			expect(options?.cache).toBe("no-store");
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		expect((await probe(website, "https://example.com", fetcher)).status).toBe(
			"operational",
		);
		expect(calls).toBe(1);
	});

	test("a transient failure is retried exactly once", async () => {
		let calls = 0;
		const fetcher = (async () =>
			new Response(null, {
				status: ++calls === 1 ? 503 : 200,
			})) as typeof fetch;
		expect((await probe(website, "https://example.com", fetcher)).status).toBe(
			"operational",
		);
		expect(calls).toBe(2);
	});

	test("network errors, redirects, and invalid JSON never report healthy", async () => {
		for (const fetcher of [
			async () => {
				throw new Error("unreachable");
			},
			async () => new Response(null, { status: 302 }),
			async () => new Response("not JSON"),
		])
			expect(
				(await probe(auth, "https://example.com", fetcher as typeof fetch))
					.status,
			).toBe("outage");
	});

	test("validates health payloads even when HTTP returns 200", async () => {
		expect(validateHealth(media, { status: "degraded" })).toBe(false);
		expect(validateHealth(render, { ok: true, workers: 0, slots: 0 })).toBe(
			false,
		);
		expect(validateHealth(render, { ok: true, workers: 2, slots: 4 })).toBe(
			true,
		);
		expect(validateHealth(auth, {})).toBe(false);
		const fetcher = (async () =>
			Response.json({ status: "ok" })) as typeof fetch;
		expect((await probe(media, "https://example.com", fetcher)).status).toBe(
			"operational",
		);
		expect((await probe(render, "https://example.com", fetcher)).status).toBe(
			"degraded",
		);
	});

	test("never permits credentials or non-HTTPS monitor URLs", () => {
		const definition = {
			...website,
			env: "STATUS_TEST_URL",
			defaultUrl: "http://example.com",
		};
		expect(() => serviceUrl(definition)).toThrow();
		expect(() =>
			serviceUrl({
				...definition,
				defaultUrl: "https://user:password@example.com",
			}),
		).toThrow();
	});
});
