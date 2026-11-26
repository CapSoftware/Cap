import { type ComponentProps, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingContent } from "@/app/(org)/dashboard/settings/organization/billing/BillingContent";
import { AddOnsSummary } from "@/app/(org)/dashboard/settings/organization/components/AddOnsSummary";

const mocks = vi.hoisted(() => ({
	userId: "owner",
	memberRole: "owner",
	organizationId: "org/invoice?history",
	invoices: vi.fn(),
	portal: vi.fn(),
	checkout: vi.fn(),
}));

vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: { id: mocks.userId },
		activeOrganization: {
			organization: { id: mocks.organizationId, ownerId: "owner" },
			members: [{ userId: mocks.userId, role: mocks.memberRole }],
		},
	}),
}));
vi.mock("@/actions/organization/sso", () => ({
	getOrganizationSsoInvoices: mocks.invoices,
	manageOrganizationSsoBilling: mocks.portal,
	startOrganizationSsoCheckout: mocks.checkout,
}));
vi.mock("hooks/useCurrency", () => ({
	useCurrency: () => ({ currency: "usd", symbol: "$" }),
}));
vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		prefetch: _prefetch,
		...props
	}: ComponentProps<"a"> & { prefetch?: boolean }) =>
		createElement("a", { href, ...props }, children),
}));
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/BillingSummaryCard",
	() => ({ BillingSummaryCard: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/SeatManagementCard",
	() => ({ SeatManagementCard: () => null }),
);

const render = (addOns: ReactNode = createElement(AddOnsSummary)) =>
	renderToStaticMarkup(createElement(BillingContent, { addOns }));

beforeEach(() => {
	mocks.userId = "owner";
	mocks.memberRole = "owner";
});

describe("add-on discovery on Billing", () => {
	it("links the owner to the selected organization's Security page without loading invoices or starting billing", () => {
		const markup = render();
		for (const anchor of ["sso", "directory-sync", "signed-baa"]) {
			expect(markup).toContain(
				`href="/dashboard/settings/organization/security?organizationId=org%2Finvoice%3Fhistory#${anchor}"`,
			);
		}
		expect(mocks.invoices).not.toHaveBeenCalled();
		expect(mocks.portal).not.toHaveBeenCalled();
		expect(mocks.checkout).not.toHaveBeenCalled();
	});

	it("shows what each add-on costs and whether it is on", () => {
		const markup = render(
			createElement(AddOnsSummary, {
				statuses: {
					sso: "active",
					ssoPrices: [{ currency: "usd", unitAmount: 19900 }],
					directorySync: "none",
					signedBaa: "paid",
				},
			}),
		);
		expect(markup).toContain("$199.00/mo");
		expect(markup).toContain("$200.00/mo");
		expect(markup).toContain("$99.00/mo");
		expect(markup).toContain(">Active<");
		expect(markup).toContain(">Awaiting signature<");
		expect(markup).toContain('aria-label="Manage SAML SSO"');
		expect(markup).toContain('aria-label="Add Directory sync (SCIM)"');
		expect(markup).toContain('aria-label="Sign Signed BAA"');
	});

	it.each(["admin", "member", "owner"])(
		"hides plan and add-on billing from non-owning membership role %s",
		(role) => {
			mocks.userId = "someone_else";
			mocks.memberRole = role;
			const markup = render();
			expect(markup).not.toContain("organization/security");
			expect(markup).toContain("Billing is managed by the organization owner.");
		},
	);
});
