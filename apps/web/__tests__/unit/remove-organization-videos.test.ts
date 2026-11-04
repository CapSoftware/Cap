import { organizations } from "@cap/database/schema";
import { Organisation, Video } from "@cap/web-domain";
import { getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeVideosFromOrganization } from "@/actions/organizations/remove-videos";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	user: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const orgId = Organisation.OrganisationId.make("org-1");
const ownVideo = Video.VideoId.make("own-video");
const otherVideo = Video.VideoId.make("other-video");
const videoOwners: Record<string, string> = {
	[ownVideo]: "member",
	[otherVideo]: "someone-else",
};

const organizationRow = Object.keys(getTableColumns(organizations)).map(
	(key) => {
		if (key === "id") return orgId;
		if (key === "ownerId") return "org-owner";
		return null;
	},
);

function setup({
	userId,
	memberRole,
}: {
	userId: string;
	memberRole: string | null;
}) {
	mocks.user.mockResolvedValue({ id: userId, activeOrganizationId: orgId });
	mocks.query.mockImplementation(async (query: string, params: unknown[]) => {
		if (query.startsWith("select")) {
			if (query.includes("from `organizations`"))
				return { rows: [organizationRow] };
			if (query.includes("from `organization_members`"))
				return { rows: memberRole ? [[memberRole]] : [] };
			if (query.includes("from `videos`"))
				return {
					rows: params
						.slice(1)
						.filter((id) => videoOwners[String(id)] === params[0])
						.map((id) => [id]),
				};
			if (query.includes("from `shared_videos`"))
				return {
					rows: params
						.slice(1)
						.filter((id) => String(id) in videoOwners)
						.map((id) => [id]),
				};
			if (query.includes("from `folders`")) return { rows: [["folder-1"]] };
			throw new Error(`Unexpected query: ${query}`);
		}
		return { rows: [{ affectedRows: 1 }] };
	});
}

function writes() {
	return mocks.query.mock.calls.filter(
		([query]) => !String(query).startsWith("select"),
	);
}

function removedFromSharing() {
	return mocks.query.mock.calls.find(([query]) =>
		String(query).startsWith("delete from `shared_videos`"),
	)?.[1];
}

function clearedFolders() {
	return mocks.query.mock.calls.find(([query]) =>
		String(query).startsWith("update `videos`"),
	)?.[1];
}

beforeEach(() => {
	mocks.query.mockReset();
});

describe("removeVideosFromOrganization", () => {
	it("lets a member remove their own video", async () => {
		setup({ userId: "member", memberRole: "member" });

		await expect(
			removeVideosFromOrganization(orgId, [ownVideo]),
		).resolves.toMatchObject({ success: true });

		expect(removedFromSharing()).toEqual([orgId, ownVideo]);
		expect(clearedFolders()).toEqual([null, ownVideo, "folder-1"]);
	});

	it("does not let a member remove another member's video", async () => {
		setup({ userId: "member", memberRole: "member" });

		await expect(
			removeVideosFromOrganization(orgId, [otherVideo]),
		).resolves.toMatchObject({
			success: false,
			error: "No valid videos found",
		});

		expect(writes()).toHaveLength(0);
	});

	it("only removes the member's own videos from a mixed selection", async () => {
		setup({ userId: "member", memberRole: "member" });

		await expect(
			removeVideosFromOrganization(orgId, [ownVideo, otherVideo]),
		).resolves.toMatchObject({ success: true });

		expect(removedFromSharing()).toEqual([orgId, ownVideo]);
		expect(clearedFolders()).toEqual([null, ownVideo, "folder-1"]);
	});

	it.each([
		{ name: "an admin", userId: "admin", memberRole: "admin" },
		{ name: "the owner", userId: "org-owner", memberRole: null },
	])(
		"lets $name remove another member's video",
		async ({ userId, memberRole }) => {
			setup({ userId, memberRole });

			await expect(
				removeVideosFromOrganization(orgId, [otherVideo]),
			).resolves.toMatchObject({ success: true });

			expect(removedFromSharing()).toEqual([orgId, otherVideo]);
			expect(clearedFolders()).toEqual([null, otherVideo, "folder-1"]);
			expect(
				mocks.query.mock.calls.some(([query]) =>
					String(query).includes("from `videos`"),
				),
			).toBe(false);
		},
	);

	it("rejects users outside the organization", async () => {
		setup({ userId: "outsider", memberRole: null });

		await expect(
			removeVideosFromOrganization(orgId, [otherVideo]),
		).resolves.toMatchObject({ success: false });

		expect(writes()).toHaveLength(0);
	});
});
