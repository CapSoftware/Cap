import { db } from "@cap/database";
import type { userSelectProps } from "@cap/database/auth/session";
import {
	notifications,
	organizationInvites,
	organizationMembers,
	organizations,
	sharedVideos,
	spaces,
	users,
	videos,
} from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { Database, ImageUploads } from "@cap/web-backend";
import type { ImageUpload } from "@cap/web-domain";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
	canManageOrganizationMembers,
	canManageOrganizationProSeats,
	canManageSpace,
	getEffectiveOrganizationRole,
	getEffectiveSpaceRole,
	type OrganizationRole,
	type SpaceRole,
} from "@/lib/permissions/roles";
import { runPromise } from "@/lib/server";
import { selectProSeatProvider } from "@/utils/organization";

export type Organization = {
	organization: Omit<
		typeof organizations.$inferSelect,
		"iconUrl" | "shareableLinkIconUrl"
	> & {
		iconUrl: ImageUpload.ImageUrl | null;
		shareableLinkIconUrl: ImageUpload.ImageUrl | null;
	};
	members: (typeof organizationMembers.$inferSelect & {
		user: Pick<
			typeof users.$inferSelect,
			"id" | "name" | "email" | "lastName"
		> & { image?: ImageUpload.ImageUrl | null };
	})[];
	invites: (typeof organizationInvites.$inferSelect)[];
	inviteQuota: number;
	totalInvites: number;
	/** Whether the organization OWNER is on Pro — gates org-wide Pro features. */
	ownerIsPro: boolean;
	hasActiveProSeatProvider: boolean;
};

export type OrganizationSettings = NonNullable<
	(typeof organizations.$inferSelect)["settings"]
>;

export type Spaces = Omit<
	typeof spaces.$inferSelect,
	"createdAt" | "updatedAt" | "iconUrl" | "password"
> & {
	memberCount: number;
	videoCount: number;
	iconUrl: ImageUpload.ImageUrl | null;
	hasPassword: boolean;
	currentUserRole: OrganizationRole | SpaceRole | null;
	currentUserCanManage: boolean;
};

export type UserPreferences = (typeof users.$inferSelect)["preferences"];

function mergeUserOrganizations(
	ownedOrganizations: (typeof organizations.$inferSelect)[],
	memberOrganizations: { organization: typeof organizations.$inferSelect }[],
) {
	const organizationsById = new Map<
		string,
		typeof organizations.$inferSelect
	>();

	for (const organization of ownedOrganizations) {
		organizationsById.set(organization.id, organization);
	}

	for (const { organization } of memberOrganizations) {
		organizationsById.set(organization.id, organization);
	}

	return Array.from(organizationsById.values());
}

type OrganizationRow = typeof organizations.$inferSelect;

async function loadUserOrganizations(user: typeof userSelectProps) {
	const [ownedOrganizations, memberOrganizations] = await Promise.all([
		db()
			.select()
			.from(organizations)
			.where(
				and(
					isNull(organizations.tombstoneAt),
					eq(organizations.ownerId, user.id),
				),
			),
		db()
			.select({ organization: organizations })
			.from(organizationMembers)
			.innerJoin(
				organizations,
				eq(organizations.id, organizationMembers.organizationId),
			)
			.where(
				and(
					eq(organizationMembers.userId, user.id),
					isNull(organizations.tombstoneAt),
				),
			),
	]);

	return mergeUserOrganizations(ownedOrganizations, memberOrganizations);
}

function resolveActiveOrganization(
	user: typeof userSelectProps,
	userOrganizations: OrganizationRow[],
) {
	const organizationIds = userOrganizations.map((org) => org.id);

	let activeOrganizationId = organizationIds.find(
		(orgId) => orgId === user.activeOrganizationId,
	);

	if (!activeOrganizationId && organizationIds.length > 0) {
		activeOrganizationId = organizationIds[0];
	}

	if (!activeOrganizationId) return null;

	return {
		activeOrganizationId,
		activeOrgInfo: userOrganizations.find(
			(org) => org.id === activeOrganizationId,
		),
	};
}

