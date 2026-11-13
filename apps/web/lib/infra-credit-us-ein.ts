import { syncCustomerUsEin } from "@/lib/checkout/customer-us-ein";
import { checkoutStripe } from "@/lib/checkout/stripe";
import { formatUsEin } from "@/lib/checkout/us-ein";

export const CREDIT_US_EIN_MAX_LENGTH = 20;

export const CREDIT_US_EIN_INVALID =
	"Enter the EIN as 9 digits, for example 12-3456789";

export type CreditUsEin =
	| { state: "none" }
	| { state: "invalid" }
	| { state: "valid"; ein: string };

export function parseCreditUsEin(input: string | undefined): CreditUsEin {
	const value = input?.trim() ?? "";
	if (!value) return { state: "none" };
	const ein = formatUsEin(value);
	return ein ? { state: "valid", ein } : { state: "invalid" };
}

export async function saveCreditUsEin(customerId: string, ein: string) {
	const { data } = await checkoutStripe().customers.listTaxIds(customerId, {
		limit: 100,
	});
	const replaced =
		data.find((taxId) => taxId.type === "us_ein" && taxId.value !== ein)
			?.value ?? null;
	await syncCustomerUsEin(customerId, ein, replaced);
}
