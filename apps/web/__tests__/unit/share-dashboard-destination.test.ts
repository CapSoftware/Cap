import type { Organisation, User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Column = { table: string; column: string };
type Condition =
	| { eq: [Column, unknown] }
	| { and: Condition[] }
	| { isNull: Column };

const table = (name: string) =>
	new Proxy({ __table: name } as Record<string, unknown>, {
		get: (target, column) =>
			column === "__table" ? target.__table : { table: name, column },
	});

vi.mock("@cap/database/schema", () => ({
	folders: table("folders"),
	organizationMembers: table("organizationMembers"),
	organizations: table("organizations"),
	sharedVideos: table("sharedVideos"),
	spaceMembers: table("spaceMembers"),
	spaces: table("spaces"),
	spaceVideos: table("spaceVideos"),
	videos: table("videos"),
}));

vi.mock("drizzle-orm", () => ({
	and: (...and: Condition[]) => ({ and }),
	eq: (left: Column, right: unknown) => ({ eq: [left, right] }),
	isNull: (isNull: Column) => ({ isNull }),
}));

type Query = {
	from: string;
	joins: { table: string; on: Condition }[];
	where?: Condition;
};

const queries: Query[] = [];
let rowsFor: Record<string, unknown[]> = {};

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const query: Query = { from: "", joins: [] };
			queries.push(query);
			const chain = {
				from: (source: { __table: string }) => {
					query.from = source.__table;
					return chain;
				},
				innerJoin: (source: { __table: string }, on: Condition) => {
					query.joins.push({ table: source.__table, on });
					return chain;
				},
				where: (where: Condition) => {
					query.where = where;
					const rows = Promise.resolve(rowsFor[query.from] ?? []) as Promise<
						unknown[]
					> & { limit: () => Promise<unknown[]> };
					rows.limit = () => rows;
					return rows;
				},
			};
			return chain;
		},
	}),
}));

const { getShareDashboardDestination, pickShareDashboardDestination } =
	await import("@/lib/share-dashboard-destination");
type ShareDashboardAccess = Parameters<typeof pickShareDashboardDestination>[0];

const flatten = (condition: Condition | undefined): Condition[] =>
	!condition
		? []
		: "and" in condition
			? condition.and.flatMap(flatten)
			: [condition];

const restrictsTo = (condition: Condition, table: string, value: unknown) =>
	flatten(condition).some(
		(part) =>
			"eq" in part &&
			part.eq[0].table === table &&
			part.eq[0].column === "userId" &&
			part.eq[1] === value,
	);

const access = (
	overrides: Partial<ShareDashboardAccess>,
): ShareDashboardAccess => ({
	isOwner: false,
	activeOrganizationId: "org-active",
	videoOrganizationId: "org-active",
	ownerIsVideoOrganizationMember: true,
	ownerFolder: null,
	memberSpaces: [],
	memberOrganizations: [],
	...overrides,
});

describe("pickShareDashboardDestination", () => {
	it("sends the owner back to My Caps", () => {
		expect(pickShareDashboardDestination(access({ isOwner: true }))).toEqual({
			kind: "caps",
			href: "/dashboard/caps",
			label: "My Caps",
			switchOrganizationId: null,
		});
	});

	it("sends the owner back to the folder the Cap lives in", () => {
		expect(
			pickShareDashboardDestination(
				access({
					isOwner: true,
					ownerFolder: { id: "folder-1", name: "Launch" },
				}),
			),
		).toEqual({
			kind: "folder",
			href: "/dashboard/folder/folder-1",
			label: "Launch",
			switchOrganizationId: null,
		});
	});

	it("ignores spaces for the owner", () => {
		expect(
			pickShareDashboardDestination(
				access({
					isOwner: true,
					memberSpaces: [
						{ id: "space-1", name: "Design", organizationId: "org-active" },
					],
				}),
			)?.kind,
		).toBe("caps");
	});

	it("sends a space member to the space the Cap was shared into", () => {
		expect(
			pickShareDashboardDestination(
				access({
					memberSpaces: [
						{ id: "space-1", name: "Design", organizationId: "org-active" },
					],
				}),
			),
		).toEqual({
			kind: "space",
			href: "/dashboard/spaces/space-1",
			label: "Design",
			switchOrganizationId: null,
		});
	});

	it("sends an organization member to the organization's shared view", () => {
		expect(
			pickShareDashboardDestination(
				access({
					memberOrganizations: [{ id: "org-active", name: "Acme" }],
				}),
			),
		).toEqual({
			kind: "organization",
			href: "/dashboard/spaces/org-active",
			label: "Acme",
			switchOrganizationId: null,
		});
	});

	it("prefers destinations in the viewer's active organization", () => {
		expect(
			pickShareDashboardDestination(
				access({
					memberSpaces: [
						{ id: "space-other", name: "Other", organizationId: "org-other" },
						{ id: "space-active", name: "Mine", organizationId: "org-active" },
					],
				}),
			)?.href,
		).toBe("/dashboard/spaces/space-active");

		expect(
			pickShareDashboardDestination(
				access({
					memberSpaces: [
						{ id: "space-other", name: "Other", organizationId: "org-other" },
					],
					memberOrganizations: [{ id: "org-active", name: "Acme" }],
				}),
			)?.href,
		).toBe("/dashboard/spaces/org-active");
	});

	it("offers nothing to a signed-in viewer the Cap was never shared with", () => {
		expect(pickShareDashboardDestination(access({}))).toBeNull();
	});

	it("switches organization only for an owner's destinations in another organization", () => {
		expect(
			pickShareDashboardDestination(
				access({ isOwner: true, videoOrganizationId: "org-other" }),
			)?.switchOrganizationId,
		).toBe("org-other");

		expect(
			pickShareDashboardDestination(
				access({ isOwner: true, activeOrganizationId: null }),
			)?.switchOrganizationId,
		).toBe("org-active");

		expect(
			pickShareDashboardDestination(
				access({
					isOwner: true,
					videoOrganizationId: "org-other",
					ownerIsVideoOrganizationMember: false,
				}),
			)?.switchOrganizationId,
		).toBeNull();

		expect(
			pickShareDashboardDestination(
				access({
					isOwner: true,
					activeOrganizationId: null,
					ownerFolder: { id: "folder-1", name: "Launch" },
				}),
			)?.switchOrganizationId,
		).toBe("org-active");

		expect(
			pickShareDashboardDestination(
				access({
					memberSpaces: [
						{ id: "space-other", name: "Other", organizationId: "org-other" },
					],
				}),
			)?.switchOrganizationId,
		).toBeNull();
	});
});

