import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const billing = fs.readFileSync(
	path.join(process.cwd(), "content/docs/api/billing.mdx"),
	"utf8",
);

describe("billing docs wording", () => {
	it("points a US business to the EIN field before checkout", () => {
		expect(billing).toContain(
			"Stripe's checkout has no US tax ID type, so a US business adds its EIN with \"Add your EIN\" on the console's Billing page before it pays",
		);
	});

	it("says where amounts are exact and that the sidebar shows whole cents", () => {
		expect(billing).not.toContain(
			"Every amount in the console and the API is exact.",
		);
		expect(billing).toContain(
			"Every balance and charge on the Billing page, in the ledger and in the API is exact.",
		);
		expect(billing).toContain(
			"The console sidebar shows the balance in whole cents, rounded down, with the exact amount on hover.",
		);
	});
});
