// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function queryByRole(
	container: ParentNode,
	role: string,
	options?: { name: string; exact?: boolean },
) {
	const selector = role === "button" ? "button" : `[role="${role}"]`;
	return (
		Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
			(element) => {
				if (!options?.name) return true;
				const label = element.id
					? document.querySelector(`label[for="${element.id}"]`)?.textContent
					: null;
				return (
					label === options.name || element.textContent?.trim() === options.name
				);
			},
		) ?? null
	);
}
function getByRole(
	container: ParentNode,
	role: string,
	options?: { name: string; exact?: boolean },
) {
	const element = queryByRole(container, role, options);
	if (!element) throw new Error(`Missing ${role}: ${options?.name ?? ""}`);
	return element;
}
async function waitFor(assertion: () => void) {
	let error: unknown;
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			assertion();
			return;
		} catch (cause) {
			error = cause;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw error;
}
const fireEvent = {
	click: (element: HTMLElement) => element.click(),
	keyDown: (element: HTMLElement, init: KeyboardEventInit) =>
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, ...init }),
		),
	change: (
		element: HTMLInputElement,
		{ target }: { target: { value: string } },
	) => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		if (!setter) throw new Error("Missing input setter");
		setter.call(element, target.value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	},
};
const mocks = vi.hoisted(() => ({
	folders: vi.fn(),
	import: vi.fn(),
	csvImport: vi.fn(),
	push: vi.fn(),
	refresh: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: { id: "owner", email: "owner@team.test", isPro: true },
		activeOrganization: {
			organization: { id: "org", name: "Team", ownerId: "owner" },
			members: [],
		},
		spacesData: [{ id: "space", name: "Sales" }],
	}),
}));
vi.mock("@/components/UpgradeModal", () => ({ UpgradeModal: () => null }));
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
	useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("next/link", () => ({
	default: ({
		children,
		...props
	}: React.PropsWithChildren<Record<string, unknown>>) =>
		React.createElement("a", props, children),
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
}));
vi.mock("@/actions/loom-concierge", () => ({
	answerLoomMigrationQuestion: vi.fn(),
	confirmLoomMigrationInvite: vi.fn(),
	getLoomMigrationDashboard: vi.fn(async () => ({ isPro: true, requests: [] })),
	requestLoomMigration: vi.fn(),
}));
vi.mock("@/actions/loom", () => ({
	getLoomImportFolders: mocks.folders,
	importFromLoom: mocks.import,
	importFromLoomCsv: mocks.csvImport,
}));
vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
	...(await import("../../../../packages/ui/src/components/Select")),
	...(await import("../../../../packages/ui/src/components/Table")),
	...(await import("../../../../packages/ui/src/components/input/Input")),
}));

import { Folder, Space } from "@cap/web-domain";
import { ImportLoomPage } from "@/app/(org)/dashboard/import/loom/ImportLoomPage";
import type { LoomImportDestination } from "@/lib/loom-import-destination";

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	HTMLElement.prototype.scrollIntoView = vi.fn();
	HTMLElement.prototype.hasPointerCapture = () => false;
	HTMLElement.prototype.setPointerCapture = vi.fn();
	HTMLElement.prototype.releasePointerCapture = vi.fn();
	mocks.folders.mockResolvedValue([
		{ id: "parent", name: "Course", parentId: null },
		{ id: "child", name: "Live Calls - Two", parentId: "parent" },
		{ id: "sibling", name: "Design", parentId: "parent" },
	]);
	mocks.import.mockResolvedValue({ success: true, videoId: "fixture" });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	queryClient.clear();
});
async function render(destination: LoomImportDestination = {}) {
	await act(async () => {
		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(ImportLoomPage, {
					initialDestination: destination,
				}),
			),
		);
	});
}
async function ready() {
	await waitFor(() =>
		expect(
			(getByRole(container, "combobox") as HTMLButtonElement).disabled,
		).toBe(false),
	);
}
async function enterUrl() {
	await act(async () => {
		const input = container.querySelector("input");
		if (!input) throw new Error("Missing Loom URL input");
		fireEvent.change(input, {
			target: { value: "https://www.loom.com/share/aaaaaaaaaaa" },
		});
	});
}
async function choose(name: string) {
	await act(async () => {
		fireEvent.keyDown(getByRole(container, "combobox"), { key: "Enter" });
	});
	await act(async () => {
		fireEvent.keyDown(
			getByRole(document.body, "option", { name, exact: true }),
			{ key: "Enter" },
		);
	});
}

