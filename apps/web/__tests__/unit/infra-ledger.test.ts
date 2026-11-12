import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/database/schema", () => ({
	developerCreditAccounts: {},
	developerCreditTransactions: {},
	developerVideos: {},
}));

import {
	describeLedgerRow,
	formatLedgerTime,
	LEDGER_CSV_COLUMNS,
	type LedgerRow,
	ledgerCsv,
	ledgerPageWindow,
	orderLedgerRows,
	serializeLedgerRow,
} from "@/lib/infra-ledger";

let serial = 0;
const row = (overrides: Partial<LedgerRow> = {}): LedgerRow => ({
	id: `tx${String(++serial).padStart(13, "0")}`,
	type: "transcription",
	amountMicroCredits: -33,
	balanceAfterMicroCredits: 2_499_967,
	referenceId: "8kq2m4x7n1p3v5w",
	referenceType: "developer_transcript",
	metadata: null,
	createdAt: new Date("2026-11-12T14:05:09Z"),
	...overrides,
});

const parseCsv = (text: string) => {
	const records: string[][] = [];
	let record: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				cell += '"';
				index++;
			} else if (char === '"') {
				quoted = false;
			} else {
				cell += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ",") {
			record.push(cell);
			cell = "";
		} else if (char === "\n") {
			record.push(cell.replace(/\r$/, ""));
			records.push(record);
			record = [];
			cell = "";
		} else {
			cell += char;
		}
	}
	if (cell !== "" || record.length > 0) {
		record.push(cell);
		records.push(record);
	}
	return records;
};

const csvTable = (text: string) => {
	const [header = [], ...lines] = parseCsv(text);
	return {
		header,
		records: lines.map((line) => ({
			width: line.length,
			cell: (name: string) => line[header.indexOf(name)] ?? "",
		})),
	};
};

const neighbours = <Item>(items: readonly Item[]) =>
	items.slice(1).map((older, index) => [items[index] as Item, older] as const);

