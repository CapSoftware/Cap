export const CREDIT_CODE_MAX_LENGTH = 64;

export function isFreeCreditCheckout(
	session: {
		mode?: string | null;
		status?: string | null;
		payment_status?: string | null;
		amount_total?: number | null;
		amount_subtotal?: number | null;
		payment_intent?: unknown;
	},
	amountCents: number,
) {
	return (
		session.mode === "payment" &&
		session.status === "complete" &&
		session.amount_total === 0 &&
		session.amount_subtotal === amountCents &&
		!session.payment_intent &&
		(session.payment_status === "paid" ||
			session.payment_status === "no_payment_required")
	);
}
