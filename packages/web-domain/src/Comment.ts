import { Schema } from "effect";

export const CommentId = Schema.String.pipe(Schema.brand("CommentId"));
export type CommentId = typeof CommentId.Type;
