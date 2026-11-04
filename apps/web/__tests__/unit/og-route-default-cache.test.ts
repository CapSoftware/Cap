import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const imageResponseConstructions = vi.hoisted(() => ({
	count: 0,
	failNext: false,
}));

vi.mock("next/og", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next/og")>();
	class CountingImageResponse extends actual.ImageResponse {
		constructor(...args: ConstructorParameters<typeof actual.ImageResponse>) {
			imageResponseConstructions.count += 1;
			if (imageResponseConstructions.failNext) {
				imageResponseConstructions.failNext = false;
				throw new Error("render failed");
			}
			super(...args);
		}
	}
	return { ...actual, ImageResponse: CountingImageResponse };
});

const loadRoute = async () => {
	vi.resetModules();
	return import("../../app/api/og/route");
};

const fetchOg = async (
	GET: (req: NextRequest) => Promise<Response>,
	query: string,
) => {
	const res = await GET(
		new NextRequest(`http://localhost:3000/api/og${query}`),
	);
	expect(res.status).toBe(200);
	return {
		headers: Object.fromEntries(res.headers.entries()),
		bytes: Buffer.from(await res.arrayBuffer()),
	};
};

describe("/api/og default image reuse", () => {
	beforeEach(() => {
		imageResponseConstructions.count = 0;
		imageResponseConstructions.failNext = false;
		vi.stubEnv("NEXTAUTH_SECRET", "og-route-default-cache-test-secret");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("renders the default image once for any number of unsigned query strings", async () => {
		const { GET } = await loadRoute();
		const bare = await fetchOg(GET, "");
		const first = await fetchOg(GET, "?s=x1");
		const second = await fetchOg(GET, "?s=x2");
		for (let i = 0; i < 5; i += 1) {
			const res = await fetchOg(GET, `?x=${i}&title=${i}`);
			expect(res.bytes.equals(bare.bytes)).toBe(true);
		}

		expect(first.bytes.equals(bare.bytes)).toBe(true);
		expect(second.bytes.equals(bare.bytes)).toBe(true);
		expect(first.headers).toEqual(bare.headers);
		expect(second.headers).toEqual(bare.headers);
		expect(bare.headers["content-type"]).toBe("image/png");
		expect(bare.headers["cache-control"]).toBe(
			"public, max-age=31536000, s-maxage=31536000, immutable",
		);
		expect(bare.headers["x-robots-tag"]).toBe("noindex");
		expect(imageResponseConstructions.count).toBe(1);
	});

	it("still renders each signed request with its own copy and long caching", async () => {
		const { GET } = await loadRoute();
		const { ogImageUrl } = await import("../../lib/og/url");
		const defaultImage = await fetchOg(GET, "");
		const signed = await fetchOg(
			GET,
			ogImageUrl({
				title: "Simple, transparent pricing",
				tag: "Pricing",
				description: "Free for individuals. Powerful for teams.",
			}).replace("/api/og", ""),
		);

		expect(signed.bytes.equals(defaultImage.bytes)).toBe(false);
		expect(signed.headers).toEqual(defaultImage.headers);
		expect(imageResponseConstructions.count).toBe(2);
	});

	it("shares one render between overlapping requests on a cold instance", async () => {
		const { GET } = await loadRoute();
		const responses = await Promise.all(
			Array.from({ length: 6 }, (_, i) => fetchOg(GET, `?s=cold${i}`)),
		);

		for (const res of responses) {
			expect(res.bytes.equals(responses[0].bytes)).toBe(true);
		}
		expect(imageResponseConstructions.count).toBe(1);
	});

	it("renders the default image again after a failed render", async () => {
		const { GET } = await loadRoute();
		imageResponseConstructions.failNext = true;

		await expect(
			GET(new NextRequest("http://localhost:3000/api/og?s=fail")),
		).rejects.toThrow("render failed");
		const retried = await fetchOg(GET, "?s=retry");
		const reused = await fetchOg(GET, "?s=reuse");

		expect(retried.bytes.equals(reused.bytes)).toBe(true);
		expect(retried.headers["content-type"]).toBe("image/png");
		expect(imageResponseConstructions.count).toBe(2);
	});
});
