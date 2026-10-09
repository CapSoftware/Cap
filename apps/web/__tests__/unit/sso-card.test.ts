// @vitest-environment jsdom

import { Organisation } from "@cap/web-domain";
import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	getOrganizationSsoInvoices,
	getOrganizationSsoSettings,
	manageOrganizationSsoBilling,
	type OrganizationSsoSettings,
	openOrganizationSsoPortal,
	startOrganizationSsoCheckout,
} from "@/actions/organization/sso";
import { SsoCard } from "@/app/(org)/dashboard/settings/organization/components/SsoCard";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
	useRouter: () => mocks,
}));
vi.mock("hooks/useCurrency", () => ({
	useCurrency: () => ({ currency: "usd", symbol: "$" }),
}));
vi.mock("@/actions/organization/sso", () => ({
	confirmOrganizationSsoCheckout: vi.fn(),
	getOrganizationSsoInvoices: vi.fn(),
	getOrganizationSsoSettings: vi.fn(),
	manageOrganizationSsoBilling: vi.fn(),
	openOrganizationSsoPortal: vi.fn(),
	startOrganizationSsoCheckout: vi.fn(),
}));
vi.mock("@cap/ui", async () => {
	const { createElement } = await import("react");
	const container = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Card: container,
		CardDescription: container,
		CardHeader: container,
		CardTitle: container,
		Button: ({
			children,
			disabled,
			onClick,
			type,
			spinner,
		}: ComponentProps<"button"> & { spinner?: boolean }) =>
			createElement(
				"button",
				{ disabled, onClick, type, "data-spinner": Boolean(spinner) },
				children,
			),
		Input: (props: ComponentProps<"input">) => createElement("input", props),
	};
});

const organizationId = Organisation.OrganisationId.make("org_sso");
const settings = (
	overrides: Partial<OrganizationSsoSettings> = {},
): OrganizationSsoSettings => ({
	organizationId,
	organizationName: "Example Organization",
	canManageBilling: true,
	ssoAvailable: true,
	entitled: true,
	hasSubscription: true,
	subscriptionStatus: "active",
	cancelAtPeriodEnd: false,
	currentPeriodEnd: null,
	suggestedDomain: "example.com",
	prices: [{ currency: "usd", unitAmount: 20000 }],
	domains: [{ domain: "example.com", state: "verified" }],
	connection: { name: "Example SSO", state: "active" },
	signInUrl: "https://cap.test/login?organizationId=org_sso",
	...overrides,
});

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root;
let container: HTMLDivElement;
const button = (text: string) =>
	Array.from(container.querySelectorAll("button")).find(
		(element) => element.textContent === text,
	);
const render = async (overrides: Partial<OrganizationSsoSettings> = {}) => {
	const initialSettings = settings(overrides);
	await act(async () =>
		root.render(
			createElement(SsoCard, {
				key: initialSettings.organizationId,
				initialSettings,
			}),
		),
	);
};

type InvoiceResult = Awaited<ReturnType<typeof getOrganizationSsoInvoices>>;
const invoiceResult = (): InvoiceResult => ({
	invoices: [
		{
			id: "in_sso",
			number: "SSO-0001",
			created: 1790812800,
			total: 20000,
			currency: "usd",
			status: "paid",
			pdfUrl: "https://pay.stripe.test/invoice/sso.pdf",
		},
	],
	hasMore: false,
});

