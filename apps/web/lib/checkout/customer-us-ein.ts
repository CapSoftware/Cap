import { checkoutStripe } from "@/lib/checkout/stripe";

export const US_EIN_METADATA_KEY = "usEin";

const customerUsEins = async (customerId: string) => {
	const { data } = await checkoutStripe().customers.listTaxIds(customerId, {
		limit: 100,
	});
	return data.filter((taxId) => taxId.type === "us_ein");
};

export async function syncCustomerUsEin(
	customerId: string,
	ein: string | null,
	previous: string | null,
) {
	const existing = await customerUsEins(customerId);
	const stale = existing.filter(
		(taxId) => previous && taxId.value === previous && taxId.value !== ein,
	);
	await Promise.all(
		stale.map((taxId) =>
			checkoutStripe().customers.deleteTaxId(customerId, taxId.id),
		),
	);
	if (ein && !existing.some((taxId) => taxId.value === ein)) {
		await checkoutStripe().customers.createTaxId(customerId, {
			type: "us_ein",
			value: ein,
		});
	}
}
