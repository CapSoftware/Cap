import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET as getMarketingOg } from "../../app/api/og/route";
import { signOgParams, verifyOgSignature } from "../../lib/og/signature";
import { ogImageUrl } from "../../lib/og/url";
import { formatDuration, renderVideoOg } from "../../lib/og/video-og";
import {
	richVideoLinkHtml,
	videoPreviewImageUrl,
} from "../../lib/video-share-clipboard";

const pngSize = (buf: Buffer) => {
	// PNG: 8-byte signature, IHDR length+type, then width/height (big endian).
	expect(buf.subarray(0, 8)).toEqual(
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	);
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

const renderMarketing = async (query: string) => {
	const res = await getMarketingOg(
		new NextRequest(`http://localhost:3000/api/og${query}`),
	);
	expect(res.status).toBe(200);
	return Buffer.from(await res.arrayBuffer());
};

describe("/api/og", () => {
	it("renders the default 1200x630 PNG with immutable caching", async () => {
		const res = await getMarketingOg(
			new NextRequest("http://localhost:3000/api/og"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("image/png");
		expect(res.headers.get("cache-control")).toContain("immutable");
		expect(res.headers.get("x-robots-tag")).toBe("noindex");
		const { width, height } = pngSize(Buffer.from(await res.arrayBuffer()));
		expect(width).toBe(1200);
		expect(height).toBe(630);
	});

	it("renders signed titles", async () => {
		const url = ogImageUrl({
			title: "Simple, transparent pricing",
			tag: "Pricing",
			description: "Free for individuals. Powerful for teams.",
		});
		expect(url).toMatch(/^\/api\/og\?/);
		const signedPng = await renderMarketing(url.replace("/api/og", ""));
		const defaultPng = await renderMarketing("");
		expect(pngSize(signedPng)).toEqual({ width: 1200, height: 630 });
		// The signed title actually renders (differs from the default image).
		expect(signedPng.equals(defaultPng)).toBe(false);
	});

	it("serves the default image for unsigned or forged params", async () => {
		const defaultPng = await renderMarketing("");
		const unsigned = await renderMarketing(
			"?title=Free%20Bitcoin%20at%20evil.example",
		);
		const forged = await renderMarketing(
			"?title=Free%20Bitcoin%20at%20evil.example&s=0000000000000000000000000000000",
		);
		// Signature for one title doesn't authorize different text.
		const replayed = await renderMarketing(
			`?title=${encodeURIComponent("Totally different words")}&s=${signOgParams(
				{ title: "Simple, transparent pricing" },
			)}`,
		);
		expect(unsigned.equals(defaultPng)).toBe(true);
		expect(forged.equals(defaultPng)).toBe(true);
		expect(replayed.equals(defaultPng)).toBe(true);
	});

	it("verifies signatures over all params", () => {
		const params = { title: "A", tag: "B", description: "C" };
		expect(verifyOgSignature(params, signOgParams(params))).toBe(true);
		expect(
			verifyOgSignature({ ...params, tag: "X" }, signOgParams(params)),
		).toBe(false);
		expect(verifyOgSignature(params, null)).toBe(false);
	});
});

describe("video og", () => {
	it("renders the video layout with caching headers", async () => {
		const res = await renderVideoOg({
			kind: "video",
			video: {
				title: "Cap walkthrough",
				ownerName: "Richie",
				duration: 204,
			},
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toContain(
			"stale-while-revalidate",
		);
		const { width, height } = pngSize(Buffer.from(await res.arrayBuffer()));
		expect(width).toBe(1200);
		expect(height).toBe(630);
	});

	it.each(["locked", "password", "not-found"] as const)(
		"renders the %s variant",
		async (kind) => {
			const res = await renderVideoOg({ kind });
			expect(res.status).toBe(200);
			pngSize(Buffer.from(await res.arrayBuffer()));
		},
	);

	it("formats durations", () => {
		expect(formatDuration(0)).toBe("0:00");
		expect(formatDuration(64.4)).toBe("1:04");
		expect(formatDuration(204)).toBe("3:24");
		expect(formatDuration(3671)).toBe("1:01:11");
	});
});

describe("rich share link", () => {
	it("builds the preview image url", () => {
		expect(videoPreviewImageUrl("https://cap.so", "abc123")).toBe(
			"https://cap.so/api/video/preview?videoId=abc123&fallback=og",
		);
	});

	it("escapes html in the clipboard markup", () => {
		const html = richVideoLinkHtml({
			url: 'https://cap.so/s/abc?"><script>',
			title: '<img onerror=alert(1)> & "quotes"',
			previewImageUrl: "https://cap.so/api/video/preview?videoId=abc",
		});
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img onerror");
		expect(html).toContain("&lt;img onerror");
		expect(html).toContain("&amp;");
		// The link and image are still present.
		expect(html).toContain('<a href="https://cap.so/s/abc?&quot;&gt;');
		expect(html).toContain("<img src=");
	});
});
