import type { Folder, Mobile, User, Video } from "@cap/web-domain";

export type MobileCapRow = {
	id: Video.VideoId;
	ownerId: User.UserId;
	ownerPreferences: unknown;
	name: string;
	createdAt: Date;
	updatedAt: Date;
	ownerName: string | null;
	duration: number | null;
	folderId: Folder.FolderId | null;
	public: boolean;
	videoSharingRestrictedToOrg: boolean;
	hasPassword: boolean;
	hasInheritedPassword: boolean;
	commentCount: number;
	reactionCount: number;
	uploadVideoId: Video.VideoId | null;
	uploadUploaded: number | null;
	uploadTotal: number | null;
	uploadPhase: Video.UploadPhase | null;
	processingProgress: number | null;
	processingMessage: string | null;
	processingError: string | null;
	metadata: unknown;
	transcriptionStatus:
		| "PROCESSING"
		| "COMPLETE"
		| "ERROR"
		| "SKIPPED"
		| "NO_AUDIO"
		| null;
};

export const toMobileCapSummary = (
	row: MobileCapRow,
	viewCount: number,
	publicOrigin: string,
	currentUserId: User.UserId,
): (typeof Mobile.MobileCapSummary)["Type"] => {
	const passwordProtected =
		!row.videoSharingRestrictedToOrg &&
		(row.hasPassword || row.hasInheritedPassword);
	const hasThumbnail =
		(!row.uploadVideoId || row.uploadPhase === "complete") &&
		(row.ownerId === currentUserId || !passwordProtected);
	const thumbnailVersion = row.updatedAt.getTime();
	return {
		id: row.id,
		ownerId: row.ownerId,
		shareUrl: `${publicOrigin}/s/${row.id}`,
		title: row.name,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		ownerName: row.ownerName ?? "",
		durationSeconds: row.duration,
		thumbnailUrl: hasThumbnail
			? `${publicOrigin}/api/mobile/caps/${encodeURIComponent(row.id)}/thumbnail?v=${thumbnailVersion}`
			: null,
		thumbnailCacheKey: hasThumbnail
			? `cap-thumbnail:${row.id}:${thumbnailVersion}`
			: null,
		folderId: row.folderId,
		public: !row.videoSharingRestrictedToOrg && row.public,
		protected: passwordProtected,
		viewCount,
		commentCount: Number(row.commentCount),
		reactionCount: Number(row.reactionCount),
		upload:
			row.uploadVideoId && row.uploadPhase !== "complete"
				? {
						uploaded: Number(row.uploadUploaded ?? 0),
						total: Number(row.uploadTotal ?? 0),
						phase: row.uploadPhase ?? "uploading",
						processingProgress: Number(row.processingProgress ?? 0),
						processingMessage: row.processingMessage,
						processingError: row.processingError,
					}
				: null,
		ownedByCurrentUser: row.ownerId === currentUserId,
	};
};
