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

describe("SSO settings", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});
	beforeEach(() => {
		window.history.replaceState(
			null,
			"",
			"/dashboard/settings/organization/security",
		);
		vi.mocked(getOrganizationSsoInvoices).mockReset();
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

	it("keeps invoice history out of Security while preserving SSO setup", async () => {
		await render();
		expect(button("View invoices")).toBeUndefined();
		expect(button("Manage SSO")).toBeDefined();
		expect(getOrganizationSsoInvoices).not.toHaveBeenCalled();
		expect(manageOrganizationSsoBilling).not.toHaveBeenCalled();
		expect(openOrganizationSsoPortal).not.toHaveBeenCalled();
		expect(startOrganizationSsoCheckout).not.toHaveBeenCalled();
	});
	it("keeps setup available to admins", async () => {
		await render({ canManageBilling: false });
		expect(button("Manage SSO")).toBeDefined();
	});
	it("offers checkout for an unsubscribed owner", async () => {
		await render({
			hasSubscription: false,
			entitled: false,
			subscriptionStatus: null,
		});
		expect(button("Add SAML SSO · $200.00/month")).toBeDefined();
	});
});
