import { parseStorageCharge } from "@/lib/infra-standing";
import { creditDollars, signedCreditDollars } from "@/lib/infra-usage";

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
	video_create: "Video upload",
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
};

const DECLINED_WITHOUT_PAYMENT = /^declined-(\d{4}-\d{2}-\d{2})$/;

function ledgerLabel(row: LedgerRow) {
	if (row.referenceType === "auto_top_up") return "Auto top-up";
	if (row.referenceType === "stripe_checkout_session") return "Code redeemed";
	if (row.type === "storage_daily" && parseStorageCharge(row).shortSince) {
		return row.amountMicroCredits === 0
			? "Storage, unpaid"
			: "Storage, part paid";
	}
	return TYPE_LABELS[row.type] ?? row.type;
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

function paidCents(metadata: unknown) {
	let fields: unknown = metadata;
	if (typeof fields === "string") {
		try {
			fields = JSON.parse(fields);
		} catch {
			return null;
		}
	}
	if (typeof fields !== "object" || fields === null) return null;
	const paid = (fields as { paidCents?: unknown }).paidCents;
	return typeof paid === "number" && Number.isSafeInteger(paid) && paid >= 0
		? paid
		: null;
}

function ledgerNote(row: LedgerRow, label: string) {
	const fixed = NOTES[label];
	if (fixed) return fixed;
	if (label !== "Top-up") return null;
	const paid = paidCents(row.metadata);
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

export function ledgerPageWindow(
	rawPage: string | undefined,
	total: number,
	size: number = LEDGER_PAGE_SIZE,
) {
	const pages = Math.max(1, Math.ceil(total / size));
	const requested =
		rawPage !== undefined && /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
	const page = Math.min(Math.max(1, requested), pages);
	const offset = (page - 1) * size;
	return {
		page,
		pages,
		offset,
		from: total === 0 ? 0 : offset + 1,
		to: Math.min(total, offset + size),
	};
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
	const { label, note } = describeLedgerRow(row);
	return `${[
		csvText(row.id),
		new Date(row.createdAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
		csvText(label),
		csvText(note),
		csvText(row.referenceType),
		csvText(row.referenceId),
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
