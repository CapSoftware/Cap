import { describe, expect, it } from "vitest";
import {
	isDefaultShareHostname,
	requestShareHostname,
} from "@/lib/share-web-url";

const headersFrom = (init: Record<string, string>) => new Headers(init);

describe("requestShareHostname", () => {
	it("reads the host header", () => {
		expect(requestShareHostname(headersFrom({ host: "cap.so" }))).toBe("cap.so");
	});

	it("prefers the forwarded host set by the proxy", () => {
		const headers = headersFrom({
			host: "cap-web.vercel.app",
			"x-forwarded-host": "looms.example.com",
		});

		expect(requestShareHostname(headers)).toBe("looms.example.com");
	});

	it("takes the first entry of a forwarded host list", () => {
		const headers = headersFrom({
			"x-forwarded-host": "looms.example.com, cap.so",
		});

		expect(requestShareHostname(headers)).toBe("looms.example.com");
	});

	it("lowercases the host and drops the port", () => {
		expect(requestShareHostname(headersFrom({ host: "LocalHost:3000" }))).toBe(
			"localhost",
		);
	});

	it("returns an empty string when no host header is present", () => {
		expect(requestShareHostname(headersFrom({}))).toBe("");
	});
});

describe("isDefaultShareHostname", () => {
	it.each(["cap.so", "cap.link", "localhost", "127.0.0.1"])(
		"treats %s as a default host",
		(hostname) => {
			expect(isDefaultShareHostname(hostname, "https://cap.so")).toBe(true);
		},
	);

	it("matches the configured web URL host", () => {
		expect(isDefaultShareHostname("cap.example.com", "https://cap.example.com")).toBe(
			true,
		);
	});

	it("rejects a custom domain", () => {
		expect(isDefaultShareHostname("looms.example.com", "https://cap.so")).toBe(
			false,
		);
	});

	it("falls back to the default host when the host is missing", () => {
		expect(isDefaultShareHostname("", "https://cap.so")).toBe(true);
	});

	it("falls back to the default host when the web URL is unparsable", () => {
		expect(isDefaultShareHostname("looms.example.com", "not-a-url")).toBe(true);
	});
});
