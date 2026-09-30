import type { comments as commentsSchema } from "@cap/database/schema";

/** The slice of a comment row media components need. */
export type MediaComment = Pick<
	typeof commentsSchema.$inferSelect,
	| "id"
	| "type"
	| "videoId"
	| "content"
	| "mediaKey"
	| "mediaDuration"
	| "mediaMeta"
>;

export const isMediaComment = <
	C extends Pick<MediaComment, "type" | "mediaKey">,
>(
	comment: C,
): boolean =>
	(comment.type === "video" || comment.type === "audio") &&
	comment.mediaKey !== null;
