import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { CurrentUser, Organisation } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { ImageUploads } from "../ImageUploads/index.ts";

export class UsersOnboarding extends Effect.Service<UsersOnboarding>()(
	"UsersOnboarding",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;
			const imageUploads = yield* ImageUploads;

			return {
				welcome: Effect.fn("Onboarding.welcome")(function* (data: {
					firstName: string;
					lastName?: string;
				}) {
					const currentUser = yield* CurrentUser;

					const [user] = yield* db.use((db) =>
						db
							.select()
							.from(Db.users)
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);

					const firstName = data.firstName.trim();
					const lastName = data.lastName?.trim() ?? "";

					yield* db.use((db) =>
						db
							.update(Db.users)
							.set({
								onboardingSteps: {
									...user.onboardingSteps,
									welcome: true,
								},
								name: firstName,
								lastName,
							})
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);

					const activeOrgId = user.activeOrganizationId || user.defaultOrgId;
					if (activeOrgId && firstName.length > 0) {
						yield* db.use((db) =>
							db
								.update(Db.organizations)
								.set({ name: `${firstName}'s Organization` })
								.where(
									Dz.and(
										Dz.eq(Db.organizations.id, activeOrgId),
										Dz.eq(Db.organizations.ownerId, currentUser.id),
										Dz.isNull(Db.organizations.tombstoneAt),
										Dz.eq(Db.organizations.name, "My Organization"),
									),
								),
						);
					}
				}),

				organizationSetup: Effect.fn("Onboarding.organizationSetup")(
					function* (data: {
						organizationName: string;
						organizationIcon?: {
							data: Uint8Array;
							contentType: string;
							fileName: string;
						};
					}) {
						const currentUser = yield* CurrentUser;

						const [user] = yield* db.use((db) =>
							db
								.select()
								.from(Db.users)
								.where(Dz.eq(Db.users.id, currentUser.id)),
						);

						const organizationName =
							data.organizationName.trim() || data.organizationName;
						const preferredOrganizationId =
							user.activeOrganizationId || user.defaultOrgId;

						const { organizationId, canEditOrganization } = yield* db.use(
							(db) =>
								db.transaction(async (tx) => {
									const [existingOrg] = preferredOrganizationId
										? await tx
												.select({
													id: Db.organizations.id,
													ownerId: Db.organizations.ownerId,
													tombstoneAt: Db.organizations.tombstoneAt,
												})
												.from(Db.organizations)
												.where(
													Dz.eq(Db.organizations.id, preferredOrganizationId),
												)
										: [];
									const resolvedOrgId =
										existingOrg?.id ??
										Organisation.OrganisationId.make(nanoId());
									const canEditOrganization =
										!existingOrg ||
										(existingOrg.ownerId === currentUser.id &&
											existingOrg.tombstoneAt === null);

									if (!existingOrg) {
										await tx.insert(Db.organizations).values({
											id: resolvedOrgId,
											ownerId: currentUser.id,
											name: organizationName,
										});

										await tx.insert(Db.organizationMembers).values({
											id: nanoId(),
											organizationId: resolvedOrgId,
											userId: currentUser.id,
											role: "owner",
										});
									} else if (canEditOrganization) {
										await tx
											.update(Db.organizations)
											.set({ name: organizationName })
											.where(
												Dz.and(
													Dz.eq(Db.organizations.id, resolvedOrgId),
													Dz.eq(Db.organizations.ownerId, currentUser.id),
													Dz.isNull(Db.organizations.tombstoneAt),
												),
											);
									}

									await tx
										.update(Db.users)
										.set({
											...(!existingOrg?.tombstoneAt && {
												activeOrganizationId: resolvedOrgId,
											}),
											...(canEditOrganization && {
												defaultOrgId: resolvedOrgId,
											}),
											onboardingSteps: {
												...user.onboardingSteps,
												organizationSetup: true,
											},
										})
										.where(Dz.eq(Db.users.id, currentUser.id));

									return { organizationId: resolvedOrgId, canEditOrganization };
								}),
						);

						const finalOrganizationId = organizationId;

						if (canEditOrganization && data.organizationIcon) {
							const [ownedOrganization] = yield* db.use((db) =>
								db
									.select({ id: Db.organizations.id })
									.from(Db.organizations)
									.where(
										Dz.and(
											Dz.eq(Db.organizations.id, finalOrganizationId),
											Dz.eq(Db.organizations.ownerId, currentUser.id),
											Dz.isNull(Db.organizations.tombstoneAt),
										),
									),
							);
							if (!ownedOrganization)
								return { organizationId: finalOrganizationId };

							const organizationIcon = data.organizationIcon;
							const uploadEffect = Effect.gen(function* () {
								const {
									data: fileData,
									contentType,
									fileName,
								} = organizationIcon;
								const allowedExt = new Map<string, string>([
									["image/png", "png"],
									["image/jpeg", "jpg"],
									["image/webp", "webp"],
									["image/svg+xml", "svg"],
								]);
								const fileExtension = allowedExt.get(contentType);
								if (!fileExtension)
									throw new Error("Unsupported icon content type");

								yield* imageUploads.applyUpdate({
									payload: Option.some({
										data: fileData,
										contentType,
										fileName,
									}),
									existing: Option.none(),
									keyPrefix: `organizations/${finalOrganizationId}`,
									update: (db, iconUrl) =>
										db
											.update(Db.organizations)
											.set({ iconUrl })
											.where(
												Dz.and(
													Dz.eq(Db.organizations.id, finalOrganizationId),
													Dz.eq(Db.organizations.ownerId, currentUser.id),
													Dz.isNull(Db.organizations.tombstoneAt),
												),
											),
								});
							}).pipe(
								Effect.catchAll((error) =>
									Effect.logError("Failed to upload organization icon", error),
								),
							);

							yield* uploadEffect;
						}

						return { organizationId: finalOrganizationId };
					},
				),

				customDomain: Effect.fn("Onboarding.customDomain")(function* () {
					const currentUser = yield* CurrentUser;

					const [user] = yield* db.use((db) =>
						db
							.select()
							.from(Db.users)
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);

					yield* db.use((db) =>
						db
							.update(Db.users)
							.set({
								onboardingSteps: {
									...user.onboardingSteps,
									customDomain: true,
								},
							})
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);
				}),

				inviteTeam: Effect.fn("Onboarding.inviteTeam")(function* () {
					const currentUser = yield* CurrentUser;

					const [user] = yield* db.use((db) =>
						db
							.select()
							.from(Db.users)
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);

					yield* db.use((db) =>
						db
							.update(Db.users)
							.set({
								onboardingSteps: {
									...user.onboardingSteps,
									inviteTeam: true,
									download: true,
								},
							})
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);
				}),
				skipToDashboard: Effect.fn("Onboarding.skipToDashboard")(function* () {
					const currentUser = yield* CurrentUser;

					const [user] = yield* db.use((db) =>
						db
							.select()
							.from(Db.users)
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);

					const shouldUsePlaceholder = !user.onboardingSteps?.welcome;
					const userName = shouldUsePlaceholder ? "Your name" : user.name;
					const orgName = shouldUsePlaceholder
						? "Your Organization"
						: `${user.name}'s organization`;

					yield* db.use((db) =>
						db.transaction(async (tx) => {
							await tx
								.update(Db.users)
								.set({
									name: userName,
									onboardingSteps: {
										welcome: true,
										organizationSetup: true,
										customDomain: true,
										inviteTeam: true,
										download: true,
									},
								})
								.where(Dz.eq(Db.users.id, currentUser.id));

							const organizationId =
								user.activeOrganizationId || user.defaultOrgId;
							const [existingOrg] = organizationId
								? await tx
										.select()
										.from(Db.organizations)
										.where(Dz.eq(Db.organizations.id, organizationId))
								: [];

							if (!existingOrg) {
								const newOrgId = Organisation.OrganisationId.make(nanoId());
								await tx.insert(Db.organizations).values({
									id: newOrgId,
									name: orgName,
									ownerId: currentUser.id,
								});
								await tx.insert(Db.organizationMembers).values({
									id: nanoId(),
									organizationId: newOrgId,
									userId: currentUser.id,
									role: "owner",
								});
								await tx
									.update(Db.users)
									.set({
										activeOrganizationId: newOrgId,
										defaultOrgId: newOrgId,
									})
									.where(Dz.eq(Db.users.id, currentUser.id));
							}
						}),
					);
				}),
			};
		}),
		dependencies: [Database.Default, ImageUploads.Default],
	},
) {}
