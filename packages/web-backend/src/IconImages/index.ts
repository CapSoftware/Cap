import { IconImage } from "@cap/web-domain";
import { Effect, Option } from "effect";

import { Database, type DbClient } from "../Database";
import { S3Buckets } from "../S3Buckets";

export class IconImages extends Effect.Service<IconImages>()("IconImages", {
	effect: Effect.gen(function* () {
		const s3Buckets = yield* S3Buckets;
		const db = yield* Database;

		const [s3] = yield* s3Buckets.getBucketAccess();

		const applyUpdate = Effect.fn("IconImages.applyUpdate")(function* (args: {
			payload: IconImage.ImageUpdatePayload;
			existing: Option.Option<IconImage.ImageUrlOrKey>;
			keyPrefix: string;
			update: (
				db: DbClient,
				urlOrKey: IconImage.ImageKey | null,
			) => Promise<unknown>;
		}) {
			yield* Option.match(args.payload, {
				onSome: Effect.fn(function* (image) {
					const fileExtension = image.fileName.split(".").pop() || "jpg";
					const s3Key = IconImage.ImageKey.make(
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
					IconImage.extractFileKey(iconKeyOrUrl, s3.isPathStyle),
				),
				Option.map(s3.deleteObject),
				Effect.transposeOption,
			);
		});

		return { applyUpdate };
	}),
	dependencies: [S3Buckets.Default, Database.Default],
}) {}
