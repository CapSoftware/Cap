// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationDetailsCard } from "@/app/(org)/dashboard/settings/organization/components/OrganizationDetailsCard";

const mocks = vi.hoisted(() => ({
	id: "org-a",
	name: "Alpha",
	domain: "alpha.example",
	verified: true,
	refresh: vi.fn(),
	updateName: vi.fn(),
	removeDomain: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@cap/web-domain", () => ({
	Organisation: { OrganisationId: { make: (id: string) => id } },
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: {
			organization: {
				id: mocks.id,
				name: mocks.name,
				customDomain: mocks.domain,
				domainVerified: mocks.verified,
			},
		},
		user: { isPro: true },
	}),
}));
vi.mock("@/actions/organization/update-details", () => ({
	updateOrganizationDetails: mocks.updateName,
}));
vi.mock("@/actions/organization/remove-domain", () => ({
	removeOrganizationDomain: mocks.removeDomain,
}));
vi.mock("@cap/ui", () => {
	const container = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Card: container,
		CardDescription: container,
		CardHeader: container,
		CardTitle: container,
		Label: ({ children }: { children?: ReactNode }) =>
			createElement("label", null, children),
		Input: (props: ComponentProps<"input">) => createElement("input", props),
		Button: ({ children, disabled, onClick }: ComponentProps<"button">) =>
			createElement("button", { disabled, onClick, type: "button" }, children),
	};
});
vi.mock("@fortawesome/react-fontawesome", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ content, children }: { content: string; children?: ReactNode }) =>
		createElement("span", { title: content }, children),
}));
vi.mock("@/components/UpgradeModal", () => ({ UpgradeModal: () => null }));
vi.mock("@/app/(org)/dashboard/_components/ConfirmationDialog", () => ({
	ConfirmationDialog: ({
		open,
		onConfirm,
	}: {
		open: boolean;
		onConfirm: () => void;
	}) =>
		open
			? createElement(
					"button",
					{ type: "button", onClick: onConfirm },
					"Confirm remove",
				)
			: null,
}));
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/CustomDomainDialog",
	() => ({
		default: () => createElement("div", { "data-domain-setup": true }),
	}),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/OrganizationIcon",
	() => ({ OrganizationIcon: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/ShareableLinkIcon",
	() => ({ ShareableLinkIcon: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/AccessEmailDomain",
	() => ({ default: () => null }),
);

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;
const render = async () => {
	await act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(OrganizationDetailsCard),
			),
		);
	});
};
const input = () => {
	const element = host.querySelector("input");
	if (!element) throw new Error("Expected organization name input");
	return element;
};
const button = (text: string) =>
	Array.from(host.querySelectorAll("button")).find(
		(element) => element.textContent === text,
	);
const click = async (element: HTMLElement | undefined | null) => {
	if (!element) throw new Error("Expected a settings control");
	await act(async () => element.click());
};
const editName = async (value: string) => {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input(), value);
		input().dispatchEvent(new Event("input", { bubbles: true }));
	});
};
const switchOrganization = async () => {
	mocks.id = "org-b";
	mocks.name = "Beta";
	mocks.domain = "beta.example";
	await render();
};
const openRemove = () =>
	click(host.querySelector('[title="Remove custom domain"] > div'));

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.id = "org-a";
	mocks.name = "Alpha";
	mocks.domain = "alpha.example";
	mocks.verified = true;
	mocks.refresh.mockClear();
	mocks.updateName.mockReset().mockResolvedValue(undefined);
	mocks.removeDomain.mockReset().mockResolvedValue(undefined);
	queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	queryClient.clear();
	host.remove();
	vi.unstubAllGlobals();
});

describe("organization settings ownership", () => {
	it("loads the new organization's name instead of leaving the previous name editable", async () => {
		await render();
		await switchOrganization();
		expect(input().value).toBe("Beta");
		expect(button("Save")?.disabled).toBe(true);
		expect(mocks.updateName).not.toHaveBeenCalled();
	});

	it("discards the previous organization's unsaved name", async () => {
		await render();
		await editName("Alpha draft");
		await switchOrganization();
		expect(input().value).toBe("Beta");
		expect(button("Save")?.disabled).toBe(true);
	});

	it("preserves an unsaved name across ordinary rerenders", async () => {
		await render();
		await editName("Alpha draft");
		await render();
		expect(input().value).toBe("Alpha draft");
		await click(button("Save"));
		expect(mocks.updateName).toHaveBeenCalledWith({
			organizationName: "Alpha draft",
			organizationId: "org-a",
		});
	});

	it("initializes verification status from the new organization", async () => {
		await render();
		expect(host.querySelector('[title="Verified"]')).not.toBeNull();
		mocks.verified = false;
		await switchOrganization();
		expect(host.querySelector('[title="Verified"]')).toBeNull();
		expect(host.querySelector('[title="Setup not complete"]')).not.toBeNull();
	});

	it("closes a removal confirmation before another organization can be removed", async () => {
		await render();
		await openRemove();
		expect(button("Confirm remove")).toBeDefined();
		await switchOrganization();
		expect(button("Confirm remove")).toBeUndefined();
		expect(mocks.removeDomain).not.toHaveBeenCalled();
	});

	it("closes the previous organization's domain setup flow", async () => {
		mocks.verified = false;
		await render();
		await click(button("Setup"));
		expect(host.querySelector("[data-domain-setup]")).not.toBeNull();
		await switchOrganization();
		expect(host.querySelector("[data-domain-setup]")).toBeNull();
	});

	it("keeps new verification state when an old domain removal finishes", async () => {
		const pending = Promise.withResolvers<void>();
		mocks.removeDomain.mockReturnValueOnce(pending.promise);
		await render();
		await openRemove();
		await click(button("Confirm remove"));
		expect(mocks.removeDomain).toHaveBeenCalledWith("org-a");
		await switchOrganization();
		await act(async () => {
			pending.resolve();
			await pending.promise;
		});
		expect(host.querySelector('[title="Verified"]')).not.toBeNull();
		expect(host.querySelector('[title="Setup not complete"]')).toBeNull();
	});
});
