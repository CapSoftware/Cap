// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
	user: { id: "owner", email: "richie@cap.so" },
	ownerId: "owner",
	pathname: "/dashboard/caps",
}));

vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: "true" } }));
vi.mock("@uidotdev/usehooks", () => ({
	useClickAway: () => ({ current: null }),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	usePathname: () => context.pathname,
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/server", () => ({
	updateActiveOrganization: vi.fn(),
}));
vi.mock("@/components/SignedImageUrl", () => ({
	SignedImageUrl: () => null,
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: context.user,
		activeOrganization: {
			organization: { id: "org", name: "Acme", ownerId: context.ownerId },
			members: [{ userId: context.user.id, role: "owner" }],
		},
		organizationData: [],
	}),
}));

import MobileTab from "@/app/(org)/dashboard/_components/MobileTab";

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
	context.user = { id: "owner", email: "richie@cap.so" };
	context.ownerId = "owner";
	context.pathname = "/dashboard/caps";
});

const hrefs = () => {
	act(() => root.render(React.createElement(MobileTab)));
	return Array.from(container.querySelectorAll("a")).map((link) =>
		link.getAttribute("href"),
	);
};

describe("dashboard mobile tabs", () => {
	it("shows Infra to an org owner who can use Infra, as on desktop", () => {
		expect(hrefs()).toContain("/dashboard/infra");
		expect(
			container
				.querySelector('a[href="/dashboard/infra"]')
				?.getAttribute("aria-label"),
		).toBe("Infra");
	});

	it("shows Infra to any org owner, not only a preview list", () => {
		context.user = { id: "owner", email: "someone@example.com" };

		expect(hrefs()).toEqual([
			"/dashboard/spaces/browse",
			"/dashboard/caps",
			"/dashboard/settings/organization",
			"/dashboard/infra",
		]);
	});

	it("does not show Infra outside the org the user owns", () => {
		context.ownerId = "someone-else";

		expect(hrefs()).not.toContain("/dashboard/infra");
	});

	it("marks only the tab for the current section as the current page", () => {
		context.pathname = "/dashboard/folder/abc";

		hrefs();
		const current = Array.from(
			container.querySelectorAll('a[aria-current="page"]'),
		).map((link) => link.getAttribute("href"));
		expect(current).toEqual(["/dashboard/caps"]);
	});
});
