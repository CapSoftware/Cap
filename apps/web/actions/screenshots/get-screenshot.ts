import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets, videos } from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { S3_BUCKET_URL } from "@cap/utils";
import { eq } from "drizzle-orm";
import { createBucketProvider } from "@/utils/s3";

export async function getScreenshot(userId: string, screenshotId: string) {
	if (!userId || !screenshotId) {
		throw new Error("userId or screenshotId not supplied");
	}

	const query = await db()
		.select({ video: videos, bucket: s3Buckets })
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, screenshotId));

	if (query.length === 0) {
		throw new Error("Video does not exist");
	}

	const result = query[0];
	if (!result?.video) {
		throw new Error("Video not found");
	}

	const { video, bucket } = result;

	if (video.public === false) {
		const user = await getCurrentUser();

		if (!user || user.id !== video.ownerId) {
			throw new Error("Video is not public");
		}
	}

	const bucketProvider = await createBucketProvider(bucket);
	const screenshotPrefix = `${userId}/${screenshotId}/`;

	try {
		const objects = await bucketProvider.listObjects({
			prefix: screenshotPrefix,
		});

		const screenshot = objects.Contents?.find((object) =>
			object.Key?.endsWith(".png"),
		);

		if (!screenshot) {
			throw new Error("Screenshot not found");
		}

		let screenshotUrl: string;

		if (video.awsBucket !== serverEnv().CAP_AWS_BUCKET) {
			screenshotUrl = await bucketProvider.getSignedObjectUrl(screenshot.Key!);
		} else {
			screenshotUrl = `${S3_BUCKET_URL}/${screenshot.Key}`;
		}

		return { url: screenshotUrl };
	} catch (error) {
		throw new Error(`Error generating screenshot URL: ${error}`);
	}
}
