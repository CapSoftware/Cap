import { INFRA_DELIVERY_BILLED_FROM } from "@/lib/infra-pricing";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

let reportedInvalid: string | null = null;

export function deliveryBillingStart(
	value: string | undefined = process.env.CAP_INFRA_DELIVERY_BILLING_FROM,
) {
	const day = value?.trim();
	if (!day) return null;
	const date = new Date(`${day}T00:00:00Z`);
	if (
		!DAY_PATTERN.test(day) ||
		Number.isNaN(date.getTime()) ||
		date.toISOString().slice(0, 10) !== day
	) {
		if (reportedInvalid !== day) {
			reportedInvalid = day;
			console.error(
				"[infra-delivery] CAP_INFRA_DELIVERY_BILLING_FROM is not a day",
				{ value: day },
			);
		}
		return null;
	}
	return day < INFRA_DELIVERY_BILLED_FROM ? INFRA_DELIVERY_BILLED_FROM : day;
}