describe("SSO invoices", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});
	beforeEach(() => {
		window.history.replaceState(
			null,
			"",
			"/dashboard/settings/organization/security",
		);
		vi.mocked(getOrganizationSsoInvoices)
			.mockReset()
			.mockResolvedValue(invoiceResult());
		vi.mocked(getOrganizationSsoSettings)
			.mockReset()
			.mockResolvedValue(settings());
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		document.body.replaceChildren();
	});
	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it.each([
		{ subscriptionStatus: "active", entitled: true, cancelAtPeriodEnd: false },
		{ subscriptionStatus: "active", entitled: true, cancelAtPeriodEnd: true },
		{ subscriptionStatus: "unpaid", entitled: false, cancelAtPeriodEnd: false },
		{
			subscriptionStatus: "canceled",
			entitled: false,
			cancelAtPeriodEnd: false,
		},
	])(
		"offers owners billing history for $subscriptionStatus subscriptions, canceling=$cancelAtPeriodEnd",
		async (overrides) => {
			await render(overrides);
			expect(button("View invoices")?.disabled).toBe(false);
		},
	);

	it("hides billing from admins while preserving SSO setup", async () => {
		await render({ canManageBilling: false });
		expect(button("View invoices")).toBeUndefined();
		expect(button("Manage SSO")).toBeDefined();
	});

	it("keeps invoice history available when SSO setup is unavailable", async () => {
		await render({ ssoAvailable: false });
		expect(button("View invoices")?.disabled).toBe(false);
		expect(button("Manage SSO")?.disabled).toBe(true);
		await act(async () => button("View invoices")?.click());
		expect(getOrganizationSsoInvoices).toHaveBeenCalledExactlyOnceWith(
			organizationId,
		);
	});

	it("hides billing before an owner has a subscription", async () => {
		await render({
			hasSubscription: false,
			entitled: false,
			subscriptionStatus: null,
		});
		expect(button("View invoices")).toBeUndefined();
		expect(button("Add SAML SSO · $200.00/month")).toBeDefined();
	});

	it("loads only invoice PDFs without opening billing, checkout or SSO setup", async () => {
		await render();
		expect(getOrganizationSsoInvoices).not.toHaveBeenCalled();
		const initialUrl = window.location.href;
		await act(async () => button("View invoices")?.click());
		expect(getOrganizationSsoInvoices).toHaveBeenCalledExactlyOnceWith(
			organizationId,
		);
		expect(manageOrganizationSsoBilling).not.toHaveBeenCalled();
		expect(openOrganizationSsoPortal).not.toHaveBeenCalled();
		expect(startOrganizationSsoCheckout).not.toHaveBeenCalled();
		expect(window.location.href).toBe(initialUrl);
		expect(button("View invoices")?.disabled).toBe(false);
		expect(container.textContent).toContain("SSO-0001");
		const link = container.querySelector(
			'a[href="https://pay.stripe.test/invoice/sso.pdf"]',
		);
		expect(link).not.toBeNull();
		expect(container.textContent).not.toMatch(/Manage (SSO )?subscription/);
	});

	it("blocks repeated clicks and other actions while invoices load", async () => {
		let complete: (value: InvoiceResult) => void = () => {};
		vi.mocked(getOrganizationSsoInvoices).mockReturnValue(
			new Promise((resolve) => {
				complete = resolve;
			}),
		);
		await render();
		const target = button("View invoices");
		expect(target).toBeDefined();
		await act(async () => {
			target?.click();
			target?.click();
		});
		expect(getOrganizationSsoInvoices).toHaveBeenCalledTimes(1);
		expect(target?.disabled).toBe(true);
		expect(target?.dataset.spinner).toBe("true");
		expect(button("Manage SSO")?.disabled).toBe(true);
		expect(button("Refresh status")?.disabled).toBe(true);
		await act(async () => complete(invoiceResult()));
		expect(button("View invoices")?.disabled).toBe(false);
		expect(button("View invoices")?.dataset.spinner).toBe("false");
	});

	it("shows an invoice error and allows retry after failure", async () => {
		vi.mocked(getOrganizationSsoInvoices).mockRejectedValueOnce(
			new Error("Unavailable"),
		);
		await render();
		await act(async () => button("View invoices")?.click());
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(
			"We couldn't load SSO invoices. Please try again or contact support.",
		);
		expect(button("View invoices")?.disabled).toBe(false);
		expect(button("View invoices")?.dataset.spinner).toBe("false");
		await act(async () => button("View invoices")?.click());
		expect(getOrganizationSsoInvoices).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).toContain("SSO-0001");
	});

	it("does not leak a late invoice response after switching organizations", async () => {
		let complete: (value: InvoiceResult) => void = () => {};
		vi.mocked(getOrganizationSsoInvoices).mockReturnValueOnce(
			new Promise((resolve) => {
				complete = resolve;
			}),
		);
		await render();
		await act(async () => button("View invoices")?.click());
		const nextOrganizationId = Organisation.OrganisationId.make("org_another");
		await render({
			organizationId: nextOrganizationId,
			organizationName: "Another Organization",
		});
		expect(button("View invoices")?.disabled).toBe(false);
		expect(container.textContent).not.toContain("SSO-0001");
		vi.mocked(getOrganizationSsoInvoices).mockResolvedValueOnce({
			invoices: [],
			hasMore: false,
		});
		await act(async () => button("View invoices")?.click());
		expect(getOrganizationSsoInvoices).toHaveBeenLastCalledWith(
			nextOrganizationId,
		);
		await act(async () => complete(invoiceResult()));
		expect(container.textContent).toContain("Another Organization");
		expect(container.textContent).toContain("No SSO invoices found.");
		expect(container.textContent).not.toContain("SSO-0001");
		expect(container.querySelector('a[href*="stripe"]')).toBeNull();
	});

	it("shows an explicit empty state without billing portal links", async () => {
		vi.mocked(getOrganizationSsoInvoices).mockResolvedValue({
			invoices: [],
			hasMore: false,
		});
		await render();
		await act(async () => button("View invoices")?.click());
		expect(container.textContent).toMatch(/no .*invoices/i);
		expect(container.querySelector('a[href*="stripe"]')).toBeNull();
	});

	it("keeps an invoice without a PDF visible without inventing a download link", async () => {
		const result = invoiceResult();
		const invoice = result.invoices[0];
		if (!invoice) throw new Error("Missing invoice fixture");
		invoice.pdfUrl = null;
		vi.mocked(getOrganizationSsoInvoices).mockResolvedValue(result);
		await render();
		await act(async () => button("View invoices")?.click());
		expect(container.textContent).toContain("SSO-0001");
		expect(container.textContent).toMatch(
			/PDF.*(unavailable|available|ready)/i,
		);
		expect(container.querySelector('a[href*="stripe"]')).toBeNull();
	});

	it("warns when invoice history exceeds the first 100 results", async () => {
		vi.mocked(getOrganizationSsoInvoices).mockResolvedValue({
			...invoiceResult(),
			hasMore: true,
		});
		await render();
		await act(async () => button("View invoices")?.click());
		expect(container.textContent).toContain("100");
		expect(container.textContent).toMatch(/older|more/i);
	});
});
