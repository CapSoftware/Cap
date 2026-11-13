import { parseStorageCharge } from "@/lib/infra-standing";
import {
	creditDollars,
	formatCharge,
	signedCreditDollars,
} from "@/lib/infra-usage";

export const LEDGER_PAGE_SIZE = 50;

export type LedgerRow = {
	id: string;
	type: string;
	amountMicroCredits: number;
	balanceAfterMicroCredits: number;
	referenceId: string | null;
	referenceType: string | null;
	metadata: unknown;
	createdAt: Date;
};

export type LedgerDescription = {
	label: string;
	note: string | null;
	reference: { kind: string; value: string } | null;
};

const TYPE_LABELS: Record<string, string> = {
	topup: "Top-up",
	video_create: "Storage, first month",
	storage_daily: "Storage",
	transcription: "Transcription",
	refund: "Refund",
	adjustment: "Adjustment",
	pro_credit: "Cap Pro credit",
	topup_failed: "Auto top-up declined",
	topup_pending: "Auto top-up pending",
};

const REFERENCE_KINDS: Record<string, string> = {
	developer_transcript: "Transcript",
	developer_video: "Video",
	storage_day: "Day",
	stripe_payment_intent: "Payment",
	stripe_checkout_session: "Checkout",
	auto_top_up: "Payment",
	auto_top_up_failed: "Payment",
	auto_top_up_pending: "Payment",
	pro_monthly_credit: "Month",
	manual: "Note",
	stripe_refund: "Refund",
	stripe_dispute: "Dispute",
};

const REVERSAL_LABELS: Record<string, string> = {
	stripe_refund: "Payment reversed",
	stripe_dispute: "Payment disputed",
};

const REVERSAL_NOTES: Record<string, string> = {
	"Payment reversed": "Credit taken back because the payment was returned.",
	"Payment disputed":
		"Credit taken back for a disputed payment. The app is paused and auto top-up is off until Cap reviews it.",
};

const NOTES: Record<string, string> = {
	Adjustment: "A credit or correction applied by Cap.",
	"Code redeemed": "A code covered this purchase in full.",
	"Auto top-up declined": "The card was not charged and no credit was added.",
	"Auto top-up pending":
		"The bank has not confirmed this charge yet, so no credit has been added.",
	"Storage, unpaid":
		"The balance could not pay for this day. It is not charged later.",
	"Storage, part paid":
		"The balance paid for part of this day. The rest is not charged later.",
	"Storage, first month":
		"One month of storage for this video, charged when it became ready. It is charged daily after that.",
	"Storage, first month, unpaid":
		"The balance could not pay for this video's first month. It is not charged later.",
	"Storage, first month, part paid":
		"The balance paid for part of this video's first month. The rest is not charged later.",
};

const DECLINED_WITHOUT_PAYMENT = /^declined-(\d{4}-\d{2}-\d{2})$/;

function ledgerLabel(row: LedgerRow) {
	const reversal = REVERSAL_LABELS[row.referenceType ?? ""];
	if (reversal) return reversal;
	if (row.referenceType === "auto_top_up") return "Auto top-up";
	if (row.referenceType === "stripe_checkout_session") return "Code redeemed";
	if (row.type === "storage_daily" && parseStorageCharge(row).shortSince) {
		return row.amountMicroCredits === 0
			? "Storage, unpaid"
			: "Storage, part paid";
	}
	if (row.type === "video_create" && firstMonthFellShort(row)) {
		return row.amountMicroCredits === 0
			? "Storage, first month, unpaid"
			: "Storage, first month, part paid";
	}
	return TYPE_LABELS[row.type] ?? row.type;
}

function firstMonthFellShort(row: LedgerRow) {
	const owed = metadataAmount(row.metadata, "owedMicroCredits") ?? 0;
	return owed > Math.abs(row.amountMicroCredits);
}

function ledgerReference(row: LedgerRow) {
	if (!row.referenceId) return null;
	const declinedDay = DECLINED_WITHOUT_PAYMENT.exec(row.referenceId)?.[1];
	if (declinedDay) return { kind: "Day", value: declinedDay };
	return {
		kind: REFERENCE_KINDS[row.referenceType ?? ""] ?? "Reference",
		value: row.referenceId,
	};
}

function metadataAmount(metadata: unknown, field: string) {
	let fields: unknown = metadata;
	if (typeof fields === "string") {
		try {
			fields = JSON.parse(fields);
		} catch {
			return null;
		}
	}
	if (typeof fields !== "object" || fields === null) return null;
	const amount = (fields as Record<string, unknown>)[field];
	return typeof amount === "number" &&
		Number.isSafeInteger(amount) &&
		amount >= 0
		? amount
		: null;
}

