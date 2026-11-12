export const CREDIT_CODE_MAX_LENGTH = 64;

export function isFreeCreditCheckout(session: {
	mode?: string | null;
	status?: string | null;
	payment_status?: string | null;
	amount_total?: number | null;
	payment_intent?: unknown;
}) {
	return (
		session.mode === "payment" &&
		session.status === "complete" &&
		session.amount_total === 0 &&
		!session.payment_intent &&
		(session.payment_status === "paid" ||
			session.payment_status === "no_payment_required")
	);
}
