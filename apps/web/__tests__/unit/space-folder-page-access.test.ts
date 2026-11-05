import { Folder, type Space } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FolderPage from "@/app/(org)/dashboard/spaces/[spaceId]/folder/[folderId]/page";

const mocks = vi.hoisted(() => ({
	spaceOrOrg: null as unknown,
	folder: null as unknown,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user-1", activeOrganizationId: "org-1" }),
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", async () => {
	const { Effect, Layer } = await import("effect");
	class Spaces extends Effect.Service<Spaces>()("Spaces", {
		succeed: { getSpaceOrOrg: () => Effect.succeed(mocks.spaceOrOrg) },
	}) {}
	return { Spaces, makeCurrentUserLayer: () => Layer.empty };
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const { Spaces } = await import("@cap/web-backend");
	return {
		runPromise: <A, E>(
			effect: import("effect").Effect.Effect<A, E, InstanceType<typeof Spaces>>,
		) =>
			Effect.runPromiseExit(Effect.provide(effect, Spaces.Default)).then(
				(exit) => {
					if (exit._tag === "Success") return exit.value;
					if (exit.cause._tag === "Die") throw exit.cause.defect;
					throw exit;
				},
			),
	};
});
vi.mock("@/lib/folder", async () => {
	const { Effect } = await import("effect");
	return {
		getChildFolders: () => Effect.succeed([]),
		getFolderBreadcrumb: () => Effect.succeed([]),
		getVideosByFolderId: () => Effect.succeed([]),
		getFolderById: () => Effect.succeed(mocks.folder),
	};
});
vi.mock("@/lib/org-pro", () => ({ isOrganizationOwnerPro: async () => true }));
vi.mock("@/actions/organization/authorization", () => ({
	getOrganizationAccess: async () => ({ role: "owner" }),
}));
vi.mock("@/actions/organization/space-authorization", () => ({
	getSpaceAccess: async () => ({ canManage: true }),
}));
vi.mock("@/app/(org)/dashboard/_components/CollectionShareControl", () => ({
	CollectionShareControl: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/FoldersSection", () => ({
	FoldersSection: () => null,
}));
vi.mock("@/app/(org)/dashboard/folder/[id]/components", () => ({
	BreadcrumbItem: () => null,
	ClientMyCapsLink: () => null,
	NewSubfolderButton: () => null,
}));
vi.mock(
	"@/app/(org)/dashboard/folder/[id]/components/FolderVideosSection",
	() => ({ default: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/spaces/[spaceId]/folder/[folderId]/AddVideosButton",
	() => ({ default: () => null }),
);

const SPACE = {
	variant: "space",
	space: { id: "space-1", organizationId: "org-1", name: "Design" },
};
const ORGANIZATION = {
	variant: "organization",
	organization: { id: "org-1", name: "Org", ownerId: "owner-1" },
};

const folder = (spaceId: string | null) => ({
	id: "folder-1",
	name: "Folder",
	color: "normal",
	public: false,
	settings: null,
	organizationId: "org-1",
	createdById: "user-1",
	parentId: null,
	spaceId,
});

const load = (spaceId: string) =>
	FolderPage({
		params: Promise.resolve({
			spaceId: spaceId as Space.SpaceIdOrOrganisationId,
			folderId: Folder.FolderId.make("folder-1"),
		}),
	});

beforeEach(() => {
	mocks.spaceOrOrg = null;
	mocks.folder = null;
});

describe("space folder page scope", () => {
	it("renders a folder that belongs to the space", async () => {
		mocks.spaceOrOrg = SPACE;
		mocks.folder = folder("space-1");

		await expect(load("space-1")).resolves.toBeTruthy();
	});

	it("renders an organization folder on the organization entry", async () => {
		mocks.spaceOrOrg = ORGANIZATION;
		mocks.folder = folder("org-1");

		await expect(load("org-1")).resolves.toBeTruthy();
	});

	it.each([
		["another space", "space-2"],
		["the organization entry", "org-1"],
		["a personal library", null],
	])("hides a folder from %s inside a space", async (_, folderSpaceId) => {
		mocks.spaceOrOrg = SPACE;
		mocks.folder = folder(folderSpaceId);

		await expect(load("space-1")).rejects.toThrow("NOT_FOUND");
	});

	it.each([
		["a space", "space-1"],
		["a personal library", null],
	])(
		"hides a folder from %s on the organization entry",
		async (_, folderSpaceId) => {
			mocks.spaceOrOrg = ORGANIZATION;
			mocks.folder = folder(folderSpaceId);

			await expect(load("org-1")).rejects.toThrow("NOT_FOUND");
		},
	);
});
