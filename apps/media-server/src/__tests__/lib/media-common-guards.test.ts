import { describe, expect, test } from "bun:test";
import { isHlsPath, isPrivateHostLiteral } from "../../lib/media-common";

describe("isPrivateHostLiteral", () => {
	test.each([
		"localhost",
		"media.localhost",
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"[::1]",
		"::1",
		"[::]",
		"[fd00:ec2::254]",
		"[fe80::1]",
		"[::ffff:10.0.0.1]",
		"[::ffff:a9fe:a9fe]",
		"[::ffff:7f00:1]",
		"[0:0:0:0:0:ffff:c0a8:101]",
		"[::127.0.0.1]",
		"localhost.",
		"127.0.0.1.",
		"FE80::1",
		"[fec0::1]",
	])("%s is private", (host) => {
		expect(isPrivateHostLiteral(host)).toBe(true);
	});

	test("recognises the form URL parsing gives a mapped address", () => {
		for (const address of ["169.254.169.254", "127.0.0.1", "10.0.0.1"]) {
			const { hostname } = new URL(`http://[::ffff:${address}]/x`);
			expect(isPrivateHostLiteral(hostname)).toBe(true);
		}
		expect(
			isPrivateHostLiteral(new URL("http://[::ffff:8.8.8.8]/").hostname),
		).toBe(false);
		expect(isPrivateHostLiteral(new URL("http://localhost./").hostname)).toBe(
			true,
		);
	});

	test.each([
		"cap.so",
		"capso.s3.us-east-1.amazonaws.com",
		"8.8.8.8",
		"172.32.0.1",
		"100.128.0.1",
		"169.253.1.1",
		"[2606:4700::1111]",
		"[::ffff:808:808]",
		"not:an:address",
		"localhost.example.com",
	])("%s is not private", (host) => {
		expect(isPrivateHostLiteral(host)).toBe(false);
	});
});

describe("isHlsPath", () => {
	test("reads the path of a URL, ignoring its query and fragment", () => {
		expect(isHlsPath("https://example.com/stream.m3u8#start")).toBe(true);
		expect(isHlsPath("https://example.com/stream.m3u8?sig=a#t=1")).toBe(true);
		expect(isHlsPath("https://example.com/video?name=a.m3u8")).toBe(false);
		expect(isHlsPath("https://example.com/video#x.m3u8")).toBe(false);
		expect(isHlsPath("/tmp/local/master.M3U8")).toBe(true);
		expect(isHlsPath("/tmp/local/video.mp4")).toBe(false);
	});
});
