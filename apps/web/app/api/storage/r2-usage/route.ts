import { getCurrentUser } from "@cap/database/auth/session";
import { S3Buckets, Videos } from "@cap/web-backend";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";

const defaultLimitBytes = 10 * 1024 * 1024 * 1024;

const getLimitBytes = () => {
	const limit = Number(process.env.CAP_STORAGE_LIMIT_BYTES);
	return Number.isFinite(limit) && limit > 0
		? Math.floor(limit)
		: defaultLimitBytes;
};

export async function GET() {
	const user = await getCurrentUser();

	if (!user) {
		return Response.json({ auth: false }, { status: 401 });
	}

	const usage = await Effect.gen(function* () {
		const s3Buckets = yield* S3Buckets;
		const videos = yield* Videos;

		yield* videos.deleteExpired(100).pipe(Effect.catchAll(() => Effect.void));

		const [bucket] = yield* s3Buckets.getBucketAccess(Option.none());
		let continuationToken: string | undefined;
		let usedBytes = 0;
		let objectCount = 0;

		do {
			const objects = yield* bucket.listObjects({ continuationToken });
			for (const object of objects.Contents ?? []) {
				usedBytes += object.Size ?? 0;
				objectCount += 1;
			}
			continuationToken = objects.NextContinuationToken;
		} while (continuationToken);

		const limitBytes = getLimitBytes();
		const usedPercent =
			limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;

		return {
			bucket: bucket.bucketName,
			usedBytes,
			limitBytes,
			usedPercent,
			objectCount,
		};
	}).pipe(runPromise);

	return Response.json(usage, { status: 200 });
}
