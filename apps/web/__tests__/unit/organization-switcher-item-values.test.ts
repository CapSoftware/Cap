// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminNavItems from "@/app/(org)/dashboard/_components/Navbar/Items";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	updateActiveOrganization: vi.fn(async (_organizationId: string) => {}),
	organizations: [] as Array<{ id: string; name: string }>,
}));

vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: false } }));
vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Cmdk")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
	...(await import("../../../../packages/ui/src/components/Popover")),
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/dashboard/caps",
	useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/components/forms/NewOrganization", () => ({
	NewOrganization: () => null,
}));
vi.mock("@/components/SignedImageUrl", () => ({
	SignedImageUrl: () => null,
}));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/UsageButton", () => ({ UsageButton: () => null }));
vi.mock("@/app/(org)/dashboard/_components/AnimatedIcons", () => ({
	CapIcon: () => null,
	ChartLineIcon: () => null,
	CodeIcon: () => null,
	CogIcon: () => null,
	ImportIcon: () => null,
	RecordIcon: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/MemberAvatars", () => ({
	MemberAvatars: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/SpacesList", () => ({
	default: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/server", () => ({
	updateActiveOrganization: mocks.updateActiveOrganization,
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => {
		const organizationData = mocks.organizations.map((organization) => ({
			organization: {
				...organization,
				ownerId: "user",
				iconUrl: null,
				customDomain: null,
				domainVerified: null,
			},
			members: [{ userId: "user", role: "owner" }],
		}));
		return {
			user: { id: "user", email: "user@example.com" },
			sidebarCollapsed: false,
			userCapsCount: 1,
			organizationData,
			activeOrganization: organizationData[0],
		};
	},
}));

const hostileText: Array<[string, string]> = [
	["double quotes", 'The "A" Team'],
	["a backslash", "Ops\\"],
	["a closing bracket", 'Design "] Guild'],
	["a newline", "Line one\nLine two"],
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Element.prototype.scrollIntoView = () => {};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

const items = () => [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];

const visibleItems = () => items().filter((item) => !item.hidden);

const selectedItems = () =>
	items().filter((item) => item.getAttribute("aria-selected") === "true");

const input = () => {
	const element = document.querySelector<HTMLInputElement>("[cmdk-input]");
	if (!element) throw new Error("Organization search input not found");
	return element;
};

async function openSwitcher() {
	await act(async () => {
		root.render(createElement(AdminNavItems));
	});
	await act(async () => {
		document.querySelector<HTMLElement>('[role="combobox"]')?.click();
	});
	await settle();
}

async function type(value: string) {
	await act(async () => {
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setValue?.call(input(), value);
		input().dispatchEvent(new Event("input", { bubbles: true }));
	});
	await settle();
}

describe("organization switcher", () => {
	it.each(hostileText)(
		"opens and switches to an organization whose name has %s",
		async (_label, name) => {
			mocks.organizations = [
				{ id: "org-1", name: "Acme" },
				{ id: "org-2", name },
			];
			await openSwitcher();

			const row = items().find((item) => item.textContent === name);
			if (!row) throw new Error("Organization row not found");
			await act(async () => {
				row.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
			});
			await settle();
			expect(selectedItems()).toEqual([row]);
			expect(input().getAttribute("aria-activedescendant")).toBe(row.id);

			await act(async () => {
				input().dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Enter",
						bubbles: true,
						cancelable: true,
					}),
				);
			});
			await settle();
			expect(mocks.updateActiveOrganization).toHaveBeenCalledWith("org-2");
		},
	);

	it("still filters organizations by name", async () => {
		mocks.organizations = [
			{ id: "org-1", name: "Acme" },
			{ id: "org-2", name: 'The "A" Team' },
			{ id: "org-3", name: "Globex" },
		];
		await openSwitcher();

		await type("glo");
		expect(visibleItems().map((item) => item.textContent)).toEqual(["Globex"]);

		await type("glx");
		expect(visibleItems().map((item) => item.textContent)).toEqual(["Globex"]);

		await type("team");
		expect(visibleItems().map((item) => item.textContent)).toEqual([
			'The "A" Team',
		]);

		await type("org-3");
		expect(visibleItems()).toEqual([]);
	});

	it("keeps organizations with identical names separately selectable", async () => {
		mocks.organizations = [
			{ id: "org-1", name: "Acme" },
			{ id: "org-2", name: "Acme" },
		];
		await openSwitcher();

		expect(selectedItems()).toHaveLength(1);
	});
});