function ledgerNote(row: LedgerRow, label: string) {
	const fixed = NOTES[label];
	if (fixed) return fixed;
	const reversal = REVERSAL_NOTES[label];
	if (reversal) {
		const uncollected = metadataAmount(row.metadata, "uncollectedMicroCredits");
		return uncollected
			? `${reversal} ${formatCharge(uncollected)} of it had already been spent and was not taken back.`
			: reversal;
	}
	if (label !== "Top-up") return null;
	const paid = metadataAmount(row.metadata, "paidCents");
	return paid === null
		? null
		: `$${(paid / 100).toFixed(2)} was paid for this credit.`;
}

export function describeLedgerRow(row: LedgerRow): LedgerDescription {
	const label = ledgerLabel(row);
	return {
		label,
		note: ledgerNote(row, label),
		reference: ledgerReference(row),
	};
}

const timeFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
});

export function formatLedgerTime(time: Date) {
	return timeFormat.format(new Date(time));
}

export function serializeLedgerRow(row: LedgerRow) {
	const { label, note } = describeLedgerRow(row);
	return {
		id: row.id,
		type: row.type,
		description: label,
		note,
		amountMicroCredits: row.amountMicroCredits,
		amountDollars: signedCreditDollars(row.amountMicroCredits),
		balanceAfterMicroCredits: row.balanceAfterMicroCredits,
		balanceAfterDollars: creditDollars(row.balanceAfterMicroCredits),
		referenceType: row.referenceType,
		referenceId: row.referenceId,
		createdAt: new Date(row.createdAt).toISOString(),
	};
}

const balanceBefore = (row: LedgerRow) =>
	row.balanceAfterMicroCredits - row.amountMicroCredits;

function chainNewestFirst<Row extends LedgerRow>(group: Row[]) {
	if (group.length < 2) return group;
	const unmoved = group.filter((row) => row.amountMicroCredits === 0);
	const remaining = group.filter((row) => row.amountMicroCredits !== 0);
	const oldestFirst: Row[] = [];
	const placeUnmovedAt = (balance: number) => {
		for (let index = 0; index < unmoved.length; ) {
			if (unmoved[index]?.balanceAfterMicroCredits === balance) {
				oldestFirst.push(...unmoved.splice(index, 1));
			} else {
				index++;
			}
		}
	};
	let next = remaining.findIndex(
		(candidate) =>
			!remaining.some(
				(other) =>
					other !== candidate &&
					other.balanceAfterMicroCredits === balanceBefore(candidate),
			),
	);
	while (remaining.length > 0) {
		const [row] = remaining.splice(next < 0 ? remaining.length - 1 : next, 1);
		if (!row) break;
		if (oldestFirst.length === 0) placeUnmovedAt(balanceBefore(row));
		oldestFirst.push(row);
		placeUnmovedAt(row.balanceAfterMicroCredits);
		next = remaining.findIndex(
			(candidate) => balanceBefore(candidate) === row.balanceAfterMicroCredits,
		);
	}
	return [...unmoved, ...oldestFirst].reverse();
}

export function orderLedgerRows<Row extends LedgerRow>(rows: readonly Row[]) {
	const newestFirst = [...rows].sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
	const ordered: Row[] = [];
	for (let start = 0; start < newestFirst.length; ) {
		const time = new Date(newestFirst[start]?.createdAt ?? 0).getTime();
		let end = start + 1;
		while (
			end < newestFirst.length &&
			new Date(newestFirst[end]?.createdAt ?? 0).getTime() === time
		) {
			end++;
		}
		ordered.push(...chainNewestFirst(newestFirst.slice(start, end)));
		start = end;
	}
	return ordered;
}

export const LEDGER_CSV_COLUMNS = [
	"id",
	"time_utc",
	"type",
	"note",
	"reference_type",
	"reference_id",
	"amount_usd",
	"amount_micro_credits",
	"balance_usd",
	"balance_micro_credits",
] as const;

const STARTS_A_FORMULA = /^[=+\-@\t\r]/;

const csvText = (value: string | null) => {
	if (!value) return "";
	const safe = STARTS_A_FORMULA.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function ledgerCsvLine(row: LedgerRow) {
	const { label, note, reference } = describeLedgerRow(row);
	return `${[
		csvText(row.id),
		new Date(row.createdAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
		csvText(label),
		csvText(note),
		csvText(reference?.kind ?? null),
		csvText(reference?.value ?? null),
		signedCreditDollars(row.amountMicroCredits),
		String(row.amountMicroCredits),
		creditDollars(row.balanceAfterMicroCredits),
		String(row.balanceAfterMicroCredits),
	].join(",")}\r\n`;
}

export const LEDGER_CSV_HEADER = `${LEDGER_CSV_COLUMNS.join(",")}\r\n`;

export function ledgerCsv(rows: readonly LedgerRow[]) {
	return LEDGER_CSV_HEADER + rows.map(ledgerCsvLine).join("");
}
