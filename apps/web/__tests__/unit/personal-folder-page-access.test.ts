import { Folder } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FolderPage from "@/app/(org)/dashboard/folder/[id]/page";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	getFolder: vi.fn(),
	getChildren: vi.fn(),
	organizationAccess: vi.fn(),
	spaceAccess: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", async () => {
	const { Layer } = await import("effect");
	return { makeCurrentUserLayer: () => Layer.empty };
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});
vi.mock("@/lib/folder", async () => {
	const { Effect } = await import("effect");
	return {
		getChildFolders: mocks.getChildren,
		getFolderBreadcrumb: () => Effect.succeed([]),
		getVideosByFolderId: () => Effect.succeed([]),
		getFolderById: mocks.getFolder,
	};
});
vi.mock("@/lib/org-pro", () => ({ isOrganizationOwnerPro: async () => false }));
vi.mock("@/actions/organization/authorization", () => ({
	getOrganizationAccess: mocks.organizationAccess,
}));
vi.mock("@/actions/organization/space-authorization", () => ({
	getSpaceAccess: mocks.spaceAccess,
}));
vi.mock("@/app/(org)/dashboard/_components/CollectionShareControl", () => ({
	CollectionShareControl: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components", () => ({
	UploadCapButton: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/FoldersSection", () => ({
	FoldersSection: () => null,
}));
vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-dialog",
	() => ({ WebRecorderDialog: () => null }),
);
vi.mock("@/app/(org)/dashboard/folder/[id]/components", () => ({
	BreadcrumbItem: () => null,
	ClientMyCapsLink: () => null,
	NewSubfolderButton: () => null,
}));
vi.mock(
	"@/app/(org)/dashboard/folder/[id]/components/FolderVideosSection",
	() => ({ default: () => null }),
);

const folder = {
	id: Folder.FolderId.make("folder-1"),
	name: "Personal folder",
	color: "normal",
	public: false,
	settings: null,
	organizationId: "removed-org",
	createdById: "user-1",
	parentId: null,
	spaceId: null,
};

const load = () =>
	FolderPage({
		params: Promise.resolve({ id: folder.id }),
		searchParams: Promise.resolve({}),
	});

beforeEach(async () => {
	const { Effect } = await import("effect");
	mocks.getCurrentUser.mockResolvedValue({
		id: "user-1",
		activeOrganizationId: "",
	});
	mocks.getFolder.mockReturnValue(Effect.succeed(folder));
	mocks.getChildren.mockReturnValue(Effect.succeed([]));
	mocks.organizationAccess.mockResolvedValue(null);
	mocks.spaceAccess.mockResolvedValue(null);
});

describe("personal folder page after losing the last organization", () => {
	it("renders the creator's folder without an active organization", async () => {
		await expect(load()).resolves.toBeTruthy();
		expect(mocks.getChildren).toHaveBeenCalledWith(folder.id, {
			variant: "user",
		});
		expect(mocks.organizationAccess).not.toHaveBeenCalled();
		expect(mocks.spaceAccess).not.toHaveBeenCalled();
	});

	it("still requires a signed-in user", async () => {
		mocks.getCurrentUser.mockResolvedValue(null);

		await expect(load()).rejects.toThrow("NOT_FOUND");
		expect(mocks.getFolder).not.toHaveBeenCalled();
	});

	it.each([
		["another user's personal folder", { ...folder, createdById: "user-2" }],
		["an organization folder", { ...folder, spaceId: "removed-org" }],
		["a space folder", { ...folder, spaceId: "removed-space" }],
		["a missing folder", null],
	])("hides %s", async (_, inaccessibleFolder) => {
		const { Effect } = await import("effect");
		mocks.getFolder.mockReturnValue(Effect.succeed(inaccessibleFolder));

		await expect(load()).rejects.toThrow("NOT_FOUND");
		expect(mocks.getChildren).not.toHaveBeenCalled();
	});
});
