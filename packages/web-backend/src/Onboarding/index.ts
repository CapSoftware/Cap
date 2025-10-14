import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { CurrentUser, Organisation } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { S3Buckets } from "../S3Buckets/index.ts";

export class OnboardingService extends Effect.Service<OnboardingService>()(
	"OnboardingService",
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

					yield* db.use((db) =>
						db
							.update(Db.users)
							.set({
								onboardingSteps: {
									...user.onboardingSteps,
									welcome: true,
								},
								name: data.firstName,
								lastName: data.lastName || "",
							})
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);
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

						const organizationId = Organisation.OrganisationId.make(nanoId());

						yield* db.use((db) =>
							db.transaction(async (tx) => {
								await tx.insert(Db.organizations).values({
									id: organizationId,
									ownerId: currentUser.id,
									name: data.organizationName,
								});

								await tx.insert(Db.organizationMembers).values({
									id: nanoId(),
									userId: currentUser.id,
									role: "owner",
									organizationId,
								});

								await tx
									.update(Db.users)
									.set({
										activeOrganizationId: organizationId,
										onboardingSteps: {
											...user.onboardingSteps,
											organizationSetup: true,
										},
									})
									.where(Dz.eq(Db.users.id, currentUser.id));
							}),
						);

						if (data.organizationIcon) {
							const organizationIcon = data.organizationIcon;
							const uploadEffect = Effect.gen(function* () {
								const {
									data: fileData,
									contentType,
									fileName,
								} = organizationIcon;
								const fileExtension = fileName.split(".").pop();
								const fileKey = `organizations/${organizationId}/icon-${Date.now()}.${fileExtension}`;

								const [bucket] = yield* s3Buckets.getBucketAccess(
									Option.none(),
								);

								yield* bucket.putObject(fileKey, fileData, { contentType });
								const iconUrl = yield* bucket.getSignedObjectUrl(fileKey);

								yield* db.use((db) =>
									db
										.update(Db.organizations)
										.set({ iconUrl })
										.where(Dz.eq(Db.organizations.id, organizationId)),
								);
							}).pipe(
								Effect.catchAll((error) =>
									Effect.logError("Failed to upload organization icon", error),
								),
							);

							yield* uploadEffect;
						}

						return { organizationId };
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
								},
								onboarding_completed_at: new Date(),
							})
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);
				}),
			};
		}),
		dependencies: [Database.Default, S3Buckets.Default],
	},
) {}
