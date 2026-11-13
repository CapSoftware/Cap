// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditTransactionTable } from "@/app/(infra)/dashboard/infra/_components/credit-transaction-table";
import type { LedgerRow } from "@/lib/infra-ledger";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const row = (overrides: Partial<LedgerRow>): LedgerRow => ({
	id: "rowid000000001",
	type: "transcription",
	amountMicroCredits: -33,
	balanceAfterMicroCredits: 2_499_967,
	referenceId: "transcript00001",
	referenceType: "developer_transcript",
	metadata: null,
	createdAt: new Date("2026-11-13T10:00:00Z"),
	...overrides,
});

const desktopReferences = () =>
	Array.from(container.querySelectorAll("table tbody tr")).map(
		(tr) => tr.querySelectorAll("td")[2]?.textContent,
	);

describe("ledger Reference column", () => {
	it("shows the video or transcript the row is about, not the row's own id", () => {
		act(() =>
			root.render(
				createElement(CreditTransactionTable, {
					transactions: [
						row({}),
						row({
							id: "rowid000000002",
							type: "storage_daily",
							referenceType: "developer_video",
							referenceId: "video0000000001",
						}),
					],
				}),
			),
		);

		expect(desktopReferences()).toEqual([
			"Transcript transcript00001",
			"Video video0000000001",
		]);
		expect(container.querySelector("table")?.textContent).not.toContain(
			"rowid000000001",
		);
	});

	it("shows a dash when the row has no reference", () => {
		act(() =>
			root.render(
				createElement(CreditTransactionTable, {
					transactions: [
						row({
							type: "adjustment",
							amountMicroCredits: 100_000,
							referenceId: null,
							referenceType: null,
						}),
					],
				}),
			),
		);

		expect(desktopReferences()).toEqual(["–"]);
		expect(container.querySelector("ul")?.textContent).toContain("Reference –");
	});

	it("truncates a 66-character reference to one line, with the full value on hover", () => {
		const session = `cs_test_${"a1B2c3D4E5".repeat(5)}a1B2c3D4`;
		expect(session).toHaveLength(66);
		act(() =>
			root.render(
				createElement(CreditTransactionTable, {
					transactions: [
						row({
							type: "topup",
							amountMicroCredits: 2_500_000,
							referenceType: "stripe_checkout_session",
							referenceId: session,
						}),
					],
				}),
			),
		);

		const cell = container.querySelectorAll("table tbody tr td")[2];
		const reference = cell?.querySelector("[title]");
		expect(reference?.className.split(" ")).toEqual([
			"block",
			"max-w-[124px]",
			"xl:inline-block",
			"xl:max-w-[220px]",
			"xl:truncate",
			"xl:align-bottom",
		]);
		const [kind, id] = Array.from(reference?.children ?? []);
		expect(kind?.className).toBe("block truncate xl:inline");
		expect(id?.className.split(" ")).toEqual(
			expect.arrayContaining(["block", "truncate", "xl:inline"]),
		);
		expect(reference?.getAttribute("title")).toContain(session);
		expect(reference?.textContent).toContain(session);

		const card = container.querySelector("ul li [title]");
		expect(card?.getAttribute("title")).toContain(session);
		expect(card?.parentElement?.className).toContain("block truncate");
	});

	it("lets the Type label wrap at a readable width so it never runs into Reference", () => {
		act(() =>
			root.render(
				createElement(CreditTransactionTable, { transactions: [row({})] }),
			),
		);

		const typeCell = container.querySelectorAll("table tbody tr td")[1];
		const classes = typeCell?.className.split(" ") ?? [];
		expect(classes).toEqual(
			expect.arrayContaining(["w-full", "min-w-[140px]", "!whitespace-normal"]),
		);
		expect(classes).not.toContain("max-w-0");
	});

	it("uses the important wrap so the table cell's nowrap cannot win over it", () => {
		act(() =>
			root.render(
				createElement(CreditTransactionTable, { transactions: [row({})] }),
			),
		);

		const classes =
			container
				.querySelectorAll("table tbody tr td")[1]
				?.className.split(" ") ?? [];
		expect(classes).toContain("whitespace-nowrap");
		expect(classes).toContain("!whitespace-normal");
		expect(classes).not.toContain("whitespace-normal");
	});

	it("keeps the phone card reference on one line", () => {
		act(() =>
			root.render(
				createElement(CreditTransactionTable, { transactions: [row({})] }),
			),
		);

		const reference = container.querySelector("ul li [title]");
		expect(reference?.getAttribute("class")).toBeNull();
		for (const part of Array.from(reference?.children ?? [])) {
			expect(part.getAttribute("class") ?? "").not.toContain("block");
		}
	});

	it("shows the same reference on phones", () => {
		act(() =>
			root.render(
				createElement(CreditTransactionTable, { transactions: [row({})] }),
			),
		);

		const card = container.querySelector("ul li")?.textContent ?? "";
		expect(card).toContain("Reference Transcript transcript00001");
		expect(card).not.toContain("rowid000000001");
	});
});
