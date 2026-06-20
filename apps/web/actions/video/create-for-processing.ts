"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { videos, videoUploads } from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { Storage as StorageService } from "@cap/web-backend";
import {
	type Folder,
	type Organisation,
	type Storage,
	Video,
} from "@cap/web-domain";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import { runPromise } from "@/lib/server";

export interface CreateForProcessingResult {
	id: Video.VideoId;
	rawFileKey: string;
	bucketId: string | null;
	storageIntegrationId: string | null;
	uploadTarget: Storage.UploadTarget;
	presignedPostData: {
		url: string;
		fields: Record<string, string>;
	} | null;
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

	// Free-tier length cap. `duration` here is client-supplied metadata sent at
	// upload-start, so it is only authoritative when a positive value is given
	// (instant recordings legitimately start with 0/unknown duration). A
	// positive declared duration over the cap is rejected up-front; the real
	// duration is only known at finalize, which is where the cap must ultimately
	// be enforced.
	if (
		!userIsPro(user) &&
		typeof duration === "number" &&
		Number.isFinite(duration) &&
		duration > 300
	) {
		throw new Error("upgrade_required");
	}

	await requireOrganizationAccess(user.id, orgId);

	const videoId = Video.VideoId.make(nanoId());

	const date = new Date();
	const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
		month: "long",
	})} ${date.getFullYear()}`;

	const rawFileKey = `${user.id}/${videoId}/raw-upload.mp4`;

	const uploadResult = await StorageService.createUploadTargetForUser(
		user.id,
		rawFileKey,
		{
			contentType: "video/mp4",
			method: "put",
			fields: {
				"x-amz-meta-userid": user.id,
				"x-amz-meta-duration": duration?.toString() ?? "",
				"x-amz-meta-resolution": resolution ?? "",
			},
		},
		orgId,
	).pipe(runPromise);

	await db()
		.insert(videos)
		.values({
			id: videoId,
			name: `Cap Upload - ${formattedDate}`,
			ownerId: user.id,
			orgId,
			source: { type: "webMP4" as const },
			bucket: Option.getOrNull(uploadResult.bucketId),
			storageIntegrationId: Option.getOrNull(uploadResult.storageIntegrationId),
			public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
			...(folderId ? { folderId } : {}),
		});

	await db().insert(videoUploads).values({
		videoId,
		mode: "singlepart",
		phase: "uploading",
		processingProgress: 0,
		rawFileKey,
	});

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
		bucketId: Option.getOrNull(uploadResult.bucketId),
		storageIntegrationId: Option.getOrNull(uploadResult.storageIntegrationId),
		uploadTarget: uploadResult.upload,
		presignedPostData:
			uploadResult.upload.type === "s3Post"
				? {
						url: uploadResult.upload.url,
						fields: uploadResult.upload.fields,
					}
				: null,
	};
}
