import { Schema } from "effect";

export const CommentId = Schema.String.pipe(Schema.brand("CommentId"));
export type CommentId = typeof CommentId.Type;

export const CommentType = Schema.Literal("emoji", "text", "video", "audio");
export type CommentType = typeof CommentType.Type;

export const MediaKind = Schema.Literal("video", "audio");
export type MediaKind = typeof MediaKind.Type;

export const MediaMeta = Schema.Struct({
	mime: Schema.String,
	size: Schema.optional(Schema.Number),
	width: Schema.optional(Schema.Number),
	height: Schema.optional(Schema.Number),
	thumbnailKey: Schema.optional(Schema.String),
	// Normalized 0..1 peaks for voice-note waveform rendering (typically 64).
	waveform: Schema.optional(Schema.Array(Schema.Number)),
});
export type MediaMeta = typeof MediaMeta.Type;