async function loadActiveOrganizationRole(
	user: typeof userSelectProps,
	activeOrganizationId: OrganizationRow["id"],
	activeOrgInfo: OrganizationRow | undefined,
) {
	const [activeOrgMembership] = await db()
		.select({ role: organizationMembers.role })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, activeOrganizationId),
				eq(organizationMembers.userId, user.id),
			),
		)
		.limit(1);

	return getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrgInfo?.ownerId,
		memberRole: activeOrgMembership?.role,
	});
}

function loadSpaces(
	user: typeof userSelectProps,
	activeOrganizationId: OrganizationRow["id"],
	currentOrganizationRolePromise: Promise<OrganizationRole | null>,
): Promise<Spaces[]> {
	return Effect.gen(function* () {
		const db = yield* Database;
		const imageUploads = yield* ImageUploads;

		return yield* db
			.use((db) =>
				db
					.select({
						id: spaces.id,
						primary: spaces.primary,
						privacy: spaces.privacy,
						public: spaces.public,
						name: spaces.name,
						description: spaces.description,
						organizationId: spaces.organizationId,
						createdById: spaces.createdById,
						iconUrl: spaces.iconUrl,
						settings: spaces.settings,
						currentUserSpaceRole: sql<string | null>`(
          SELECT space_members.role FROM space_members
          WHERE space_members.spaceId = spaces.id
          AND space_members.userId = ${user.id}
          LIMIT 1
        )`,
						hasPassword: sql`${spaces.password} IS NOT NULL`.mapWith(Boolean),
						memberCount: sql<number>`(
          SELECT COUNT(*) FROM space_members WHERE space_members.spaceId = spaces.id
        )`,
						videoCount: sql<number>`(
          SELECT COUNT(*) FROM space_videos WHERE space_videos.spaceId = spaces.id
        )`,
					})
					.from(spaces)
					.where(
						and(
							eq(spaces.organizationId, activeOrganizationId),
							or(
								eq(spaces.createdById, user.id),
								eq(spaces.privacy, "Public"),
								sql`EXISTS (
          SELECT 1 FROM space_members 
          WHERE space_members.spaceId = spaces.id 
          AND space_members.userId = ${user.id}
        )`,
							),
						),
					),
			)
			.pipe(
				Effect.flatMap((rows) =>
					Effect.promise(() => currentOrganizationRolePromise).pipe(
						Effect.map((currentOrganizationRole) => ({
							rows,
							currentOrganizationRole,
						})),
					),
				),
				Effect.map(({ rows, currentOrganizationRole }) =>
					rows.map(
						Effect.fn(function* (row) {
							const { currentUserSpaceRole, ...spaceRow } = row;
							const currentUserRole = getEffectiveSpaceRole({
								userId: user.id,
								createdById: row.createdById,
								memberRole: currentUserSpaceRole,
							});
							return {
								...spaceRow,
								iconUrl: row.iconUrl
									? yield* imageUploads.resolveImageUrl(row.iconUrl)
									: null,
								currentUserRole,
								currentUserCanManage: canManageSpace({
									organizationRole: currentOrganizationRole,
									spaceRole: currentUserRole,
								}),
							};
						}),
					),
				),
				Effect.flatMap(Effect.all),
			);
	}).pipe(runPromise);
}

async function loadAllSpacesEntry(
	activeOrgInfo: OrganizationRow,
	currentOrganizationRolePromise: Promise<OrganizationRole | null>,
): Promise<Spaces> {
	const [orgMemberCountResult, orgVideoCountResult, currentOrganizationRole] =
		await Promise.all([
			db()
				.select({ value: sql<number>`COUNT(*)` })
				.from(organizationMembers)
				.where(eq(organizationMembers.organizationId, activeOrgInfo.id)),
			db()
				.select({
					value: sql<number>`COUNT(DISTINCT ${sharedVideos.videoId})`,
				})
				.from(sharedVideos)
				.where(eq(sharedVideos.organizationId, activeOrgInfo.id)),
			currentOrganizationRolePromise,
		]);
	const orgMemberCount = orgMemberCountResult[0]?.value || 0;
	const orgVideoCount = orgVideoCountResult[0]?.value || 0;

	return Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;

		const iconUrl = activeOrgInfo.iconUrl;

		return {
			id: activeOrgInfo.id,
			primary: true,
			privacy: "Public",
			name: `All ${activeOrgInfo.name}`,
			description: `View all content in ${activeOrgInfo.name}`,
			organizationId: activeOrgInfo.id,
			iconUrl: iconUrl ? yield* imageUploads.resolveImageUrl(iconUrl) : null,
			memberCount: orgMemberCount,
			createdById: activeOrgInfo.ownerId,
			videoCount: orgVideoCount,
			settings: null,
			hasPassword: false,
			public: false,
			currentUserRole: currentOrganizationRole,
			currentUserCanManage: canManageOrganizationMembers(
				currentOrganizationRole,
			),
		} as const;
	}).pipe(runPromise);
}

