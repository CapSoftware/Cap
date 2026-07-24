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

export async function getDashboardData(user: typeof userSelectProps) {
	try {
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

		const userOrganizations = mergeUserOrganizations(
			ownedOrganizations,
			memberOrganizations,
		);

		const organizationIds = userOrganizations.map((org) => org.id);

		let organizationInvitesData: (typeof organizationInvites.$inferSelect)[] =
			[];
		if (organizationIds.length > 0) {
			organizationInvitesData = await db()
				.select()
				.from(organizationInvites)
				.where(inArray(organizationInvites.organizationId, organizationIds));
		}

		let anyNewNotifications = false;
		let spacesData: Spaces[] = [];
		let organizationSettings: OrganizationSettings | null = null;
		let userCapsCount = 0;
		let currentOrganizationRole: OrganizationRole | null = null;

		let activeOrganizationId = organizationIds.find(
			(orgId) => orgId === user.activeOrganizationId,
		);

		if (!activeOrganizationId && organizationIds.length > 0) {
			activeOrganizationId = organizationIds[0];
		}

		if (activeOrganizationId) {
			const activeOrgInfo = userOrganizations.find(
				(org) => org.id === activeOrganizationId,
			);
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
			currentOrganizationRole = getEffectiveOrganizationRole({
				userId: user.id,
				ownerId: activeOrgInfo?.ownerId,
				memberRole: activeOrgMembership?.role,
			});

			const [notification] = await db()
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.recipientId, user.id),
						eq(notifications.orgId, activeOrganizationId),
						isNull(notifications.readAt),
					),
				)
				.limit(1);

			anyNewNotifications = !!notification;

			const [organizationSetting] = await db()
				.select({ settings: organizations.settings })
				.from(organizations)
				.where(eq(organizations.id, activeOrganizationId));
			organizationSettings = organizationSetting?.settings || null;

			spacesData = await Effect.gen(function* () {
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
								hasPassword: sql`${spaces.password} IS NOT NULL`.mapWith(
									Boolean,
								),
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
						Effect.map((rows) =>
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

			if (activeOrgInfo) {
				const orgMemberCountResult = await db()
					.select({ value: sql<number>`COUNT(*)` })
					.from(organizationMembers)
					.where(eq(organizationMembers.organizationId, activeOrgInfo.id));
				const orgMemberCount = orgMemberCountResult[0]?.value || 0;

				const orgVideoCountResult = await db()
					.select({
						value: sql<number>`COUNT(DISTINCT ${sharedVideos.videoId})`,
					})
					.from(sharedVideos)
					.where(eq(sharedVideos.organizationId, activeOrgInfo.id));
				const orgVideoCount = orgVideoCountResult[0]?.value || 0;

				const userCapsCountResult = await db()
					.select({
						value: sql<number>`COUNT(DISTINCT ${videos.id})`,
					})
					.from(videos)
					.where(
						and(
							eq(videos.orgId, activeOrgInfo.id),
							eq(videos.ownerId, user.id),
						),
					);

				userCapsCount = userCapsCountResult[0]?.value || 0;

				const allSpacesEntry = await Effect.gen(function* () {
					const imageUploads = yield* ImageUploads;

					const iconUrl = activeOrgInfo.iconUrl;

					return {
						id: activeOrgInfo.id,
						primary: true,
						privacy: "Public",
						name: `All ${activeOrgInfo.name}`,
						description: `View all content in ${activeOrgInfo.name}`,
						organizationId: activeOrgInfo.id,
						iconUrl: iconUrl
							? yield* imageUploads.resolveImageUrl(iconUrl)
							: null,
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

				spacesData = [allSpacesEntry, ...spacesData];
			}
		}

		const [userPreferences] = await db()
			.select({
				preferences: users.preferences,
			})
			.from(users)
			.where(eq(users.id, user.id))
			.limit(1);

		const organizationSelect: Organization[] = await Effect.all(
			userOrganizations.map(
				Effect.fn(function* (organization) {
					const db = yield* Database;
					const iconImages = yield* ImageUploads;

					const allMembers = yield* db.use((db) =>
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
							.where(eq(organizationMembers.organizationId, organization.id)),
					);

					const managerIds = Array.from(
						new Set([organization.ownerId, user.id]),
					);
					const managers = yield* db.use((db) =>
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

					const ownedOrgIds = db.use((db) =>
						db
							.select({ id: organizations.id })
							.from(organizations)
							.where(
								and(
									eq(organizations.ownerId, organization.ownerId),
									isNull(organizations.tombstoneAt),
								),
							)
							.then((rows) => rows.map((r) => r.id)),
					);

					const ownedIds = yield* ownedOrgIds;

					const memberCountResult = yield* db.use((db) =>
						ownedIds.length > 0
							? db
									.select({ value: count() })
									.from(organizationMembers)
									.where(inArray(organizationMembers.organizationId, ownedIds))
							: Promise.resolve([{ value: 0 }]),
					);

					const inviteCountResult = yield* db.use((db) =>
						ownedIds.length > 0
							? db
									.select({ value: count() })
									.from(organizationInvites)
									.where(inArray(organizationInvites.organizationId, ownedIds))
							: Promise.resolve([{ value: 0 }]),
					);

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
						invites: organizationInvitesData.filter(
							(invite) => invite.organizationId === organization.id,
						),
						inviteQuota: proSeatProvider?.inviteQuota ?? 0,
						totalInvites,
						ownerIsPro: userIsPro(owner ?? null),
						hasActiveProSeatProvider: proSeatProvider !== null,
					};
				}),
			),
			{ concurrency: 3 },
		).pipe(runPromise);

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
