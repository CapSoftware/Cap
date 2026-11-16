// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	setSpaceMembers: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({ user: { id: "owner" } }),
}));
vi.mock("@/app/(org)/dashboard/spaces/[spaceId]/actions", () => ({
	setSpaceMembers: mocks.setSpaceMembers,
}));
vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/components/SignedImageUrl", () => ({ SignedImageUrl: () => null }));
vi.mock(
	"@/app/(org)/dashboard/spaces/[spaceId]/components/MemberSelect",
	() => ({
		MemberSelect: ({
			selected,
			onSelect,
		}: {
			selected: { value: string; label: string }[];
			onSelect: (next: { value: string; label: string }[]) => void;
		}) =>
			React.createElement(
				"div",
				null,
				selected.map((member) =>
					React.createElement(
						"button",
						{
							key: member.value,
							type: "button",
							"aria-label": `Remove ${member.label}`,
							onClick: () =>
								onSelect(selected.filter((m) => m.value !== member.value)),
						},
						member.label,
					),
				),
			),
	}),
);
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
	...(await import("../../../../packages/ui/src/components/input/Form")),
	Select: ({
		value,
		disabled,
		onValueChange,
	}: {
		value: string;
		disabled?: boolean;
		onValueChange: (value: string) => void;
	}) =>
		React.createElement(
			"button",
			{
				type: "button",
				disabled,
				"data-role-picker": "",
				onClick: () => onValueChange(value === "admin" ? "member" : "admin"),
			},
			`role:${value}`,
		),
}));

import { MembersIndicator } from "@/app/(org)/dashboard/spaces/[spaceId]/components/MembersIndicator";

const member = (userId: string, name: string) => ({
	userId,
	name,
	email: `${userId}@example.com`,
	image: null,
	role: "member",
});
const members = [member("owner", "Owner"), member("bob", "Bob")];

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.setSpaceMembers.mockReset();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root.render(
			React.createElement(MembersIndicator, {
				memberCount: 2,
				members: members as never,
				organizationMembers: members as never,
				spaceId: "space-1" as never,
				canManageMembers: true,
			}),
		);
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.body.innerHTML = "";
});

const button = (label: string) => {
	const found = [...document.querySelectorAll("button")].find(
		(element) =>
			element.getAttribute("aria-label") === label ||
			element.textContent?.trim() === label,
	);
	if (!found) throw new Error(`Button not found: ${label}`);
	return found;
};
const click = async (label: string) => {
	await act(async () => button(label).click());
};
const listed = (name: string) =>
	[...document.querySelectorAll("button")].some(
		(element) => element.getAttribute("aria-label") === `Remove ${name}`,
	);

describe("space members dialog", () => {
	it("drops edits that were closed without saving", async () => {
		await click("2 members");
		await click("Remove Bob");
		expect(listed("Bob")).toBe(false);
		await click("Close");
		await click("2 members");

		expect(listed("Bob")).toBe(true);
	});

	it("drops a role change that was closed without saving", async () => {
		const bobRole = () =>
			[
				...document.querySelectorAll<HTMLButtonElement>("[data-role-picker]"),
			].find((picker) => !picker.disabled);
		await click("2 members");
		expect(bobRole()?.textContent).toBe("role:member");
		await act(async () => bobRole()?.click());
		expect(bobRole()?.textContent).toBe("role:admin");
		await click("Close");
		await click("2 members");

		expect(bobRole()?.textContent).toBe("role:member");
	});

	it("stays open with the edits when saving fails", async () => {
		mocks.setSpaceMembers.mockRejectedValue(new Error("offline"));
		await click("2 members");
		await click("Remove Bob");
		await click("Save");

		expect(mocks.setSpaceMembers).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).toContain("Space Members");
		expect(listed("Bob")).toBe(false);
	});
});