function loomCsvRow(index: number) {
	return `https://www.loom.com/share/${index.toString(16).padStart(32, "0")},user@team.test,`;
}
async function uploadCsv(rows: string[]) {
	await act(async () => {
		fireEvent.click(getByRole(container, "button", { name: "Bulk Import" }));
	});
	const csv = ["loom_video_url,user_email,space_name", ...rows].join("\n");
	const file = new File([csv], "loom.csv", { type: "text/csv" });
	Object.defineProperty(file, "text", { value: async () => csv });
	const input = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error("Missing CSV input");
	Object.defineProperty(input, "files", { value: [file] });
	await act(async () => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
function csvRowResult(rowNumber: number, throttled: boolean) {
	return throttled
		? {
				rowNumber,
				userEmail: "user@team.test",
				success: false,
				error:
					"Loom is temporarily unavailable. Please retry the import later.",
				errorCode: "loom_temporarily_unavailable",
			}
		: { rowNumber, userEmail: "user@team.test", success: true };
}
async function startCsvImport() {
	await waitFor(() =>
		expect(
			(
				getByRole(container, "button", {
					name: "Review Import",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false),
	);
	await act(async () => {
		fireEvent.click(getByRole(container, "button", { name: "Review Import" }));
	});
	await waitFor(() =>
		expect(
			queryByRole(document.body, "button", { name: "Start Import" }),
		).not.toBeNull(),
	);
	vi.useFakeTimers();
	await act(async () => {
		fireEvent.click(
			getByRole(document.body, "button", { name: "Start Import" }),
		);
	});
}
async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

describe("Loom importer component", () => {
	it("shows the inherited subfolder and submits it then returns there", async () => {
		await render({ folderId: Folder.FolderId.make("child") });
		await ready();
		await waitFor(() =>
			expect(container.textContent).toContain("Moving a whole Loom workspace?"),
		);
		expect(
			getByRole(container, "combobox", { name: "Import to" }).textContent,
		).toContain("My Caps / Course / Live Calls - Two");
		await enterUrl();
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Import Loom" }));
		});
		expect(mocks.import).toHaveBeenCalledWith({
			loomUrl: "https://www.loom.com/share/aaaaaaaaaaa",
			orgId: "org",
			folderId: "child",
			spaceId: undefined,
		});
		expect(mocks.push).toHaveBeenCalledWith("/dashboard/folder/child");
	});
	it("allows choosing a different nested folder", async () => {
		await render({ folderId: Folder.FolderId.make("child") });
		await ready();
		await choose("My Caps / Course / Design");
		await enterUrl();
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Import Loom" }));
		});
		expect(mocks.import).toHaveBeenCalledWith(
			expect.objectContaining({ folderId: "sibling" }),
		);
	});
	it("blocks a missing folder until the user chooses a destination", async () => {
		await render({ folderId: Folder.FolderId.make("missing") });
		await ready();
		await enterUrl();
		expect(getByRole(container, "alert").textContent).toContain(
			"no longer available",
		);
		expect(
			(
				getByRole(container, "button", {
					name: "Import Loom",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		await choose("My Caps");
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Import Loom" }));
		});
		expect(mocks.import).toHaveBeenCalledWith(
			expect.objectContaining({ folderId: undefined }),
		);
	});
	it("shows a recoverable destination error without enabling import", async () => {
		mocks.folders.mockRejectedValueOnce(new Error("Unavailable"));
		await render();
		await enterUrl();
		await waitFor(() =>
			expect(getByRole(container, "alert").textContent).toContain(
				"couldn't load",
			),
		);
		expect(
			(
				getByRole(container, "button", {
					name: "Import Loom",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Retry" }));
		});
		await ready();
		expect(queryByRole(container, "alert")).toBe(null);
	});
	it("shows shared visibility and returns to the selected space folder", async () => {
		await render({
			spaceId: Space.SpaceId.make("space"),
			folderId: Folder.FolderId.make("child"),
		});
		await ready();
		await enterUrl();
		expect(container.textContent).toContain(
			"This video will be shared with Sales.",
		);
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Import Loom" }));
		});
		expect(mocks.import).toHaveBeenCalledWith(
			expect.objectContaining({
				spaceId: Space.SpaceId.make("space"),
				folderId: Folder.FolderId.make("child"),
			}),
		);
		expect(mocks.push).toHaveBeenCalledWith(
			"/dashboard/spaces/space/folder/child",
		);
	});
	it("copies an agent migration prompt for this organization", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		await render();
		await waitFor(() =>
			expect(container.textContent).toContain("Hand it to your agent"),
		);

		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Copy prompt" }));
		});

		expect(writeText).toHaveBeenCalledTimes(1);
		const prompt = writeText.mock.calls[0]?.[0] ?? "";
		expect(prompt).toContain("Cap organization: Team");
		expect(prompt).toContain("--organization org ");
		expect(prompt).toContain("My Cap account: owner@team.test");
	});

	it("sends CSV files over the import limit to a concierge migration", async () => {
		await render();
		await uploadCsv(
			Array.from({ length: 3001 }, (_, index) => loomCsvRow(index)),
		);

		await waitFor(() =>
			expect(container.textContent).toContain(
				"CSV imports are limited to 3,000 videos at a time.",
			),
		);
		const conciergeLink = container.querySelector<HTMLAnchorElement>(
			'a[href="#loom-concierge"]',
		);
		expect(conciergeLink?.textContent).toBe("request a concierge migration");
		expect(container.querySelector("#loom-concierge")).not.toBeNull();
		expect(
			(
				getByRole(container, "button", {
					name: "Review Import",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});
	it("retries only throttled CSV rows with growing waits and stops after four retries", async () => {
		mocks.csvImport.mockImplementation(
			async ({ rows }: { rows: { rowNumber: number }[] }) => ({
				success: true,
				importedCount: 0,
				failedCount: 0,
				results: rows.map((row) =>
					csvRowResult(row.rowNumber, row.rowNumber === 2),
				),
			}),
		);
		await render();
		await uploadCsv([loomCsvRow(1), loomCsvRow(2)]);
		try {
			await startCsvImport();
			expect(mocks.csvImport).toHaveBeenCalledTimes(1);
			expect(mocks.csvImport.mock.calls[0]?.[0]).toMatchObject({ bulk: false });

			for (const [index, wait] of [
				30_000, 60_000, 120_000, 240_000,
			].entries()) {
				await advance(wait - 1);
				expect(mocks.csvImport).toHaveBeenCalledTimes(index + 1);
				await advance(1);
				expect(mocks.csvImport).toHaveBeenCalledTimes(index + 2);
				expect(
					mocks.csvImport.mock.calls[index + 1]?.[0].rows.map(
						(row: { rowNumber: number }) => row.rowNumber,
					),
				).toEqual([2]);
			}

			await advance(600_000);
			expect(mocks.csvImport).toHaveBeenCalledTimes(5);
			expect(container.textContent).toContain("1 started, 1 failed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops retrying once throttled CSV rows import", async () => {
		mocks.csvImport
			.mockResolvedValueOnce({
				success: true,
				importedCount: 1,
				failedCount: 1,
				results: [csvRowResult(2, true), csvRowResult(3, false)],
			})
			.mockResolvedValueOnce({
				success: true,
				importedCount: 1,
				failedCount: 0,
				results: [csvRowResult(2, false)],
			});
		await render();
		await uploadCsv([loomCsvRow(1), loomCsvRow(2)]);
		try {
			await startCsvImport();
			await advance(30_000);
			await advance(600_000);
			expect(mocks.csvImport).toHaveBeenCalledTimes(2);
			expect(container.textContent).toContain("2 started, 0 failed");
		} finally {
			vi.useRealTimers();
		}
	});
});
