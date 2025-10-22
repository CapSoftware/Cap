import * as Db from "@cap/database/schema";
import { InternalError, Organisation, User } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Layer, Option } from "effect";
import { Database } from "../Database";
import { S3Buckets } from "../S3Buckets";
import { parseImageKey } from "./helpers";
import { UsersOnboarding } from "./UsersOnboarding";

export const UsersRpcsLive = User.UserRpcs.toLayer(
	Effect.gen(function* () {
		const onboarding = yield* UsersOnboarding;
		const s3Buckets = yield* S3Buckets;
		const db = yield* Database;
		return {
			UserCompleteOnboardingStep: (payload) =>
				Effect.gen(function* () {
					switch (payload.step) {
						case "welcome":
							yield* onboarding.welcome(payload.data);
							return { step: "welcome" as const, data: undefined };

						case "organizationSetup": {
							const result = yield* onboarding.organizationSetup(payload.data);
							return {
								step: "organizationSetup" as const,
								data: result,
							};
						}
						case "customDomain":
							yield* onboarding.customDomain();
							return { step: "customDomain" as const, data: undefined };

						case "inviteTeam":
							yield* onboarding.inviteTeam();
							return { step: "inviteTeam" as const, data: undefined };
						case "skipToDashboard":
							yield* onboarding.skipToDashboard();
							return { step: "skipToDashboard" as const, data: undefined };
					}
				}).pipe(
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
				),
			GetSignedImageUrl: (payload: {
				key: string;
				type: "user" | "organization";
			}) =>
				Effect.gen(function* () {
					const [bucket] = yield* s3Buckets.getBucketAccess(Option.none());
					const url = yield* bucket.getSignedObjectUrl(payload.key);
					return { url };
				}).pipe(
					Effect.catchTag("S3Error", () => new InternalError({ type: "s3" })),
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchAll(() => new InternalError({ type: "unknown" })),
				),
			UploadImage: (payload) =>
				Effect.gen(function* () {
					const oldS3KeyOption = yield* parseImageKey(
						payload.oldImageKey,
						payload.type,
					);
					const [bucket] = yield* s3Buckets.getBucketAccess(Option.none());

					// Delete old image if it exists and is valid
					if (Option.isSome(oldS3KeyOption)) {
						yield* bucket.deleteObject(oldS3KeyOption.value);
					}

					// Generate new S3 key
					const timestamp = Date.now();
					const fileExtension = payload.fileName.split(".").pop() || "jpg";
					const s3Key = `${payload.type}s/${payload.entityId}/${timestamp}.${fileExtension}`;

					// Upload new image
					const buffer = Buffer.from(payload.data);
					yield* bucket.putObject(s3Key, buffer, {
						contentType: payload.contentType,
					});

					// Update database
					if (payload.type === "user") {
						yield* db.use((db) =>
							db
								.update(Db.users)
								.set({ image: s3Key })
								.where(Dz.eq(Db.users.id, User.UserId.make(payload.entityId))),
						);
					} else {
						yield* db.use((db) =>
							db
								.update(Db.organizations)
								.set({ iconUrl: s3Key })
								.where(
									Dz.eq(
										Db.organizations.id,
										Organisation.OrganisationId.make(payload.entityId),
									),
								),
						);
					}

					return { key: s3Key };
				}).pipe(
					Effect.catchTag("S3Error", () => new InternalError({ type: "s3" })),
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchAll(() => new InternalError({ type: "unknown" })),
				),
			RemoveImage: (payload) =>
				Effect.gen(function* () {
					const s3KeyOption = yield* parseImageKey(
						payload.imageKey,
						payload.type,
					);
					const [bucket] = yield* s3Buckets.getBucketAccess(Option.none());

					// Only delete if we have a valid S3 key
					if (Option.isSome(s3KeyOption)) {
						yield* bucket.deleteObject(s3KeyOption.value);
					}

					// Update database
					if (payload.type === "user") {
						yield* db.use((db) =>
							db
								.update(Db.users)
								.set({ image: null })
								.where(Dz.eq(Db.users.id, User.UserId.make(payload.entityId))),
						);
					} else {
						yield* db.use((db) =>
							db
								.update(Db.organizations)
								.set({ iconUrl: null })
								.where(
									Dz.eq(
										Db.organizations.id,
										Organisation.OrganisationId.make(payload.entityId),
									),
								),
						);
					}

					return { success: true as const };
				}).pipe(
					Effect.catchTag("S3Error", () => new InternalError({ type: "s3" })),
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchAll(() => new InternalError({ type: "unknown" })),
				),
		};
	}),
).pipe(Layer.provide([UsersOnboarding.Default, Database.Default]));