describe("what each row says", () => {
	it.each([
		[
			"a top-up paid by card",
			row({
				type: "topup",
				amountMicroCredits: 2_500_000,
				referenceType: "stripe_payment_intent",
				referenceId: "pi_3TestPayment",
			}),
			{
				label: "Top-up",
				note: null,
				reference: { kind: "Payment", value: "pi_3TestPayment" },
			},
		],
		[
			"a code that covered the purchase",
			row({
				type: "topup",
				amountMicroCredits: 500_000,
				referenceType: "stripe_checkout_session",
				referenceId: "cs_test_a1b2c3",
			}),
			{
				label: "Code redeemed",
				note: "A code covered this purchase in full.",
				reference: { kind: "Checkout", value: "cs_test_a1b2c3" },
			},
		],
		[
			"an auto top-up",
			row({
				type: "topup",
				amountMicroCredits: 2_500_000,
				referenceType: "auto_top_up",
				referenceId: "pi_3TestAuto",
			}),
			{
				label: "Auto top-up",
				note: null,
				reference: { kind: "Payment", value: "pi_3TestAuto" },
			},
		],
		[
			"a storage day",
			row({
				type: "storage_daily",
				amountMicroCredits: -247,
				referenceType: "storage_day",
				referenceId: "2026-11-12",
				metadata: { snapshotDate: "2026-11-12", shortSince: null },
			}),
			{
				label: "Storage",
				note: null,
				reference: { kind: "Day", value: "2026-11-12" },
			},
		],
		[
			"a transcript",
			row(),
			{
				label: "Transcription",
				note: null,
				reference: { kind: "Transcript", value: "8kq2m4x7n1p3v5w" },
			},
		],
		[
			"an adjustment",
			row({
				type: "adjustment",
				amountMicroCredits: 2_500_000,
				referenceType: "manual",
				referenceId: null,
			}),
			{
				label: "Adjustment",
				note: "A credit or correction applied by Cap.",
				reference: null,
			},
		],
		[
			"the Cap Pro credit",
			row({
				type: "pro_credit",
				amountMicroCredits: 500_000,
				referenceType: "pro_monthly_credit",
				referenceId: "2026-11",
			}),
			{
				label: "Cap Pro credit",
				note: null,
				reference: { kind: "Month", value: "2026-11" },
			},
		],
		[
			"a declined auto top-up with no payment",
			row({
				type: "topup_failed",
				amountMicroCredits: 0,
				referenceType: "auto_top_up_failed",
				referenceId: "declined-2026-11-12",
			}),
			{
				label: "Auto top-up declined",
				note: "The card was not charged and no credit was added.",
				reference: { kind: "Day", value: "2026-11-12" },
			},
		],
		[
			"a day the balance could not pay for",
			row({
				type: "storage_daily",
				amountMicroCredits: 0,
				referenceType: "storage_day",
				referenceId: "2026-11-12",
				metadata: { shortSince: "2026-11-12T06:41:00.000Z" },
			}),
			{
				label: "Storage, unpaid",
				note: "The balance could not pay for this day. It is not charged later.",
				reference: { kind: "Day", value: "2026-11-12" },
			},
		],
	])("names %s and gives it a reference", (_name, entry, expected) => {
		expect(describeLedgerRow(entry)).toEqual(expected);
	});

	it("says what was paid when a code covered part of a top-up", () => {
		const partPaid = row({
			type: "topup",
			amountMicroCredits: 2_500_000,
			referenceType: "stripe_payment_intent",
			referenceId: "pi_3TestPayment",
			metadata: { amountCents: 2500, paidCents: 2000 },
		});

		expect(describeLedgerRow(partPaid).note).toBe(
			"$20.00 was paid for this credit.",
		);
		expect(
			describeLedgerRow({
				...partPaid,
				metadata: JSON.stringify({ amountCents: 2500, paidCents: 2000 }),
			}).note,
		).toBe("$20.00 was paid for this credit.");
		for (const metadata of [
			{ amountCents: 2500 },
			{ amountCents: 2500, paidCents: "2000" },
			{ amountCents: 2500, paidCents: -1 },
			null,
		]) {
			expect(describeLedgerRow({ ...partPaid, metadata }).note).toBeNull();
		}
	});

	it("gives every kind of row an id a customer can quote", () => {
		const entry = row({ type: "adjustment", referenceId: null });
		expect(serializeLedgerRow(entry).id).toBe(entry.id);
		expect(entry.id).toHaveLength(15);
	});

	it("states the time to the second, in UTC", () => {
		expect(formatLedgerTime(new Date("2026-11-12T14:05:09Z"))).toBe(
			"Nov 12, 2026, 14:05:09",
		);
		expect(formatLedgerTime(new Date("2026-11-12T23:59:59-08:00"))).toBe(
			"Nov 13, 2026, 07:59:59",
		);
		expect(formatLedgerTime(new Date("2026-01-01T00:00:00Z"))).toBe(
			"Jan 1, 2026, 00:00:00",
		);
	});
});

describe("the API shape", () => {
	it("carries exact dollars beside the micro-credits", () => {
		expect(serializeLedgerRow(row())).toEqual({
			id: expect.any(String),
			type: "transcription",
			description: "Transcription",
			note: null,
			amountMicroCredits: -33,
			amountDollars: "-0.00033",
			balanceAfterMicroCredits: 2_499_967,
			balanceAfterDollars: "24.99967",
			referenceType: "developer_transcript",
			referenceId: "8kq2m4x7n1p3v5w",
			createdAt: "2026-11-12T14:05:09.000Z",
		});
	});

	it("never passes metadata through", () => {
		const serialized = serializeLedgerRow(
			row({ metadata: { amountCents: 2500, internal: "note" } }),
		);
		expect(JSON.stringify(serialized)).not.toContain("internal");
		expect(serialized).not.toHaveProperty("metadata");
	});
});