describe("getShareDashboardDestination", () => {
	const VIEWER = "user-viewer" as User.UserId;
	const OWNER = "user-owner" as User.UserId;
	const VIDEO = "video-1" as Video.VideoId;

	beforeEach(() => {
		queries.length = 0;
		rowsFor = {};
	});

	const resolve = (
		viewerId: User.UserId | null,
		videoOrganizationId = "org-active" as Organisation.OrganisationId,
	) =>
		getShareDashboardDestination({
			viewer: viewerId
				? { id: viewerId, activeOrganizationId: "org-active" }
				: null,
			videoId: VIDEO,
			ownerId: OWNER,
			videoOrganizationId,
		});

	it("resolves nothing for a signed-out viewer without querying", async () => {
		expect(await resolve(null)).toBeNull();
		expect(queries).toEqual([]);
	});

	it("looks up only the owner's personal folder for the owner", async () => {
		rowsFor = { videos: [{ id: "folder-1", name: "Launch" }] };

		expect(await resolve(OWNER)).toMatchObject({
			kind: "folder",
			href: "/dashboard/folder/folder-1",
		});
		expect(queries).toHaveLength(1);
		const [query] = queries;
		expect(query?.joins.map((join) => join.table)).toEqual(["folders"]);
		expect(
			flatten(query?.where).some(
				(part) => "isNull" in part && part.isNull.column === "spaceId",
			),
		).toBe(true);
	});

	it("only offers spaces and organizations the viewer is a member of", async () => {
		rowsFor = {
			spaceVideos: [
				{ id: "space-1", name: "Design", organizationId: "org-active" },
			],
		};

		expect(await resolve(VIEWER)).toMatchObject({
			kind: "space",
			href: "/dashboard/spaces/space-1",
		});

		const spaceQuery = queries.find((query) => query.from === "spaceVideos");
		const spaceMembership = spaceQuery?.joins.find(
			(join) => join.table === "spaceMembers",
		);
		expect(
			spaceMembership &&
				restrictsTo(spaceMembership.on, "spaceMembers", VIEWER),
		).toBe(true);

		const organizationQuery = queries.find(
			(query) => query.from === "sharedVideos",
		);
		const organizationMembership = organizationQuery?.joins.find(
			(join) => join.table === "organizationMembers",
		);
		expect(
			organizationMembership &&
				restrictsTo(organizationMembership.on, "organizationMembers", VIEWER),
		).toBe(true);
		expect(
			queries.some((query) => query.joins.some((j) => j.table === "folders")),
		).toBe(false);
	});

	it("checks the owner's membership before switching to the Cap's organization", async () => {
		rowsFor = { organizationMembers: [{ id: "membership-1" }] };

		expect(
			await resolve(OWNER, "org-other" as Organisation.OrganisationId),
		).toMatchObject({
			kind: "caps",
			switchOrganizationId: "org-other",
		});
		const membershipQuery = queries.find(
			(query) => query.from === "organizationMembers",
		);
		expect(
			membershipQuery?.where &&
				restrictsTo(membershipQuery.where, "organizationMembers", OWNER),
		).toBe(true);
	});

	it("does not switch when the owner has left the Cap's organization", async () => {
		expect(
			await resolve(OWNER, "org-other" as Organisation.OrganisationId),
		).toMatchObject({
			kind: "caps",
			switchOrganizationId: null,
		});
	});

	it("resolves nothing when the viewer has no membership", async () => {
		expect(await resolve(VIEWER)).toBeNull();
	});
});
