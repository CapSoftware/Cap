import { type ComponentProps, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BillingAndMembersPage from "@/app/(org)/dashboard/settings/organization/billing/page";

const mocks = vi.hoisted(() => ({
	userId: "owner",
	memberRole: "owner",
	organizationId: "org/invoice?history",
	isCap: true,
	invoices: vi.fn(),
	portal: vi.fn(),
	checkout: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return mocks.isCap;
		},
	},
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: { id: mocks.userId },
		activeOrganization: {
			organization: { id: mocks.organizationId, ownerId: "owner" },
			members: [{ userId: mocks.userId, role: mocks.memberRole }],
		},
		setInviteDialogOpen: vi.fn(),
	}),
}));
vi.mock("@/actions/organization/sso", () => ({
	getOrganizationSsoInvoices: mocks.invoices,
	manageOrganizationSsoBilling: mocks.portal,
	startOrganizationSsoCheckout: mocks.checkout,
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: ComponentProps<"a"> & { prefetch?: boolean }) =>
		createElement("a", { href }, children),
}));
vi.mock("@cap/ui", () => {
	const container = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Card: container,
		CardHeader: container,
		CardTitle: container,
		CardDescription: container,
	};
});
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/BillingSummaryCard",
	() => ({ BillingSummaryCard: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/MembersCard",
	() => ({ MembersCard: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/SeatManagementCard",
	() => ({ SeatManagementCard: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/SignedBaaCard",
	() => ({ SignedBaaCard: () => null }),
);

beforeEach(() => {
	mocks.userId = "owner";
	mocks.memberRole = "owner";
	mocks.isCap = true;
});

describe("SSO invoice discovery on Billing", () => {
	it("links the owner to the selected organization's Security page without loading invoices or starting billing", () => {
		const markup = renderToStaticMarkup(createElement(BillingAndMembersPage));
		expect(markup).toContain(
			'href="/dashboard/settings/organization/security?organizationId=org%2Finvoice%3Fhistory"',
		);
		expect(markup).toContain("Open SSO invoices in Security settings");
		expect(mocks.invoices).not.toHaveBeenCalled();
		expect(mocks.portal).not.toHaveBeenCalled();
		expect(mocks.checkout).not.toHaveBeenCalled();
	});

	it.each(["admin", "member", "owner"])(
		"hides invoice discovery from non-owning membership role %s",
		(role) => {
			mocks.userId = "someone_else";
			mocks.memberRole = role;
			const markup = renderToStaticMarkup(createElement(BillingAndMembersPage));
			expect(markup).not.toContain("Open SSO invoices");
			expect(markup).toContain("Billing is managed by the organization owner.");
		},
	);

	it("does not show hosted billing discovery in a self-hosted deployment", () => {
		mocks.isCap = false;
		expect(
			renderToStaticMarkup(createElement(BillingAndMembersPage)),
		).not.toContain("Open SSO invoices");
	});
});
