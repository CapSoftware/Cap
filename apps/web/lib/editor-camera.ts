import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { getCameraVideoKey } from "@/lib/editor-saved-render";
import { runPromise } from "@/lib/server";

function isMissingObjectError(error: { cause: unknown }): boolean {
	const cause = error.cause as
		| {
				$metadata?: { httpStatusCode?: number };
				name?: string;
		  }
		| undefined;

	if (cause?.$metadata?.httpStatusCode === 404) return true;
	if (cause?.name === "NotFound" || cause?.name === "NoSuchKey") return true;
	return false;
}

interface HasCameraRecordingInput {
	videoId: string;
	ownerId: string;
	bucketId: string | null;
}

export async function hasCameraRecording({
	videoId,
	ownerId,
	bucketId,
}: HasCameraRecordingInput): Promise<boolean> {
	const cameraKey = getCameraVideoKey(videoId, ownerId);

	try {
		return await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId as S3Bucket.S3BucketId | null),
		).pipe(
			Effect.flatMap(([bucket]) =>
				bucket.headObject(cameraKey).pipe(
					Effect.as(true),
					Effect.catchTag("S3Error", (error) => {
						if (isMissingObjectError(error)) {
							return Effect.succeed(false);
						}
						return Effect.fail(error);
					}),
				),
			),
			runPromise,
		);
	} catch {
		return false;
	}
}