describe("rows written in the same second", () => {
	const at = new Date("2026-11-12T14:05:09Z");

	it("are ordered so each balance follows from the row beneath it", () => {
		const first = row({
			id: "zzzzzzzzzzzzzzz",
			amountMicroCredits: -33,
			balanceAfterMicroCredits: 2_499_967,
			createdAt: at,
		});
		const second = row({
			id: "mmmmmmmmmmmmmmm",
			amountMicroCredits: -33,
			balanceAfterMicroCredits: 2_499_934,
			createdAt: at,
		});
		const third = row({
			id: "aaaaaaaaaaaaaaa",
			amountMicroCredits: 500_000,
			balanceAfterMicroCredits: 2_999_934,
			createdAt: at,
		});
		const earlier = row({
			type: "adjustment",
			amountMicroCredits: 2_500_000,
			balanceAfterMicroCredits: 2_500_000,
			createdAt: new Date("2026-11-12T14:00:00Z"),
		});

		for (const shuffled of [
			[first, second, third, earlier],
			[third, first, second, earlier],
			[second, third, first, earlier],
		]) {
			const ordered = orderLedgerRows(shuffled);
			expect(ordered.map((entry) => entry.id)).toEqual([
				third.id,
				second.id,
				first.id,
				earlier.id,
			]);
			for (const [newer, older] of neighbours(ordered)) {
				expect(newer.balanceAfterMicroCredits - newer.amountMicroCredits).toBe(
					older.balanceAfterMicroCredits,
				);
			}
		}
	});

	it("keeps rows that moved nothing where the balance they show was reached", () => {
		const credit = row({
			type: "topup",
			amountMicroCredits: 2_500,
			balanceAfterMicroCredits: 2_500,
			createdAt: at,
		});
		const pending = row({
			type: "topup_pending",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 2_500,
			createdAt: at,
		});
		const declined = row({
			type: "topup_failed",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 2_500,
			createdAt: at,
		});
		const debit = row({
			amountMicroCredits: -33,
			balanceAfterMicroCredits: 2_467,
			createdAt: at,
		});
		const before = row({
			type: "topup_failed",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 0,
			createdAt: at,
		});
		const group = [credit, pending, declined, debit, before];

		const orders = (rows: LedgerRow[]): LedgerRow[][] =>
			rows.length < 2
				? [rows]
				: rows.flatMap((first, index) =>
						orders(rows.filter((_, other) => other !== index)).map((rest) => [
							first,
							...rest,
						]),
					);

		for (const shuffled of orders(group)) {
			const ordered = orderLedgerRows(shuffled);
			expect(ordered.map((entry) => entry.id).sort()).toEqual(
				group.map((entry) => entry.id).sort(),
			);
			expect(ordered[0]?.id).toBe(debit.id);
			expect(ordered.at(-1)?.id).toBe(before.id);
			for (const [newer, older] of neighbours(ordered)) {
				expect(newer.balanceAfterMicroCredits - newer.amountMicroCredits).toBe(
					older.balanceAfterMicroCredits,
				);
			}
		}
	});

	it("keeps every row exactly once when the chain cannot be told apart", () => {
		const rows = [
			row({
				amountMicroCredits: 0,
				balanceAfterMicroCredits: 0,
				createdAt: at,
			}),
			row({
				amountMicroCredits: 0,
				balanceAfterMicroCredits: 0,
				createdAt: at,
			}),
			row({
				amountMicroCredits: 0,
				balanceAfterMicroCredits: 0,
				createdAt: at,
			}),
		];
		const ordered = orderLedgerRows(rows);
		expect(ordered.map((entry) => entry.id).sort()).toEqual(
			rows.map((entry) => entry.id).sort(),
		);
	});
});

