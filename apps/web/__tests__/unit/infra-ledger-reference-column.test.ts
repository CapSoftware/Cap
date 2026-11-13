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
