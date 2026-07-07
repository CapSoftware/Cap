import * as Db from "@cap/database/schema";
import { CurrentUser, Organisation, Policy } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Array as EffectArray, Option } from "effect";
import { Database } from "../Database";
import { ImageUploads } from "../ImageUploads";
import { S3Buckets } from "../S3Buckets";
import { Tinybird } from "../Tinybird";
import { OrganisationsPolicy } from "./OrganisationsPolicy";

const analyticsDatasources = [
	"analytics_events",
	"analytics_pages_mv",
	"analytics_sessions_mv",
] as const;
const s3DeleteBatchSize = 1000;

const escapeTinybirdLiteral = (value: string) =>
	value.replace(/\\/g, "\\\\").replace(/'/g, "''");

const tenantDeleteCondition = (tenantIds: ReadonlyArray<string>) => {
	const uniqueTenantIds = [...new Set(tenantIds.filter(Boolean))];
	return `tenant_id IN (${uniqueTenantIds
		.map((tenantId) => `'${escapeTinybirdLiteral(tenantId)}'`)
		.join(", ")})`;
};

export class Organisations extends Effect.Service<Organisations>()(
	"Organisations",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;
			const policy = yield* OrganisationsPolicy;
			const imageUploads = yield* ImageUploads;
			const s3Buckets = yield* S3Buckets;
			const tinybird = yield* Tinybird;

			const update = Effect.fn("Organisations.update")(function* (
				payload: Organisation.OrganisationUpdate,
			) {
				const organisation = yield* db
					.use((db) =>
						db
							.select()
							.from(Db.organizations)
							.where(Dz.eq(Db.organizations.id, payload.id)),
					)
					.pipe(
						Effect.flatMap(EffectArray.get(0)),
						Effect.catchTag("NoSuchElementException", () =>
							Effect.fail(new Organisation.NotFoundError()),
						),
						Policy.withPolicy(policy.isAdminOrOwner(payload.id)),
					);

				if (payload.image) {
					yield* imageUploads.applyUpdate({
						payload: payload.image,
						existing: Option.fromNullable(organisation.iconUrl),
						keyPrefix: `organizations/${organisation.id}`,
						update: (db, urlOrKey) =>
							db
								.update(Db.organizations)
								.set({ iconUrl: urlOrKey })
								.where(Dz.eq(Db.organizations.id, organisation.id)),
					});
				}
			});

			const softDelete = Effect.fn("Organisations.softDelete")(function* (
				id: Organisation.OrganisationId,
			) {
				const user = yield* CurrentUser;

				yield* Policy.withPolicy(policy.isOwner(id))(Effect.void);

				const organisation = yield* db
					.use((db) =>
						db
							.select({
								id: Db.organizations.id,
								ownerId: Db.organizations.ownerId,
							})
							.from(Db.organizations)
							.where(Dz.eq(Db.organizations.id, id)),
					)
					.pipe(
						Effect.flatMap(EffectArray.get(0)),
						Effect.catchTag("NoSuchElementException", () =>
							Effect.fail(new Organisation.NotFoundError()),
						),
					);

				const videos = yield* db.use((db) =>
					db
						.select({
							id: Db.videos.id,
							ownerId: Db.videos.ownerId,
							bucket: Db.videos.bucket,
							storageIntegrationId: Db.videos.storageIntegrationId,
						})
						.from(Db.videos)
						.where(Dz.eq(Db.videos.orgId, id)),
				);
				const capManagedVideos = videos.filter(
					(video) => !video.bucket && !video.storageIntegrationId,
				);

				const [defaultBucket] = yield* s3Buckets.getBucketAccess(Option.none());

				const deleteS3Prefix = (prefix: string) =>
					Effect.gen(function* () {
						let continuationToken: string | undefined;
						do {
							const listedObjects = yield* defaultBucket.listObjects({
								prefix,
								continuationToken,
							});
							const objects =
								listedObjects.Contents?.filter(
									(object): object is { Key: string } => Boolean(object.Key),
								) ?? [];

							for (
								let index = 0;
								index < objects.length;
								index += s3DeleteBatchSize
							) {
								yield* defaultBucket.deleteObjects(
									objects.slice(index, index + s3DeleteBatchSize),
								);
							}

							continuationToken = listedObjects.IsTruncated
								? listedObjects.NextContinuationToken
								: undefined;
						} while (continuationToken);
					});

				yield* Effect.forEach(
					capManagedVideos,
					(video) => deleteS3Prefix(`${video.ownerId}/${video.id}/`),
					{ concurrency: 3 },
				);
				yield* deleteS3Prefix(`organizations/${id}/`);

				const deleteCondition = tenantDeleteCondition([
					id,
					organisation.ownerId,
				]);
				yield* Effect.forEach(
					analyticsDatasources,
					(datasource) => tinybird.deleteData(datasource, deleteCondition),
					{ concurrency: 1 },
				);

				yield* db.use((db) =>
					db.transaction(async (tx) => {
						const videoIds = videos.map((video) => video.id);
						const spaceRows = await tx
							.select({ id: Db.spaces.id })
							.from(Db.spaces)
							.where(Dz.eq(Db.spaces.organizationId, id));
						const memberRows = await tx
							.select({ userId: Db.organizationMembers.userId })
							.from(Db.organizationMembers)
							.where(Dz.eq(Db.organizationMembers.organizationId, id));
						const integrationRows = await tx
							.select({ id: Db.storageIntegrations.id })
							.from(Db.storageIntegrations)
							.where(Dz.eq(Db.storageIntegrations.organizationId, id));
						const spaceIds = spaceRows.map((space) => space.id);
						const affectedUserIds = [
							...new Set([
								organisation.ownerId,
								...memberRows.map((member) => member.userId),
							]),
						];
						const integrationIds = integrationRows.map(
							(integration) => integration.id,
						);

						if (videoIds.length > 0) {
							await tx
								.delete(Db.comments)
								.where(Dz.inArray(Db.comments.videoId, videoIds));
							await tx
								.delete(Db.notifications)
								.where(Dz.inArray(Db.notifications.videoId, videoIds));
							await tx
								.delete(Db.videoUploads)
								.where(Dz.inArray(Db.videoUploads.videoId, videoIds));
							await tx
								.delete(Db.importedVideos)
								.where(Dz.inArray(Db.importedVideos.id, videoIds));
							await tx
								.delete(Db.storageObjects)
								.where(Dz.inArray(Db.storageObjects.videoId, videoIds));
							await tx
								.delete(Db.sharedVideos)
								.where(Dz.inArray(Db.sharedVideos.videoId, videoIds));
							await tx
								.delete(Db.spaceVideos)
								.where(Dz.inArray(Db.spaceVideos.videoId, videoIds));
						}

						if (spaceIds.length > 0) {
							await tx
								.delete(Db.spaceVideos)
								.where(Dz.inArray(Db.spaceVideos.spaceId, spaceIds));
							await tx
								.delete(Db.spaceMembers)
								.where(Dz.inArray(Db.spaceMembers.spaceId, spaceIds));
						}

						if (integrationIds.length > 0) {
							await tx
								.delete(Db.storageObjects)
								.where(
									Dz.inArray(Db.storageObjects.integrationId, integrationIds),
								);
						}

						await tx
							.delete(Db.sharedVideos)
							.where(Dz.eq(Db.sharedVideos.organizationId, id));
						await tx
							.delete(Db.importedVideos)
							.where(Dz.eq(Db.importedVideos.orgId, id));
						await tx
							.delete(Db.notifications)
							.where(Dz.eq(Db.notifications.orgId, id));
						await tx
							.delete(Db.folders)
							.where(Dz.eq(Db.folders.organizationId, id));

						if (videoIds.length > 0) {
							await tx
								.delete(Db.videos)
								.where(Dz.inArray(Db.videos.id, videoIds));
						}

						if (spaceIds.length > 0) {
							await tx
								.delete(Db.spaces)
								.where(Dz.inArray(Db.spaces.id, spaceIds));
						}

						await tx
							.delete(Db.organizationInvites)
							.where(Dz.eq(Db.organizationInvites.organizationId, id));
						await tx
							.delete(Db.organizationMembers)
							.where(Dz.eq(Db.organizationMembers.organizationId, id));
						await tx
							.delete(Db.storageIntegrations)
							.where(Dz.eq(Db.storageIntegrations.organizationId, id));
						await tx
							.delete(Db.s3Buckets)
							.where(Dz.eq(Db.s3Buckets.organizationId, id));
						await tx
							.delete(Db.organizations)
							.where(Dz.eq(Db.organizations.id, id));

						for (const affectedUserId of affectedUserIds) {
							const [otherOrg] = await tx
								.select({ id: Db.organizations.id })
								.from(Db.organizations)
								.leftJoin(
									Db.organizationMembers,
									Dz.and(
										Dz.eq(
											Db.organizationMembers.organizationId,
											Db.organizations.id,
										),
										Dz.eq(Db.organizationMembers.userId, affectedUserId),
									),
								)
								.where(
									Dz.and(
										Dz.isNull(Db.organizations.tombstoneAt),
										Dz.or(
											Dz.eq(Db.organizations.ownerId, affectedUserId),
											Dz.eq(Db.organizationMembers.userId, affectedUserId),
										),
									),
								)
								.orderBy(Dz.asc(Db.organizations.createdAt))
								.limit(1);
							const fallbackOrgId =
								otherOrg?.id ?? Organisation.OrganisationId.make("");

							await tx
								.update(Db.users)
								.set({
									activeOrganizationId: fallbackOrgId,
									defaultOrgId: fallbackOrgId,
								})
								.where(
									Dz.and(
										Dz.eq(Db.users.id, affectedUserId),
										Dz.or(
											Dz.eq(Db.users.activeOrganizationId, id),
											Dz.eq(Db.users.defaultOrgId, id),
										),
									),
								);
						}

						await tx
							.delete(Db.sessions)
							.where(Dz.eq(Db.sessions.userId, user.id));
						await tx
							.delete(Db.authApiKeys)
							.where(Dz.eq(Db.authApiKeys.userId, user.id));
					}),
				);
			});
			return { update, softDelete };
		}),
		dependencies: [
			ImageUploads.Default,
			S3Buckets.Default,
			Tinybird.Default,
			Database.Default,
			OrganisationsPolicy.Default,
		],
	},
) {}
