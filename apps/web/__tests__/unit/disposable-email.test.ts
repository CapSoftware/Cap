import {
	hostMatchesDomainList,
	isDisposableEmailDomain,
} from "@cap/database/auth/disposable-email";
import { describe, expect, it, vi } from "vitest";

const noMx = async () => [];

describe("isDisposableEmailDomain", () => {
	it("flags listed domains without a DNS lookup", async () => {
		const resolveMx = vi.fn(noMx);
		await expect(
			isDisposableEmailDomain("mailinator.com", resolveMx),
		).resolves.toBe(true);
		await expect(
			isDisposableEmailDomain("YOPMAIL.COM.", resolveMx),
		).resolves.toBe(true);
		expect(resolveMx).not.toHaveBeenCalled();
	});

	it("flags subdomains of listed domains", async () => {
		await expect(
			isDisposableEmailDomain("team123.mailinator.com", noMx),
		).resolves.toBe(true);
	});

	it("flags unlisted domains whose mail is handled by a throwaway inbox service", async () => {
		await expect(
			isDisposableEmailDomain("brand-new-rotation.example", async () => [
				"in.mail.tm",
			]),
		).resolves.toBe(true);
	});

	it("allows ordinary domains", async () => {
		await expect(
			isDisposableEmailDomain("company-one.example", async () => [
				"aspmx.l.google.com",
				"alt1.aspmx.l.google.com",
			]),
		).resolves.toBe(false);
		await expect(
			isDisposableEmailDomain("company-two.example", async () => [
				"company-two-example.mail.protection.outlook.com",
			]),
		).resolves.toBe(false);
	});

	it("allows the domain when the MX lookup fails", async () => {
		await expect(
			isDisposableEmailDomain("dns-down.example", async () => {
				throw new Error("ETIMEOUT");
			}),
		).resolves.toBe(false);
	});

	it("refuses domains past DNS length limits without a lookup", async () => {
		const resolveMx = vi.fn(noMx);
		const deep = `${"a.".repeat(12)}example`;
		const long = `${"a".repeat(64)}.example`;
		await expect(isDisposableEmailDomain(deep, resolveMx)).resolves.toBe(true);
		await expect(isDisposableEmailDomain(long, resolveMx)).resolves.toBe(true);
		expect(resolveMx).not.toHaveBeenCalled();
	});

	it("caches a failed MX lookup instead of repeating it", async () => {
		const resolveMx = vi.fn(async () => {
			throw new Error("ETIMEOUT");
		});
		await isDisposableEmailDomain("flaky-dns.example", resolveMx);
		await isDisposableEmailDomain("flaky-dns.example", resolveMx);
		expect(resolveMx).toHaveBeenCalledTimes(1);
	});

	it("ignores values that are not domains", async () => {
		const resolveMx = vi.fn(noMx);
		await expect(isDisposableEmailDomain("localhost", resolveMx)).resolves.toBe(
			false,
		);
		await expect(isDisposableEmailDomain("", resolveMx)).resolves.toBe(false);
		expect(resolveMx).not.toHaveBeenCalled();
	});
});

describe("hostMatchesDomainList", () => {
	const list = new Set(["mail.tm"]);

	it("matches the host or any parent domain, but never a bare TLD", () => {
		expect(hostMatchesDomainList("mail.tm", list)).toBe(true);
		expect(hostMatchesDomainList("in.mail.tm.", list)).toBe(true);
		expect(hostMatchesDomainList("notmail.tm", list)).toBe(false);
		expect(hostMatchesDomainList("tm", new Set(["tm"]))).toBe(false);
	});
});
