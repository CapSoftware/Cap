// @vitest-environment jsdom

import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getInvoiceHistory,
	getInvoiceHistoryPage,
} from "@/actions/billing/invoices";
import { InvoiceHistory } from "@/app/(org)/dashboard/settings/invoices/invoice-history";
import type { BillingDocument } from "@/lib/billing/invoices";

vi.mock("@/actions/billing/invoices", () => ({
	getInvoiceHistory: vi.fn(),
	getInvoiceHistoryPage: vi.fn(),
}));
vi.mock("@cap/ui", () => {
	const container = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Card: container,
		CardHeader: container,
		CardTitle: container,
		CardDescription: container,
		Button: ({
			children,
			onClick,
			disabled,
		}: ComponentProps<"button"> & { spinner?: boolean }) =>
			createElement("button", { type: "button", onClick, disabled }, children),
	};
});
const invoice = (
	overrides: Partial<BillingDocument> = {},
): BillingDocument => ({
	id: "in_example",
	number: "CAP-001",
	description: "Cap Pro",
	created: 100,
	total: 1000,
	currency: "usd",
	status: "paid",
	kind: "invoice",
	url: "https://pay.stripe.com/invoice/example/pdf",
	...overrides,
});
const fixture = (): NonNullable<
	ComponentProps<typeof InvoiceHistory>["initialHistory"]
> => ({
	sections: [
		{
			id: "source",
			title: "Account purchases",
			page: {
				documents: [invoice()],
				next: { invoices: "in_example", receipts: null },
			},
		},
	],
	warnings: [],
});
const environment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root;
let container: HTMLDivElement;
const button = (text: string) =>
	Array.from(container.querySelectorAll("button")).find(
		(element) => element.textContent === text,
	);
const render = async (
	history: ComponentProps<typeof InvoiceHistory>["initialHistory"] = fixture(),
) => {
	await act(async () =>
		root.render(createElement(InvoiceHistory, { initialHistory: history })),
	);
};
beforeEach(() => {
	environment.IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	vi.mocked(getInvoiceHistory).mockReset().mockResolvedValue(fixture());
	vi.mocked(getInvoiceHistoryPage)
		.mockReset()
		.mockResolvedValue({ documents: [], next: null });
});
afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	delete environment.IS_REACT_ACT_ENVIRONMENT;
});
describe("invoice history interactions", () => {
	it("shows payment state and documents with accessible download names", async () => {
		const history = fixture();
		history.sections[0]?.page?.documents.push(
			invoice({
				id: "ch_desktop",
				description: "Desktop license",
				number: null,
				kind: "receipt",
				url: "https://pay.stripe.com/receipts/example",
			}),
			invoice({ id: "in_pending", number: "CAP-002", url: null }),
		);
		await render(history);
		expect(container.textContent).toContain("$10.00");
		expect(container.textContent).toContain("paid");
		expect(container.textContent).toContain("Download PDF for CAP-001");
		expect(container.textContent).toContain("View receipt for Desktop license");
		expect(container.textContent).toContain("Not available yet");
		expect(container.querySelectorAll("a")).toHaveLength(2);
	});
	it("appends older documents without duplicates and removes the exhausted pager", async () => {
		vi.mocked(getInvoiceHistoryPage).mockResolvedValue({
			documents: [
				invoice(),
				invoice({ id: "in_older", number: "CAP-000", created: 1 }),
			],
			next: null,
		});
		await render();
		await act(async () => button("Load older documents")?.click());
		expect(getInvoiceHistoryPage).toHaveBeenCalledWith("source", {
			invoices: "in_example",
			receipts: null,
		});
		expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
		expect(button("Load older documents")).toBeUndefined();
	});
	it("prevents duplicate page requests and preserves loaded invoices on failure", async () => {
		let fail: (error: Error) => void = () => {};
		vi.mocked(getInvoiceHistoryPage).mockReturnValueOnce(
			new Promise((_resolve, reject) => {
				fail = reject;
			}),
		);
		await render();
		await act(async () => {
			const target = button("Load older documents");
			target?.click();
			target?.click();
		});
		expect(getInvoiceHistoryPage).toHaveBeenCalledTimes(1);
		expect(button("Load older documents")?.disabled).toBe(true);
		await act(async () => fail(new Error("Unavailable")));
		expect(container.textContent).toContain("CAP-001");
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
		await act(async () => button("Try again")?.click());
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});
	it("retries a failed initial section without pretending it was empty", async () => {
		await render({
			sections: [{ id: "source", title: "Account purchases", page: null }],
			warnings: [],
		});
		expect(container.textContent).not.toContain("No invoices");
		await act(async () => button("Try again")?.click());
		expect(getInvoiceHistoryPage).toHaveBeenCalledWith("source", undefined);
		expect(container.textContent).toContain("No invoices or receipts found.");
	});
	it("refreshes failed source discovery and discards old section state", async () => {
		await render({ sections: [], warnings: ["License invoices unavailable"] });
		await act(async () => button("Refresh invoices")?.click());
		expect(container.textContent).not.toContain("License invoices unavailable");
		expect(container.textContent).toContain("CAP-001");
	});
});
