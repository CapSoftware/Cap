import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	hasMediaServerSecret,
	validateMediaServerSecret,
} from "../../lib/auth";

const saved = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const context = (secret?: string) => ({
	req: {
		header: (name: string) =>
			name === "x-media-server-secret" ? secret : undefined,
	},
});

afterEach(() => {
	if (saved === undefined) delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = saved;
});

describe("validateMediaServerSecret", () => {
	test("accepts only the exact secret", () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "correct-secret";
		expect(validateMediaServerSecret(context("correct-secret"))).toBe(true);
		for (const given of [
			undefined,
			"",
			"correct-secre",
			"correct-secret ",
			"correct-secreT",
			"x".repeat(4096),
		]) {
			expect(validateMediaServerSecret(context(given))).toBe(false);
			expect(hasMediaServerSecret(context(given))).toBe(false);
		}
	});

	test("rejects everything when no secret is configured", () => {
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(validateMediaServerSecret(context(""))).toBe(false);
			expect(validateMediaServerSecret(context("anything"))).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});
});
