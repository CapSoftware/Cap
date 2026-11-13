export const TOP_UP_MIN_CENTS = 500;
export const TOP_UP_MAX_CENTS = 100_000;
export const TOP_UP_PRESETS_CENTS = [1_000, 2_500, 5_000, 10_000] as const;
export const TOP_UP_DEFAULT_CENTS = 2_500;

export type TopUpAmount =
	| { amountCents: number; error: null; custom: boolean }
	| { amountCents: null; error: string | null; custom: boolean };

const TYPED_AMOUNT = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{0,2}))?$/;

const dollarsLabel = (cents: number) =>
	`$${(cents / 100).toLocaleString("en-US", {
		minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
		maximumFractionDigits: 2,
	})}`;

const NOT_AN_AMOUNT = "Enter an amount in dollars, for example 25 or 12.50.";
const OUT_OF_RANGE = `Enter an amount from ${dollarsLabel(TOP_UP_MIN_CENTS)} to ${dollarsLabel(TOP_UP_MAX_CENTS)}.`;

export function resolveTopUpAmount(
	typed: string,
	presetCents: number | null,
): TopUpAmount {
	const text = typed.trim();
	if (text === "") {
		return { amountCents: presetCents, error: null, custom: false };
	}
	const match = TYPED_AMOUNT.exec(text);
	if (!match?.[1]) {
		return { amountCents: null, error: NOT_AN_AMOUNT, custom: true };
	}
	const amountCents =
		Number(match[1].replaceAll(",", "")) * 100 +
		Number((match[2] ?? "").padEnd(2, "0"));
	if (
		!Number.isSafeInteger(amountCents) ||
		amountCents < TOP_UP_MIN_CENTS ||
		amountCents > TOP_UP_MAX_CENTS
	) {
		return { amountCents: null, error: OUT_OF_RANGE, custom: true };
	}
	return { amountCents, error: null, custom: true };
}

export function topUpButtonLabel(amount: TopUpAmount) {
	return amount.amountCents === null
		? "Add credits"
		: `Add ${dollarsLabel(amount.amountCents)}`;
}