export async function getDashboardSpacesData(
	user: typeof userSelectProps,
): Promise<Spaces[]> {
	const userOrganizations = await loadUserOrganizations(user);
	const active = resolveActiveOrganization(user, userOrganizations);
	if (!active) return [];

	const currentOrganizationRole = loadActiveOrganizationRole(
		user,
		active.activeOrganizationId,
		active.activeOrgInfo,
	);
	const [spacesRows, allSpacesEntry] = await Promise.all([
		loadSpaces(user, active.activeOrganizationId, currentOrganizationRole),
		active.activeOrgInfo
			? loadAllSpacesEntry(active.activeOrgInfo, currentOrganizationRole)
			: Promise.resolve(null),
		currentOrganizationRole,
	]);

	return allSpacesEntry ? [allSpacesEntry, ...spacesRows] : spacesRows;
}

async function loadActiveOrganizationData(
	user: typeof userSelectProps,
	{
		activeOrganizationId,
		activeOrgInfo,
	}: NonNullable<ReturnType<typeof resolveActiveOrganization>>,
) {
	const currentOrganizationRole = loadActiveOrganizationRole(
		user,
		activeOrganizationId,
		activeOrgInfo,
	);
	const [[notification], spacesRows, allSpacesEntry, userCapsCountResult] =
		await Promise.all([
			db()
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.recipientId, user.id),
						eq(notifications.orgId, activeOrganizationId),
						isNull(notifications.readAt),
					),
				)
				.limit(1),
			loadSpaces(user, activeOrganizationId, currentOrganizationRole),
			activeOrgInfo
				? loadAllSpacesEntry(activeOrgInfo, currentOrganizationRole)
				: Promise.resolve(null),
			activeOrgInfo
				? db()
						.select({
							value: sql<number>`COUNT(DISTINCT ${videos.id})`,
						})
						.from(videos)
						.where(
							and(
								eq(videos.orgId, activeOrgInfo.id),
								eq(videos.ownerId, user.id),
							),
						)
				: Promise.resolve<{ value: number }[]>([]),
			currentOrganizationRole,
		]);

	return {
		anyNewNotifications: !!notification,
		organizationSettings: activeOrgInfo?.settings || null,
		spacesData: allSpacesEntry ? [allSpacesEntry, ...spacesRows] : spacesRows,
		userCapsCount: userCapsCountResult[0]?.value || 0,
	};
}

