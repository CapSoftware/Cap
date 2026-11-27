import { findInsecureSecrets, formatInsecureSecrets } from "@cap/env";
import { describe, expect, it } from "vitest";

const strong =
	"9f1c2b7e4d5a6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";

describe("findInsecureSecrets", () => {
	it("flags missing and placeholder secrets", () => {
		const problems = findInsecureSecrets({
			NEXTAUTH_SECRET:
				"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
			DATABASE_ENCRYPTION_KEY: "",
			MEDIA_SERVER_WEBHOOK_SECRET: strong,
		});
		expect(problems).toEqual([
			{ name: "NEXTAUTH_SECRET", problem: "placeholder" },
			{ name: "DATABASE_ENCRYPTION_KEY", problem: "missing" },
		]);
		expect(formatInsecureSecrets(problems)).toContain("openssl rand -hex 32");
	});

	it("accepts unique secrets", () => {
		expect(
			findInsecureSecrets({
				NEXTAUTH_SECRET: strong,
				DATABASE_ENCRYPTION_KEY: `${strong.slice(1)}0`,
				MEDIA_SERVER_WEBHOOK_SECRET: `${strong.slice(2)}00`,
			}),
		).toEqual([]);
	});

	it("only checks the requested names", () => {
		expect(
			findInsecureSecrets(
				{ NEXTAUTH_SECRET: strong, DATABASE_ENCRYPTION_KEY: strong },
				["NEXTAUTH_SECRET", "DATABASE_ENCRYPTION_KEY"],
			),
		).toEqual([]);
	});
});
