"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { s3Buckets, videos, videoUploads } from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { S3Buckets } from "@cap/web-backend";
import {
	type Folder,
	type Organisation,
	S3Bucket,
	Video,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";

export interface CreateForProcessingResult {
	id: Video.VideoId;
	rawFileKey: string;
	bucketId: string | null;
	presignedPostData: {
		url: string;
		fields: Record<string, string>;
	};
}

export async function createVideoForServerProcessing({
	duration,
	resolution,
	folderId,
	orgId,
}: {
	duration?: number;
	resolution?: string;
	folderId?: Folder.FolderId;
	orgId: Organisation.OrganisationId;
}): Promise<CreateForProcessingResult> {
	const user = await getCurrentUser();

	if (!user) throw new Error("Unauthorized");

	if (!userIsPro(user) && duration && duration > 300) {
		throw new Error("upgrade_required");
	}

	const [customBucket] = await db()
		.select()
		.from(s3Buckets)
		.where(eq(s3Buckets.ownerId, user.id));

	const videoId = Video.VideoId.make(nanoId());

	const date = new Date();
	const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
		month: "long",
	})} ${date.getFullYear()}`;

	await db()
		.insert(videos)
		.values({
			id: videoId,
			name: `Cap Upload - ${formattedDate}`,
			ownerId: user.id,
			orgId,
			source: { type: "webMP4" as const },
			bucket: customBucket?.id,
			public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
			...(folderId ? { folderId } : {}),
		});

	await db().insert(videoUploads).values({
		videoId,
		phase: "uploading",
		processingProgress: 0,
	});

	const rawFileKey = `${user.id}/${videoId}/raw-upload.mp4`;

	const bucketIdOption = Option.fromNullable(customBucket?.id).pipe(
		Option.map((id) => S3Bucket.S3BucketId.make(id)),
	);

	const presignedPostData = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);

		return yield* bucket.getPresignedPostUrl(rawFileKey, {
			Fields: {
				"Content-Type": "video/mp4",
				"x-amz-meta-userid": user.id,
				"x-amz-meta-duration": duration?.toString() ?? "",
				"x-amz-meta-resolution": resolution ?? "",
			},
			Expires: 3600,
		});
	}).pipe(runPromise);

	if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production") {
		await dub()
			.links.create({
				url: `${serverEnv().WEB_URL}/s/${videoId}`,
				domain: "cap.link",
				key: videoId,
			})
			.catch((err) => {
				console.error("Dub link create failed", err);
			});
	}

	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/folder");
	revalidatePath("/dashboard/spaces");

	return {
		id: videoId,
		rawFileKey,
		bucketId: customBucket?.id ?? null,
		presignedPostData,
	};
}