export async function getDashboardData(user: typeof userSelectProps) {
	try {
		const userOrganizations = await loadUserOrganizations(user);
		const organizationIds = userOrganizations.map((org) => org.id);
		const active = resolveActiveOrganization(user, userOrganizations);

		const organizationInvitesPromise =
			organizationIds.length > 0
				? db()
						.select()
						.from(organizationInvites)
						.where(inArray(organizationInvites.organizationId, organizationIds))
						.execute()
				: Promise.resolve<(typeof organizationInvites.$inferSelect)[]>([]);

		const organizationSelectPromise: Promise<Organization[]> = Effect.all(
			userOrganizations.map(
				Effect.fn(function* (organization) {
					const db = yield* Database;
					const iconImages = yield* ImageUploads;

					const managerIds = Array.from(
						new Set([organization.ownerId, user.id]),
					);
					const ownedOrganizationIds = (
						database: Parameters<Parameters<typeof db.use>[0]>[0],
					) =>
						database
							.select({ id: organizations.id })
							.from(organizations)
							.where(
								and(
									eq(organizations.ownerId, organization.ownerId),
									isNull(organizations.tombstoneAt),
								),
							);
					const [allMembers, managers, memberCountResult, inviteCountResult] =
						yield* Effect.all(
							[
								db.use((db) =>
									db
										.select({
											member: organizationMembers,
											user: {
												id: users.id,
												name: users.name,
												lastName: users.lastName,
												email: users.email,
												image: users.image,
											},
										})
										.from(organizationMembers)
										.leftJoin(users, eq(organizationMembers.userId, users.id))
										.where(
											eq(organizationMembers.organizationId, organization.id),
										),
								),
								db.use((db) =>
									db
										.select({
											id: users.id,
											inviteQuota: users.inviteQuota,
											stripeSubscriptionId: users.stripeSubscriptionId,
											stripeSubscriptionStatus: users.stripeSubscriptionStatus,
											thirdPartyStripeSubscriptionId:
												users.thirdPartyStripeSubscriptionId,
										})
										.from(users)
										.where(inArray(users.id, managerIds)),
								),
								db.use((db) =>
									db
										.select({ value: count() })
										.from(organizationMembers)
										.where(
											inArray(
												organizationMembers.organizationId,
												ownedOrganizationIds(db),
											),
										),
								),
								db.use((db) =>
									db
										.select({ value: count() })
										.from(organizationInvites)
										.where(
											inArray(
												organizationInvites.organizationId,
												ownedOrganizationIds(db),
											),
										),
								),
							],
							{ concurrency: "unbounded" },
						);
					const owner = managers.find(
						(manager) => manager.id === organization.ownerId,
					);
					const currentManager = managers.find(
						(manager) => manager.id === user.id,
					);
					const currentMember = allMembers.find(
						(member) => member.member.userId === user.id,
					);
					const currentRole = getEffectiveOrganizationRole({
						userId: user.id,
						ownerId: organization.ownerId,
						memberRole: currentMember?.member.role,
					});
					const proSeatProvider = selectProSeatProvider({
						actor: currentManager,
						owner,
						actorCanManageProSeats: canManageOrganizationProSeats(currentRole),
					});

					const totalInvites =
						(memberCountResult[0]?.value || 0) +
						(inviteCountResult[0]?.value || 0);

					return {
						organization: {
							...organization,
							iconUrl: organization.iconUrl
								? yield* iconImages.resolveImageUrl(organization.iconUrl)
								: null,
							shareableLinkIconUrl: organization.shareableLinkIconUrl
								? yield* iconImages.resolveImageUrl(
										organization.shareableLinkIconUrl,
									)
								: null,
						},
						members: yield* Effect.all(
							allMembers.map(
								Effect.fn(function* (m) {
									const imageUploads = yield* ImageUploads;
									if (!m.user) {
										throw new Error("Organization member user not found");
									}
									return {
										...m.member,
										user: {
											...m.user,
											image: m.user.image
												? yield* imageUploads.resolveImageUrl(m.user.image)
												: null,
										},
									};
								}),
							),
						),
						invites: (yield* Effect.promise(
							() => organizationInvitesPromise,
						)).filter((invite) => invite.organizationId === organization.id),
						inviteQuota: proSeatProvider?.inviteQuota ?? 0,
						totalInvites,
						ownerIsPro: userIsPro(owner ?? null),
						hasActiveProSeatProvider: proSeatProvider !== null,
					};
				}),
			),
			{ concurrency: 3 },
		).pipe(runPromise);

		const [, activeData, organizationSelect] = await Promise.all([
			organizationInvitesPromise,
			active ? loadActiveOrganizationData(user, active) : Promise.resolve(null),
			organizationSelectPromise,
		]);

		const spacesData: Spaces[] = activeData?.spacesData ?? [];
		const organizationSettings: OrganizationSettings | null =
			activeData?.organizationSettings ?? null;
		const anyNewNotifications = activeData?.anyNewNotifications ?? false;
		const userCapsCount = activeData?.userCapsCount ?? 0;
		const userPreferences = { preferences: user.preferences };

		return {
			organizationSelect,
			organizationSettings,
			spacesData,
			anyNewNotifications,
			userPreferences,
			userCapsCount,
		};
	} catch (error) {
		console.error("Failed to fetch dashboard data", error);
		return {
			organizationSelect: [],
			spacesData: [],
			userCapsCount: null,
			anyNewNotifications: false,
			userPreferences: null,
			organizationSettings: null,
		};
	}
}
