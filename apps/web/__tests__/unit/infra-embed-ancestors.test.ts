import { describe, expect, it } from "vitest";
import { normalizeEmbedOrigin } from "@/lib/infra-domain";
import {
	embedFrameAncestors,
	embedFrameSource,
	embedPlaybackId,
	withFrameAncestors,
} from "@/lib/infra-embed-ancestors";

describe("embedFrameAncestors", () => {
	it("sends nothing for an empty list", () => {
		expect(embedFrameAncestors([])).toBeNull();
	});

	it("allows one site plus the hosted origin", () => {
		expect(embedFrameAncestors(["https://myshop.com"])).toBe(
			"frame-ancestors 'self' https://myshop.com",
		);
	});

	it("allows several sites, once each", () => {
		expect(
			embedFrameAncestors([
				"https://myshop.com",
				"https://www.myshop.com",
				"https://app.example.com:8443",
				"https://myshop.com",
			]),
		).toBe(
			"frame-ancestors 'self' https://myshop.com https://www.myshop.com https://app.example.com:8443",
		);
	});

	it("keeps localhost over http for testing", () => {
		expect(
			embedFrameAncestors(["http://localhost:3000", "http://127.0.0.1:8080"]),
		).toBe(
			"frame-ancestors 'self' http://localhost:3000 http://127.0.0.1:8080",
		);
	});

	it.each([
		"*.myshop.com",
		"https://*.myshop.com",
		"*",
		"http://myshop.com",
		"https://myshop.com/path",
		"https://myshop.com/",
		"myshop.com",
		"https://myshop.com; script-src *",
		"https://myshop.com https://evil.example",
		"https://user:pass@myshop.com",
		"javascript:alert(1)",
		"",
		"'self'",
		"'unsafe-inline'",
		"data:",
		"HTTPS://MYSHOP.COM",
	])("skips the stored entry %j", (entry) => {
		expect(embedFrameSource(entry)).toBeNull();
		expect(embedFrameAncestors([entry, "https://myshop.com"])).toBe(
			"frame-ancestors 'self' https://myshop.com",
		);
	});

	it("keeps a set list restrictive when no entry is usable", () => {
		expect(embedFrameAncestors(["http://myshop.com", "*.myshop.com"])).toBe(
			"frame-ancestors 'self'",
		);
	});
});

describe("withFrameAncestors", () => {
	const ancestors = "frame-ancestors 'self' https://myshop.com";

	it("sets the directive when there is no policy", () => {
		expect(withFrameAncestors(null, ancestors)).toBe(ancestors);
	});

	it("keeps the other directives of an existing policy", () => {
		expect(
			withFrameAncestors("default-src 'self'; img-src * data:", ancestors),
		).toBe(`default-src 'self'; img-src * data:; ${ancestors}`);
	});

	it("replaces an existing frame-ancestors directive", () => {
		expect(
			withFrameAncestors("default-src 'self'; Frame-Ancestors *; ", ancestors),
		).toBe(`default-src 'self'; ${ancestors}`);
	});
});

describe("embedPlaybackId", () => {
	it.each([
		["/dev/playback-id-0123456789ab/embed", "playback-id-0123456789ab"],
		["/dev/%70layback-id-0123456789ab/embed", "playback-id-0123456789ab"],
		["/Dev/playback-id-0123456789ab/Embed", "playback-id-0123456789ab"],
		["/DEV/playback-id-0123456789ab/EMBED", "playback-id-0123456789ab"],
		["/dev/playback%2Did%2D0123456789ab/embed", "playback-id-0123456789ab"],
	])("finds the playback id in %s", (path, id) => {
		expect(embedPlaybackId(path)).toBe(id);
	});

	it.each([
		"/dev/playback-id-0123456789ab",
		"/dev/playback-id-0123456789ab/embed/",
		"/dev/playback-id-0123456789ab/embed/x",
		"//dev/playback-id-0123456789ab/embed",
		"/dev/short/embed",
		"/dev/playback%2Fid-0123456789ab/embed",
		"/dev/%E0%A4%A/embed",
		"/s/playback-id-0123456789ab/embed",
		"/embed/playback-id-0123456789ab",
		"/%64ev/playback-id-0123456789ab/embed",
		"/dev/playback-id-0123456789ab/%65mbed",
	])("ignores %s", (path) => {
		expect(embedPlaybackId(path)).toBeNull();
	});
});

describe("normalizeEmbedOrigin", () => {
	it.each([
		["myshop.com", "https://myshop.com"],
		["https://myshop.com/pricing", "https://myshop.com"],
		["localhost:3000", "http://localhost:3000"],
		["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
	])("accepts %s as %s", (input, origin) => {
		expect(normalizeEmbedOrigin(input)).toEqual({ ok: true, origin });
	});

	it.each(["http://myshop.com", "*.myshop.com", "ftp://myshop.com", ""])(
		"refuses %j",
		(input) => {
			expect(normalizeEmbedOrigin(input).ok).toBe(false);
		},
	);
});