describe("CSV export", () => {
	const ledger = [
		row({
			type: "transcription",
			amountMicroCredits: -33,
			balanceAfterMicroCredits: 2_999_901,
			createdAt: new Date("2026-11-12T14:20:00Z"),
		}),
		row({
			type: "topup",
			amountMicroCredits: 500_000,
			balanceAfterMicroCredits: 2_999_934,
			referenceType: "stripe_checkout_session",
			referenceId: "cs_test_a1b2c3",
			createdAt: new Date("2026-11-12T14:10:00Z"),
		}),
		row({
			type: "transcription",
			amountMicroCredits: -33,
			balanceAfterMicroCredits: 2_499_934,
			createdAt: new Date("2026-11-12T14:06:00Z"),
		}),
		row({
			type: "transcription",
			amountMicroCredits: -33,
			balanceAfterMicroCredits: 2_499_967,
			createdAt: new Date("2026-11-12T14:05:00Z"),
		}),
		row({
			type: "adjustment",
			amountMicroCredits: 2_500_000,
			balanceAfterMicroCredits: 2_500_000,
			referenceType: "manual",
			referenceId: null,
			createdAt: new Date("2026-11-12T13:00:00Z"),
		}),
	];

	it("has a header and one line per row", () => {
		const lines = parseCsv(ledgerCsv(ledger));
		expect(lines[0]).toEqual([...LEDGER_CSV_COLUMNS]);
		expect(lines).toHaveLength(ledger.length + 1);
		expect(lines[1]).toEqual([
			ledger[0]?.id,
			"2026-11-12T14:20:00Z",
			"Transcription",
			"",
			"developer_transcript",
			"8kq2m4x7n1p3v5w",
			"-0.00033",
			"-33",
			"29.99901",
			"2999901",
		]);
	});

	it("totals to the same figures as the ledger", () => {
		const { records } = csvTable(ledgerCsv(ledger));
		const microCredits = records.map((record) =>
			Number(record.cell("amount_micro_credits")),
		);
		const dollars = records.map((record) => Number(record.cell("amount_usd")));

		expect(records).toHaveLength(ledger.length);
		expect(microCredits.reduce((sum, value) => sum + value, 0)).toBe(
			ledger.reduce((sum, entry) => sum + entry.amountMicroCredits, 0),
		);
		expect(
			Math.round(dollars.reduce((sum, value) => sum + value, 0) * 100_000),
		).toBe(2_999_901);
		expect(records[0]?.cell("balance_micro_credits")).toBe("2999901");
		expect(records[0]?.cell("balance_usd")).toBe("29.99901");
		for (const record of records) {
			expect(Math.round(Number(record.cell("amount_usd")) * 100_000)).toBe(
				Number(record.cell("amount_micro_credits")),
			);
			expect(Math.round(Number(record.cell("balance_usd")) * 100_000)).toBe(
				Number(record.cell("balance_micro_credits")),
			);
		}
		for (const [newer, older] of neighbours(records)) {
			expect(
				Number(newer.cell("balance_micro_credits")) -
					Number(newer.cell("amount_micro_credits")),
			).toBe(Number(older.cell("balance_micro_credits")));
		}
	});

	it("quotes commas, quotes and line breaks so a cell stays one cell", () => {
		const awkward = row({
			type: "adjustment",
			referenceType: "manual",
			referenceId: 'Goodwill, "launch week"\nsecond line',
		});
		const text = ledgerCsv([awkward]);
		const { records } = csvTable(text);

		expect(text).toContain('"Goodwill, ""launch week""\nsecond line"');
		expect(records).toHaveLength(1);
		expect(records[0]?.width).toBe(LEDGER_CSV_COLUMNS.length);
		expect(records[0]?.cell("reference_id")).toBe(
			'Goodwill, "launch week"\nsecond line',
		);
	});

	it.each(["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx"])(
		"stops a spreadsheet running %j as a formula",
		(value) => {
			const { records } = csvTable(
				ledgerCsv([
					row({
						type: "adjustment",
						referenceType: "manual",
						referenceId: value,
					}),
				]),
			);
			expect(records[0]?.cell("reference_id")).toBe(`'${value}`);
		},
	);

	it("leaves negative amounts as numbers", () => {
		const { records } = csvTable(ledgerCsv([row()]));
		expect(records[0]?.cell("amount_usd")).toBe("-0.00033");
		expect(records[0]?.cell("amount_micro_credits")).toBe("-33");
	});

	it("is only a header for an app with no transactions", () => {
		expect(ledgerCsv([])).toBe(`${LEDGER_CSV_COLUMNS.join(",")}\r\n`);
	});
});

describe("paging the console ledger", () => {
	it.each([
		[undefined, 312, { page: 1, offset: 0, from: 1, to: 50, pages: 7 }],
		["2", 312, { page: 2, offset: 50, from: 51, to: 100, pages: 7 }],
		["7", 312, { page: 7, offset: 300, from: 301, to: 312, pages: 7 }],
		["99", 312, { page: 7, offset: 300, from: 301, to: 312, pages: 7 }],
		["0", 312, { page: 1, offset: 0, from: 1, to: 50, pages: 7 }],
		["-3", 312, { page: 1, offset: 0, from: 1, to: 50, pages: 7 }],
		["abc", 312, { page: 1, offset: 0, from: 1, to: 50, pages: 7 }],
		["2", 0, { page: 1, offset: 0, from: 0, to: 0, pages: 1 }],
		["1", 50, { page: 1, offset: 0, from: 1, to: 50, pages: 1 }],
	])("reads page %j of %i rows", (raw, total, expected) => {
		expect(ledgerPageWindow(raw, total)).toEqual(expected);
	});
});
