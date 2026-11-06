import { Organisation } from "@cap/web-domain";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OrganizationDirectorySync } from "@/actions/organization/directory-sync";

vi.mock("@cap/ui", () => ({
	Button: ({ children, disabled }: ComponentProps<"button">) =>
		createElement("button", { disabled, type: "button" }, children),
	Card: "section",
	CardDescription: "p",
	CardHeader: "header",
	CardTitle: "h2",
}));
vi.mock("hooks/useCurrency", () => ({
	useCurrency: () => ({ currency: "usd" }),
}));
vi.mock("@/actions/organization/directory-sync", () => ({
	approveDirectorySyncRemovals: vi.fn(),
	getOrganizationDirectorySync: vi.fn(),
	openOrganizationDirectorySyncPortal: vi.fn(),
}));

const { DirectorySyncCard } = await import(
	"@/app/(org)/dashboard/settings/organization/components/DirectorySyncCard"
);

const organizationId = Organisation.OrganisationId.make("org_fixture");
const base: OrganizationDirectorySync = {
	entitled: true,
	available: true,
	directories: [],
	syncedMembers: 0,
	lastSyncedAt: null,
	syncFailed: false,
	heldRemovals: 0,
};

function render(status: Partial<OrganizationDirectorySync>) {
	return renderToStaticMarkup(
		createElement(DirectorySyncCard, {
			organizationId,
			organizationName: "Acme",
			initialStatus: { ...base, ...status },
		}),
	);
}

describe("DirectorySyncCard", () => {
	it("offers the paid add-on to organizations without it", () => {
		const markup = render({ entitled: false, available: false });
		expect(markup).toContain("$200.00");
		expect(markup).toContain("/month add-on");
		expect(markup).toContain("hello@cap.so");
		expect(markup).toContain(">Add-on<");
		expect(markup).not.toContain("Set up directory sync");
		expect(markup).not.toContain("Verify your organization");
	});

	it("asks for a verified domain before setup", () => {
		const markup = render({ available: false });
		expect(markup).toContain("Verify your organization&#x27;s domain");
		expect(markup).not.toContain("Set up directory sync");
	});

	it("offers setup when no directory exists", () => {
		const markup = render({});
		expect(markup).toContain("Set up directory sync");
		expect(markup).toContain("Ready to set up");
	});

	it("shows a connected directory, sync counts, and a held removal", () => {
		const markup = render({
			directories: [{ id: "directory_1", name: "Okta", state: "active" }],
			syncedMembers: 42,
			lastSyncedAt: "2026-11-06T12:00:00.000Z",
			heldRemovals: 12,
			syncFailed: true,
		});
		expect(markup).toContain("Okta · Connected");
		expect(markup).toContain("42 members synced");
		expect(markup).toContain("Manage directory sync");
		expect(markup).toContain("Remove 12 members");
		expect(markup).toContain("Cap retries automatically");
		expect(markup).toContain(">Active<");
	});
});
