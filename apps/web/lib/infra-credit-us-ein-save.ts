import { syncCustomerUsEin } from "@/lib/checkout/customer-us-ein";
import { checkoutStripe } from "@/lib/checkout/stripe";

export async function saveCreditUsEin(customerId: string, ein: string) {
	const { data } = await checkoutStripe().customers.listTaxIds(customerId, {
		limit: 100,
	});
	const replaced =
		data.find((taxId) => taxId.type === "us_ein" && taxId.value !== ein)
			?.value ?? null;
	await syncCustomerUsEin(customerId, ein, null);
	if (replaced) await syncCustomerUsEin(customerId, ein, replaced);
}
