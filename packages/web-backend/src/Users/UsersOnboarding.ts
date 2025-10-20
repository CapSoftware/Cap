import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { CurrentUser, Organisation } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { S3Buckets } from "../S3Buckets/index.ts";

export class UsersOnboarding extends Effect.Service<UsersOnboarding>()(
	"UsersOnboarding",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;
			const s3Buckets = yield* S3Buckets;

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

					const activeOrgId = user.activeOrganizationId ?? user.defaultOrgId;
					if (activeOrgId && firstName.length > 0) {
						const [organization] = yield* db.use((db) =>
							db
								.select({ name: Db.organizations.name })
								.from(Db.organizations)
								.where(Dz.eq(Db.organizations.id, activeOrgId)),
						);

						if (organization?.name === "My Organization") {
							const personalizedName = `${firstName}'s Organization`;
							yield* db.use((db) =>
								db
									.update(Db.organizations)
									.set({ name: personalizedName })
									.where(Dz.eq(Db.organizations.id, activeOrgId)),
							);
						}
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
						let organizationId =
							user.activeOrganizationId ?? user.defaultOrgId ?? null;

						yield* db.use((db) =>
							db.transaction(async (tx) => {
								let resolvedOrgId = organizationId;

								if (resolvedOrgId) {
									const [existingOrg] = await tx
										.select({ id: Db.organizations.id })
										.from(Db.organizations)
										.where(Dz.eq(Db.organizations.id, resolvedOrgId));

									if (existingOrg) {
										await tx
											.update(Db.organizations)
											.set({ name: organizationName })
											.where(Dz.eq(Db.organizations.id, resolvedOrgId));
									} else {
										resolvedOrgId = Organisation.OrganisationId.make(nanoId());

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
									}
								} else {
									resolvedOrgId = Organisation.OrganisationId.make(nanoId());

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
								}

								await tx
									.update(Db.users)
									.set({
										activeOrganizationId: resolvedOrgId,
										defaultOrgId: resolvedOrgId,
										onboardingSteps: {
											...user.onboardingSteps,
											organizationSetup: true,
										},
									})
									.where(Dz.eq(Db.users.id, currentUser.id));

								organizationId = resolvedOrgId;
							}),
						);

						if (!organizationId) {
							throw new Error(
								"Failed to resolve organization during onboarding",
							);
						}

						const finalOrganizationId = organizationId;

						if (data.organizationIcon) {
							const organizationIcon = data.organizationIcon;
							const uploadEffect = Effect.gen(function* () {
								const { data: fileData, contentType } = organizationIcon;
								const allowedExt = new Map<string, string>([
									["image/png", "png"],
									["image/jpeg", "jpg"],
									["image/webp", "webp"],
									["image/svg+xml", "svg"],
								]);
								const fileExtension = allowedExt.get(contentType);
								if (!fileExtension)
									throw new Error("Unsupported icon content type");
								const fileKey = `organizations/${finalOrganizationId}/icon-${Date.now()}.${fileExtension}`;

								const [bucket] = yield* s3Buckets.getBucketAccess(
									Option.none(),
								);

								yield* bucket.putObject(fileKey, fileData, { contentType });

								yield* db.use((db) =>
									db
										.update(Db.organizations)
										.set({ iconUrlOrKey: fileKey })
										.where(Dz.eq(Db.organizations.id, finalOrganizationId)),
								);
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

							const [existingOrg] = await tx
								.select()
								.from(Db.organizations)
								.where(
									Dz.eq(Db.organizations.id, currentUser.activeOrganizationId),
								);

							if (!existingOrg || !user.onboardingSteps?.organizationSetup) {
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
		dependencies: [Database.Default, S3Buckets.Default],
	},
) {}
