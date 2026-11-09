// @vitest-environment jsdom

import {
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import { getTableColumns } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	refresh: vi.fn(),
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "caller", activeOrganizationId: "org-1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
	useParams: () => ({}),
	usePathname: () => "/dashboard/caps",
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		sidebarCollapsed: false,
		spacesData: [
			{ id: "org-1", name: "All team members", primary: true },
			{ id: "destination", name: "Design", primary: false },
		],
	}),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock(
	"@cap/ui",
	async () => import("../../../../packages/ui/src/components/Button"),
);
vi.mock("@/components/SignedImageUrl", () => ({ SignedImageUrl: () => null }));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/actions/organization/delete-space", () => ({
	deleteSpace: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/_components/AnimatedIcons", () => ({
	LayersIcon: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/ConfirmationDialog", () => ({
	ConfirmationDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/SpaceDialog", () => ({
	default: () => null,
}));

import SpacesList from "@/app/(org)/dashboard/_components/Navbar/SpacesList";

let root: Root;
let container: HTMLDivElement;
let videoOwnerId: string;
let alreadyShared: boolean;

function row(table: MySqlTable, values: Record<string, unknown>) {
	return Object.values(getTableColumns(table)).map(
		(column) => values[column.name] ?? null,
	);
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	videoOwnerId = "caller";
	alreadyShared = false;
	mocks.query.mockImplementation(async (query: string, params: unknown[]) => {
		if (/^(insert|update|delete) /.test(query)) {
			return { rows: [{ insertId: 0, affectedRows: 1 }] };
		}
		if (query.includes("from `videos`")) {
			return {
				rows: [
					row(videos, {
						id: "cap-1",
						ownerId: videoOwnerId,
						folderId: "personal",
					}),
				],
			};
		}
		if (query.includes("from `organization_members`"))
			return { rows: [["org-1"]] };
		if (query.includes("from `organizations`")) {
			return {
				rows:
					params[0] === "org-1" ? [row(organizations, { id: "org-1" })] : [],
			};
		}
		if (query.includes("from `spaces`")) {
			if (query.includes("inner join `organizations`")) {
				return {
					rows: [
						[
							"destination",
							"org-1",
							"creator",
							"org-owner",
							"member",
							"member",
						],
					],
				};
			}
			return {
				rows:
					params[0] === "destination"
						? [
								row(spaces, {
									id: "destination",
									organizationId: "org-1",
									privacy: "Private",
								}),
							]
						: [],
			};
		}
		if (query.includes("from `space_videos`")) {
			return {
				rows: [
					row(spaceVideos, {
						id: "old-space-share",
						videoId: "cap-1",
						spaceId: "existing",
						folderId: "space-folder",
					}),
					...(alreadyShared
						? [
								row(spaceVideos, {
									id: "destination-share",
									videoId: "cap-1",
									spaceId: "destination",
									folderId: "destination-folder",
								}),
							]
						: []),
				],
			};
		}
		if (query.includes("from `shared_videos`")) {
			return {
				rows: [
					row(sharedVideos, {
						id: "team-share",
						videoId: "cap-1",
						organizationId: "org-1",
						folderId: "team-folder",
					}),
				],
			};
		}
		throw new Error(`Unexpected query: ${query}`);
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(SpacesList)));
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function drop(destination: string) {
	const target = container
		.querySelector(`a[href="/dashboard/spaces/${destination}"]`)
		?.closest("li");
	if (!target) throw new Error("Missing sidebar drop target");
	const event = new Event("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		value: { getData: () => JSON.stringify({ id: "cap-1", name: "Demo" }) },
	});
	await act(async () => target.dispatchEvent(event));
}

const writes = () =>
	mocks.query.mock.calls.filter(([query]) =>
		/^(insert|update|delete) /.test(query),
	);

describe("sharing a Cap through the spaces sidebar", () => {
	it("adds a space without removing existing team shares or folder placements", async () => {
		await drop("destination");
		expect(mocks.toast.success).toHaveBeenCalledWith('Shared "Demo" to Design');
		expect(writes()).toHaveLength(1);
		expect(writes()[0]?.[0]).toMatch(/^insert into `space_videos`/);
		expect(writes()[0]?.[1]).toEqual(
			expect.arrayContaining(["cap-1", "destination", "caller"]),
		);
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it.each(["destination", "org-1"])(
		"keeps existing placements when dropping on %s again",
		async (destination) => {
			alreadyShared = true;
			await drop(destination);
			expect(mocks.toast.success).toHaveBeenCalledOnce();
			expect(writes()).toEqual([]);
		},
	);

	it("rejects another owner's Cap without changing sharing", async () => {
		videoOwnerId = "another-user";
		await drop("destination");
		expect(mocks.toast.error).toHaveBeenCalledWith("Unauthorized");
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(writes()).toEqual([]);
	});
});
