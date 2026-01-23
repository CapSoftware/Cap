import { ImageUpload } from "@inflight/web-domain";
import { Effect, Option } from "effect";

import { Database, type DbClient } from "../Database";
import { S3Buckets } from "../S3Buckets";

export class ImageUploads extends Effect.Service<ImageUploads>()(
	"ImageUploads",
	{
		effect: Effect.gen(function* () {
			const s3Buckets = yield* S3Buckets;
			const db = yield* Database;

			const [s3] = yield* s3Buckets.getBucketAccess();

			const applyUpdate = Effect.fn("ImageUploads.applyUpdate")(
				function* (args: {
					payload: ImageUpload.ImageUpdatePayload;
					existing: Option.Option<ImageUpload.ImageUrlOrKey>;
					keyPrefix: string;
					update: (
						db: DbClient,
						urlOrKey: ImageUpload.ImageKey | null,
					) => Promise<unknown>;
				}) {
					yield* Option.match(args.payload, {
						onSome: Effect.fn(function* (image) {
							const fileExtension = image.fileName.split(".").pop() || "jpg";
							const s3Key = ImageUpload.ImageKey.make(
								`${args.keyPrefix}/${Date.now()}.${fileExtension}`,
							);

							yield* s3.putObject(s3Key, image.data, {
								contentType: image.contentType,
							});

							yield* db.use((db) => args.update(db, s3Key));
						}),
						onNone: () => db.use((db) => args.update(db, null)),
					});

					yield* args.existing.pipe(
						Option.andThen((iconKeyOrUrl) =>
							ImageUpload.extractFileKey(iconKeyOrUrl, s3.isPathStyle),
						),
						Option.map(s3.deleteObject),
						Effect.transposeOption,
					);
				},
			);

			const resolveImageUrl = Effect.fn(function* (
				urlOrKey: ImageUpload.ImageUrlOrKey,
			) {
				const key = ImageUpload.extractFileKey(urlOrKey, s3.isPathStyle);

				return yield* Option.match(key, {
					onSome: (key) => s3.getSignedObjectUrl(key),
					onNone: () => Effect.succeed(urlOrKey),
				}).pipe(Effect.map(ImageUpload.ImageUrl.make));
			});

			return { applyUpdate, resolveImageUrl };
		}),
		dependencies: [S3Buckets.Default, Database.Default],
	},
) {}
