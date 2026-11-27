import { isEmailShape } from "@cap/database/auth/domain-utils";
import { describe, expect, it } from "vitest";

const legacyEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const accepted = [
	"a@b.co",
	"user@example.com",
	"first.last+tag@sub.example.co.uk",
	"UPPER@EXAMPLE.COM",
	"a@b.c",
	"x@y..z",
	"x@.y.z",
	"x@y.z.",
	"x@y.z.w",
	"a.b@c-d.io",
	"üser@exämple.de",
	"user@xn--bcher-kva.example",
	"a!#$%&'*+/=?^_`{|}~-@x.y",
	"\u{1f600}@x.y",
];

const rejected = [
	"",
	"plain",
	"@",
	"a@",
	"@b.c",
	"a@b",
	"a@b.",
	"a@.b",
	"a@.",
	"a@..",
	"a@b@c.d",
	"a@@b.c",
	"a b@c.d",
	"a@b .c",
	" a@b.c",
	"a@b.c ",
	"a@b.c\n",
	"\ta@b.c",
	"a@b.c ",
	"a @b.c",
	"a@b.c ",
	"a,b@c.d@e.f",
];

describe("isEmailShape", () => {
	it.each(accepted)("accepts %j like the previous regex", (value) => {
		expect(legacyEmailPattern.test(value)).toBe(true);
		expect(isEmailShape(value)).toBe(true);
	});

	it.each(rejected)("rejects %j like the previous regex", (value) => {
		expect(legacyEmailPattern.test(value)).toBe(false);
		expect(isEmailShape(value)).toBe(false);
	});

	it("agrees with the previous regex on every short string over an email-shaped alphabet", () => {
		const alphabet = ["a", "@", ".", " ", "\n", " ", "-"];
		let level = [""];
		let checked = 0;
		for (let length = 0; length < 7; length++) {
			level = level.flatMap((prefix) =>
				alphabet.map((piece) => prefix + piece),
			);
			for (const input of level) {
				checked++;
				if (isEmailShape(input) !== legacyEmailPattern.test(input)) {
					expect.fail(`disagreement on ${JSON.stringify(input)}`);
				}
			}
		}
		expect(checked).toBeGreaterThan(900_000);
	});

	it("returns quickly on the input that makes the previous regex quadratic", () => {
		const input = `a@${".".repeat(50_000)} !`;
		const start = performance.now();
		expect(isEmailShape(input)).toBe(false);
		expect(performance.now() - start).toBeLessThan(500);
	});

	it("returns quickly on long inputs with no @ or a late @", () => {
		for (const input of [
			"a".repeat(50_000),
			`${"a".repeat(50_000)}@b`,
			`a@${"b".repeat(50_000)}`,
			`a@${"b.".repeat(25_000)}`,
		]) {
			const expected = legacyEmailPattern.test(input);
			const start = performance.now();
			const actual = isEmailShape(input);
			expect(performance.now() - start).toBeLessThan(500);
			expect(actual).toBe(expected);
		}
	});
});
