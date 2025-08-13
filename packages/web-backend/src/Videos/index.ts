import { CurrentUser, Policy, Video } from "@cap/web-domain";
import { Array, Effect, Option } from "effect";
import { S3Buckets } from "../S3Buckets";
import { S3BucketAccess } from "../S3Buckets/S3BucketAccess";
import { VideosPolicy } from "./VideosPolicy";
import { VideosRepo } from "./VideosRepo";

export class Videos extends Effect.Service<Videos>()("Videos", {
	effect: Effect.gen(function* () {
		const repo = yield* VideosRepo;
		const policy = yield* VideosPolicy;
		const s3Buckets = yield* S3Buckets;

		return {
			/*
			 * Get a video by ID. Will fail if the user does not have access.
			 */
			// This is only for external use since it does an access check,
			// internal use should prefer the repo directly
			getById: (id: Video.VideoId) =>
				repo.getById(id).pipe(
					Policy.withPublicPolicy(policy.canView(id)),
					Effect.withSpan("Videos.getById"),
				),

			/*
			 * Delete a video. Will fail if the user does not have access.
			 */
			delete: Effect.fn("Videos.delete")(function* (videoId: Video.VideoId) {
				const [video] = yield* repo
					.getById(videoId)
					.pipe(
						Effect.flatMap(Effect.catchAll(() => new Video.NotFoundError())),
					);

				const [S3ProviderLayer] = yield* s3Buckets.getProviderLayer(
					video.bucketId,
				);

				yield* repo
					.delete(video.id)
					.pipe(Policy.withPolicy(policy.isOwner(video.id)));

				yield* Effect.gen(function* () {
					const s3 = yield* S3BucketAccess;
					const user = yield* CurrentUser;

					const prefix = `${user.id}/${video.id}/`;

					const listedObjects = yield* s3.listObjects({ prefix });

					if (listedObjects.Contents?.length) {
						yield* s3.deleteObjects(
							listedObjects.Contents.map((content) => ({
								Key: content.Key,
							})),
						);
					}
				}).pipe(Effect.provide(S3ProviderLayer));
			}),

			/*
			 * Duplicates a video, its metadata, and its media files.
			 * Comments and reactions will not be duplicated or carried over.
			 */
			duplicate: Effect.fn("Videos.duplicate")(function* (
				videoId: Video.VideoId,
			) {
				const [video] = yield* repo
					.getById(videoId)
					.pipe(
						Effect.flatMap(Effect.catchAll(() => new Video.NotFoundError())),
						Policy.withPolicy(policy.isOwner(videoId)),
					);

				const [S3ProviderLayer] = yield* s3Buckets.getProviderLayer(
					video.bucketId,
				);

				// Don't duplicate password or sharing data
				const newVideoId = yield* repo.create(yield* video.toJS());

				yield* Effect.gen(function* () {
					const s3 = yield* S3BucketAccess;
					const bucketName = yield* s3.bucketName;

					const prefix = `${video.ownerId}/${video.id}/`;
					const newPrefix = `${video.ownerId}/${newVideoId}/`;

					const allObjects = yield* s3.listObjects({ prefix });

					if (allObjects.Contents)
						yield* Effect.all(
							Array.filterMap(allObjects.Contents, (obj) =>
								Option.map(Option.fromNullable(obj.Key), (key) => {
									const newKey = key.replace(prefix, newPrefix);
									return s3.copyObject(`${bucketName}/${obj.Key}`, newKey);
								}),
							),
							{ concurrency: 1 },
						);
				}).pipe(Effect.provide(S3ProviderLayer));
			}),
		};
	}),
	dependencies: [VideosPolicy.Default, VideosRepo.Default, S3Buckets.Default],
}) { }
